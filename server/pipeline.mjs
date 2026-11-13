// utterance PCM -> text -> intent -> source -> card. One pipeline per connection.
// Privacy: nothing spoken, asked, answered or retrieved is ever logged; log lines
// carry event names, route names, counts and timings only.

import { classifyLocally } from './understand.mjs';

const CONTEXT_LINES = 6;
const ASR_ERROR = 'speech-to-text unavailable';
const UNDERSTAND_ERROR = 'answers unavailable';
const UNDERSTAND_FAILURES_TO_REPORT = 3; // consecutive failed understand calls before the lens is told
const UNDERSTAND_MAX_IN_FLIGHT = 2;

/**
 * @param {{
 *   asr: {transcribe(pcm: Int16Array): Promise<{text: string, via: 'local'|'backup'}>},
 *   understand: (heard: string, context: string[]) => Promise<import('./types.mjs').Intent>,
 *   classifyLocal?: (heard: string) => (import('./types.mjs').Intent | null), // default: the real pause / too-short rule
 *   sources: {kb: {search(q: string): Promise<{passages: import('./types.mjs').Passage[]}>},
 *     statutes: {lookup(a: {chapters: string[], section?: string, query: string}): Promise<{passages: import('./types.mjs').Passage[]}>},
 *     projects: {lookup(q: string): Promise<{passages: import('./types.mjs').Passage[]}>}},
 *   writeAnswer: Function, llm: import('./types.mjs').Llm,
 *   config: {card: {nothingSolid?: string}},
 *   emit: (message: object) => void,
 *   onPause?: () => void,
 *   getMode?: () => 'auto'|'work', // read once per question; 'work' sends every question except a statute one to the knowledge base
 *   workAnswer?: (args: {intent: import('./types.mjs').Intent, heard: string}) =>
 *     Promise<{card: object, passages: object[], rounds: number}>, // work mode's deep search and answer (server/work.mjs)
 *   log?: (line: string) => void,
 * }} deps
 * @returns {{handleUtterance(pcm: Int16Array): Promise<void>, reset(): void, setState(state: string): void}}
 */
export function createPipeline({
  asr, understand, classifyLocal = classifyLocally, sources, writeAnswer, llm, config, emit, onPause,
  getMode = () => 'auto', workAnswer = null, log = () => {},
}) {
  let context = [];
  let via = 'local'; // `via` of the latest transcription, carried on every state message
  let generation = 0; // bumped by reset(): work started before it is discarded
  let utteranceSeq = 0; // numbers utterances in the order they were spoken (entered handleUtterance)
  let newestQuestion = 0; // highest sequence number classified as a question so far
  let cardId = 0;
  let current = 'listening'; // the last state sent (the server greets with `listening`)
  let understandFailures = 0; // consecutive; reset by any understand result that reached the model
  let understandInFlight = 0;
  let waiting = null; // the one utterance waiting for an understand slot: {resolve(granted: boolean)}

  const state = (s) => { current = s; emit({ type: 'state', state: s, asr: via }); };

  // At most UNDERSTAND_MAX_IN_FLIGHT understand calls; one more may wait, and a newer arrival replaces it.
  function acquireUnderstand() {
    if (understandInFlight < UNDERSTAND_MAX_IN_FLIGHT) { understandInFlight++; return Promise.resolve(true); }
    if (waiting) waiting.resolve(false); // replaced: the older waiting utterance is dropped
    return new Promise((resolve) => { waiting = { resolve }; });
  }
  function releaseUnderstand() {
    if (waiting) { const w = waiting; waiting = null; w.resolve(true); } // the slot passes straight on
    else understandInFlight--;
  }

  async function fetchPassages(intent) {
    try {
      let result;
      if (intent.route === 'work') result = await sources.kb.search(intent.query);
      else if (intent.route === 'statute') {
        result = await sources.statutes.lookup({ chapters: intent.chapters ?? [], section: intent.section, query: intent.query });
      } else if (intent.route === 'project') result = await sources.projects.lookup(intent.query);
      else return [];
      return Array.isArray(result?.passages) ? result.passages : [];
    } catch {
      log(`source-failed route=${intent.route}`);
      return [];
    }
  }

  async function run(pcm) {
    const gen = generation;
    const seq = ++utteranceSeq;

    let heard;
    try {
      const r = await asr.transcribe(pcm);
      if (gen !== generation) return;
      const nextVia = r?.via === 'backup' ? 'backup' : 'local';
      if (nextVia !== via) { // announce at once: audio may be leaving the Mac now
        via = nextVia;
        state(current);
      }
      heard = typeof r?.text === 'string' ? r.text.trim() : '';
    } catch {
      if (gen !== generation) return;
      log('asr-failed');
      emit({ type: 'error', message: ASR_ERROR });
      return;
    }
    if (!heard) return;

    context.push(heard);
    if (context.length > CONTEXT_LINES) context = context.slice(-CONTEXT_LINES);
    // The pause command and too-short utterances need no model, so they never queue for a slot: a
    // spoken pause acts at once, and neither can replace a real utterance that is waiting.
    let intent = classifyLocal(heard);
    if (!intent) {
      if (!(await acquireUnderstand())) {
        log('understand-dropped');
        return;
      }
      try {
        if (gen !== generation) return;
        intent = await understand(heard, [...context]);
      } finally {
        releaseUnderstand();
      }
      if (gen !== generation) return;
    }

    if (intent?.failed) {
      understandFailures++;
      if (understandFailures === UNDERSTAND_FAILURES_TO_REPORT) emit({ type: 'error', message: UNDERSTAND_ERROR });
    } else if (intent && !intent.skipped && intent.kind !== 'pause') {
      understandFailures = 0; // the model answered
    }

    if (intent?.kind === 'pause') {
      generation++; // like a client pause: whatever is still in flight must not speak or announce listening
      log('intent pause');
      state('paused');
      if (onPause) onPause();
      return;
    }
    if (intent?.kind !== 'question') return;

    // Invariant: every emitted `thinking` is followed by exactly one of: a card + `listening`,
    // `paused`, or a newer question's `thinking`. So an utterance already stale when classified
    // (a newer-spoken question was classified first) does nothing at all: no state, no source, no answer.
    if (seq < newestQuestion) {
      log(`question-stale route=${intent.route}`);
      return;
    }
    newestQuestion = seq;
    // Work mode: every question is a knowledge base question, except one that names a statute.
    const workMode = getMode() === 'work';
    if (workMode && intent.route !== 'statute') intent = { ...intent, route: 'work' };
    const deep = workMode && intent.route === 'work' && typeof workAnswer === 'function';
    const started = Date.now();
    state('thinking');
    let card = null;
    let passages = [];
    let rounds = 0;
    if (deep) {
      try {
        const r = await workAnswer({ intent, heard });
        card = r?.card ?? null;
        passages = Array.isArray(r?.passages) ? r.passages : [];
        rounds = r?.rounds ?? 0;
      } catch {
        log(`answer-failed route=${intent.route}`); // never leave the lens on "thinking"
      }
    } else {
      passages = await fetchPassages(intent);
      if (gen !== generation) return;
      try {
        card = await writeAnswer({ intent, heard, passages, llm, card: config.card });
      } catch {
        log(`answer-failed route=${intent.route}`); // writeAnswer should not reject; never leave the lens on "thinking"
      }
    }
    if (gen !== generation || seq < newestQuestion) {
      log(`card-dropped route=${intent.route}`);
      return; // a newer question owns the lens now
    }
    const dark = config.card?.nothingSolid === 'dark' && card?.solid === false;
    if (card && !dark) emit({ type: 'card', id: ++cardId, ...card });
    log(`question route=${intent.route}${deep ? ` mode=work passages=${passages.length} rounds=${rounds}` : ` passages=${passages.length}`}`
      + ` solid=${card?.solid} ms=${Date.now() - started}`);
    state('listening');
  }

  return {
    /** Never rejects. */
    async handleUtterance(pcm) {
      try {
        await run(pcm);
      } catch {
        log('pipeline-error');
      }
    },
    /** Forget the context and discard whatever is still in flight. */
    reset() {
      generation++;
      context = [];
    },
    setState: state,
  };
}
