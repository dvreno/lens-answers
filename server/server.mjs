// HTTP + WebSocket front end, and the entry point (`node server/server.mjs`).
// Binds 127.0.0.1 only; Tailscale `serve` provides HTTPS (see README).
// Privacy: logs carry event names, counts and timings only; audio is never written to disk.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { loadConfig, kbEnabled } from './config.mjs';
import { createPipeline } from './pipeline.mjs';
import { createOpusDecoder as realOpusDecoder } from './audio/opus.mjs';
import { createSegmenter as realSegmenter } from './audio/segmenter.mjs';
import { createAsr as realAsr } from './audio/asr.mjs';
import { createUnderstand as realUnderstand, routingFrom } from './understand.mjs';
import { createKb as realKb } from './sources/kb.mjs';
import { createStatutes as realStatutes } from './sources/statutes.mjs';
import { createProjects as realProjects, briefsAreStale as realBriefsAreStale, buildBriefs as realBuildBriefs } from './sources/projects.mjs';
import { writeAnswer as realWriteAnswer } from './answer.mjs';
import { createWorkAnswerer as realWorkAnswerer } from './work.mjs';
import { loadContextPack as realLoadContextPack } from './sources/pack.mjs';
import { createLlm as realLlm } from './llm/index.mjs';
import { decodeChunk } from '../phone/lib/wire.js';

const HOST = '127.0.0.1';
const MAX_PAYLOAD = 64 * 1024;
const HELLO_TIMEOUT_MS = 5000;
const AUDIO_REPORT_MS = 5000; // while audio arrives, one counts-only log line per this interval
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4409;
const CLOSE_INTERNAL = 1011; // this session cannot work (the audio decoder did not start)
const FRAME_SAMPLES = 320; // 20 ms of 16 kHz PCM, the size the real path pushes per Opus frame

/** Reads the token file, creating it (32 random bytes of hex, mode 600) on first run. */
function loadToken(tokenFile) {
  try {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600); // writeFileSync's mode is ignored when the (empty) file already exists
  return token;
}

function tokenMatches(expected, given) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * @param {import('./types.mjs').Config} config
 * @param {object} [deps]  injected factories for every dependency (tests use fakes)
 * @returns {Promise<{port: number, close(): Promise<void>, stats(): {badChunks: number},
 *   feedPcm(pcm: Int16Array): boolean}>}
 */
export async function startServer(config, deps = {}) {
  const log = deps.log ?? (() => {});
  const helloTimeoutMs = deps.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const audioReportMs = deps.audioReportMs ?? AUDIO_REPORT_MS;
  const makeDecoder = deps.createOpusDecoder ?? realOpusDecoder;
  const makeSegmenter = deps.createSegmenter ?? realSegmenter;
  const answer = deps.writeAnswer ?? realWriteAnswer;

  const llm = (deps.createLlm ?? realLlm)(config);
  const asr = (deps.createAsr ?? realAsr)(config);
  // Which routes exist follows from the config (a notes bridge, statutes, projects); a bad routing pattern
  // stops the start here, before anything is listening.
  const routing = routingFrom(config);
  const workAvailable = kbEnabled(config);
  log(`routes ${routing.routes.join(',')}`);
  const understand = (deps.createUnderstand ?? realUnderstand)({ llm, log, routing });
  const sources = {
    kb: (deps.createKb ?? realKb)(config, { log }),
    statutes: (deps.createStatutes ?? realStatutes)(),
    projects: (deps.createProjects ?? realProjects)(config),
  };
  // Work mode: the knowledge base's context pack is read once, here, and kept in memory only.
  const pack = (deps.loadContextPack ?? realLoadContextPack)(config, { log });
  const workAnswer = (deps.createWorkAnswerer ?? realWorkAnswerer)({ kb: sources.kb, llm, config, pack, log });
  const token = loadToken(config.tokenFile);
  const stats = { badChunks: 0 };

  const http = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  http.on('upgrade', (req, socket, head) => {
    let path = '';
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { /* falls through to 404 */ }
    if (path !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  /** @type {null | {close(code?: number): void}} */
  let active = null; // the one authenticated client

  function onConnection(ws) {
    let session = null; // set by a valid hello
    const helloTimer = setTimeout(() => ws.close(CLOSE_UNAUTHORIZED, 'hello required'), helloTimeoutMs);
    ws.on('error', () => {}); // protocol errors (e.g. oversize) surface as a close

    ws.on('message', (data, isBinary) => {
      if (session) { session.receive(data, isBinary); return; }
      if (isBinary) { ws.close(CLOSE_UNAUTHORIZED, 'hello required'); return; }
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { /* not JSON */ }
      if (msg?.type !== 'hello' || !tokenMatches(token, msg.token)) {
        ws.close(CLOSE_UNAUTHORIZED, 'unauthorized');
        return;
      }
      clearTimeout(helloTimer);
      if (active) active.close(CLOSE_REPLACED);
      session = createSession(ws);
      active = session;
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (session) {
        session.dispose();
        if (active === session) active = null;
      }
    });
  }

  function createSession(ws) {
    const segmenter = makeSegmenter(config.vad);
    let decoder = null;
    let paused = false;
    /** @type {null|'manual'|'voice'|'call'} why listening is paused; null while listening */
    let pausedBy = null;
    let closed = false;
    /** @type {'auto'|'work'} every connection starts in automatic mode; the phone restores its own choice */
    let mode = 'auto';
    let lastState = { state: 'listening', asr: 'local' }; // the last state sent, repeated when the mode changes
    let queue = Promise.resolve(); // handles messages in arrival order
    // Counts since the last `audio` log line: what arrived, what would not decode, and how loud it was.
    // Numbers only, never audio or words; this is how a silent or broken microphone path is told apart.
    // `speech` / `quiet` are how the sentence detector judged the slices and `floor` is its background level:
    // nearly all speech with sentences ending by `max` means the quiet between sentences is not being found.
    let heard = { chunks: 0, frames: 0, undecodable: 0, peak: 0 };
    let judged = { quiet: 0, speech: 0 }; // the detector's running totals at the last report
    let reportedAt = -Infinity;
    function reportAudio() {
      const now = Date.now();
      if (now - reportedAt < audioReportMs) return;
      reportedAt = now;
      const s = segmenter.stats?.() ?? { quiet: 0, speech: 0, floor: 0 };
      log(`audio chunks=${heard.chunks} frames=${heard.frames} undecodable=${heard.undecodable} peak=${heard.peak}`
        + ` speech=${s.speech - judged.speech} quiet=${s.quiet - judged.quiet} floor=${s.floor}`);
      heard = { chunks: 0, frames: 0, undecodable: 0, peak: 0 };
      judged = { quiet: s.quiet, speech: s.speech };
    }
    log('client-connected');

    // Every state message also says which mode is on, so the phone and the lens can show it, and carries
    // `noWork` when there is no notes source (the phone then switches its work-mode box off).
    const send = (message) => {
      let out = message;
      if (message.type === 'state') {
        lastState = { state: message.state, asr: message.asr };
        out = workAvailable ? { ...message, mode } : { ...message, mode, noWork: true };
      }
      if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(out));
    };
    const pipeline = createPipeline({
      asr, understand, sources, writeAnswer: answer, llm, config, emit: send, log,
      getMode: () => mode, workAnswer,
      // a spoken "pause" is exactly a client pause (the pipeline has already sent `paused`)
      onPause: () => { paused = true; pausedBy = 'voice'; segmenter.reset(); pipeline.reset(); },
    });

    // A decoder that cannot start ends this session only: one log line, close 1011, the server keeps running.
    const decoderReady = Promise.resolve().then(() => makeDecoder()).then((d) => {
      if (closed) d.free();
      else decoder = d;
    }, () => {
      log('decoder-failed');
      if (!closed) ws.close(CLOSE_INTERNAL, 'audio decoder unavailable');
    });

    function pause(reason) {
      paused = true;
      // An explicit pause (button or voice) takes over from a call pause; a call never relabels one.
      if (pausedBy === null || reason !== 'call') pausedBy = reason;
      segmenter.reset();
      pipeline.reset();
      pipeline.setState('paused');
    }
    /** Resumes only a pause for one of `reasons`; a no-op otherwise (no reset, no state message). */
    function resume(reasons) {
      if (!paused || !reasons.includes(pausedBy)) return;
      paused = false;
      pausedBy = null;
      segmenter.reset();
      pipeline.setState('listening');
    }

    /** Work mode waits longer for the end of a sentence; the pipeline reads `mode` once per question. */
    function setMode(next) {
      if (next !== 'work' && next !== 'auto') return;
      if (next === 'work' && !workAvailable) log('mode work unavailable'); // refused: the confirmation below says auto
      else if (next !== mode) {
        mode = next;
        segmenter.setSilenceMs(mode === 'work' ? config.work.silenceMs : config.vad.silenceMs);
        log(`mode ${mode}`);
      }
      send({ type: 'state', ...lastState }); // the confirmation, also for a repeated request
    }

    function onAudio(buf) {
      if (paused || !decoder) return; // paused audio is discarded undecoded
      let frames;
      try {
        ({ frames } = decodeChunk(buf));
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        stats.badChunks++;
        log(`bad-chunk count=${stats.badChunks}`);
        return;
      }
      heard.chunks++;
      for (const frame of frames) {
        if (paused || closed) return; // a spoken pause can land mid-chunk
        heard.frames++;
        let pcm;
        try { pcm = decoder.decode(frame); } catch { stats.badChunks++; heard.undecodable++; continue; }
        for (let i = 0; i < pcm.length; i++) {
          const level = pcm[i] < 0 ? -pcm[i] : pcm[i];
          if (level > heard.peak) heard.peak = level;
        }
        const utterance = segmenter.push(pcm);
        if (utterance) {
          log(`utterance samples=${utterance.length} end=${segmenter.stats?.().lastEnd ?? 'unknown'}`);
          pipeline.handleUtterance(utterance); // not awaited: audio keeps flowing; never rejects
        }
      }
      reportAudio();
    }

    // Local test hook (see feedPcm on the returned object): the same segmenter -> pipeline path as onAudio.
    function feedPcm(pcm) {
      if (paused || closed) return;
      for (let i = 0; i < pcm.length; i += FRAME_SAMPLES) {
        if (paused || closed) return; // a spoken pause can land mid-feed
        const utterance = segmenter.push(pcm.subarray(i, i + FRAME_SAMPLES));
        if (utterance) {
          log(`utterance samples=${utterance.length} end=${segmenter.stats?.().lastEnd ?? 'unknown'}`);
          pipeline.handleUtterance(utterance);
        }
      }
    }

    function onControl(data) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      switch (msg?.type) {
        case 'pause': pause('manual'); break;
        case 'resume': resume(['manual', 'voice', 'call']); break; // the user pressed Resume
        case 'call':
          if (msg.on === true) { if (!config.callMode) pause('call'); } else if (msg.on === false) resume(['call']);
          break;
        case 'mode': setMode(msg.mode); break;
        default: break; // includes a repeated hello
      }
    }

    queue = queue.then(() => decoderReady).then(() => { if (decoder) send({ type: 'state', state: 'listening', asr: 'local' }); });

    return {
      feedPcm,
      receive(data, isBinary) {
        queue = queue.then(() => {
          if (closed) return;
          if (isBinary) onAudio(data);
          else onControl(data);
        }).catch(() => { log('message-error'); });
      },
      close(code) {
        // Free everything now: a dead peer never answers the close frame (ws waits 30 s).
        this.dispose();
        ws.close(code);
        const kill = setTimeout(() => ws.terminate(), 1000);
        kill.unref();
        ws.once('close', () => clearTimeout(kill));
      },
      dispose() {
        if (closed) return;
        closed = true;
        pipeline.reset();
        segmenter.reset();
        if (decoder) { decoder.free(); decoder = null; }
      },
    };
  }

  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(config.port, HOST, resolve);
  });
  const { port } = http.address();

  // The KB bridge is started and warmed in the background: never awaited, never fatal.
  Promise.resolve()
    .then(() => sources.kb.warm?.())
    .then((ok) => { if (ok === false) log('kb-warm failed'); }, () => log('kb-warm failed'));

  // Stale project briefs are rebuilt in the background: never awaited, never fatal.
  try {
    if ((deps.briefsAreStale ?? realBriefsAreStale)(config)) {
      log('brief-rebuild started');
      Promise.resolve((deps.buildBriefs ?? realBuildBriefs)(config, llm)).catch(() => log('brief-rebuild failed'));
    }
  } catch {
    log('brief-rebuild failed');
  }

  return {
    port,
    stats: () => ({ ...stats }),
    /**
     * LOCAL TEST HOOK, not reachable over the network (it is a method on this in-process object, not a
     * socket message or HTTP route). Pushes 16 kHz mono PCM into the active session's segmenter and
     * pipeline, skipping only the WebSocket and the Opus decode. Used by test/studio-smoke.mjs, where the
     * virtual glasses have no microphone. Returns false when no client is connected (nothing is fed).
     */
    feedPcm(pcm) {
      if (!active) return false;
      active.feedPcm(pcm);
      return true;
    },
    async close() {
      for (const ws of wss.clients) ws.terminate();
      if (active) active.dispose();
      wss.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(() => resolve()));
      try { await sources.kb.close?.(); } catch { /* shutting down anyway */ }
      try { llm.close?.(); } catch { /* shutting down anyway */ }
    },
  };
}

async function main() {
  const config = loadConfig();
  const log = (line) => console.log(`[lens-answers] ${line}`);
  const server = await startServer(config, { log });
  console.log(`lens-answers listening on ${HOST}:${server.port} (token file: ${config.tokenFile})`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

let entry = false;
try { entry = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { /* not a file entry */ }
if (entry) {
  main().catch((e) => {
    console.error(`lens-answers failed to start: ${e.message}`);
    process.exit(1);
  });
}
