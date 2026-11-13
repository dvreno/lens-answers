import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSetup, isOnPath } from '../scripts/setup.mjs';

const EXAMPLE = fileURLToPath(new URL('../config.example.json', import.meta.url));

// A machine where everything is in place; each test takes one thing away.
function machine(t, over = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lens-setup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    args: {
      env: {},
      nodeVersion: '22.4.0',
      configPath: join(dir, 'config', 'config.json'),
      examplePath: EXAMPLE,
      syncSdk: async () => ({ output: '/somewhere/phone/vendor/sdk.js', version: '0.1.0' }),
      onPath: () => true,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ text: '' }) }), // a healthy speech server
      readToken: () => 'TOKEN-FROM-FILE',
      ...over,
    },
  };
}
const todos = (r) => r.lines.filter((l) => l.trimStart().startsWith('todo'));

test('on a machine with everything in place setup is ready and has nothing left to do', async (t) => {
  const m = machine(t);
  const r = await runSetup(m.args);
  assert.equal(r.ready, true, r.lines.join('\n'));
  assert.deepEqual(todos(r), []);
  assert.match(r.lines.join('\n'), /ok\s+Node 22\.4\.0/);
  assert.match(r.lines.join('\n'), /ok\s+MemoMind Web SDK 0\.1\.0/);
  assert.match(r.lines.join('\n'), /npm start/);
});

test('a missing config is created from the example, readable by the owner only', async (t) => {
  const m = machine(t);
  const r = await runSetup(m.args);
  assert.deepEqual(JSON.parse(readFileSync(m.args.configPath, 'utf8')), JSON.parse(readFileSync(EXAMPLE, 'utf8')));
  if (process.platform !== 'win32') assert.equal(statSync(m.args.configPath).mode & 0o777, 0o600); // Windows has no such modes
  assert.match(r.lines.join('\n'), /ok\s+Config created/);
});

test('an existing config is never overwritten', async (t) => {
  const m = machine(t);
  await runSetup(m.args);
  const mine = JSON.stringify({ port: 9999, asr: { url: 'http://127.0.0.1:7777' } });
  writeFileSync(m.args.configPath, mine);
  const seen = [];
  const r = await runSetup({ ...m.args, fetchImpl: async (url) => { seen.push(String(url)); return { ok: true, status: 200, json: async () => ({ text: '' }) }; } });
  assert.equal(readFileSync(m.args.configPath, 'utf8'), mine);
  assert.match(r.lines.join('\n'), /ok\s+Config found/);
  assert.deepEqual(seen, ['http://127.0.0.1:7777/v1/audio/transcriptions'], 'the speech check uses the address in the config');
});

test('each missing piece is one todo line, and setup never throws', async (t) => {
  const cases = [
    [{ nodeVersion: '18.19.0' }, /todo\s+Node 18\.19\.0 is too old/],
    [{ syncSdk: async () => { throw new Error('PhoneSDK not found at /x\nClone it'); } }, /todo\s+MemoMind Web SDK/],
    [{ onPath: (name) => name !== 'claude' }, /todo\s+Model back end: claude-code needs the `claude` command/],
    [{ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } }, /todo\s+Speech-to-text: nothing answers at http:\/\/127\.0\.0\.1:8089/],
  ];
  for (const [over, expected] of cases) {
    const r = await runSetup(machine(t, over).args);
    assert.equal(r.ready, false, String(expected));
    assert.equal(todos(r).length, 1, r.lines.join('\n'));
    assert.match(todos(r)[0], expected);
  }
});

test('the anthropic-api back end needs its key in the environment, and the key is never printed', async (t) => {
  const m = machine(t, { env: { LENS_LLM_BACKEND: 'anthropic-api' }, onPath: () => false });
  let r = await runSetup(m.args);
  assert.match(todos(r).join('\n'), /Model back end: anthropic-api needs ANTHROPIC_API_KEY/);
  r = await runSetup({ ...m.args, env: { LENS_LLM_BACKEND: 'anthropic-api', ANTHROPIC_API_KEY: 'sk-SECRET-VALUE' } });
  assert.deepEqual(todos(r).filter((l) => /Model back end/.test(l)), []);
  assert.doesNotMatch(r.lines.join('\n'), /SECRET-VALUE/);
});

test('a config that is not valid JSON is reported, not replaced', async (t) => {
  const m = machine(t);
  await runSetup(m.args);
  writeFileSync(m.args.configPath, '{ not json');
  const r = await runSetup(m.args);
  assert.equal(r.ready, false);
  assert.match(todos(r).join('\n'), /Config .* is not valid JSON/);
  assert.equal(readFileSync(m.args.configPath, 'utf8'), '{ not json');
});

test('the notes source and Tailscale are notes, never todos', async (t) => {
  const r = await runSetup(machine(t, { onPath: (name) => name !== 'tailscale' }).args);
  assert.equal(r.ready, true);
  assert.match(r.lines.join('\n'), /note\s+Notes source: none/);
  assert.match(r.lines.join('\n'), /note\s+Tailscale not found/);
  assert.ok(!existsSync(join(tmpdir(), 'never-created')));
});

test('a config that cannot be created is one todo line, not a crash', async (t) => {
  const m = machine(t);
  const blocker = join(m.dir, 'config');
  writeFileSync(blocker, 'a file where the config folder should be');
  const r = await runSetup(m.args);
  assert.equal(r.ready, false);
  assert.match(todos(r).join('\n'), /todo\s+Config could not be created at/);
});

test('isOnPath finds a program on the PATH, and on Windows tries the usual program extensions', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lens-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'plainprog'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(dir, 'winprog.CMD'), '@echo off\r\n', { mode: 0o755 });
  const env = { PATH: dir, PATHEXT: '.COM;.EXE;.CMD' };
  assert.equal(isOnPath('plainprog', env, 'linux'), true);
  assert.equal(isOnPath('nosuchprog', env, 'linux'), false);
  assert.equal(isOnPath('winprog', env, 'linux'), false, 'extensions are a Windows rule only');
  assert.equal(isOnPath('winprog', env, 'win32'), true);
  assert.equal(isOnPath('nosuchprog', env, 'win32'), false);
});

// ---- the speech check sends a short test clip --------------------------------------------------------------

test('the speech check posts a WAV clip with the configured model and wants JSON text back', async (t) => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => ({ text: 'hm' }) }; };
  const r = await runSetup(machine(t, { fetchImpl }).args);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body.get('model'), 'qwen3-asr');
  assert.equal(calls[0].opts.body.get('file').type, 'audio/wav');
  assert.match(r.lines.join('\n'), /ok\s+Speech-to-text: http:\/\/127\.0\.0\.1:8089 transcribed a test clip \(model qwen3-asr\)/);
});

test('a speech server that answers but refuses the clip is a todo naming the status and the model', async (t) => {
  const r = await runSetup(machine(t, { fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) }).args);
  assert.equal(r.ready, false);
  assert.match(todos(r).join('\n'), /Speech-to-text: http:\/\/127\.0\.0\.1:8089 answered with status 404\. Check asr\.model \("qwen3-asr"\)/);
});

// ---- the guided run: questions are asked only when `ask` is given -----------------------------------------

// Answers by the first words of each question; anything unexpected fails the test.
function answers(map) {
  const asked = [];
  const ask = async (question) => {
    asked.push(question);
    const hit = Object.keys(map).find((k) => question.includes(k));
    if (hit === undefined) throw new Error(`unexpected question: ${question}`);
    return map[hit];
  };
  ask.asked = asked;
  return ask;
}
const QUIET = { 'Send one test question': 'n', 'Copy the plugin': 'n', 'Show the token': 'n', 'How will it reach Claude': '' };

test('without `ask` nothing is fetched, tested, copied or shown, and no token is read', async (t) => {
  const never = (name) => () => { throw new Error(`${name} must not be called`); };
  const r = await runSetup(machine(t, {
    syncSdk: async () => { throw new Error('missing'); },
    fetchSdk: never('fetchSdk'), testModel: never('testModel'), copyPlugin: never('copyPlugin'), readToken: never('readToken'),
  }).args);
  assert.equal(todos(r).length, 1);
  assert.doesNotMatch(r.lines.join('\n'), /TOKEN-FROM-FILE/);
});

test('guided: a missing SDK is fetched when the answer is yes, and setup carries on with it', async (t) => {
  let have = false;
  const fetched = [];
  const m = machine(t, {
    ask: answers({ ...QUIET, 'Fetch it now': 'y' }),
    sdkDir: '/some/place/plugin-open-platform',
    syncSdk: async () => { if (!have) throw new Error('missing'); return { version: '0.1.0' }; },
    fetchSdk: async (dir) => { fetched.push(dir); have = true; },
  });
  const r = await runSetup(m.args);
  assert.deepEqual(fetched, ['/some/place/plugin-open-platform']);
  assert.match(m.args.ask.asked.find((q) => q.includes('Fetch it now')), /github\.com\/memomind-open\/plugin-open-platform/);
  assert.match(r.lines.join('\n'), /ok\s+MemoMind Web SDK 0\.1\.0/);
  assert.equal(r.ready, true, r.lines.join('\n'));
});

test('guided: saying no to fetching the SDK leaves it as a todo; a failed fetch is a todo too', async (t) => {
  const missing = async () => { throw new Error('missing'); };
  let r = await runSetup(machine(t, { ask: answers({ ...QUIET, 'Fetch it now': 'n' }), syncSdk: missing,
    fetchSdk: async () => { throw new Error('must not be called'); } }).args);
  assert.match(todos(r).join('\n'), /MemoMind Web SDK not found/);
  r = await runSetup(machine(t, { ask: answers({ ...QUIET, 'Fetch it now': '' }), syncSdk: missing,
    fetchSdk: async () => { throw new Error('git is not installed'); } }).args);
  assert.match(todos(r).join('\n'), /MemoMind Web SDK could not be fetched/);
});

test('guided: choosing the API key back end is written to the config, keeping everything else in it', async (t) => {
  const m = machine(t, { ask: answers({ ...QUIET, 'How will it reach Claude': '2' }), env: { ANTHROPIC_API_KEY: 'sk-SECRET-VALUE' } });
  await runSetup({ ...m.args, ask: undefined }); // creates the config
  const before = JSON.parse(readFileSync(m.args.configPath, 'utf8'));
  writeFileSync(m.args.configPath, JSON.stringify({ ...before, port: 9911 }));
  const r = await runSetup(m.args);
  const after = JSON.parse(readFileSync(m.args.configPath, 'utf8'));
  assert.equal(after.llm.backend, 'anthropic-api');
  assert.equal(after.port, 9911);
  assert.equal(after.llm.fastModel, before.llm.fastModel);
  if (process.platform !== 'win32') assert.equal(statSync(m.args.configPath).mode & 0o777, 0o600);
  assert.match(r.lines.join('\n'), /ok\s+Model back end: anthropic-api \(ANTHROPIC_API_KEY is set\)/);
  assert.doesNotMatch(r.lines.join('\n') + m.args.ask.asked.join('\n'), /SECRET-VALUE/);
  assert.ok(!m.args.ask.asked.some((q) => /key/i.test(q) && /type|enter|paste/i.test(q)), 'the key itself is never asked for');
});

test('guided: pressing Enter keeps the back end the config already has', async (t) => {
  const m = machine(t, { ask: answers(QUIET) });
  await runSetup(m.args);
  assert.equal(JSON.parse(readFileSync(m.args.configPath, 'utf8')).llm.backend, 'claude-code');
});

test('guided: the test question is sent only on yes, and a failure is a todo with the error class only', async (t) => {
  let sent = 0;
  let r = await runSetup(machine(t, { ask: answers({ ...QUIET, 'Send one test question': 'y' }), testModel: async () => { sent++; return 'ready'; } }).args);
  assert.equal(sent, 1);
  assert.match(r.lines.join('\n'), /ok\s+Claude answered the test question/);
  class LoginError extends Error {}
  r = await runSetup(machine(t, { ask: answers({ ...QUIET, 'Send one test question': '' }),
    testModel: async () => { throw new LoginError('secret detail about the account'); } }).args);
  assert.equal(r.ready, false);
  assert.match(todos(r).join('\n'), /Claude did not answer the test question \(LoginError\)/);
  assert.doesNotMatch(r.lines.join('\n'), /secret detail/);
  r = await runSetup(machine(t, { ask: answers(QUIET), testModel: async () => { throw new Error('must not be called'); } }).args);
  assert.equal(r.ready, true);
});

test('guided: when no speech server answers, an address typed in is saved and checked', async (t) => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(String(url));
    if (String(url).startsWith('http://127.0.0.1:8089')) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => ({ text: '' }) };
  };
  const m = machine(t, { ask: answers({ ...QUIET, 'another address': 'http://127.0.0.1:9000/' }), fetchImpl });
  const r = await runSetup(m.args);
  assert.deepEqual(seen, ['http://127.0.0.1:8089/v1/audio/transcriptions', 'http://127.0.0.1:9000/v1/audio/transcriptions']);
  assert.equal(JSON.parse(readFileSync(m.args.configPath, 'utf8')).asr.url, 'http://127.0.0.1:9000');
  assert.match(r.lines.join('\n'), /ok\s+Speech-to-text: http:\/\/127\.0\.0\.1:9000 transcribed a test clip/);
  const skip = await runSetup(machine(t, { ask: answers({ ...QUIET, 'another address': '' }), fetchImpl }).args);
  assert.match(todos(skip).join('\n'), /Speech-to-text: nothing answers at http:\/\/127\.0\.0\.1:8089/);
});

test('guided: the plugin is copied into the SDK examples folder on yes', async (t) => {
  const copies = [];
  const m = machine(t, { ask: answers({ ...QUIET, 'Copy the plugin': 'y' }), sdkDir: join('some', 'sdk'),
    copyPlugin: (from, to) => copies.push({ from, to }) });
  const r = await runSetup(m.args);
  assert.equal(copies.length, 1);
  assert.ok(copies[0].from.endsWith('phone'), copies[0].from);
  assert.equal(copies[0].to, join('some', 'sdk', 'PhoneSDK', 'examples', 'lens-answers'));
  assert.match(r.lines.join('\n'), /ok\s+Plugin copied to/);
});

test('guided: the token is shown only when asked for, and the closing lines give the address to type', async (t) => {
  let r = await runSetup(machine(t, { ask: answers({ ...QUIET, 'Show the token': 'y' }) }).args);
  assert.match(r.lines.join('\n'), /Token:\s+TOKEN-FROM-FILE/);
  assert.match(r.lines.join('\n'), /Address:\s+127\.0\.0\.1:8790/);
  r = await runSetup(machine(t, { ask: answers({ ...QUIET, 'Show the token': '' }) }).args);
  assert.doesNotMatch(r.lines.join('\n'), /TOKEN-FROM-FILE/);
  assert.match(r.lines.join('\n'), /Token:\s+in the file /);
});

test('every line is also handed to `print` as it is written', async (t) => {
  const printed = [];
  const r = await runSetup(machine(t, { print: (line) => printed.push(line) }).args);
  assert.deepEqual(printed, r.lines);
});
