import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, sample, isHit, parseEval, run, smallTalk, SMALL_TALK } from '../scripts/eval.mjs';

test('percentile: median and p90 of a list; null when empty', () => {
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([], 50), null);
});

test('sample spreads N entries evenly and deterministically; no limit gives all', () => {
  const all = Array.from({ length: 56 }, (_, i) => i);
  assert.deepEqual(sample(all, 4), [0, 14, 28, 42]);
  assert.equal(sample(all, 12).length, 12);
  assert.deepEqual(sample(all, 12), sample(all, 12));
  assert.equal(sample(all).length, 56);
  assert.equal(sample(all, 999).length, 56);
});

test('isHit: any expected path counts; exact or trailing-part match; nothing else', () => {
  assert.equal(isHit('a/b/c.md', ['x.md', 'a/b/c.md']), true);
  assert.equal(isHit('root/a/b/c.md', ['a/b/c.md']), true);
  assert.equal(isHit('a/b/c.md', ['root/a/b/c.md']), true);
  assert.equal(isHit('a/b/c.md', ['b/c.mdx']), false);
  assert.equal(isHit('', ['a']), false);
  assert.equal(isHit(undefined, ['a']), false);
  assert.equal(isHit('a', []), false);
});

test('parseEval keeps entries with a query and an expected list, from a top-level list or a keyed list', () => {
  const yaml = '- {id: a, query: "q one", kind: k, expected: [p1]}\n- {id: b, query: "q two"}\n';
  assert.deepEqual(parseEval(yaml).map((e) => e.id), ['a']);
  assert.deepEqual(parseEval('items:\n  - {id: c, query: "q", expected: [p]}\n').map((e) => e.id), ['c']);
});

// An invented wearer: a notes bridge (never started here), a statute route, projects and two routing patterns.
const config = { kb: { root: '/nonexistent', command: ['no-such-bridge'], env: {}, timeoutMs: 100 },
  projects: [{ name: 'P', paths: [] }], statutes: { enabled: true },
  routing: { work: { about: '', always: ['\\btyre[\\s-]*pad\\b'], lean: ['\\btune[\\s-]*ups?\\b'] } },
  card: { ttlMs: 1, heardMax: 80, sourceMax: 60, answerMax: 180 } };

test('run output holds counts only: never a query, a path or an answer', async () => {
  // createKb spawns the configured bridge, which does not exist here: every search is empty (a counted miss).
  const lines = [];
  const entries = [{ id: 'e1', query: 'SECRET-QUERY-WORDS', kind: 'cat-a', expected: ['SECRET/PATH.md'] }];
  const { counts } = await run({ config, entries, retrievalOnly: true, print: (l) => lines.push(l) });
  assert.equal(counts.questions, 1);
  assert.equal(counts.noPassages, 1);
  assert.equal(counts.top1, 0);
  const out = lines.join('\n');
  assert.doesNotMatch(out, /SECRET|e1/);
  assert.doesNotMatch(out, /cat-a/, 'free-text category names are never printed');
  assert.match(out, /category 1 0\/1/);
  assert.match(out, /expected document is the top passage: 0\/1/);
});

// A fake KB: two passages, paths parallel to them.
const fakeKb = () => ({
  async search() {
    return { passages: [{ label: 'KB · Doc A v01, current', text: 'a' }, { label: 'KB · Doc B v01, current', text: 'b' }],
      paths: ['docs/a.md', 'docs/b.md'], mode: 'hybrid' };
  },
  close() {},
});

test('full run counts solid cards that cite an expected document, and routes of KB questions not sent to work', async () => {
  const plan = [ // per question: understand reply, answer reply
    [{ kind: 'question', route: 'work', query: 'q1' }, { answer: 'x', source: 2 }], // cites b.md: expected -> grounded
    [{ kind: 'question', route: 'work', query: 'q2' }, { answer: 'x', source: 1 }], // cites a.md: not expected
    [{ kind: 'question', route: 'work', query: 'q3' }, { answer: 'x', source: null }], // nothing solid
    [{ kind: 'question', route: 'project', query: 'q4' }, null],
    [{ kind: 'question', route: 'statute', query: 'q5' }, null],
    [{ kind: 'none' }, null],
  ];
  let i = -1;
  const llm = {
    async complete(req) {
      if (req.model === 'fast') { i++; return { text: JSON.stringify(plan[i][0]), sources: [] }; }
      return { text: JSON.stringify(plan[i][1]), sources: [] };
    },
  };
  const entries = plan.map((_, n) => ({ id: `e${n}`, query: `a synthetic question number ${n}`, kind: n < 3 ? 'k1' : 'k2', expected: ['docs/b.md'] }));
  const lines = [];
  const { counts } = await run({ config, entries, retrievalOnly: false, llm, kb: fakeKb(), print: (l) => lines.push(l) });
  assert.equal(counts.answered, 3);
  assert.equal(counts.solid, 2);
  assert.equal(counts.solidCitingExpected, 1);
  assert.deepEqual(counts.notWorkRoutes, { project: 1, statute: 1, none: 1 });
  const out = lines.join('\n');
  assert.match(out, /solid cards citing an expected document: 1\/2/);
  assert.match(out, /KB questions not routed to work, by route: none 1, project 1, statute 1/);
  assert.match(out, /category 1 0\/3, category 2 0\/3/);
  assert.doesNotMatch(out, /k1|k2|synthetic|docs\/|Doc A|Doc B/);
});

test('retrieval-only also counts questions holding a lean-to-work term', async () => {
  const entries = [
    { query: 'when is the tune up due', kind: 'k', expected: ['x'] },
    { query: 'is the tyre pad charged', kind: 'k', expected: ['x'] },
    { query: 'how tall is the tree', kind: 'k', expected: ['x'] },
  ];
  const lines = [];
  const { counts } = await run({ config, entries, retrievalOnly: true, kb: fakeKb(), print: (l) => lines.push(l) });
  assert.equal(counts.ruleWork, 1);
  assert.equal(counts.ruleOrVocab, 2);
  assert.match(lines.join('\n'), /hard rules or the lean-to-work vocabulary: 2/);
});

test('full run answers only questions understand routes to work, and counts solid and nothing-solid', async () => {
  const calls = [];
  const llm = {
    async complete(req) {
      calls.push(req.model);
      if (req.model === 'fast') return { text: '{"kind":"question","route":"work","query":"SECRET-QUERY"}', sources: [] };
      return { text: '{"answer":"x","source":1}', sources: [] };
    },
  };
  const lines = [];
  const entries = [{ id: 'e1', query: 'a question about the system here', kind: 'cat-a', expected: ['p.md'] }];
  const { counts } = await run({ config, entries, retrievalOnly: false, llm, print: (l) => lines.push(l) });
  assert.equal(counts.routedWork, 1);
  assert.equal(counts.answered, 1, 'a work-routed question is answered');
  assert.equal(counts.nothingSolid, 1, 'no passages came back, so the card is nothing-solid');
  assert.equal(counts.solid, 0);
  assert.deepEqual(calls, ['fast'], 'with no passages the answer model is never called');
  assert.doesNotMatch(lines.join('\n'), /SECRET/);
});

test('small talk: counts lines that would produce a card; there are ten synthetic lines', async () => {
  assert.equal(SMALL_TALK.length, 10);
  const lines = [];
  const none = await smallTalk({ llm: { async complete() { return { text: '{"kind":"none"}', sources: [] }; } }, print: (l) => lines.push(l) });
  assert.equal(none, 0);
  const some = await smallTalk({ llm: { async complete() { return { text: '{"kind":"question","route":"general","query":"q"}', sources: [] }; } }, print: () => {} });
  assert.equal(some, SMALL_TALK.filter((l) => l.split(/\s+/).length >= 3).length);
  assert.match(lines.join('\n'), /10 lines, 0 would produce a card/);
});

test('work-mode run: every question except a statute one goes to the deep answerer; counts only', async () => {
  const entries = [
    { id: 'w1', query: 'SECRET words one', kind: 'k', expected: ['docs/a.md'] }, // solid, cites the expected document
    { id: 'w2', query: 'SECRET words two', kind: 'k', expected: ['docs/a.md'] }, // solid, cites another document it read
    { id: 'w3', query: 'SECRET words three', kind: 'k', expected: ['docs/a.md'] }, // solid from the context pack, second search
    { id: 'w4', query: 'SECRET words four', kind: 'k', expected: ['docs/zzz.md'] }, // nothing solid, expected never read
    { id: 'w5', query: 'SECRET words five', kind: 'k', expected: ['docs/a.md'] }, // a statute question: not answered here
    { id: 'w6', query: 'SECRET words six', kind: 'k', expected: ['docs/a.md'] }, // not a question
  ];
  const routes = { one: 'general', two: 'work', three: 'web', four: 'project', five: 'statute' };
  const llm = { async complete({ user }) {
    const word = Object.keys(routes).find((w) => user.includes(`SECRET words ${w}`));
    return { text: JSON.stringify(word ? { kind: 'question', route: routes[word], query: `SECRET words ${word}` } : { kind: 'none' }), sources: [] };
  } };
  const seen = [];
  const card = (solid) => ({ heard: 'h', source: 's', answer: 'a', solid, ttlMs: 1 });
  const answerWork = async ({ intent, heard }) => {
    seen.push({ route: intent.route, heard });
    const read = { passages: [{ label: 'A', text: 'a' }, { label: 'B', text: 'b' }], paths: ['docs/a.md', 'docs/b.md'] };
    if (heard.endsWith('one')) return { card: card(true), ...read, cited: 'docs/a.md', rounds: 1 };
    if (heard.endsWith('two')) return { card: card(true), ...read, cited: 'docs/b.md', rounds: 1 };
    if (heard.endsWith('three')) return { card: card(true), ...read, cited: 'pack', rounds: 2 };
    return { card: card(false), ...read, cited: '', rounds: 1 };
  };
  const lines = [];
  const { counts } = await run({ config, entries, retrievalOnly: false, workMode: true, answerWork, llm,
    kb: fakeKb(), print: (l) => lines.push(l) });
  assert.deepEqual(seen.map((s) => s.route), ['work', 'work', 'work', 'work']);
  assert.equal(counts.answered, 4);
  assert.equal(counts.solid, 3);
  assert.equal(counts.solidCitingExpected, 1);
  assert.equal(counts.solidCitingPack, 1);
  assert.equal(counts.nothingSolid, 1);
  assert.equal(counts.readExpected, 3);
  assert.equal(counts.secondSearch, 1);
  assert.equal(counts.notQuestion, 1);
  assert.deepEqual(counts.notWorkRoutes, { none: 1, statute: 1 });
  const out = lines.join('\n');
  assert.doesNotMatch(out, /SECRET|docs\//);
  assert.match(out, /work mode: answered 4 {2}solid: 3 {2}nothing solid: 1/);
  assert.match(out, /solid cards citing an expected document: 1\/3 {2}citing the context pack: 1\/3/);
  assert.match(out, /expected document among the passages read: 3\/4/);
  assert.match(out, /second searches: 1/);
  assert.match(out, / {2}work\s+n= {2}4/);
});
