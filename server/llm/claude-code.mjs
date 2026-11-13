import { spawn as nodeSpawn } from 'node:child_process';

const TIMEOUT_MS = 30_000;
const STANDBY_MAX_AGE_MS = 15 * 60_000; // a standby that has waited longer is replaced, not asked
const MAX_STANDBYS = 4; // one per distinct (model, system prompt, tools); the oldest goes first
const CONTINUES = new Set(['tool_use', 'pause_turn']); // stop reasons of a message that is not the answer

const SOURCES_RULE = 'After your answer, end your reply with one final line of the form '
  + '"SOURCES: <url> <url>" listing the pages you relied on, or "SOURCES: none" if you used no page.';
// The model sometimes puts the marker at the end of the answer line instead of on its own line.
const SOURCES_LINE = /(?:^|\s)SOURCES:[ \t]*([^\n]*)\s*$/;

// Split a trailing `SOURCES:` line off the reply; keep http(s) URLs only.
function splitSources(text) {
  const m = SOURCES_LINE.exec(text);
  if (!m) return { text, sources: [] };
  const sources = m[1].split(/\s+/).filter((u) => /^https?:\/\/\S+$/i.test(u));
  return { text: text.slice(0, m.index).trim(), sources };
}

/**
 * Each call is answered by its own `claude -p` process speaking the stream-json protocol, so questions
 * never share a conversation. Two things keep a call short (measured: about 4.3 s -> 1.2 s -> 0.8 s):
 *   - the answer is taken when the model's message ends; the CLI's own wrap-up after it is not waited for;
 *   - `warm` (default on): after a call, a process with the same arguments is started at once and waits
 *     for the next one, so that call skips the start-up. A waiting process makes no model call.
 * @param {{spawn?: Function, timeoutMs?: number, warm?: boolean, standbyMaxAgeMs?: number, now?: () => number}} [deps]
 */
export function createClaudeCodeBackend(deps = {}) {
  const spawn = deps.spawn || nodeSpawn;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const maxAgeMs = deps.standbyMaxAgeMs ?? STANDBY_MAX_AGE_MS;
  const now = deps.now ?? Date.now;
  let warm = deps.warm ?? true;
  const standbys = new Map(); // key (the arguments) -> proc, oldest first

  // A started process. Output before it is asked anything is ignored; `ended` records an early death.
  function start(args) {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const proc = { child, bornAt: now(), ended: null, stderr: '', onEvent: null, onEnd: null };
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (proc.onEvent) proc.onEvent(event);
      }
    });
    child.stderr.on('data', (d) => { if (proc.stderr.length < 2000) proc.stderr += d; });
    const end = (ended) => {
      if (proc.ended) return;
      proc.ended = ended;
      if (proc.onEnd) proc.onEnd();
    };
    child.on('error', (e) => end({ error: e }));
    child.on('close', (code) => end({ code }));
    child.stdin.on('error', () => { /* surfaced via close */ });
    return proc;
  }

  const stop = (proc, signal) => { try { proc.child.kill(signal); } catch { /* already gone */ } };
  // A waiting standby must never keep the server (or a script) alive.
  const setRef = (proc, on) => {
    for (const h of [proc.child, proc.child.stdin, proc.child.stdout, proc.child.stderr]) {
      try { if (on) h.ref?.(); else h.unref?.(); } catch { /* not a real handle */ }
    }
  };

  function takeStandby(key) {
    const proc = standbys.get(key);
    if (!proc) return null;
    standbys.delete(key);
    if (proc.ended) return null;
    if (now() - proc.bornAt > maxAgeMs) { stop(proc); return null; }
    setRef(proc, true);
    return proc;
  }

  function refill(key, args) {
    if (!warm || standbys.has(key)) return;
    let proc;
    try { proc = start(args); } catch { return; } // the next call simply starts cold
    setRef(proc, false);
    standbys.set(key, proc);
    while (standbys.size > MAX_STANDBYS) {
      const [oldestKey, oldest] = standbys.entries().next().value;
      standbys.delete(oldestKey);
      stop(oldest);
    }
  }

  // Ask one process one question. Rejections carry `silent: true` when the process produced no output at all.
  function ask(proc, user, webSearch) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let text = '';
      let stopReason = null;
      let sawOutput = false;
      const finish = (fn, value, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.onEvent = null;
        proc.onEnd = null;
        stop(proc, signal); // one call per process; its wrap-up after the answer is not needed
        fn(value);
      };
      const answer = (raw) => {
        const trimmed = typeof raw === 'string' ? raw.trim() : '';
        // `claude -p` does not expose result URLs, so web answers carry them on a SOURCES line.
        const out = webSearch ? splitSources(trimmed) : { text: trimmed, sources: [] };
        if (!out.text) finish(reject, new Error('claude returned empty text'));
        else finish(resolve, out);
      };
      const timer = setTimeout(() => finish(reject, new Error(`claude timed out after ${timeoutMs} ms`), 'SIGKILL'), timeoutMs);

      proc.onEvent = (m) => {
        sawOutput = true;
        if (m.type === 'result') {
          if (m.is_error) finish(reject, new Error(`claude reported an error: ${String(m.result || '').slice(0, 300)}`));
          else answer(m.result);
          return;
        }
        if (m.type !== 'stream_event' || m.parent_tool_use_id) return; // a tool's own model calls are not the answer
        const e = m.event || {};
        if (e.type === 'message_start') { text = ''; stopReason = null; }
        else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') text += e.delta.text;
        else if (e.type === 'message_delta' && e.delta?.stop_reason) stopReason = e.delta.stop_reason;
        else if (e.type === 'message_stop' && stopReason && !CONTINUES.has(stopReason)) answer(text);
      };
      proc.onEnd = () => {
        const { error, code } = proc.ended;
        const why = error ? `claude failed to run: ${error.message}`
          : code === 0 ? 'claude ended without an answer'
            : `claude exited with code ${code}: ${proc.stderr.trim().slice(0, 300)}`;
        finish(reject, Object.assign(new Error(why), { silent: !sawOutput }));
      };
      if (proc.ended) { proc.onEnd(); return; }
      proc.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: user } })}\n`);
    });
  }

  return {
    complete({ model, system, user, webSearch }) {
      // --safe-mode: do not load the owner's CLAUDE.md, skills, plugins, hooks or MCP servers. Measured live,
      // without it a one-word call carried a ~1M-token prompt (7 s, and "prompt too long" with web search).
      const args = ['-p', '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--verbose', '--include-partial-messages', '--no-session-persistence', '--safe-mode',
        '--append-system-prompt', webSearch ? `${system}\n\n${SOURCES_RULE}` : system];
      if (webSearch) args.push('--tools', 'WebSearch', '--allowedTools', 'WebSearch');
      else args.push('--tools', '');
      const key = JSON.stringify(args);

      const standby = takeStandby(key);
      let proc = standby;
      if (!proc) {
        try { proc = start(args); } catch (e) {
          return Promise.reject(new Error(`Could not start claude: ${e.message}`));
        }
      }
      refill(key, args);
      const first = ask(proc, user, webSearch);
      if (!standby) return first;
      // A standby may have gone stale while it waited: if it dies without a word, ask a fresh process once.
      return first.catch((e) => {
        if (!e.silent) throw e;
        let fresh;
        try { fresh = start(args); } catch { throw e; }
        return ask(fresh, user, webSearch);
      });
    },
    /** Stop every waiting standby and start no more. Calls still work, cold. */
    close() {
      warm = false;
      for (const proc of standbys.values()) stop(proc);
      standbys.clear();
    },
  };
}
