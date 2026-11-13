import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '../server/config.mjs';
import { createAsr, pcmToWav } from '../server/audio/asr.mjs';

const LOCAL = 'http://127.0.0.1:8089';
const pcm = Int16Array.from({ length: 1600 }, (_, i) => (i % 50) * 100);

function config(backup = {}) {
  const c = defaults();
  Object.assign(c.asr.backup, backup);
  return c;
}

// Fake fetch: records calls, answers per URL prefix.
function fakeFetch(handlers) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    const h = Object.entries(handlers).find(([prefix]) => String(url).startsWith(prefix));
    if (!h) throw new Error(`unexpected host ${url}`);
    return h[1](init);
  };
  impl.calls = calls;
  return impl;
}
const ok = (text) => () => new Response(JSON.stringify({ text }), { status: 200 });
const down = () => { throw new TypeError('fetch failed'); };

test('pcmToWav writes a 16 kHz mono 16-bit header in memory', () => {
  const wav = pcmToWav(pcm);
  assert.equal(wav.length, 44 + pcm.length * 2);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), 36 + pcm.length * 2);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length * 2);
  assert.equal(wav.readInt16LE(44 + 2 * 3), pcm[3]);
});

test('local ok → via local, with a WAV file and model in the multipart body', async () => {
  const fetchImpl = fakeFetch({ [LOCAL]: ok('  hi there ') });
  const asr = createAsr(config(), { fetchImpl, env: {} });
  assert.deepEqual(await asr.transcribe(pcm), { text: 'hi there', via: 'local' });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, `${LOCAL}/v1/audio/transcriptions`);
  assert.equal(init.method, 'POST');
  assert.ok(init.body instanceof FormData);
  assert.equal(init.body.get('model'), 'qwen3-asr');
  const file = init.body.get('file');
  const bytes = Buffer.from(await file.arrayBuffer());
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.length, 44 + pcm.length * 2);
  assert.equal(init.headers?.Authorization, undefined);
  assert.ok(init.signal instanceof AbortSignal);
});

test('empty or whitespace transcription resolves with text ""', async () => {
  for (const t of ['', '   \n']) {
    const asr = createAsr(config(), { fetchImpl: fakeFetch({ [LOCAL]: ok(t) }), env: {} });
    assert.deepEqual(await asr.transcribe(pcm), { text: '', via: 'local' });
  }
});

test('local down, backup disabled → rejects; no request made to any other host', async () => {
  const fetchImpl = fakeFetch({ [LOCAL]: down, 'https://backup.example': ok('leaked') });
  // backup details are filled in but enabled is false: still must not be used
  const cfg = config({ enabled: false, url: 'https://backup.example', model: 'm', keyEnv: 'K' });
  const asr = createAsr(cfg, { fetchImpl, env: { K: 'secret' } });
  await assert.rejects(asr.transcribe(pcm), /fetch failed/);
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [`${LOCAL}/v1/audio/transcriptions`]);
});

test('local HTTP error with backup disabled rejects and stays local', async () => {
  const fetchImpl = fakeFetch({ [LOCAL]: () => new Response('boom', { status: 500 }) });
  const asr = createAsr(config(), { fetchImpl, env: {} });
  await assert.rejects(asr.transcribe(pcm), /500/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('local down, backup enabled → via backup with bearer header', async () => {
  const seen = {};
  const fetchImpl = fakeFetch({
    [LOCAL]: down,
    'https://backup.example': (init) => { seen.init = init; return new Response(JSON.stringify({ text: 'from backup' })); },
  });
  const cfg = config({ enabled: true, url: 'https://backup.example/', model: 'whisper-x', keyEnv: 'MY_KEY' });
  const asr = createAsr(cfg, { fetchImpl, env: { MY_KEY: 'sk-test' } });
  assert.deepEqual(await asr.transcribe(pcm), { text: 'from backup', via: 'backup' });
  assert.deepEqual(fetchImpl.calls.map((c) => c.url), [
    `${LOCAL}/v1/audio/transcriptions`,
    'https://backup.example/v1/audio/transcriptions',
  ]);
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(seen.init.body.get('model'), 'whisper-x');
});

test('backup enabled but key env var unset → rejects without contacting the backup', async () => {
  const fetchImpl = fakeFetch({ [LOCAL]: down, 'https://backup.example': ok('x') });
  const cfg = config({ enabled: true, url: 'https://backup.example', model: 'm', keyEnv: 'MISSING' });
  const asr = createAsr(cfg, { fetchImpl, env: {} });
  await assert.rejects(asr.transcribe(pcm), /MISSING/);
  assert.equal(fetchImpl.calls.length, 1);
});

test('both fail → rejects', async () => {
  const fetchImpl = fakeFetch({ [LOCAL]: down, 'https://backup.example': () => new Response('no', { status: 401 }) });
  const cfg = config({ enabled: true, url: 'https://backup.example', model: 'm', keyEnv: 'K' });
  const asr = createAsr(cfg, { fetchImpl, env: { K: 'k' } });
  await assert.rejects(asr.transcribe(pcm), /401/);
});
