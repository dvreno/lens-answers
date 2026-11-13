import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { startServer } from '../server/server.mjs';
import { defaults } from '../server/config.mjs';
import { encodeChunk } from '../phone/lib/wire.js';
import { oggPackets } from './helpers/ogg-packets.mjs';
import { fixtureOgg } from './fixtures/make-fixtures.mjs';

const LOUD = Uint8Array.of(1);
const QUIET = Uint8Array.of(0);

function chunk(frames) {
  const data = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) { data.set(f, o); o += f.length; }
  return encodeChunk(frames.map((f) => f.length), data);
}
// 30 loud frames (600 ms) then 55 quiet (1100 ms, past the 1000 ms default wait): one utterance of 30 * 320 samples.
const speech = () => chunk([...Array(30).fill(LOUD), ...Array(55).fill(QUIET)]);
const UTTERANCE_SAMPLES = 30 * 320;

async function waitFor(cond, what = 'condition', ms = 3000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeDecoder(log) {
  return async () => {
    const d = { freed: 0, decoded: 0 };
    log.push(d);
    return {
      decode(frame) { d.decoded++; return new Int16Array(320).fill(frame[0] === 1 ? 8000 : 0); },
      free() { d.freed++; },
    };
  };
}

// Starts a server with a fake for every dependency. Cleans up after the test.
async function harness(t, { config = {}, deps = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lens-server-test-'));
  const h = { dir, decoders: [], asrCalls: [], kbClosed: 0, logs: [], clients: [], answers: [], deepAnswers: [] };
  // kb.root points into the temporary folder and the bridge is a fake: no test may read anyone's real notes.
  const cfg = { ...defaults(), port: 0, tokenFile: join(dir, 'token'), kb: { root: join(dir, 'kb'), command: ['fake-bridge'], env: {}, timeoutMs: 4000 }, ...config };
  h.config = cfg;
  const fakeDeps = {
    createOpusDecoder: fakeDecoder(h.decoders),
    createAsr: () => ({ async transcribe(pcm) { h.asrCalls.push(pcm); return { text: `heard utterance ${h.asrCalls.length}`, via: 'local' }; } }),
    createUnderstand: () => async (heard) => ({ kind: 'question', route: 'general', query: heard }),
    createKb: () => ({ async search() { return { passages: [], mode: 'none' }; }, close() { h.kbClosed++; } }),
    createStatutes: () => ({ async lookup() { return { passages: [] }; } }),
    createProjects: () => ({ async lookup() { return { passages: [] }; } }),
    createLlm: () => ({ async complete() { return { text: '', sources: [] }; } }),
    writeAnswer: async ({ heard }) => {
      h.answers.push(heard);
      return { heard: `They ask: ${heard}`, source: 'General knowledge', answer: 'An answer', solid: true, ttlMs: 7000 };
    },
    briefsAreStale: () => false,
    buildBriefs: async () => [],
    loadContextPack: () => '',
    createWorkAnswerer: () => async ({ heard }) => {
      h.deepAnswers.push(heard);
      return { card: { heard: `They ask: ${heard}`, source: 'KB · Deep', answer: 'A deep answer', solid: true, ttlMs: 7000 },
        passages: [], paths: [], cited: '', rounds: 1 };
    },
    log: (l) => h.logs.push(String(l)),
    ...deps,
  };
  h.server = await startServer(cfg, fakeDeps);
  h.token = () => readFileSync(cfg.tokenFile, 'utf8').trim();
  h.connect = async ({ hello = true, token } = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/ws`);
    const c = { ws, msgs: [], closeCode: null };
    ws.on('message', (data, isBinary) => { if (!isBinary) c.msgs.push(JSON.parse(data.toString())); });
    ws.on('close', (code) => { c.closeCode = code; });
    ws.on('error', () => {});
    await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
    c.sendJson = (m) => ws.send(JSON.stringify(m));
    c.sendBin = (b) => ws.send(b);
    c.types = () => c.msgs.map((m) => (m.type === 'state' ? `state:${m.state}` : m.type));
    c.closed = () => waitFor(() => c.closeCode !== null, 'socket close');
    h.clients.push(c);
    if (hello) {
      c.sendJson({ type: 'hello', token: token ?? h.token() });
      await waitFor(() => c.msgs.length >= 1, 'hello state');
    }
    return c;
  };
  t.after(async () => {
    for (const c of h.clients) c.ws.terminate();
    await h.server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

const get = (port, path) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  });
  req.on('error', reject);
  req.end();
});

test('GET /health answers ok; other paths are 404', async (t) => {
  const h = await harness(t);
  const r = await get(h.server.port, '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.equal((await get(h.server.port, '/nope')).status, 404);
});

test('token file is created with mode 600 and 32 random bytes of hex, then reused', async (t) => {
  const h = await harness(t);
  const token = h.token();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(statSync(h.config.tokenFile).mode & 0o777, 0o600);
  const again = await startServer(h.config, {
    createOpusDecoder: fakeDecoder([]), createAsr: () => ({}), createUnderstand: () => async () => ({ kind: 'none' }),
    createKb: () => ({ close() {} }), createStatutes: () => ({}), createProjects: () => ({}), createLlm: () => ({}),
    writeAnswer: async () => ({}), briefsAreStale: () => false, buildBriefs: async () => [], log: () => {},
    loadContextPack: () => '', createWorkAnswerer: () => async () => ({}),
  });
  await again.close();
  assert.equal(h.token(), token);
});

test('an existing token file is honoured', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lens-server-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'token'), 'preset-token\n', { mode: 0o600 });
  const h = await harness(t, { config: { tokenFile: join(dir, 'token') } });
  const c = await h.connect({ token: 'preset-token' });
  assert.equal(c.msgs[0].type, 'state');
});

test('valid hello → listening state', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  assert.deepEqual(c.msgs, [{ type: 'state', state: 'listening', asr: 'local', mode: 'auto' }]);
  assert.equal(c.closeCode, null);
});

test('bad token → socket closed 4401', async (t) => {
  const h = await harness(t);
  const c = await h.connect({ hello: false });
  c.sendJson({ type: 'hello', token: 'not-the-token' });
  await c.closed();
  assert.equal(c.closeCode, 4401);
  assert.deepEqual(c.msgs, []);
});

test('a token of the wrong length or type is refused', async (t) => {
  const h = await harness(t);
  for (const token of ['', 'x', h.token().slice(1), h.token() + 'a', 12345, null]) {
    const c = await h.connect({ hello: false });
    c.sendJson({ type: 'hello', token });
    await c.closed();
    assert.equal(c.closeCode, 4401, `token ${JSON.stringify(token)}`);
  }
});

test('anything before a valid hello closes with 4401', async (t) => {
  const h = await harness(t);
  for (const send of [(c) => c.sendBin(speech()), (c) => c.sendJson({ type: 'pause' }), (c) => c.ws.send('not json')]) {
    const c = await h.connect({ hello: false });
    send(c);
    await c.closed();
    assert.equal(c.closeCode, 4401);
  }
  assert.equal(h.asrCalls.length, 0);
});

test('no hello within the deadline → closed 4401', async (t) => {
  const h = await harness(t, { deps: { helloTimeoutMs: 40 } });
  const c = await h.connect({ hello: false });
  await c.closed();
  assert.equal(c.closeCode, 4401);
});

test('websocket upgrades on other paths are refused', async (t) => {
  const h = await harness(t);
  const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/other`);
  ws.on('error', () => {});
  const code = await new Promise((res) => { ws.once('unexpected-response', (_q, r) => res(r.statusCode)); ws.once('open', () => res('open')); });
  assert.equal(code, 404);
});

test('question → thinking, card, listening over the socket; asr receives the utterance', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendBin(speech());
  await waitFor(() => c.msgs.length >= 4, 'card flow');
  assert.deepEqual(c.types(), ['state:listening', 'state:thinking', 'card', 'state:listening']);
  assert.equal(c.msgs[2].id, 1);
  assert.equal(c.msgs[2].answer, 'An answer');
  assert.equal(h.asrCalls.length, 1);
  assert.equal(h.asrCalls[0].length, UTTERANCE_SAMPLES);
  assert.deepEqual(h.answers, ['heard utterance 1']);
});

test('audio while paused is discarded (asr never called, nothing decoded)', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendJson({ type: 'pause' });
  await waitFor(() => c.msgs.length >= 2, 'paused state');
  assert.deepEqual(c.msgs[1], { type: 'state', state: 'paused', asr: 'local', mode: 'auto' });
  c.sendBin(speech());
  c.sendJson({ type: 'resume' });
  await waitFor(() => c.msgs.length >= 3, 'resume state');
  assert.deepEqual(c.msgs[2], { type: 'state', state: 'listening', asr: 'local', mode: 'auto' });
  assert.equal(h.decoders[0].decoded, 0, 'paused audio must not be decoded');
  c.sendBin(speech());
  await waitFor(() => h.asrCalls.length >= 1, 'asr call after resume');
  await waitFor(() => c.types().includes('card'), 'card after resume');
  assert.equal(h.asrCalls.length, 1);
  assert.equal(h.decoders[0].decoded, 85);
});

test('pause resets the segmenter: half an utterance before pause does not join audio after resume', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendBin(chunk(Array(20).fill(LOUD))); // 400 ms of speech, no end yet
  c.sendJson({ type: 'pause' });
  c.sendJson({ type: 'resume' });
  c.sendBin(speech());
  await waitFor(() => h.asrCalls.length >= 1, 'asr call');
  assert.equal(h.asrCalls[0].length, UTTERANCE_SAMPLES);
});

test('call on with callMode false pauses; call off resumes', async (t) => {
  const h = await harness(t, { config: { callMode: false } });
  const c = await h.connect();
  c.sendJson({ type: 'call', on: true });
  await waitFor(() => c.msgs.length >= 2, 'paused state');
  assert.equal(c.msgs[1].state, 'paused');
  c.sendBin(speech());
  c.sendJson({ type: 'call', on: false });
  await waitFor(() => c.msgs.length >= 3, 'listening state');
  assert.equal(c.msgs[2].state, 'listening');
  assert.equal(h.decoders[0].decoded, 0);
});

test('call on with callMode true keeps listening', async (t) => {
  const h = await harness(t, { config: { callMode: true } });
  const c = await h.connect();
  c.sendJson({ type: 'call', on: true });
  c.sendBin(speech());
  await waitFor(() => c.types().includes('card'), 'card while on a call');
  assert.ok(!c.types().includes('state:paused'));
  assert.equal(h.asrCalls.length, 1);
});

test('a spoken pause intent pauses the server too', async (t) => {
  const h = await harness(t, { deps: { createUnderstand: () => async () => ({ kind: 'pause' }) } });
  const c = await h.connect();
  c.sendBin(speech());
  await waitFor(() => c.types().includes('state:paused'), 'paused state');
  const decoded = h.decoders[0].decoded;
  c.sendBin(speech());
  c.sendJson({ type: 'resume' });
  await waitFor(() => c.types().at(-1) === 'state:listening', 'resume');
  assert.equal(h.decoders[0].decoded, decoded, 'audio after a spoken pause is discarded');
  assert.equal(h.asrCalls.length, 1);
});

test('a spoken pause discards an utterance still in asr: the lens never goes back to listening', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const h = await harness(t, {
    deps: {
      createAsr: () => ({
        async transcribe() {
          const n = ++calls;
          if (n === 1) { await gate; return { text: 'a late question', via: 'local' }; }
          return { text: n === 2 ? 'pause please now' : 'after the resume', via: 'local' };
        },
      }),
      createUnderstand: () => async (heard) => (heard === 'pause please now' ? { kind: 'pause' } : { kind: 'question', route: 'general', query: heard }),
    },
  });
  const c = await h.connect();
  c.sendBin(speech());
  await waitFor(() => calls === 1, 'first asr call');
  c.sendBin(speech());
  await waitFor(() => c.types().includes('state:paused'), 'paused state');
  release();
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(c.types(), ['state:listening', 'state:paused']);
  c.sendJson({ type: 'resume' });
  c.sendBin(speech());
  await waitFor(() => c.types().includes('card'), 'card after resume');
  assert.deepEqual(c.types(), ['state:listening', 'state:paused', 'state:listening', 'state:thinking', 'card', 'state:listening']);
});

test('a new client replaces the old one; an unauthenticated socket cannot', async (t) => {
  const h = await harness(t);
  const first = await h.connect();
  const stranger = await h.connect({ hello: false });
  stranger.sendJson({ type: 'hello', token: 'wrong' });
  await stranger.closed();
  assert.equal(first.closeCode, null, 'a failed hello must not kick the connected client');

  const second = await h.connect();
  await first.closed();
  assert.equal(first.closeCode, 4409);
  await waitFor(() => h.decoders[0].freed === 1, 'old decoder freed');
  second.sendBin(speech());
  await waitFor(() => second.types().includes('card'), 'card on new client');
  assert.ok(!first.types().includes('card'));
});

test('replacing a client whose peer never answers the close frame frees its resources promptly', async (t) => {
  const h = await harness(t);
  const first = await h.connect();
  first.ws._socket.pause(); // a dead peer: the close frame is never read or answered
  first.sendBin(chunk(Array(20).fill(LOUD)));
  await waitFor(() => h.decoders[0].decoded === 20, 'frames decoded');
  const second = await h.connect();
  await waitFor(() => h.decoders[0].freed === 1, 'old decoder freed without waiting for the handshake');
  assert.equal(first.closeCode, null, 'the old socket has not finished closing');
  second.sendBin(speech());
  await waitFor(() => second.types().includes('card'), 'card on new client');
  assert.equal(h.asrCalls[0].length, UTTERANCE_SAMPLES);
});

test('a malformed chunk is ignored and counted; the connection keeps working', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendBin(Uint8Array.of(5, 0, 1)); // header claims 5 frames
  c.sendBin(Uint8Array.of(9)); // too short
  c.sendBin(speech());
  await waitFor(() => c.types().includes('card'), 'card after bad chunks');
  assert.equal(c.closeCode, null);
  assert.equal(h.server.stats().badChunks, 2);
});

test('a frame the decoder cannot handle is skipped, not fatal', async (t) => {
  let n = 0;
  const h = await harness(t, {
    deps: {
      createOpusDecoder: async () => ({
        decode(frame) { if (++n === 3) throw new Error('corrupt'); return new Int16Array(320).fill(frame[0] === 1 ? 8000 : 0); },
        free() {},
      }),
    },
  });
  const c = await h.connect();
  c.sendBin(speech());
  await waitFor(() => c.types().includes('card'), 'card despite a bad frame');
  assert.equal(c.closeCode, null);
});

test('messages over 64 KiB are refused', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendBin(new Uint8Array(64 * 1024 + 1));
  await c.closed();
  assert.equal(c.closeCode, 1009);
});

test('client disconnect mid-utterance frees the decoder and drops the partial audio', async (t) => {
  const h = await harness(t);
  const a = await h.connect();
  a.sendBin(chunk(Array(30).fill(LOUD))); // speech, never finished
  await waitFor(() => h.decoders[0].decoded === 30, 'frames decoded');
  a.ws.close();
  await waitFor(() => h.decoders[0].freed === 1, 'decoder freed');
  const b = await h.connect();
  b.sendBin(chunk(Array(40).fill(QUIET))); // would finish a leftover utterance if audio had been kept
  b.sendBin(speech());
  await waitFor(() => b.types().includes('card'), 'card on second connection');
  assert.equal(h.asrCalls.length, 1);
  // The new connection's speech plus its own 300 ms look-back (15 quiet frames), nothing of the old one's.
  assert.equal(h.asrCalls[0].length, UTTERANCE_SAMPLES + 15 * 320, 'only the new connection\'s audio was transcribed');
  assert.ok(h.asrCalls[0].subarray(0, 15 * 320).every((v) => v === 0), 'the look-back is the new connection\'s quiet audio');
  assert.equal(h.decoders[0].freed, 1, 'freed exactly once');
});

test('results still in flight when the client leaves are discarded', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const h = await harness(t, {
    deps: {
      createAsr: () => ({ async transcribe() { await gate; return { text: 'some late words', via: 'local' }; } }),
    },
  });
  const a = await h.connect();
  a.sendBin(speech());
  a.ws.close();
  await waitFor(() => h.decoders[0].freed === 1, 'decoder freed');
  release();
  const b = await h.connect();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(b.types(), ['state:listening']);
  assert.deepEqual(h.answers, []);
});

test('stale briefs are rebuilt on start; a rebuild failure does not stop the server', async (t) => {
  let built = 0;
  const h = await harness(t, {
    deps: {
      briefsAreStale: () => true,
      buildBriefs: async () => { built++; throw new Error('model down with secret detail'); },
    },
  });
  assert.equal(built, 1);
  assert.equal((await get(h.server.port, '/health')).status, 200);
  await waitFor(() => h.logs.some((l) => /brief.*failed/.test(l)), 'a brief failure log line');
  const lines = h.logs.filter((l) => /brief.*failed/.test(l));
  assert.equal(lines.length, 1);
  assert.ok(!/secret/.test(lines[0]));
});

test('the brief rebuild never delays startup and is skipped when briefs are fresh', async (t) => {
  let started = 0;
  const h = await harness(t, {
    deps: { briefsAreStale: () => true, buildBriefs: () => { started++; return new Promise(() => {}); } },
  });
  assert.equal(started, 1); // startServer already resolved even though the rebuild never finishes
  assert.equal((await get(h.server.port, '/health')).status, 200);

  let fresh = 0;
  await harness(t, { deps: { briefsAreStale: () => false, buildBriefs: async () => { fresh++; return []; } } });
  assert.equal(fresh, 0);
});

test('real audio path: fixture ogg packets sent as wire chunks reach asr as one utterance', async (t) => {
  const packets = oggPackets(await fixtureOgg('library'));
  // The segmenter's max cut ends the utterance deterministically: 50 frames (1 s).
  const h = await harness(t, {
    config: { vad: { silenceMs: 700, minSpeechMs: 400, maxUtteranceMs: 1000 } },
    deps: { createOpusDecoder: undefined },
  });
  assert.ok(packets.length >= 80, `fixture too short: ${packets.length} packets`);
  const c = await h.connect();
  for (let i = 0; i < 80; i += 4) c.sendBin(chunk(packets.slice(i, i + 4)));
  await waitFor(() => h.asrCalls.length >= 1, 'asr call');
  await waitFor(() => c.types().includes('card'), 'card');
  assert.equal(h.asrCalls.length, 1);
  assert.equal(h.asrCalls[0].length, 16000);
  assert.ok(h.asrCalls[0] instanceof Int16Array);
  let peak = 0;
  for (const s of h.asrCalls[0]) peak = Math.max(peak, Math.abs(s));
  assert.ok(peak > 1000, `decoded speech too quiet: ${peak}`);
});

test('close() closes the clients, the kb bridge and the port', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  await h.server.close();
  await c.closed();
  assert.equal(h.kbClosed, 1);
  assert.equal(h.decoders[0].freed, 1);
  await assert.rejects(get(h.server.port, '/health'));
});

test('logs never contain what was said, asked or answered', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendBin(speech());
  await waitFor(() => c.types().includes('card'), 'card');
  for (const l of h.logs) assert.ok(!/heard \d|An answer/.test(l), l);
});

test('feedPcm (local test hook) runs PCM through segmenter and pipeline; the lens gets thinking, card, listening', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  // 600 ms of loud audio, then 1100 ms quiet, in one array: the hook frames it like the real path does.
  const pcm = new Int16Array(85 * 320);
  pcm.fill(8000, 0, 30 * 320);
  assert.equal(h.server.feedPcm(pcm), true);
  await waitFor(() => c.msgs.some((m) => m.type === 'card'), 'card');
  assert.equal(h.asrCalls.length, 1);
  assert.equal(h.asrCalls[0].length, 30 * 320, 'the utterance is exactly the speech part');
  await waitFor(() => c.types().join() === 'state:listening,state:thinking,card,state:listening', 'state order');
  assert.equal(h.decoders[0].decoded, 0, 'the Opus decoder is skipped');
});

test('feedPcm does nothing without a client or while paused', async (t) => {
  const h = await harness(t);
  const loud = new Int16Array(70 * 320).fill(8000);
  assert.equal(h.server.feedPcm(loud), false, 'no client connected');
  assert.equal(h.asrCalls.length, 0);
  const c = await h.connect();
  c.sendJson({ type: 'pause' });
  await waitFor(() => c.types().includes('state:paused'), 'paused');
  assert.equal(h.server.feedPcm(loud), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.asrCalls.length, 0, 'paused audio is discarded');
});

test('no socket message reaches the feedPcm hook', async (t) => {
  const h = await harness(t);
  const c = await h.connect(); // listening, not paused
  // 20 loud frames (400 ms) then 51 quiet (1020 ms): a complete utterance if it ever reached the segmenter.
  // Kept under the 64 KiB socket limit as base64 so the message is delivered, not refused.
  const pcm = new Int16Array(71 * 320);
  pcm.fill(8000, 0, 20 * 320);
  const b64 = Buffer.from(pcm.buffer).toString('base64');
  for (const type of ['feedPcm', 'feed', 'pcm']) c.sendJson({ type, pcm: b64 });
  c.sendJson({ type: 'ping' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(h.asrCalls.length, 0, 'a socket client cannot inject audio through the hook');
  assert.equal(c.closeCode, null, 'the message was delivered, not refused: the connection is still open');
});

test('the KB bridge is warmed in the background at start, with the server log passed to createKb', async (t) => {
  let warmed = 0;
  let kbDeps = null;
  const h = await harness(t, {
    deps: {
      createKb: (config, deps) => {
        kbDeps = deps;
        return { async search() { return { passages: [] }; }, warm() { warmed++; return new Promise(() => {}); }, close() {} };
      },
    },
  });
  assert.equal(warmed, 1, 'warm started; startServer resolved although warm never finishes');
  assert.equal(typeof kbDeps?.log, 'function');
  kbDeps.log('kb-timeout');
  assert.ok(h.logs.includes('kb-timeout'));
  assert.equal((await get(h.server.port, '/health')).status, 200);
});

test('a failed KB warm-up is logged as one line and does not stop the server', async (t) => {
  for (const warm of [async () => false, async () => { throw new Error('secret detail'); }]) {
    const h = await harness(t, { deps: { createKb: () => ({ async search() { return { passages: [] }; }, warm, close() {} }) } });
    await waitFor(() => h.logs.some((l) => l.startsWith('kb-warm')), 'warm log');
    assert.deepEqual(h.logs.filter((l) => l.startsWith('kb-warm')), ['kb-warm failed']);
    assert.equal((await get(h.server.port, '/health')).status, 200);
  }
});

test('understand gets the server log', async (t) => {
  let got = null;
  await harness(t, { deps: { createUnderstand: (deps) => { got = deps; return async () => ({ kind: 'none' }); } } });
  assert.equal(typeof got?.log, 'function');
  assert.ok(got.llm);
});

test('a decoder that fails to start closes that socket with 1011 and logs one line; the server keeps running', async (t) => {
  let n = 0;
  const h = await harness(t, {
    deps: {
      createOpusDecoder: async () => {
        if (++n === 1) throw new Error('wasm load failed with secret detail');
        return { decode: () => new Int16Array(320), free() {} };
      },
    },
  });
  const c = await h.connect({ hello: false });
  c.sendJson({ type: 'hello', token: h.token() });
  await c.closed();
  assert.equal(c.closeCode, 1011);
  assert.deepEqual(c.msgs, [], 'no listening greeting');
  assert.deepEqual(h.logs.filter((l) => l.startsWith('decoder')), ['decoder-failed']);
  const d = await h.connect();
  assert.deepEqual(d.msgs[0], { type: 'state', state: 'listening', asr: 'local', mode: 'auto' });
  assert.equal((await get(h.server.port, '/health')).status, 200);
});

test('call off does not resume a manual pause; resume does', async (t) => {
  const h = await harness(t, { config: { callMode: false } });
  const c = await h.connect();
  c.sendJson({ type: 'pause' });
  await waitFor(() => c.msgs.length >= 2, 'paused');
  c.sendJson({ type: 'call', on: false });
  c.sendBin(speech());
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(c.types(), ['state:listening', 'state:paused'], 'call off: no state message');
  assert.equal(h.decoders[0].decoded, 0, 'still paused');
  c.sendJson({ type: 'resume' });
  await waitFor(() => c.msgs.length >= 3, 'listening');
  assert.equal(c.msgs[2].state, 'listening');
});

test('call off does not resume a spoken pause; resume does', async (t) => {
  const h = await harness(t, { deps: { createUnderstand: () => async () => ({ kind: 'pause' }) } });
  const c = await h.connect();
  c.sendBin(speech());
  await waitFor(() => c.types().includes('state:paused'), 'paused');
  const before = c.msgs.length;
  c.sendJson({ type: 'call', on: false });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(c.msgs.length, before);
  c.sendJson({ type: 'resume' });
  await waitFor(() => c.types().at(-1) === 'state:listening', 'resumed');
});

test('resume also ends a call pause (the user pressed Resume)', async (t) => {
  const h = await harness(t, { config: { callMode: false } });
  const c = await h.connect();
  c.sendJson({ type: 'call', on: true });
  await waitFor(() => c.types().includes('state:paused'), 'paused');
  c.sendJson({ type: 'resume' });
  await waitFor(() => c.types().at(-1) === 'state:listening', 'resumed');
});

test('resume and call off while not paused do nothing: no state message, no segmenter reset', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendBin(chunk(Array(20).fill(LOUD))); // 400 ms of speech, no end yet
  c.sendJson({ type: 'resume' });
  c.sendJson({ type: 'call', on: false });
  c.sendBin(speech());
  await waitFor(() => h.asrCalls.length >= 1, 'asr call');
  assert.equal(h.asrCalls[0].length, 50 * 320, 'the half utterance was kept');
  assert.equal(c.msgs[1]?.state, 'thinking', 'the first message after the greeting is the question');
});

test('incoming audio is summarised in the log: connection, chunk and frame counts, undecodable frames, peak level', async (t) => {
  let n = 0;
  const h = await harness(t, {
    deps: {
      audioReportMs: 0, // report on every chunk
      createOpusDecoder: async () => ({
        decode(frame) { if (++n === 2) throw new Error('corrupt'); return new Int16Array(320).fill(frame[0] === 1 ? 8000 : 0); },
        free() {},
      }),
    },
  });
  const c = await h.connect();
  await waitFor(() => h.logs.includes('client-connected'), 'connection logged');
  c.sendBin(chunk([LOUD, LOUD, LOUD, QUIET]));
  await waitFor(() => h.logs.some((l) => l.startsWith('audio ')), 'audio line');
  // speech / quiet: how the sentence detector judged the decoded slices; floor: its background level.
  assert.ok(h.logs.some((l) => /^audio chunks=1 frames=4 undecodable=1 peak=8000 speech=2 quiet=1 floor=\d+$/.test(l)), h.logs.join(' | '));
  c.sendBin(chunk([QUIET, QUIET]));
  await waitFor(() => h.logs.some((l) => /^audio chunks=1 frames=2 undecodable=0 peak=0 speech=0 quiet=2 floor=\d+$/.test(l)), 'counts restart after each report');
});

test('the audio summary is written at most once per interval', async (t) => {
  const h = await harness(t, { deps: { audioReportMs: 60_000 } });
  const c = await h.connect();
  for (let i = 0; i < 5; i++) c.sendBin(chunk([QUIET, QUIET]));
  c.sendBin(speech());
  await waitFor(() => c.types().includes('card'), 'card');
  assert.equal(h.logs.filter((l) => l.startsWith('audio ')).length, 1, 'only the first chunk of the interval reports');
});

// ---- work mode ----------------------------------------------------------------------

test('every state message says which mode is on; a new connection starts in automatic mode', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  assert.deepEqual(c.msgs[0], { type: 'state', state: 'listening', asr: 'local', mode: 'auto' });
});

test('mode work: the server confirms, questions go to the deep answerer, and mode auto switches back', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendJson({ type: 'mode', mode: 'work' });
  await waitFor(() => c.msgs.length >= 2, 'mode confirmation');
  assert.deepEqual(c.msgs[1], { type: 'state', state: 'listening', asr: 'local', mode: 'work' });
  assert.ok(h.logs.includes('mode work'), h.logs.join('|'));

  // Work mode waits 1500 ms of quiet: 30 loud frames then 80 quiet ones end the sentence.
  c.sendBin(chunk([...Array(30).fill(LOUD), ...Array(40).fill(QUIET)]));
  c.sendBin(chunk(Array(40).fill(QUIET)));
  await waitFor(() => c.msgs.length >= 5, 'deep card flow');
  assert.deepEqual(c.types().slice(2), ['state:thinking', 'card', 'state:listening']);
  assert.equal(c.msgs[3].source, 'KB · Deep');
  assert.ok(c.msgs.slice(2).filter((m) => m.type === 'state').every((m) => m.mode === 'work'));
  assert.deepEqual(h.deepAnswers, ['heard utterance 1']);
  assert.deepEqual(h.answers, [], 'the quick answer writer was not used');

  c.sendJson({ type: 'mode', mode: 'auto' });
  await waitFor(() => c.msgs.length >= 6, 'mode confirmation');
  assert.equal(c.msgs[5].mode, 'auto');
  c.sendBin(speech());
  await waitFor(() => c.msgs.length >= 9, 'quick card flow');
  assert.equal(c.msgs[7].source, 'General knowledge');
  assert.deepEqual(h.answers, ['heard utterance 2']);
});

test('work mode waits longer for the end of a sentence than automatic mode', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendJson({ type: 'mode', mode: 'work' });
  await waitFor(() => c.msgs.length >= 2, 'mode confirmation');
  c.sendBin(speech()); // 1100 ms of quiet: enough in automatic mode, not in work mode
  c.sendJson({ type: 'mode', mode: 'work' }); // a repeat: answered after the audio before it was handled
  await waitFor(() => c.msgs.length >= 3, 'second confirmation');
  assert.equal(h.asrCalls.length, 0, 'the sentence has not ended yet');
  c.sendBin(chunk(Array(25).fill(QUIET))); // 1600 ms of quiet in all
  await waitFor(() => h.asrCalls.length === 1, 'utterance');
  assert.equal(h.asrCalls[0].length, UTTERANCE_SAMPLES);
});

test('an unknown mode is ignored', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendJson({ type: 'mode', mode: 'turbo' });
  c.sendJson({ type: 'mode' });
  c.sendJson({ type: 'pause' });
  await waitFor(() => c.msgs.length >= 2, 'paused');
  assert.deepEqual(c.msgs.slice(1), [{ type: 'state', state: 'paused', asr: 'local', mode: 'auto' }]);
});

test('switching mode while paused keeps the pause and reports the new mode', async (t) => {
  const h = await harness(t);
  const c = await h.connect();
  c.sendJson({ type: 'pause' });
  c.sendJson({ type: 'mode', mode: 'work' });
  await waitFor(() => c.msgs.length >= 3, 'mode confirmation');
  assert.deepEqual(c.msgs[2], { type: 'state', state: 'paused', asr: 'local', mode: 'work' });
});

test('the context pack is read once at start and handed to the work answerer with the kb, llm, config and log', async (t) => {
  const seen = { pack: [], work: [] };
  const kb = { async search() { return { passages: [] }; }, close() {} };
  const llm = { async complete() { return { text: '', sources: [] }; } };
  const h = await harness(t, { deps: {
    createKb: () => kb, createLlm: () => llm,
    loadContextPack: (config, deps) => { seen.pack.push({ config, deps }); deps.log('context-pack chars=5'); return 'NOTES'; },
    createWorkAnswerer: (args) => { seen.work.push(args); return async () => ({}); },
  } });
  assert.equal(seen.pack.length, 1);
  assert.equal(seen.pack[0].config, h.config);
  assert.equal(seen.work.length, 1);
  assert.equal(seen.work[0].pack, 'NOTES');
  assert.equal(seen.work[0].kb, kb);
  assert.equal(seen.work[0].llm, llm);
  assert.equal(seen.work[0].config, h.config);
  assert.ok(h.logs.includes('context-pack chars=5'));
  await h.connect();
  await h.connect();
  assert.equal(seen.pack.length, 1, 'not read again per connection');
});

test('the log says why each sentence ended: quiet, or the length limit', async (t) => {
  const h = await harness(t, { config: { vad: { silenceMs: 1000, minSpeechMs: 400, maxUtteranceMs: 2000 } } });
  const c = await h.connect();
  c.sendBin(speech());
  await waitFor(() => h.logs.includes(`utterance samples=${UTTERANCE_SAMPLES} end=quiet`), 'quiet end');
  c.sendBin(chunk(Array(110).fill(LOUD))); // no quiet at all: cut at the 2 s limit
  await waitFor(() => h.logs.some((l) => /^utterance samples=\d+ end=max$/.test(l)), 'max end');
});

// ---- no notes source: no work mode, and the classifier is told so ---------------------------------------

const NO_NOTES = { kb: { root: '', command: [], env: {}, timeoutMs: 4000 } };

test('with no notes bridge every state message carries noWork, and a request for work mode is refused', async (t) => {
  const h = await harness(t, { config: NO_NOTES });
  const c = await h.connect();
  assert.deepEqual(c.msgs[0], { type: 'state', state: 'listening', asr: 'local', mode: 'auto', noWork: true });
  c.sendJson({ type: 'mode', mode: 'work' });
  await waitFor(() => c.msgs.length >= 2, 'the refusal');
  assert.deepEqual(c.msgs[1], { type: 'state', state: 'listening', asr: 'local', mode: 'auto', noWork: true });
  assert.ok(h.logs.includes('mode work unavailable'), h.logs.join('|'));
  assert.ok(!h.logs.includes('mode work'));
  c.sendBin(speech());
  await waitFor(() => c.msgs.length >= 5, 'quick card flow');
  assert.equal(c.msgs[3].source, 'General knowledge');
  assert.deepEqual(h.deepAnswers, [], 'the work answerer was never used');
});

test('the classifier is built with the routing worked out from the config', async (t) => {
  let given = null;
  const createUnderstand = (args) => { given = args; return async () => ({ kind: 'none' }); };
  await harness(t, { config: { ...NO_NOTES, projects: [] }, deps: { createUnderstand } });
  assert.deepEqual(given.routing.routes, ['web', 'general']);
  const h = await harness(t, {
    config: { projects: [{ name: 'P', paths: [] }], statutes: { ...defaults().statutes, enabled: true } },
    deps: { createUnderstand },
  });
  assert.deepEqual(given.routing.routes, ['work', 'statute', 'project', 'web', 'general']);
  assert.ok(h.logs.includes('routes work,statute,project,web,general'), h.logs.join('|'));
});

test('a routing pattern that is not a regular expression stops the server from starting', async (t) => {
  // Through the harness, so that every dependency is a fake whether or not the start is refused.
  const routing = { work: { about: '', always: ['(('], lean: [] } };
  await assert.rejects(() => harness(t, { config: { routing } }), /routing\.work\.always\[0\]/);
});
