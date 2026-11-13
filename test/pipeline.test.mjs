import test from 'node:test';
import assert from 'node:assert/strict';
import { createPipeline } from '../server/pipeline.mjs';
import { classifyLocally } from '../server/understand.mjs';

const CARD = { ttlMs: 7000, heardMax: 80, sourceMax: 60, answerMax: 180, nothingSolid: 'show' };
const PCM = new Int16Array(320);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setImmediate(r));

// Fakes for every dependency. `texts` is consumed one transcription per call. The classifier is fake in
// both halves (`understand` and the local pause / too-short rule) unless a test passes `classifyLocal`.
function setup(over = {}) {
  const sent = [];
  const calls = { asr: 0, understand: [], kb: [], statutes: [], projects: [], answer: [] };
  const texts = over.texts ?? [];
  const deps = {
    asr: over.asr ?? {
      async transcribe() {
        calls.asr++;
        const next = texts.shift();
        return typeof next === 'string' ? { text: next, via: 'local' } : next;
      },
    },
    understand: over.understand ?? (async (heard, context) => {
      calls.understand.push({ heard, context });
      return { kind: 'question', route: 'work', query: `q:${heard}` };
    }),
    classifyLocal: over.classifyLocal ?? (() => null),
    sources: {
      kb: { async search(q) { calls.kb.push(q); return { passages: [{ label: 'KB', text: 'p' }], mode: 'hybrid' }; } },
      statutes: { async lookup(a) { calls.statutes.push(a); return { passages: [{ label: 'NRS', text: 's' }] }; } },
      projects: { async lookup(q) { calls.projects.push(q); return { passages: [{ label: 'Proj', text: 'x' }] }; } },
      ...over.sources,
    },
    writeAnswer: over.writeAnswer ?? (async (args) => {
      calls.answer.push(args);
      return { heard: `They ask: ${args.heard}`, source: 'KB', answer: `a:${args.heard}`, solid: true, ttlMs: 7000 };
    }),
    llm: { name: 'fake-llm' },
    config: { card: { ...CARD, ...(over.card || {}) } },
    emit: (m) => sent.push(m),
    onPause: over.onPause,
  };
  return { pipeline: createPipeline(deps), sent, calls, deps };
}

const types = (sent) => sent.map((m) => (m.type === 'state' ? `state:${m.state}` : m.type));

test('question → thinking, card, listening in order', async () => {
  const { pipeline, sent, calls } = setup({ texts: ['When does it open'] });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(types(sent), ['state:thinking', 'card', 'state:listening']);
  assert.deepEqual(calls.kb, ['q:When does it open']);
  assert.equal(calls.answer[0].heard, 'When does it open');
  assert.equal(calls.answer[0].llm.name, 'fake-llm');
  assert.deepEqual(calls.answer[0].card, CARD);
  assert.deepEqual(calls.answer[0].passages, [{ label: 'KB', text: 'p' }]);
  const card = sent[1];
  assert.equal(card.id, 1);
  assert.equal(card.answer, 'a:When does it open');
  assert.equal(card.source, 'KB');
  assert.equal(card.solid, true);
  assert.equal(card.ttlMs, 7000);
  assert.equal(sent[0].asr, 'local');
});

test('card ids increase across questions', async () => {
  const { pipeline, sent } = setup({ texts: ['one', 'two'] });
  await pipeline.handleUtterance(PCM);
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent.filter((m) => m.type === 'card').map((m) => m.id), [1, 2]);
});

test('none → no messages', async () => {
  const { pipeline, sent, calls } = setup({
    texts: ['just chatting'],
    understand: async () => ({ kind: 'none' }),
  });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent, []);
  assert.equal(calls.answer.length, 0);
  assert.equal(calls.kb.length, 0);
});

test('pause intent → paused state', async () => {
  let paused = 0;
  const { pipeline, sent } = setup({
    texts: ['hold on a second'],
    understand: async () => ({ kind: 'pause' }),
    onPause: () => { paused++; },
  });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent, [{ type: 'state', state: 'paused', asr: 'local' }]);
  assert.equal(paused, 1);
});

test('slow first question finishing after a second → first card dropped', async () => {
  const gate = deferred();
  let n = 0;
  const { pipeline, sent } = setup({
    texts: ['first', 'second'],
    writeAnswer: async ({ heard }) => {
      if (++n === 1) await gate.promise; // the first answer is slow
      return { heard, source: 'S', answer: `a:${heard}`, solid: true, ttlMs: 1 };
    },
  });
  const first = pipeline.handleUtterance(PCM);
  await tick();
  await pipeline.handleUtterance(PCM); // second starts and finishes while the first waits
  gate.resolve();
  await first;
  const cards = sent.filter((m) => m.type === 'card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].answer, 'a:second');
  // thinking x2, then the second card and a single listening; nothing after the first finishes
  assert.deepEqual(types(sent), ['state:thinking', 'state:thinking', 'card', 'state:listening']);
});

test('an older question still in flight keeps listening back until the newest finishes', async () => {
  const gate = deferred();
  let n = 0;
  const { pipeline, sent } = setup({
    texts: ['first', 'second'],
    writeAnswer: async ({ heard }) => {
      if (++n === 2) await gate.promise; // the newest is slow
      return { heard, source: 'S', answer: `a:${heard}`, solid: true, ttlMs: 1 };
    },
  });
  await pipeline.handleUtterance(PCM); // first finishes before the second starts: normal
  const second = pipeline.handleUtterance(PCM);
  await tick();
  assert.deepEqual(types(sent), ['state:thinking', 'card', 'state:listening', 'state:thinking']);
  gate.resolve();
  await second;
  assert.deepEqual(types(sent).slice(-2), ['card', 'state:listening']);
});

test('asr rejects → error message, pipeline keeps working', async () => {
  let calls = 0;
  const { pipeline, sent } = setup({
    asr: {
      async transcribe() {
        if (++calls === 1) throw new Error('secret detail about http://127.0.0.1:8089');
        return { text: 'second try', via: 'local' };
      },
    },
  });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent, [{ type: 'error', message: 'speech-to-text unavailable' }]);
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(types(sent), ['error', 'state:thinking', 'card', 'state:listening']);
});

test('transcription via backup → a state message announces it at once, and later states carry it', async () => {
  const { pipeline, sent } = setup({ texts: [{ text: 'a question', via: 'backup' }, { text: 'again', via: 'local' }] });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent[0], { type: 'state', state: 'listening', asr: 'backup' }, 'announced before thinking');
  const states = sent.filter((m) => m.type === 'state');
  assert.deepEqual(states.map((s) => `${s.state}/${s.asr}`), ['listening/backup', 'thinking/backup', 'listening/backup']);
  sent.length = 0;
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent[0], { type: 'state', state: 'listening', asr: 'local' }, 'the change back is announced too');
});

test('a via change is announced even when the utterance is not a question; no change, no message', async () => {
  const { pipeline, sent } = setup({
    texts: [{ text: 'chat', via: 'local' }, { text: 'chat', via: 'backup' }, { text: 'chat', via: 'backup' }],
    understand: async () => ({ kind: 'none' }),
  });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent, []);
  await pipeline.handleUtterance(PCM);
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent, [{ type: 'state', state: 'listening', asr: 'backup' }]);
});

test('a via change while thinking announces the current state (thinking)', async () => {
  const gate = deferred();
  let n = 0;
  const { pipeline, sent } = setup({
    texts: ['first', { text: 'chat', via: 'backup' }],
    understand: async (heard) => (heard === 'first' ? { kind: 'question', route: 'general', query: heard } : { kind: 'none' }),
    writeAnswer: async ({ heard }) => { if (++n === 1) await gate.promise; return { heard, source: 'S', answer: 'a', solid: true, ttlMs: 1 }; },
  });
  const first = pipeline.handleUtterance(PCM);
  await tick();
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent.map((m) => `${m.state}/${m.asr}`), ['thinking/local', 'thinking/backup']);
  gate.resolve();
  await first;
});

test('three understand failures in a row → one "answers unavailable" error; again only after a success', async () => {
  const results = [];
  const { pipeline, sent } = setup({
    texts: Array.from({ length: 12 }, (_, i) => `u${i}`),
    understand: async () => results.shift(),
  });
  const failed = { kind: 'none', failed: true };
  const errors = () => sent.filter((m) => m.type === 'error');
  results.push(failed, failed, { kind: 'none', skipped: true }, { kind: 'pause' });
  for (let i = 0; i < 4; i++) await pipeline.handleUtterance(PCM);
  assert.equal(errors().length, 0, 'two failures; a skipped none and a pause neither count nor reset');
  results.push(failed);
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(errors(), [{ type: 'error', message: 'answers unavailable' }]);
  results.push(failed, failed, failed);
  for (let i = 0; i < 3; i++) await pipeline.handleUtterance(PCM);
  assert.equal(errors().length, 1, 'still failing: not repeated');
});

test('the error is not repeated while failures continue, and returns after a success', async () => {
  const results = [];
  const { pipeline, sent } = setup({ texts: Array.from({ length: 20 }, (_, i) => `u${i}`), understand: async () => results.shift() });
  const failed = { kind: 'none', failed: true };
  results.push(failed, failed, failed, failed, failed, { kind: 'none' }, failed, failed);
  for (let i = 0; i < 8; i++) await pipeline.handleUtterance(PCM);
  assert.equal(sent.filter((m) => m.type === 'error').length, 1);
  results.push(failed);
  await pipeline.handleUtterance(PCM);
  assert.equal(sent.filter((m) => m.type === 'error').length, 2, 'three in a row again after a success');
  results.push({ kind: 'question', route: 'general', query: 'q' }, failed, failed);
  for (let i = 0; i < 3; i++) await pipeline.handleUtterance(PCM);
  assert.equal(sent.filter((m) => m.type === 'error').length, 2, 'a question is a success too');
});

test('at most two understand calls in flight; one waiting slot, a newer utterance replaces the waiting one', async () => {
  const gates = [];
  const seen = [];
  const lines = [];
  const { deps } = setup({
    texts: ['U1', 'U2', 'U3', 'U4'],
    understand: async (heard) => {
      seen.push(heard);
      const g = deferred();
      gates.push(g);
      await g.promise;
      return { kind: 'none' };
    },
  });
  const pipeline = createPipeline({ ...deps, log: (l) => lines.push(l) });
  const runs = [];
  for (let i = 0; i < 4; i++) { runs.push(pipeline.handleUtterance(PCM)); await tick(); }
  assert.deepEqual(seen, ['U1', 'U2'], 'two in flight, U3 waits, U4 replaces U3');
  gates[0].resolve();
  await tick(); await tick();
  assert.deepEqual(seen, ['U1', 'U2', 'U4']);
  gates[1].resolve(); gates[2].resolve();
  await Promise.all(runs);
  assert.deepEqual(seen, ['U1', 'U2', 'U4'], 'U3 was dropped');
  assert.ok(lines.includes('understand-dropped'), lines.join('|'));
});

test('slots are released: later utterances still reach understand after a busy spell', async () => {
  const seen = [];
  const { pipeline } = setup({
    texts: ['a', 'b', 'c', 'd', 'e'],
    understand: async (heard) => { seen.push(heard); return { kind: 'none' }; },
  });
  await Promise.all([pipeline.handleUtterance(PCM), pipeline.handleUtterance(PCM), pipeline.handleUtterance(PCM)]);
  await pipeline.handleUtterance(PCM);
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'e']);
});

test('nothingSolid dark → no card for a non-solid answer', async () => {
  const notSolid = async ({ heard }) => ({ heard, source: 'No source found', answer: 'Nothing solid on this one', solid: false, ttlMs: 1 });
  const dark = setup({ texts: ['q1'], card: { nothingSolid: 'dark' }, writeAnswer: notSolid });
  await dark.pipeline.handleUtterance(PCM);
  assert.deepEqual(types(dark.sent), ['state:thinking', 'state:listening']);

  const show = setup({ texts: ['q1'], writeAnswer: notSolid });
  await show.pipeline.handleUtterance(PCM);
  assert.deepEqual(types(show.sent), ['state:thinking', 'card', 'state:listening']);

  const darkSolid = setup({ texts: ['q1'], card: { nothingSolid: 'dark' } });
  await darkSolid.pipeline.handleUtterance(PCM);
  assert.deepEqual(types(darkSolid.sent), ['state:thinking', 'card', 'state:listening']);
});

test('empty or whitespace transcription is dropped without touching context or understand', async () => {
  const { pipeline, sent, calls } = setup({ texts: ['', '   \n', 'real words'] });
  await pipeline.handleUtterance(PCM);
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(sent, []);
  assert.equal(calls.understand.length, 0);
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(calls.understand[0].context, ['real words']);
});

test('context is the last 6 utterances, oldest first, including the current one', async () => {
  const words = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8'];
  const { pipeline, calls } = setup({ texts: [...words], understand: async (heard, context) => { calls.understand.push({ heard, context }); return { kind: 'none' }; } });
  for (let i = 0; i < words.length; i++) await pipeline.handleUtterance(PCM);
  assert.deepEqual(calls.understand[1].context, ['u1', 'u2']);
  assert.deepEqual(calls.understand[7].context, ['u3', 'u4', 'u5', 'u6', 'u7', 'u8']);
  assert.equal(calls.understand[7].heard, 'u8');
});

test('routing: work, statute, project use their source; web and general use none', async () => {
  const intents = [
    { kind: 'question', route: 'work', query: 'wq' },
    { kind: 'question', route: 'statute', query: 'sq', chapters: ['484B'], section: '484B.100' },
    { kind: 'question', route: 'statute', query: 'sq2' },
    { kind: 'question', route: 'project', query: 'pq' },
    { kind: 'question', route: 'web', query: 'webq' },
    { kind: 'question', route: 'general', query: 'gq' },
    { kind: 'question', route: 'mystery', query: 'mq' },
  ];
  const { pipeline, calls } = setup({
    texts: intents.map((_, i) => `t${i}`),
    understand: async () => intents.shift(),
  });
  for (let i = 0; i < 7; i++) await pipeline.handleUtterance(PCM);
  assert.deepEqual(calls.kb, ['wq']);
  assert.deepEqual(calls.statutes, [
    { chapters: ['484B'], section: '484B.100', query: 'sq' },
    { chapters: [], section: undefined, query: 'sq2' },
  ]);
  assert.deepEqual(calls.projects, ['pq']);
  assert.deepEqual(calls.answer.map((a) => a.passages.length), [1, 1, 1, 1, 0, 0, 0]);
  assert.deepEqual(calls.answer.map((a) => a.intent.route), ['work', 'statute', 'statute', 'project', 'web', 'general', 'mystery']);
});

test('a source that rejects is treated as empty passages', async () => {
  const { pipeline, sent, calls } = setup({
    texts: ['q'],
    sources: { kb: { async search() { throw new Error('bridge down'); } } },
  });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(calls.answer[0].passages, []);
  assert.deepEqual(types(sent), ['state:thinking', 'card', 'state:listening']);
});

test('reset() discards an in-flight question and clears the context', async () => {
  const gate = deferred();
  const { pipeline, sent, calls } = setup({
    texts: ['old words', 'new words'],
    writeAnswer: async ({ heard }) => {
      await gate.promise;
      return { heard, source: 'S', answer: 'late', solid: true, ttlMs: 1 };
    },
  });
  const inflight = pipeline.handleUtterance(PCM);
  await tick();
  pipeline.reset();
  gate.resolve();
  await inflight;
  assert.deepEqual(types(sent), ['state:thinking']); // no card, no listening after reset
  calls.understand.length = 0;
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(calls.understand[0].context, ['new words']);
});

test('a pause intent drops an older in-flight question and no listening follows', async () => {
  const gate = deferred();
  const intents = [{ kind: 'question', route: 'general', query: 'q' }, { kind: 'pause' }];
  const { pipeline, sent } = setup({
    texts: ['ask', 'pause please'],
    understand: async () => intents.shift(),
    writeAnswer: async ({ heard }) => {
      await gate.promise;
      return { heard, source: 'S', answer: 'late', solid: true, ttlMs: 1 };
    },
  });
  const first = pipeline.handleUtterance(PCM);
  await tick();
  await pipeline.handleUtterance(PCM);
  gate.resolve();
  await first;
  assert.deepEqual(types(sent), ['state:thinking', 'state:paused']);
});

test('setState sends a state message carrying the latest asr', async () => {
  const { pipeline, sent } = setup({ texts: [{ text: 'x', via: 'backup' }], understand: async () => ({ kind: 'none' }) });
  pipeline.setState('listening');
  await pipeline.handleUtterance(PCM);
  pipeline.setState('paused');
  assert.deepEqual(sent, [
    { type: 'state', state: 'listening', asr: 'local' },
    { type: 'state', state: 'listening', asr: 'backup' }, // the via change, announced at once
    { type: 'state', state: 'paused', asr: 'backup' },
  ]);
});

test('logs carry no transcript text, question or answer', async () => {
  const lines = [];
  const { deps } = setup({ texts: ['SECRET-SPOKEN-WORDS'] });
  const pipeline = createPipeline({ ...deps, log: (l) => lines.push(String(l)) });
  await pipeline.handleUtterance(PCM);
  assert.ok(lines.length > 0);
  for (const l of lines) assert.ok(!/SECRET-SPOKEN-WORDS|q:|a:/.test(l), l);
});

test('a writeAnswer that rejects still returns the lens to listening, without a card', async () => {
  const { pipeline, sent } = setup({ texts: ['q'], writeAnswer: async () => { throw new Error('boom'); } });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(types(sent), ['state:thinking', 'state:listening']);
});

test('newest means most recently spoken: a slow earlier utterance finishing later is dropped', async () => {
  const gate = deferred();
  let n = 0;
  const { pipeline, sent, calls } = setup({
    asr: {
      async transcribe() {
        if (++n === 1) { await gate.promise; return { text: 'U1', via: 'local' }; } // spoken first, slow
        return { text: 'U2', via: 'local' };
      },
    },
  });
  const u1 = pipeline.handleUtterance(PCM);
  await tick();
  await pipeline.handleUtterance(PCM); // U2 enters second, finishes first
  gate.resolve();
  await u1; // U1 is classified as a question only now
  const cards = sent.filter((m) => m.type === 'card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].answer, 'a:U2');
  assert.deepEqual(types(sent), ['state:thinking', 'card', 'state:listening']); // never ends on "thinking"
  assert.deepEqual(calls.kb, ['q:U2']);
  assert.deepEqual(calls.answer.map((a) => a.heard), ['U2']);
});

test('a newer utterance that is not a question does not cut the newest question short', async () => {
  const gate = deferred();
  const { pipeline, sent } = setup({
    texts: ['U1', 'chatter'],
    understand: async (heard) => (heard === 'U1' ? { kind: 'question', route: 'general', query: heard } : { kind: 'none' }),
    writeAnswer: async ({ heard }) => {
      await gate.promise;
      return { heard, source: 'S', answer: `a:${heard}`, solid: true, ttlMs: 1 };
    },
  });
  const u1 = pipeline.handleUtterance(PCM);
  await tick();
  await pipeline.handleUtterance(PCM); // spoken later, not a question
  gate.resolve();
  await u1;
  assert.deepEqual(types(sent), ['state:thinking', 'card', 'state:listening']);
});

test('a pause intent discards an utterance still in ASR: no thinking, card or listening after paused', async () => {
  const gate = deferred();
  let n = 0;
  const { pipeline, sent } = setup({
    asr: {
      async transcribe() {
        if (++n === 1) { await gate.promise; return { text: 'late question', via: 'local' }; }
        return { text: 'pause', via: 'local' };
      },
    },
    understand: async (heard) => (heard === 'pause' ? { kind: 'pause' } : { kind: 'question', route: 'general', query: heard }),
  });
  const late = pipeline.handleUtterance(PCM);
  await tick();
  await pipeline.handleUtterance(PCM);
  gate.resolve();
  await late;
  assert.deepEqual(types(sent), ['state:paused']);
});

// --- pause and too-short are decided before an understand slot is taken ---

// Two long utterances hold both understand slots open until their gates resolve.
function busySetup(texts, over = {}) {
  const gates = [];
  const seen = [];
  const lines = [];
  let paused = 0;
  const { deps, sent } = setup({
    texts,
    understand: async (heard) => {
      seen.push(heard);
      const g = deferred();
      gates.push(g);
      await g.promise;
      return { kind: 'none' };
    },
    onPause: () => { paused++; },
    classifyLocal: classifyLocally,
    ...over,
  });
  const pipeline = createPipeline({ ...deps, log: (l) => lines.push(l) });
  return { pipeline, sent, gates, seen, lines, pausedCount: () => paused };
}

test('a spoken "stop listening" pauses at once while both understand slots are busy', async () => {
  const { pipeline, sent, gates, seen, pausedCount } = busySetup(
    ['what time does the office open', 'where is the form kept', 'okay stop listening']);
  const runs = [];
  for (let i = 0; i < 3; i++) { runs.push(pipeline.handleUtterance(PCM)); await tick(); }
  assert.deepEqual(types(sent), ['state:paused'], 'paused before either slot is released');
  assert.equal(pausedCount(), 1);
  assert.equal(seen.length, 2, 'the pause never went to understand');
  gates.forEach((g) => g.resolve());
  await Promise.all(runs);
  assert.deepEqual(types(sent), ['state:paused'], 'nothing follows the pause');
});

test('a spoken pause is not lost when a newer utterance arrives behind it', async () => {
  const { pipeline, sent, gates, pausedCount } = busySetup(
    ['what time does the office open', 'where is the form kept', 'stop listening', 'and one more thing to ask']);
  const runs = [];
  for (let i = 0; i < 4; i++) { runs.push(pipeline.handleUtterance(PCM)); await tick(); }
  assert.equal(pausedCount(), 1);
  assert.equal(types(sent)[0], 'state:paused');
  gates.forEach((g) => g.resolve());
  await tick(); await tick();
  gates.forEach((g) => g.resolve());
  await Promise.all(runs);
});

test('by default the pipeline uses the real rule: a pause phrase alone never calls understand', async () => {
  const { deps, sent, calls } = setup({ texts: ['Stop listening.'] });
  delete deps.classifyLocal;
  const pipeline = createPipeline(deps);
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(types(sent), ['state:paused']);
  assert.equal(calls.understand.length, 0);
});

test('a too-short utterance takes no slot and does not replace the waiting utterance', async () => {
  const { pipeline, gates, seen, lines } = busySetup(
    ['what time does the office open', 'where is the form kept', 'who signs the form off', 'uh huh']);
  const runs = [];
  for (let i = 0; i < 4; i++) { runs.push(pipeline.handleUtterance(PCM)); await tick(); }
  gates[0].resolve();
  await tick(); await tick();
  assert.deepEqual(seen, ['what time does the office open', 'where is the form kept', 'who signs the form off']);
  gates.forEach((g) => g.resolve());
  await Promise.all(runs);
  assert.ok(!lines.includes('understand-dropped'), lines.join('|'));
});

test('a too-short utterance still joins the context for the next question', async () => {
  const { pipeline, calls } = setup({ texts: ['uh huh', 'so when does it open'], classifyLocal: classifyLocally });
  await pipeline.handleUtterance(PCM);
  await pipeline.handleUtterance(PCM);
  assert.equal(calls.understand.length, 1);
  assert.deepEqual(calls.understand[0].context, ['uh huh', 'so when does it open']);
});

// ---- work mode ----------------------------------------------------------------------

// A work-mode pipeline: `mode` can be flipped by the test; the deep answerer is a fake that records its calls.
function workSetup(over = {}) {
  const base = setup(over);
  const lines = [];
  const state = { mode: over.mode ?? 'work' };
  const deep = [];
  const workAnswer = over.workAnswer ?? (async (args) => {
    deep.push(args);
    return {
      card: { heard: `They ask: ${args.heard}`, source: 'KB · Deep', answer: 'deep answer', solid: true, ttlMs: 7000 },
      passages: [{ label: 'a', text: 'b' }, { label: 'c', text: 'd' }], paths: ['x', 'y'], cited: 'x', rounds: 2,
    };
  });
  const pipeline = createPipeline({ ...base.deps, workAnswer, getMode: () => state.mode, log: (l) => lines.push(String(l)) });
  return { ...base, pipeline, lines, state, deep };
}

test('work mode: a question the model called general goes to the knowledge base through the deep answerer', async () => {
  const { pipeline, sent, calls, deep, lines } = workSetup({
    texts: ['what is the turnaround on that'],
    understand: async () => ({ kind: 'question', route: 'general', query: 'turnaround time' }),
  });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(types(sent), ['state:thinking', 'card', 'state:listening']);
  assert.equal(sent[1].source, 'KB · Deep');
  assert.equal(deep.length, 1);
  assert.deepEqual(deep[0], { intent: { kind: 'question', route: 'work', query: 'turnaround time' }, heard: 'what is the turnaround on that' });
  assert.equal(calls.kb.length, 0, 'the quick search is not used');
  assert.equal(calls.answer.length, 0, 'the quick answer writer is not used');
  assert.ok(lines.some((l) => /^question route=work mode=work passages=2 rounds=2 solid=true ms=\d+$/.test(l)), lines.join('|'));
});

test('work mode: an NRS question still goes to the live statute lookup', async () => {
  const { pipeline, calls, deep } = workSetup({
    texts: ['what does NRS 484B say'],
    understand: async () => ({ kind: 'question', route: 'statute', query: 'NRS 484B', chapters: ['484B'] }),
  });
  await pipeline.handleUtterance(PCM);
  assert.equal(deep.length, 0);
  assert.equal(calls.statutes.length, 1);
  assert.equal(calls.answer.length, 1);
});

test('work mode off: a work question takes the quick path exactly as before', async () => {
  const { pipeline, calls, deep, lines, state } = workSetup({ texts: ['when does it open', 'and when does it close'], mode: 'auto' });
  await pipeline.handleUtterance(PCM);
  assert.equal(deep.length, 0);
  assert.equal(calls.kb.length, 1);
  assert.equal(calls.answer.length, 1);
  assert.ok(lines.some((l) => /^question route=work passages=1 solid=true ms=\d+$/.test(l)), lines.join('|'));
  state.mode = 'work'; // the switch applies to the next question
  await pipeline.handleUtterance(PCM);
  assert.equal(deep.length, 1);
});

test('work mode: a deep answerer that fails leaves the lens listening, with no card', async () => {
  const { pipeline, sent, lines } = workSetup({ texts: ['when does it open'], workAnswer: async () => { throw new Error('boom'); } });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(types(sent), ['state:thinking', 'state:listening']);
  assert.ok(lines.includes('answer-failed route=work'), lines.join('|'));
});

test('work mode: Nothing solid is shown or kept dark by the same setting as the quick path', async () => {
  const nothing = async (args) => ({
    card: { heard: `They ask: ${args.heard}`, source: 'No source found', answer: 'Nothing solid on this one', solid: false, ttlMs: 7000 },
    passages: [], paths: [], cited: '', rounds: 1 });
  const shown = workSetup({ texts: ['when does it open'], workAnswer: nothing });
  await shown.pipeline.handleUtterance(PCM);
  assert.deepEqual(types(shown.sent), ['state:thinking', 'card', 'state:listening']);
  const dark = workSetup({ texts: ['when does it open'], workAnswer: nothing, card: { nothingSolid: 'dark' } });
  await dark.pipeline.handleUtterance(PCM);
  assert.deepEqual(types(dark.sent), ['state:thinking', 'state:listening']);
});

test('work mode with no deep answerer wired in falls back to the quick path on the work route', async () => {
  const { deps, calls } = setup({
    texts: ['what is the turnaround on that'],
    understand: async () => ({ kind: 'question', route: 'web', query: 'turnaround time' }),
  });
  const pipeline = createPipeline({ ...deps, getMode: () => 'work' });
  await pipeline.handleUtterance(PCM);
  assert.deepEqual(calls.kb, ['turnaround time']);
  assert.equal(calls.answer[0].intent.route, 'work');
});

test('work mode: a pause while the deep answer is being written leaves no card and no listening state', async () => {
  const gate = deferred();
  const { pipeline, sent } = workSetup({ texts: ['when does it open'], workAnswer: async (args) => {
    await gate.promise;
    return { card: { heard: `They ask: ${args.heard}`, source: 'KB · Deep', answer: 'late', solid: true, ttlMs: 7000 },
      passages: [], paths: [], cited: '', rounds: 1 };
  } });
  const run = pipeline.handleUtterance(PCM);
  await tick(); await tick();
  assert.deepEqual(types(sent), ['state:thinking']);
  pipeline.reset(); // what a pause does
  pipeline.setState('paused');
  gate.resolve();
  await run;
  assert.deepEqual(types(sent), ['state:thinking', 'state:paused']);
});

test('work mode: a newer question takes the lens from an older deep answer still being written', async () => {
  const gates = [deferred(), deferred()];
  let n = 0;
  const { pipeline, sent, lines } = workSetup({ texts: ['when does it open', 'and where is it'], workAnswer: async (args) => {
    await gates[n++].promise;
    return { card: { heard: `They ask: ${args.heard}`, source: 'KB · Deep', answer: `a:${args.heard}`, solid: true, ttlMs: 7000 },
      passages: [], paths: [], cited: '', rounds: 1 };
  } });
  const first = pipeline.handleUtterance(PCM);
  await tick(); await tick();
  const second = pipeline.handleUtterance(PCM);
  await tick(); await tick();
  gates[0].resolve(); // the older answer arrives while the newer question is still being answered
  await first;
  gates[1].resolve();
  await second;
  assert.deepEqual(types(sent), ['state:thinking', 'state:thinking', 'card', 'state:listening']);
  assert.equal(sent[2].answer, 'a:and where is it');
  assert.ok(lines.includes('card-dropped route=work'), lines.join('|'));
});
