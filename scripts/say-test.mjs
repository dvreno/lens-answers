#!/usr/bin/env node
// Speaks one synthetic sentence at the running Lens Answers server and prints every server message
// with a millisecond offset from the end of speech.
//
//   node scripts/say-test.mjs "what time does the library open on friday"
//   node scripts/say-test.mjs --redact "..."   prints only flags and the source prefix, never text
//   node scripts/say-test.mjs "stop listening" --then "what is the capital of france"   same connection
//
// Synthesizes with macOS `say`, encodes 16 kHz mono Opus in 20 ms frames with ffmpeg, then streams the
// frames in real time (100 ms chunks, the phone's wire format) followed by 1 s of silence.
// This connects as THE client: it replaces whatever phone is connected. The token is read from the
// token file, sent only in the hello message, and never printed or put in a URL.
// Audio is synthesized under os.tmpdir() and deleted at once; nothing is kept.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { loadConfig, expandHome } from '../server/config.mjs';
import { encodeChunk } from '../phone/lib/wire.js';
import { oggPackets } from '../test/helpers/ogg-packets.mjs';

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const FRAME_MS = 20;
const PAD_MS = 1000;
const CHUNK_FRAMES = 5;

/** Opus packets (20 ms each) of a synthetic sentence plus PAD_MS of trailing silence. */
export function synthesize(sentence) {
  const dir = mkdtempSync(join(tmpdir(), 'lens-say-'));
  try {
    const aiff = join(dir, 's.aiff');
    const ogg = join(dir, 's.ogg');
    execFileSync('say', ['-o', aiff, sentence]);
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', aiff, '-af', `apad=pad_dur=${PAD_MS / 1000}`,
      '-c:a', 'libopus', '-ar', '16000', '-ac', '1', '-frame_duration', String(FRAME_MS), ogg]);
    const packets = oggPackets(new Uint8Array(readFileSync(ogg)));
    return { packets, speechFrames: Math.max(0, packets.length - PAD_MS / FRAME_MS) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readToken = (file) => readFileSync(expandHome(file), 'utf8').trim();

/**
 * @param {string} sentence
 * @param {{config?: object, port?: number, redact?: boolean, print?: (line: string) => void,
 *   idleMs?: number, maxMs?: number, then?: string[]}} [opts]
 * @returns {Promise<{messages: {t: number, msg: object}[], endOfSpeechMs: number}>}
 *   t is ms from the end of the current sentence's speech (null before it ends).
 */
export async function sayTest(sentence, opts = {}) {
  const config = opts.config ?? loadConfig();
  const port = opts.port ?? config.port;
  const print = opts.print ?? ((l) => console.log(l));
  const idleMs = opts.idleMs ?? 8000; // no `thinking` this long after speech ends: nothing is coming
  const maxMs = opts.maxMs ?? 60000;
  const sentences = [sentence, ...(opts.then ?? [])]; // later ones are spoken on the same connection

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  let endAt = null; // performance.now() at the end of the current sentence's speech
  let sawThinking = false;
  let finished = false;
  const rel = () => Math.round(performance.now() - endAt);

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const t = endAt === null ? null : rel();
    messages.push({ t, msg });
    print(`${t === null ? '(before speech)'.padStart(10) : `${String(t).padStart(7)} ms`}  ${describe(msg, opts.redact)}`);
    if (endAt !== null) {
      if (msg.type === 'state' && msg.state === 'thinking') sawThinking = true;
      if (msg.type === 'state' && msg.state === 'paused') finished = true;
      if (msg.type === 'state' && msg.state === 'listening' && sawThinking) finished = true;
      if (msg.type === 'error') finished = true;
    }
  });
  ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', token: readToken(config.tokenFile) }));
  // Wait for the server's first state message (hello accepted) so audio is not sent into a closed socket.
  const helloDeadline = performance.now() + 5000;
  while (messages.length === 0) {
    if (performance.now() > helloDeadline || ws.readyState !== ws.OPEN) throw new Error('server did not accept the hello (is the token file the one the server uses?)');
    await sleep(10);
  }

  let endOfSpeechMs = 0;
  for (const [n, text] of sentences.entries()) {
    if (n > 0) print(`           --- next sentence, same connection ---`);
    const { packets, speechFrames } = synthesize(text);
    endAt = null; sawThinking = false; finished = false;
    const first = messages.length;
    const start = performance.now();
    for (let i = 0; i < packets.length; i += CHUNK_FRAMES) {
      const frames = packets.slice(i, i + CHUNK_FRAMES);
      const data = new Uint8Array(frames.reduce((c, f) => c + f.length, 0));
      let o = 0;
      for (const f of frames) { data.set(f, o); o += f.length; }
      // Real time: this chunk is "spoken" when its last frame ends.
      await sleep(Math.max(0, start + (i + frames.length) * FRAME_MS - performance.now()));
      if (ws.readyState !== ws.OPEN) break;
      ws.send(encodeChunk(frames.map((f) => f.length), data));
      if (endAt === null && i + frames.length >= speechFrames) endAt = start + speechFrames * FRAME_MS;
    }
    endAt ??= performance.now();
    endOfSpeechMs = Math.round(endAt - start);

    const stop = performance.now() + maxMs;
    const idle = () => !sawThinking && performance.now() - endAt > idleMs;
    while (!finished && !idle() && performance.now() < stop && ws.readyState === ws.OPEN) await sleep(20);
    if (!sawThinking && !finished) print(`${String(rel()).padStart(7)} ms  (no thinking: nothing was answered; ${messages.length - first} messages for this sentence)`);
  }
  ws.close();
  return { messages, endOfSpeechMs };
}

function describe(msg, redact) {
  if (msg.type === 'state') return `state ${msg.state} (asr ${msg.asr})`;
  if (msg.type === 'error') return `error ${msg.message}`;
  if (msg.type === 'card') {
    if (redact) return `card id=${msg.id} solid=${msg.solid} source-prefix="${String(msg.source).split(' · ')[0]} · " answer-chars=${String(msg.answer).length}`;
    return `card id=${msg.id} solid=${msg.solid}\n            heard:  ${msg.heard}\n            source: ${msg.source}\n            answer: ${msg.answer}`;
  }
  return msg.type;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const redact = args.includes('--redact');
  const portAt = args.indexOf('--port');
  const port = portAt >= 0 ? Number(args[portAt + 1]) : undefined;
  const thenAt = args.indexOf('--then');
  const then = thenAt >= 0 ? args.slice(thenAt + 1) : [];
  const head = thenAt >= 0 ? args.slice(0, thenAt) : args;
  const sentence = head.filter((a, i) => a !== '--redact' && a !== '--port' && !(portAt >= 0 && i === portAt + 1)).join(' ').trim();
  if (!sentence) {
    console.error('usage: node scripts/say-test.mjs [--redact] [--port N] "<sentence>" [--then "<sentence>" ...]');
    process.exit(2);
  }
  sayTest(sentence, { redact, port, then }).then(() => process.exit(0), (e) => { console.error(`say-test failed: ${e.message}`); process.exit(1); });
}
