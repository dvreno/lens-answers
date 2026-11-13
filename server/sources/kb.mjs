// Node client for the notes bridge: one long-lived process, named by `kb.command`, that searches the wearer's
// own notes and documents and answers JSON-lines requests (the protocol is in bridge/README.md).
// With no command configured there is no notes source: nothing is started and every search is empty.
import { spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kbEnabled } from '../config.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEXT_MAX = 2400;
const TOP_K = 3;
const MIN_CUT_CHARS = 200; // a passage the total limit would cut below this is left out
const WARM_TIMEOUT_MS = 20000;
const WARM_QUERY = 'warm up the search index';
const NONE = () => ({ passages: [], paths: [], mode: 'none' });

const oneLine = (v) => (v ? String(v).replace(/\s+/g, ' ').trim() : '');

/**
 * `KB · <title> <version>, <status>[ (keyword match)]`, at most `max` characters by construction. Only the
 * title is ever cut (ending in `…`): the status and keyword marker are the owner's guard against a superseded
 * or weakly matched document, so later caps (answer source cap, lens layout) must never reach them.
 */
export function kbLabel({ title, version, status }, keywordOnly, max) {
  const prefix = 'KB · ';
  const ver = oneLine(version);
  const stat = oneLine(status);
  const tail = `${ver ? ` ${ver}` : ''}${stat ? `, ${stat}` : ''}${keywordOnly ? ' (keyword match)' : ''}`;
  const name = oneLine(title);
  let label = `${prefix}${name}${tail}`;
  if (label.length <= max) return label;
  const chars = Array.from(name); // code points, so a character is never cut in half
  do {
    chars.pop();
    label = `${prefix}${chars.join('').trimEnd()}…${tail}`;
  } while (chars.length && label.length > max);
  return label;
}

function toResult(reply, sourceMax, { textMax = TEXT_MAX, totalMax = Infinity } = {}) {
  if (!reply || typeof reply !== 'object' || reply.mode === 'none' || !Array.isArray(reply.results)) return NONE();
  const keywordOnly = reply.mode === 'keyword_only';
  // All-terms matches (`exact`) follow the search results; a document already among them is not repeated.
  const seen = new Set(reply.results.map((r) => r?.source_path).filter(Boolean));
  const extra = (Array.isArray(reply.exact) ? reply.exact : []).filter((r) => {
    if (!r || typeof r !== 'object' || seen.has(r.source_path)) return false;
    seen.add(r.source_path);
    return true;
  });
  const rows = [...reply.results.map((r) => [r, keywordOnly]), ...extra.map((r) => [r, true])];
  const passages = [];
  const paths = []; // parallel to `passages`: each result's source_path ('' when the bridge did not send one).
  let room = totalMax; // Only scripts/eval.mjs reads `paths`; it never reaches a card.
  for (const [r, byKeyword] of rows) {
    if (room <= 0) break;
    const excerpts = Array.isArray(r.excerpts) ? r.excerpts.filter((e) => typeof e === 'string') : [];
    const whole = excerpts.join('\n').slice(0, textMax);
    if (whole.length > room && room < MIN_CUT_CHARS) break; // the total limit would leave a stub
    const text = whole.slice(0, room);
    room -= text.length;
    passages.push({ label: kbLabel(r, byKeyword, sourceMax), text });
    paths.push(typeof r.source_path === 'string' ? r.source_path : '');
  }
  return passages.length ? { passages, paths, mode: String(reply.mode) } : NONE();
}

/**
 * @param {import('../types.mjs').Config} config
 * @param {{spawnImpl?: typeof nodeSpawn, log?: (line: string) => void}} [deps]
 */
export function createKb(config, { spawnImpl = nodeSpawn, log = () => {} } = {}) {
  const root = config.kb.root;
  const enabled = kbEnabled(config);
  const [program, ...programArgs] = enabled ? config.kb.command : [];
  const timeoutMs = config.kb.timeoutMs;
  const sourceMax = config.card?.sourceMax ?? 60;
  let child = null;
  let closed = false;
  let nextId = 1;
  const pending = new Map(); // id -> {resolve, timer, proc}; resolve gets the bridge's reply, or null

  function settle(id, reply) {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(reply);
  }
  // Only the requests sent to `proc`: a dying bridge must not settle requests sent to its replacement.
  const settleAll = (proc) => {
    for (const [id, p] of [...pending]) if (!proc || p.proc === proc) settle(id, null);
  };

  function kill(proc) {
    if (child === proc) child = null; // the next call respawns
    try { proc.kill(); } catch { /* already gone */ }
  }

  function start() {
    // cwd is this repo, never the notes folder, so a bridge that writes a relative file cannot touch the notes.
    const proc = spawnImpl(program, programArgs, {
      cwd: REPO,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', KB_ROOT: root, ...config.kb.env },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const lines = createInterface({ input: proc.stdout });
    lines.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { settleAll(proc); return; }
      if (msg && typeof msg === 'object' && pending.get(msg.id)?.proc === proc) settle(msg.id, msg);
    });
    const dead = () => {
      if (child === proc) child = null;
      settleAll(proc);
    };
    proc.on('exit', dead);
    proc.on('error', dead);
    proc.stdin.on('error', dead);
    return proc;
  }

  /** One request to the bridge: its raw reply, or null (no bridge, crash, garbage, timeout). Never rejects. */
  function ask(request, ms) {
    if (closed || !enabled) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = nextId++;
      try {
        child ??= start();
        const proc = child;
        const timer = setTimeout(() => { // a hung bridge is killed, so it cannot swallow every later question
          if (!pending.has(id)) return;
          settle(id, null);
          log('kb-timeout');
          kill(proc);
        }, ms);
        pending.set(id, { resolve, timer, proc });
        proc.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
      } catch {
        child = null;
        settle(id, null);
        resolve(null);
      }
    });
  }

  /**
   * @param {string} query
   * @param {{topK?: number, full?: boolean, exact?: boolean, textMax?: number, totalMax?: number}} [opts]
   *   topK: documents asked for (default 3). full: whole matching sections instead of short previews.
   *   exact: also sections holding every content word, appended and marked `(keyword match)`.
   *   textMax / totalMax: characters kept per passage / over all passages.
   * @returns {Promise<{passages: import('../types.mjs').Passage[], paths: string[], mode: string}>}
   */
  const search = (query, opts = {}) => {
    const request = { query, top_k: opts.topK ?? TOP_K };
    if (opts.full) request.full = true;
    if (opts.exact) request.exact = true;
    return ask(request, timeoutMs).then((reply) => (reply ? toResult(reply, sourceMax, opts) : NONE()));
  };

  /**
   * Starts the bridge and sends one neutral query with a long timeout so the index and embedder are loaded
   * before the first real question. The result is ignored; resolves true when the bridge replied.
   */
  const warm = () => (enabled
    ? ask({ query: WARM_QUERY, top_k: TOP_K }, WARM_TIMEOUT_MS).then((reply) => reply !== null)
    : Promise.resolve(true)); // nothing to warm

  function close() {
    closed = true;
    const proc = child;
    child = null;
    settleAll();
    if (proc) { try { proc.kill(); } catch { /* already gone */ } }
  }

  return { search, warm, close, enabled };
}
