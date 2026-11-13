import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults as nothingConfigured } from '../server/config.mjs';
import { createKb } from '../server/sources/kb.mjs';
import { writeAnswer } from '../server/answer.mjs';
import { layoutCard } from '../phone/card-layout.js';

const FAKE = fileURLToPath(new URL('./helpers/fake-kb-bridge.mjs', import.meta.url));

// The defaults with a notes bridge configured (the fake spawn below runs the fake bridge whatever it names).
function defaults() {
  const config = nothingConfigured();
  config.kb.command = ['some-bridge', '--some-arg'];
  return config;
}

// spawnImpl that runs the fake bridge in the given mode and records each spawn.
function fakeSpawn(mode, extraEnv = {}) {
  const calls = [];
  const impl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return spawn(process.execPath, [FAKE], {
      ...opts, env: { ...opts.env, FAKE_MODE: mode, ...extraEnv },
    });
  };
  impl.calls = calls;
  return impl;
}

async function withKb(mode, fn, { config = defaults(), env } = {}) {
  const spawnImpl = fakeSpawn(mode, env);
  const kb = createKb(config, { spawnImpl });
  try { await fn(kb, spawnImpl); } finally { kb.close(); }
}

test('maps a current official result to its label', async () => {
  await withKb('current', async (kb) => {
    const r = await kb.search('spare tyre setup');
    assert.equal(r.mode, 'hybrid');
    assert.equal(r.passages.length, 1);
    assert.equal(r.passages[0].label, 'KB · Sample Guide v02, current');
    assert.equal(r.passages[0].text, 'First excerpt.\nSecond excerpt.');
  });
});

test('paths runs parallel to passages with each result source_path; labels and text are unchanged', async () => {
  await withKb('current', async (kb) => {
    const r = await kb.search('q');
    assert.deepEqual(r.paths, ['sample/guide-v02.md']);
    assert.equal(r.paths.length, r.passages.length);
    assert.equal(r.passages[0].label, 'KB · Sample Guide v02, current');
    assert.equal(r.passages[0].text, 'First excerpt.\nSecond excerpt.');
    assert.deepEqual(Object.keys(r.passages[0]).sort(), ['label', 'text']);
  });
  await withKb('none', async (kb) => {
    assert.deepEqual((await kb.search('q')).paths, []);
  });
});

test('keyword_only adds (keyword match)', async () => {
  await withKb('keyword', async (kb) => {
    const r = await kb.search('q');
    assert.equal(r.mode, 'keyword_only');
    assert.equal(r.passages[0].label, 'KB · Sample Guide v02, current (keyword match)');
  });
});

test('superseded status appears in the label', async () => {
  await withKb('superseded', async (kb) => {
    const r = await kb.search('q');
    assert.equal(r.passages[0].label, 'KB · Sample Guide v01, superseded');
  });
});

test('a long title is cut, never the version, status or keyword marker; the label survives the card caps unchanged', async () => {
  await withKb('long-title', async (kb) => {
    const config = defaults();
    const { label } = (await kb.search('q')).passages[0];
    assert.ok(label.length <= config.card.sourceMax, `label is ${label.length} chars`);
    assert.ok(label.startsWith('KB · TTT'), label);
    assert.ok(label.endsWith('… v01, superseded (keyword match)'), label);
    const llm = { async complete() { return { text: '{"answer":"An answer.","source":1}', sources: [] }; } };
    const card = await writeAnswer({ intent: { kind: 'question', route: 'work', query: 'q' }, heard: 'q',
      passages: [{ label, text: 'x' }], llm, card: config.card });
    assert.equal(card.source, label);
    assert.equal(layoutCard(card).source, label);
  });
});

test('a missing version is omitted from the label', async () => {
  await withKb('noversion', async (kb) => {
    const r = await kb.search('q');
    assert.equal(r.passages[0].label, 'KB · Sample Guide, current');
  });
});

test('passage text is capped at 2,400 characters', async () => {
  await withKb('long', async (kb) => {
    const r = await kb.search('q');
    assert.equal(r.passages[0].text.length, 2400);
  });
});

test('mode none from the bridge gives empty passages', async () => {
  await withKb('none', async (kb) => {
    assert.deepEqual(await kb.search('q'), { passages: [], paths: [], mode: 'none' });
  });
});

test('a garbled line from the bridge gives empty passages', async () => {
  await withKb('garbage', async (kb) => {
    assert.deepEqual(await kb.search('q'), { passages: [], paths: [], mode: 'none' });
  });
});

test('bridge silent for 4 s → empty passages, resolves in under 4.5 s', async () => {
  await withKb('silent', async (kb) => {
    const t0 = Date.now();
    const r = await kb.search('q');
    const dt = Date.now() - t0;
    assert.deepEqual(r, { passages: [], paths: [], mode: 'none' });
    assert.ok(dt >= 3900 && dt < 4500, `took ${dt} ms`);
  });
});

test('bridge crash → empty passages, next call respawns', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kb-test-'));
  const flag = join(dir, 'flag');
  try {
    // First child crashes on its first request; later children see the flag file and answer.
    const impl = (cmd, args, opts) => {
      const env = existsSync(flag) ? { FAKE_FLAG: '1' } : { FAKE_FLAG: '' };
      return spawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, FAKE_MODE: 'crash-once', ...env } });
    };
    let spawns = 0;
    const counting = (...a) => { spawns += 1; return impl(...a); };
    const kb = createKb(defaults(), { spawnImpl: counting });
    try {
      assert.deepEqual(await kb.search('q'), { passages: [], paths: [], mode: 'none' });
      writeFileSync(flag, '1');
      const r = await kb.search('q');
      assert.equal(r.mode, 'hybrid');
      assert.equal(r.passages[0].label, 'KB · Sample Guide v02, current');
      assert.equal(spawns, 2);
    } finally { kb.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('overlapping searches are matched to replies by id', async () => {
  await withKb('reverse', async (kb) => {
    const [a, b] = await Promise.all([kb.search('one'), kb.search('two')]);
    assert.equal(a.passages[0].label, 'KB · First Doc v02, current');
    assert.equal(b.passages[0].label, 'KB · Second Doc v02, current');
  });
});

test('one bridge process serves several searches', async () => {
  await withKb('current', async (kb, spawnImpl) => {
    await kb.search('a');
    await kb.search('b');
    assert.equal(spawnImpl.calls.length, 1);
  });
});

test('spawns the configured bridge command with KB_ROOT, the configured env, and this repo as cwd', async () => {
  const config = defaults();
  config.kb.root = '/notes/root';
  config.kb.command = ['/some/python', '/some/bridge.py', '--flag'];
  config.kb.env = { PYTHONPATH: '/notes/root:/notes/root/lib' };
  await withKb('current', async (kb, spawnImpl) => {
    await kb.search('q');
    const { cmd, args, opts } = spawnImpl.calls[0];
    assert.equal(cmd, '/some/python');
    assert.deepEqual(args, ['/some/bridge.py', '--flag']);
    assert.equal(opts.env.KB_ROOT, '/notes/root');
    assert.equal(opts.env.PYTHONDONTWRITEBYTECODE, '1'); // a Python bridge must not leave .pyc files beside the notes
    assert.equal(opts.env.PYTHONPATH, '/notes/root:/notes/root/lib');
    assert.notEqual(opts.cwd, '/notes/root');
    assert.equal(opts.cwd, resolve(fileURLToPath(new URL('..', import.meta.url))));
  }, { config });
});

test('with no bridge configured nothing is ever spawned: search is empty, warm is true, enabled is false', async () => {
  const spawnImpl = fakeSpawn('current');
  const kb = createKb(nothingConfigured(), { spawnImpl });
  assert.equal(kb.enabled, false);
  assert.deepEqual(await kb.search('q'), { passages: [], paths: [], mode: 'none' });
  assert.equal(await kb.warm(), true);
  assert.equal(spawnImpl.calls.length, 0);
  kb.close();
  assert.equal(createKb(defaults(), { spawnImpl }).enabled, true);
});

test('search after close resolves empty and does not respawn', async () => {
  const spawnImpl = fakeSpawn('current');
  const kb = createKb(defaults(), { spawnImpl });
  kb.close();
  assert.deepEqual(await kb.search('q'), { passages: [], paths: [], mode: 'none' });
  assert.equal(spawnImpl.calls.length, 0);
});

test('a spawn that throws gives empty passages', async () => {
  const kb = createKb(defaults(), { spawnImpl: () => { throw new Error('ENOENT'); } });
  assert.deepEqual(await kb.search('q'), { passages: [], paths: [], mode: 'none' });
  kb.close();
});

test('warm() spawns the bridge and sends one query with a 20 s timeout, longer than kb.timeoutMs', async () => {
  const config = defaults();
  config.kb.timeoutMs = 150;
  const dir = mkdtempSync(join(tmpdir(), 'kb-test-'));
  const logFile = join(dir, 'ids');
  try {
    await withKb('slow', async (kb, spawnImpl) => {
      const t0 = Date.now();
      assert.equal(await kb.warm(), true, 'a reply after 600 ms still counts: warm waits longer');
      assert.ok(Date.now() - t0 >= 550);
      assert.equal(spawnImpl.calls.length, 1);
      assert.equal(readFileSync(logFile, 'utf8').trim().split('\n').length, 1, 'one query sent');
      const r = await kb.search('q'); // same process serves later searches; 600 ms > 150 ms: times out
      assert.equal(r.mode, 'none');
    }, { config, env: { FAKE_DELAY: '600', FAKE_LOG: logFile } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('warm() resolves false when the bridge cannot start; it never rejects', async () => {
  const kb = createKb(defaults(), { spawnImpl: () => { throw new Error('ENOENT'); } });
  assert.equal(await kb.warm(), false);
  kb.close();
});

test('a search timeout kills the hung bridge, logs kb-timeout without the query, and the next call respawns', async () => {
  const config = defaults();
  config.kb.timeoutMs = 200;
  const dir = mkdtempSync(join(tmpdir(), 'kb-test-'));
  const flag = join(dir, 'flag');
  const children = [];
  const lines = [];
  const impl = (cmd, args, opts) => {
    const child = spawn(process.execPath, [FAKE], {
      ...opts, env: { ...opts.env, FAKE_MODE: 'silent-once', FAKE_FLAG: existsSync(flag) ? '1' : '' } });
    children.push(child);
    return child;
  };
  const kb = createKb(config, { spawnImpl: impl, log: (l) => lines.push(l) });
  try {
    assert.deepEqual(await kb.search('SECRET-QUERY'), { passages: [], paths: [], mode: 'none' });
    assert.deepEqual(lines, ['kb-timeout']);
    await new Promise((r) => (children[0].exitCode !== null || children[0].signalCode ? r() : children[0].once('exit', r)));
    assert.ok(children[0].killed || children[0].signalCode, 'the hung bridge was killed');
    writeFileSync(flag, '1');
    const r = await kb.search('q');
    assert.equal(r.mode, 'hybrid');
    assert.equal(children.length, 2);
  } finally { kb.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the exit of a killed bridge does not settle requests sent to its replacement', async () => {
  const config = defaults();
  config.kb.timeoutMs = 1000; // long enough for child 2's 500 ms reply
  let n = 0;
  const impl = (cmd, args, opts) => {
    n += 1;
    // the first child ignores SIGTERM for a while, so its exit lands after the replacement got a request
    const extra = n === 1 ? { FAKE_MODE: 'silent-once', FAKE_FLAG: '', FAKE_LINGER: '100' } : { FAKE_MODE: 'slow', FAKE_DELAY: '500' };
    return spawn(process.execPath, [FAKE], { ...opts, env: { ...opts.env, ...extra } });
  };
  const kb = createKb(config, { spawnImpl: impl });
  try {
    await kb.search('a'); // times out, kills child 1 (which lingers)
    const r = await kb.search('b'); // child 1 exits after 100 ms; child 2 answers only after 500 ms
    assert.equal(r.mode, 'hybrid');
  } finally { kb.close(); }
});

test('a plain search asks for 3 short results and no all-terms matches', async () => {
  await withKb('deep', async (kb) => {
    const r = await kb.search('q');
    assert.equal(r.passages.length, 3);
    assert.ok(r.passages.every((p) => p.text === 'preview'));
    assert.deepEqual(r.paths, ['sample/doc-1.md', 'sample/doc-2.md', 'sample/doc-3.md']);
  });
});

test('a deep search asks for more results, whole sections and all-terms matches', async () => {
  await withKb('deep', async (kb) => {
    const r = await kb.search('q', { topK: 10, full: true, exact: true, textMax: 4000, totalMax: 100000 });
    assert.equal(r.passages.length, 11, '10 search results plus the one all-terms match not already among them');
    assert.equal(r.passages[0].text.length, 3000, 'the whole section, not the preview');
    assert.equal(r.paths.length, r.passages.length);
    assert.equal(r.paths[10], 'sample/exact-only.md');
    assert.equal(r.passages[10].label, 'KB · Exact Only v02, draft (keyword match)');
    assert.equal(r.paths.filter((p) => p === 'sample/doc-1.md').length, 1, 'no document twice');
    assert.ok(!r.passages[0].label.includes('keyword match'));
  });
});

test('a deep search cuts each passage to textMax and stops at totalMax', async () => {
  await withKb('deep', async (kb) => {
    const r = await kb.search('q', { topK: 10, full: true, textMax: 1000, totalMax: 2500 });
    assert.deepEqual(r.passages.map((p) => p.text.length), [1000, 1000, 500]);
    assert.equal(r.paths.length, 3);
    const stub = await kb.search('q', { topK: 10, full: true, textMax: 1000, totalMax: 2100 });
    assert.deepEqual(stub.passages.map((p) => p.text.length), [1000, 1000], 'a 100-character stub is left out');
  });
});
