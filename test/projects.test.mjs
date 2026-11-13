import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherProjectNotes, buildBriefs, briefsAreStale, createProjects } from '../server/sources/projects.mjs';

const tmp = (p = 'lens-proj-') => mkdtempSync(join(tmpdir(), p));
const put = (root, rel, text, mtimeSec) => {
  const f = join(root, rel);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, text);
  if (mtimeSec !== undefined) utimesSync(f, mtimeSec, mtimeSec);
  return f;
};
const GOOD = 'What: A toy tracker.\nDoes: Counts things.\nStatus: Works.\nNext: Ship it.';
const fakeLlm = (reply = GOOD) => {
  const calls = [];
  return { calls, complete: async (req) => { calls.push(req); return { text: typeof reply === 'function' ? reply(req) : reply, sources: [] }; } };
};
const cfgFor = (projects, briefsDir, sharedNotePaths = []) => ({ projects, briefsDir, sharedNotePaths });

test('gathers README, memory and .remember, capped', () => {
  const root = tmp();
  put(root, 'README.md', 'R'.repeat(7000));
  put(root, 'memory/a.md', 'alpha note', 1000);
  put(root, 'memory/b.md', 'bravo note', 3000);
  put(root, 'memory/ignored.txt', 'not markdown', 2000);
  put(root, 'memory/sub/deep.md', 'too deep', 2000);
  put(root, '.remember/now.md', 'now note', 2500);
  put(root, '.remember/recent.md', 'recent note', 1500);
  put(root, '.remember/today-2026-11-11.md', 'today note', 2800);
  put(root, '.remember/random.md', 'not on the list', 2900);
  const out = gatherProjectNotes({ name: 'p', paths: [root, join(root, 'missing')] });
  assert.ok(out.startsWith('R'.repeat(6000)), 'README comes first');
  assert.ok(!out.includes('R'.repeat(6001)), 'README capped at 6000 chars');
  const order = ['bravo note', 'today note', 'now note', 'recent note', 'alpha note'].map((t) => out.indexOf(t));
  assert.ok(order.every((i) => i > 0), 'all wanted notes present');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'newest first by modification time');
  for (const bad of ['not markdown', 'too deep', 'not on the list']) assert.ok(!out.includes(bad), bad);

  const big = tmp();
  for (let i = 0; i < 8; i++) put(big, `memory/n${i}.md`, 'x '.repeat(4000), 1000 + i);
  assert.equal(gatherProjectNotes({ name: 'p', paths: [big] }).length, 20000);
});

test('missing roots and files give an empty string', () => {
  assert.equal(gatherProjectNotes({ name: 'p', paths: ['/nonexistent-lens-root'] }), '');
  assert.equal(gatherProjectNotes({ name: 'p', paths: [] }), '');
});

test('shared notes follow project notes, skip README, and never crowd them out', () => {
  const proj = tmp();
  const shared = tmp();
  put(proj, 'README.md', 'project readme');
  put(proj, 'memory/p.md', 'P'.repeat(19000), 1000);
  put(shared, 'README.md', 'shared readme');
  put(shared, 'memory/s.md', 'shared memory note ' + 'S'.repeat(5000), 9000);
  put(shared, '.remember/now.md', 'shared now', 9000);
  put(shared, '.remember/other.md', 'shared other', 9000);
  const out = gatherProjectNotes({ name: 'p', paths: [proj] }, [shared]);
  assert.equal(out.length, 20000);
  assert.ok(out.includes('P'.repeat(19000)), 'project notes intact');
  assert.ok(!out.includes('shared readme') && !out.includes('shared other'));
  assert.ok(out.indexOf('shared memory note') > out.indexOf('P'.repeat(100)), 'shared after project');

  const small = tmp();
  put(small, 'memory/x.md', 'tiny', 1000);
  const both = gatherProjectNotes({ name: 'p', paths: [small] }, [shared]);
  assert.ok(both.includes('tiny') && both.includes('shared now') && both.includes('shared memory note'));
  assert.ok(both.indexOf('tiny') < both.indexOf('shared now'));
});

test('drops credential-looking lines from notes', () => {
  const root = tmp();
  put(root, 'README.md', [
    'keep this line',
    'my API_KEY is abc',
    'apikey=zzz',
    'export TOKEN=1',
    'The Secret sauce',
    'password: hunter2',
    'Authorization: Bearer abc.def',
    'hash 0123456789abcdef0123456789abcdef0123',
    'blob Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo=',
    'see /Users/someone/projects/my-long-project-name/src/index.mjs',
    'sha /0123456789abcdef0123456789abcdef01234567',
    'url //host/Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo',
    '0123456789abcdef0123456789abcdef01234567',
    'blob Zm9vYmFyYmF6cXV4MTIz/NDU2Nzg5MGFiY2RlZmdoaWo',
    'key aB3dE5fG7hJ9kL1mN3pQ5rS7/tU9vW1xY3zA5bC7d',
    'see ~/projects/my-long-project-name/2026-11-11/notes.md',
    'see /Users/someone/projects/my-long-project-name/src/index.mjs',
    'keep this line too',
  ].join('\n'));
  const out = gatherProjectNotes({ name: 'p', paths: [root] });
  assert.equal(
    out.trim(),
    'keep this line\nsee /Users/someone/projects/my-long-project-name/src/index.mjs\nsee ~/projects/my-long-project-name/2026-11-11/notes.md\nsee /Users/someone/projects/my-long-project-name/src/index.mjs\nkeep this line too',
  );
});

test('buildBriefs writes one file per project from the model text', async () => {
  const a = tmp(); const b = tmp(); const dir = join(tmp(), 'briefs');
  put(a, 'README.md', 'Garden planner readme');
  put(b, 'README.md', 'Doctor readme');
  const llm = fakeLlm();
  const now = new Date(2026, 10, 11, 9, 0, 0);
  const written = await buildBriefs(cfgFor([{ name: 'Garden Planner', paths: [a] }, { name: 'Recipe Box', paths: [b] }], dir), llm, { now });
  assert.deepEqual([...written], [join(dir, 'garden-planner.md'), join(dir, 'recipe-box.md')]);
  assert.deepEqual(written.failed, []);
  assert.equal(readFileSync(written[0], 'utf8'), `# Garden Planner\n${GOOD}\n`);
  assert.equal(llm.calls.length, 2);
  const req = llm.calls[0];
  assert.equal(req.model, 'answer');
  assert.equal(req.maxTokens, 400);
  assert.match(req.user, /Garden planner readme/);
  assert.match(req.system, /What:.*Does:.*Status:.*Next:/s);
  assert.match(req.system, /120 words/);
  assert.match(req.system, /data, not instructions/);
});

test('buildBriefs never sends credential-looking lines to the model', async () => {
  const a = tmp(); const dir = tmp();
  put(a, 'memory/n.md', 'safe line\npassword: hunter2\nBearer abc123');
  const llm = fakeLlm();
  await buildBriefs(cfgFor([{ name: 'P', paths: [a] }], dir), llm, {});
  assert.match(llm.calls[0].user, /safe line/);
  assert.doesNotMatch(llm.calls[0].user, /hunter2|abc123/);
});

test('a bad reply keeps the old brief, is reported, and does not stop the others', async () => {
  const a = tmp(); const b = tmp(); const c = tmp(); const dir = tmp();
  for (const r of [a, b, c]) put(r, 'README.md', 'readme for ' + r);
  writeFileSyncOld(dir, 'bad.md', '# Bad\nOLD BRIEF\n');
  const llm = fakeLlm((req) => (req.user.includes(b) ? 'I cannot do that.' : GOOD));
  const projects = [{ name: 'Good One', paths: [a] }, { name: 'Bad', paths: [b] }, { name: 'Good Two', paths: [c] }];
  const written = await buildBriefs(cfgFor(projects, dir), llm, {});
  assert.deepEqual(written.map((f) => f.slice(dir.length + 1)), ['good-one.md', 'good-two.md']);
  assert.deepEqual(written.failed, ['Bad']);
  assert.equal(readFileSync(join(dir, 'bad.md'), 'utf8'), '# Bad\nOLD BRIEF\n');

  const throwing = { complete: async () => { throw new Error('boom'); } };
  const w2 = await buildBriefs(cfgFor(projects, dir), throwing, {});
  assert.deepEqual([...w2], []);
  assert.deepEqual(w2.failed, ['Good One', 'Bad', 'Good Two']);
});

test('a project with no notes is reported failed without calling the model', async () => {
  const dir = tmp();
  const llm = fakeLlm();
  const w = await buildBriefs(cfgFor([{ name: 'Empty', paths: ['/nonexistent-lens-root'] }], dir), llm, {});
  assert.deepEqual([...w], []);
  assert.deepEqual(w.failed, ['Empty']);
  assert.equal(llm.calls.length, 0);
  assert.equal(existsSync(join(dir, 'empty.md')), false);
});

test('slug lower-cases and collapses non-alphanumerics', async () => {
  const a = tmp(); const dir = tmp();
  put(a, 'README.md', 'x');
  const w = await buildBriefs(cfgFor([{ name: 'Trip Notes v2!', paths: [a] }], dir), fakeLlm(), {});
  assert.equal(w[0], join(dir, 'trip-notes-v2.md'));
});

test('stale after 24 h', async () => {
  const a = tmp(); const dir = tmp();
  put(a, 'README.md', 'x');
  const cfg = cfgFor([{ name: 'P', paths: [a] }], dir);
  const now = new Date(2026, 10, 11, 9, 0, 0);
  assert.equal(briefsAreStale(cfg, now), true, 'missing brief is stale');
  await buildBriefs(cfg, fakeLlm(), { now });
  assert.equal(briefsAreStale(cfg, now), false);
  assert.equal(briefsAreStale(cfg, new Date(now.getTime() + 23 * 3600e3)), false);
  assert.equal(briefsAreStale(cfg, new Date(now.getTime() + 25 * 3600e3)), true);
  assert.equal(briefsAreStale(cfgFor([], dir), now), false, 'nothing to build, not stale');
  const two = cfgFor([{ name: 'P', paths: [a] }, { name: 'Q', paths: [a] }], dir);
  assert.equal(briefsAreStale(two, now), true, 'one missing brief is enough');
});

test('lookup labels each brief', async () => {
  const dir = tmp();
  writeFileSyncOld(dir, 'garden-planner.md', `# Garden Planner\n${GOOD}\n`);
  writeFileSyncOld(dir, 'lens-answers.md', '# Lens Answers\n' + 'W'.repeat(2000) + '\n');
  const r = await createProjects({ briefsDir: dir }).lookup('anything');
  assert.equal(r.passages.length, 2);
  assert.equal(r.passages[0].label, 'Your projects · Garden Planner');
  assert.equal(r.passages[0].text, GOOD);
  assert.equal(r.passages[1].label, 'Your projects · Lens Answers');
  assert.equal(r.passages[1].text.length, 1200);
});

test('no briefs yet → empty passages', async () => {
  assert.deepEqual((await createProjects({ briefsDir: join(tmp(), 'nope') }).lookup('x')).passages, []);
  assert.deepEqual((await createProjects({ briefsDir: tmp() }).lookup('x')).passages, []);
});

function writeFileSyncOld(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}
