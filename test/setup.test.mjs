import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSetup } from '../scripts/setup.mjs';

const EXAMPLE = new URL('../config.example.json', import.meta.url).pathname;

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
      fetchImpl: async () => ({ ok: false, status: 404 }), // any answer at all means the speech server is up
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
  assert.equal(statSync(m.args.configPath).mode & 0o777, 0o600);
  assert.match(r.lines.join('\n'), /ok\s+Config created/);
});

test('an existing config is never overwritten', async (t) => {
  const m = machine(t);
  await runSetup(m.args);
  const mine = JSON.stringify({ port: 9999, asr: { url: 'http://127.0.0.1:7777' } });
  writeFileSync(m.args.configPath, mine);
  const seen = [];
  const r = await runSetup({ ...m.args, fetchImpl: async (url) => { seen.push(String(url)); return { ok: true, status: 200 }; } });
  assert.equal(readFileSync(m.args.configPath, 'utf8'), mine);
  assert.match(r.lines.join('\n'), /ok\s+Config found/);
  assert.deepEqual(seen, ['http://127.0.0.1:7777'], 'the speech check uses the address in the config');
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
