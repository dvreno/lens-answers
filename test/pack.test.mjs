import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadContextPack, PACK_MAX_CHARS } from '../server/sources/pack.mjs';

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'lens-pack-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const config = (root, contextPack = 'PACK.md', command = ['some-bridge']) => ({ kb: { root, command }, work: { contextPack } });

test('reads the context pack from the knowledge base folder and logs its size only', () => withRoot((root) => {
  writeFileSync(join(root, 'PACK.md'), '  # Notes\nGlossary line.\n\n');
  const lines = [];
  assert.equal(loadContextPack(config(root), { log: (l) => lines.push(l) }), '# Notes\nGlossary line.');
  assert.deepEqual(lines, ['context-pack chars=22']);
}));

test('a missing, empty or unset context pack gives an empty string and one log line', () => withRoot((root) => {
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(loadContextPack(config(root), { log }), '');
  writeFileSync(join(root, 'PACK.md'), '   \n');
  assert.equal(loadContextPack(config(root), { log }), '');
  assert.equal(loadContextPack(config(root, ''), { log }), '');
  assert.deepEqual(lines, ['context-pack missing', 'context-pack empty', 'context-pack off']);
}));

test('a context pack path that leaves the knowledge base folder is refused', () => withRoot((root) => {
  mkdirSync(join(root, 'kb'));
  writeFileSync(join(root, 'outside.md'), 'secret');
  const lines = [];
  assert.equal(loadContextPack(config(join(root, 'kb'), '../outside.md'), { log: (l) => lines.push(l) }), '');
  assert.deepEqual(lines, ['context-pack refused']);
}));

test('an over-long context pack is cut at the limit', () => withRoot((root) => {
  writeFileSync(join(root, 'PACK.md'), 'x'.repeat(PACK_MAX_CHARS + 50));
  assert.equal(loadContextPack(config(root)).length, PACK_MAX_CHARS);
}));

test('with no notes folder or no bridge the context pack is off, whatever sits in the current folder', () => withRoot((root) => {
  writeFileSync(join(root, 'PACK.md'), 'notes that must not be read');
  const lines = [];
  const log = (l) => lines.push(l);
  const before = process.cwd();
  process.chdir(root); // an empty kb.root must not come to mean "the folder the server was started in"
  try {
    assert.equal(loadContextPack(config(''), { log }), '');
    assert.equal(loadContextPack(config(root, 'PACK.md', []), { log }), '');
  } finally { process.chdir(before); }
  assert.deepEqual(lines, ['context-pack off', 'context-pack off']);
}));
