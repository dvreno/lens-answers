import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, kbEnabled, defaults } from '../server/config.mjs';

const tmpFile = (obj, raw) => {
  const f = join(mkdtempSync(join(tmpdir(), 'lens-cfg-')), 'config.json');
  writeFileSync(f, raw ?? JSON.stringify(obj));
  return f;
};

test('defaults', () => {
  const c = loadConfig({}, '/nonexistent');
  assert.equal(c.port, 8790);
  assert.equal(c.asr.backup.enabled, false);
  assert.equal(c.asr.backup.keyEnv, 'LENS_ASR_BACKUP_KEY');
  assert.equal(c.card.ttlMs, 7000);
  assert.deepEqual(c.card, { ttlMs: 7000, heardMax: 80, sourceMax: 60, answerMax: 180, nothingSolid: 'show' });
  assert.equal(c.llm.backend, 'claude-code');
  assert.equal(c.llm.fastModel, 'claude-haiku-5-5');
  assert.equal(c.llm.warm, true);
  assert.deepEqual(c.vad, { silenceMs: 1000, minSpeechMs: 400, maxUtteranceMs: 10000,
    shorten: [{ afterMs: 4000, silenceMs: 400 }, { afterMs: 8000, silenceMs: 200 }], cutSearchMs: 2000 });
  assert.equal(c.kb.timeoutMs, 4000);
  assert.deepEqual(c.projects, []);
  assert.equal(c.callMode, false);
});

test('file then env override', () => {
  const f = tmpFile({ port: 9000, llm: { fastModel: 'x-model' }, card: { ttlMs: 5000 } });
  const fromFile = loadConfig({}, f);
  assert.equal(fromFile.port, 9000);
  assert.equal(fromFile.llm.fastModel, 'x-model');
  assert.equal(fromFile.llm.answerModel, 'claude-haiku-5-5', 'unset nested keys keep defaults');
  assert.equal(fromFile.card.ttlMs, 5000);
  assert.equal(fromFile.card.heardMax, 80);
  const c = loadConfig({ LENS_PORT: '9100', LENS_ASR_BACKUP_ENABLED: 'true', LENS_CALL_MODE: '0' }, f);
  assert.equal(c.port, 9100);
  assert.equal(c.asr.backup.enabled, true);
  assert.equal(c.callMode, false);
  assert.equal(c.llm.fastModel, 'x-model');
});

test('~ expands to the home directory', () => {
  const f = tmpFile({ briefsDir: '~/briefs', projects: [{ name: 'p', paths: ['~/code/p', '/abs'] }] });
  const c = loadConfig({ LENS_KB_ROOT: '~/kb' }, f);
  assert.equal(c.briefsDir, join(homedir(), 'briefs'));
  assert.equal(c.tokenFile, join(homedir(), '.config/lens-answers/token'));
  assert.equal(c.kb.root, join(homedir(), 'kb'));
  assert.deepEqual(c.projects[0].paths, [join(homedir(), 'code/p'), '/abs']);
});

test('bad input fails loudly', () => {
  assert.throws(() => loadConfig({}, tmpFile(null, '{nope')), /not valid JSON/);
  assert.throws(() => loadConfig({ LENS_PORT: 'abc' }, '/nonexistent'), /LENS_PORT/);
});

test('sharedNotePaths defaults to empty and expands ~', () => {
  assert.deepEqual(loadConfig({}, '/nonexistent').sharedNotePaths, []);
  const f = tmpFile({ sharedNotePaths: ['~/notes/a', '/abs/b'] });
  assert.deepEqual(loadConfig({}, f).sharedNotePaths, [join(homedir(), 'notes/a'), '/abs/b']);
});

test('LENS_LLM_WARM turns the claude-code warm standby off', () => {
  assert.equal(loadConfig({ LENS_LLM_WARM: '0' }, '/nonexistent').llm.warm, false);
  assert.equal(loadConfig({ LENS_LLM_WARM: 'true' }, '/nonexistent').llm.warm, true);
});

test('work mode defaults and overrides', () => {
  const c = loadConfig({}, '/nonexistent');
  assert.deepEqual(c.work, {
    silenceMs: 1500, topK: 10, exact: true, followUp: true, contextPack: 'KB_CONTEXT_PACK.md',
    passageChars: 4000, totalChars: 36000,
  });
  assert.equal(typeof c.llm.workModel, 'string');
  const e = loadConfig({ LENS_WORK_MODEL: 'some-model', LENS_WORK_SILENCE_MS: '1800' }, '/nonexistent');
  assert.equal(e.llm.workModel, 'some-model');
  assert.equal(e.work.silenceMs, 1800);
});

// ---- nothing personal in the defaults; the notes source, statutes and routing are all opt-in ----------

test('defaults name no notes folder, no bridge, no wearer and no routing patterns; statutes are off', () => {
  const c = loadConfig({}, '/nonexistent/lens-answers/config.json');
  assert.deepEqual(c.kb, { root: '', command: [], env: {}, timeoutMs: 4000 });
  assert.deepEqual(c.profile, { wearer: '', audience: '' });
  assert.deepEqual(c.routing, { work: { about: '', always: [], lean: [] } });
  assert.equal(c.statutes.enabled, false);
  assert.equal(kbEnabled(c), false);
});

test('kb.command and kb.env expand ~ and switch the notes source on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lens-config-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify({
    kb: { root: '~/notes', command: ['~/bin/python', '~/bridges/mine.py', '--flag'], env: { PYTHONPATH: '~/notes:~/notes/lib', OTHER: 'x' } },
  }));
  const c = loadConfig({}, file);
  assert.equal(c.kb.root, join(homedir(), 'notes'));
  assert.deepEqual(c.kb.command, [join(homedir(), 'bin/python'), join(homedir(), 'bridges/mine.py'), '--flag']);
  assert.deepEqual(c.kb.env, { PYTHONPATH: `${join(homedir(), 'notes')}:${join(homedir(), 'notes/lib')}`, OTHER: 'x' });
  assert.equal(kbEnabled(c), true);
});

test('a kb.command that is not a list of strings is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lens-config-'));
  const file = join(dir, 'config.json');
  for (const command of ['python bridge.py', [1, 2], [''], {}]) {
    writeFileSync(file, JSON.stringify({ kb: { command } }));
    assert.throws(() => loadConfig({}, file), /kb\.command/, JSON.stringify(command));
  }
});

test('config.example.json is exactly the defaults: nothing personal, nothing switched on', () => {
  const example = new URL('../config.example.json', import.meta.url).pathname;
  assert.deepEqual(JSON.parse(readFileSync(example, 'utf8')), defaults());
  assert.deepEqual(loadConfig({}, example), loadConfig({}, '/nonexistent/lens-answers/config.json'));
});

test('a config file that is not valid JSON is refused without echoing any of its text', () => {
  const file = tmpFile(null, '{ "routing": { "work": { "always": [\'PRIVATE-WORD\'] } } }');
  assert.throws(() => loadConfig({}, file), (e) => /not valid JSON/.test(e.message) && !/PRIV/.test(e.message));
});

test('a section set to the wrong kind of value is refused by name, not left to crash later', () => {
  for (const [key, value] of [['work', null], ['kb', null], ['kb', 'x'], ['routing', []], ['statutes', 3], ['profile', null], ['llm', null]]) {
    assert.throws(() => loadConfig({}, tmpFile({ [key]: value })), new RegExp(`${key} must be an object`), key);
  }
  assert.throws(() => loadConfig({}, tmpFile({ projects: {} })), /projects must be a list/);
  assert.throws(() => loadConfig({}, tmpFile({ sharedNotePaths: 'x' })), /sharedNotePaths must be a list/);
  assert.throws(() => loadConfig({}, tmpFile({ routing: { work: null } })), /routing\.work must be an object/);
});
