// The claude-code back end: stream protocol (answer taken at the end of the model's message, without
// waiting for the CLI's wrap-up) and the warm standby process kept ready for the next call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createClaudeCodeBackend } from '../server/llm/claude-code.mjs';

const tick = () => new Promise((r) => setImmediate(r));

// Scriptable fake `claude` processes, in spawn order.
function fakeClaude() {
  const list = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    Object.assign(child, { cmd, args, written: '', killed: false, refs: [] });
    child.stdin = new PassThrough();
    child.stdin.on('data', (d) => { child.written += d; });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    child.unref = () => { child.refs.push('unref'); };
    child.ref = () => { child.refs.push('ref'); };
    child.say = (...events) => { for (const e of events.flat()) child.stdout.write(`${JSON.stringify(e)}\n`); };
    child.exit = async (code = 0, stderr = '') => {
      if (stderr) child.stderr.write(stderr);
      await tick();
      child.emit('close', code);
    };
    list.push(child);
    return child;
  };
  return { spawn, list };
}

const ev = (event, parent = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event });
const start = (parent) => ev({ type: 'message_start', message: {} }, parent);
const text = (t, parent) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }, parent);
const stop = (reason, parent) => [
  ev({ type: 'message_delta', delta: { stop_reason: reason } }, parent),
  ev({ type: 'message_stop' }, parent),
];
const message = (t, reason = 'end_turn') => [start(), text(t), ...stop(reason)];
const REQ = { model: 'claude-haiku-5-5', system: 'BE BRIEF', user: 'the question' };
const cold = (extra) => { const f = fakeClaude(); return { ...f, llm: createClaudeCodeBackend({ spawn: f.spawn, warm: false, ...extra }) }; };

test('asks over the stream protocol: one JSON user line on stdin, stream flags on the command', async () => {
  const { llm, list } = cold();
  const p = llm.complete(REQ);
  await tick();
  const [child] = list;
  assert.equal(child.cmd, 'claude');
  const arg = (name) => child.args[child.args.indexOf(name) + 1];
  assert.equal(arg('--input-format'), 'stream-json');
  assert.equal(arg('--output-format'), 'stream-json');
  assert.ok(child.args.includes('--include-partial-messages') && child.args.includes('--verbose'));
  assert.ok(child.args.includes('-p') && child.args.includes('--safe-mode') && child.args.includes('--no-session-persistence'));
  assert.equal(arg('--model'), 'claude-haiku-5-5');
  assert.equal(arg('--append-system-prompt'), 'BE BRIEF');
  assert.equal(arg('--tools'), '');
  assert.deepEqual(JSON.parse(child.written), { type: 'user', message: { role: 'user', content: 'the question' } });
  assert.ok(child.written.endsWith('\n'));
  child.say(message('ok'));
  await p;
});

test('resolves when the model message ends, without waiting for the result line or the process to exit', async () => {
  const { llm, list } = cold();
  const p = llm.complete(REQ);
  await tick();
  list[0].say({ type: 'system', subtype: 'init' }, start(), text(' Par'), text('is. \n'), ...stop('end_turn'));
  assert.deepEqual(await p, { text: 'Paris.', sources: [] });
  assert.equal(list[0].killed, true, 'the process is stopped: its wrap-up step is not needed');
});

test('a message that ends in a tool call is not the answer; the final message is', async () => {
  const { llm, list } = cold();
  const p = llm.complete({ ...REQ, webSearch: true });
  await tick();
  assert.equal(list[0].args[list[0].args.indexOf('--tools') + 1], 'WebSearch');
  list[0].say(message('Let me search.', 'tool_use'));
  list[0].say(start('toolu_1'), text('inner helper text', 'toolu_1'), ...stop('end_turn', 'toolu_1'));
  await tick();
  list[0].say(message('It is 8,849 m.\nSOURCES: https://a.example/x ftp://no https://b.example'));
  assert.deepEqual(await p, { text: 'It is 8,849 m.', sources: ['https://a.example/x', 'https://b.example'] });
});

test('falls back to the result line when no stream message arrives', async () => {
  const { llm, list } = cold();
  const p = llm.complete(REQ);
  await tick();
  list[0].say({ type: 'result', is_error: false, result: ' from result ' });
  assert.deepEqual(await p, { text: 'from result', sources: [] });
});

test('failures reject: error result, empty text, exit before an answer, spawn that throws', async () => {
  const run = async (script) => {
    const { llm, list } = cold();
    const p = llm.complete(REQ);
    await tick();
    await script(list[0]);
    return p;
  };
  await assert.rejects(run((c) => c.say({ type: 'result', is_error: true, result: 'rate limited' })), /reported an error: rate limited/);
  await assert.rejects(run((c) => c.say(message('   '))), /empty text/);
  await assert.rejects(run((c) => c.exit(1, 'boom')), /code 1.*boom/);
  await assert.rejects(run((c) => { c.stdout.write('not json\n'); return c.exit(0); }), /without an answer/);
  const broken = createClaudeCodeBackend({ spawn: () => { throw new Error('ENOENT'); }, warm: false });
  await assert.rejects(broken.complete(REQ), /Could not start claude: ENOENT/);
});

test('a call that never answers times out and the process is killed', async () => {
  const { llm, list } = cold({ timeoutMs: 20 });
  await assert.rejects(llm.complete(REQ), /timed out after 20 ms/);
  assert.equal(list[0].killed, true);
});

test('warm: a standby with the same arguments is started at once and answers the next call', async () => {
  const f = fakeClaude();
  const llm = createClaudeCodeBackend({ spawn: f.spawn });
  const first = llm.complete(REQ);
  await tick();
  assert.equal(f.list.length, 2, 'the call process and its standby');
  assert.deepEqual(f.list[1].args, f.list[0].args);
  assert.equal(f.list[1].written, '', 'the standby has been asked nothing');
  assert.ok(f.list[1].refs.includes('unref'), 'a waiting standby never keeps the server alive');
  f.list[0].say(message('one'));
  assert.equal((await first).text, 'one');

  const second = llm.complete({ ...REQ, user: 'next question' });
  await tick();
  assert.equal(JSON.parse(f.list[1].written).message.content, 'next question', 'the standby took the call');
  assert.equal(f.list.length, 3, 'and a new standby replaced it');
  f.list[1].say(message('two'));
  assert.equal((await second).text, 'two');
  assert.equal(f.list[1].killed, true, 'each process answers one call: questions never share a conversation');
  llm.close();
});

test('warm: different arguments never share a standby', async () => {
  const f = fakeClaude();
  const llm = createClaudeCodeBackend({ spawn: f.spawn });
  const a = llm.complete(REQ);
  await tick();
  f.list[0].say(message('a'));
  await a;
  const b = llm.complete({ ...REQ, system: 'ANOTHER PROMPT' });
  await tick();
  assert.equal(f.list[1].written, '', 'the standby for the first prompt was not used');
  assert.equal(f.list[2].args[f.list[2].args.indexOf('--append-system-prompt') + 1], 'ANOTHER PROMPT');
  f.list[2].say(message('b'));
  assert.equal((await b).text, 'b');
  llm.close();
});

test('warm: a standby that died or is too old is not used', async () => {
  let now = 1_000_000;
  const f = fakeClaude();
  const llm = createClaudeCodeBackend({ spawn: f.spawn, standbyMaxAgeMs: 60_000, now: () => now });
  const a = llm.complete(REQ); await tick(); f.list[0].say(message('a')); await a;
  await f.list[1].exit(1); // the standby dies while waiting
  const b = llm.complete(REQ); await tick();
  assert.equal(f.list[1].written, '');
  f.list[2].say(message('b')); assert.equal((await b).text, 'b'); // list[3] is now the standby
  now += 61_000;
  const c = llm.complete(REQ); await tick();
  assert.equal(f.list[3].written, '', 'too old: not asked');
  assert.equal(f.list[3].killed, true, 'and stopped');
  f.list[4].say(message('c')); assert.equal((await c).text, 'c');
  llm.close();
});

test('warm: a standby that fails without any output is retried once on a fresh process', async () => {
  const f = fakeClaude();
  const llm = createClaudeCodeBackend({ spawn: f.spawn });
  const a = llm.complete(REQ); await tick(); f.list[0].say(message('a')); await a;
  const b = llm.complete(REQ); await tick();
  await f.list[1].exit(1, 'stale'); // the standby took the call and died silently
  await tick();
  const retry = f.list[f.list.length - 1];
  assert.equal(JSON.parse(retry.written).message.content, 'the question');
  retry.say(message('b'));
  assert.equal((await b).text, 'b');
  llm.close();
});

test('a fresh process that fails is not retried', async () => {
  const { llm, list } = cold();
  const p = llm.complete(REQ);
  await tick();
  await list[0].exit(1, 'boom');
  await assert.rejects(p, /code 1/);
  assert.equal(list.length, 1);
});

test('warm: at most four standbys are kept, the oldest is stopped first; close() stops them all', async () => {
  const f = fakeClaude();
  const llm = createClaudeCodeBackend({ spawn: f.spawn });
  const standbys = [];
  for (let i = 0; i < 5; i++) {
    const p = llm.complete({ ...REQ, system: `PROMPT ${i}` });
    await tick();
    const call = f.list[f.list.length - 2];
    standbys.push(f.list[f.list.length - 1]);
    call.say(message('x'));
    await p;
  }
  assert.deepEqual(standbys.map((s) => s.killed), [true, false, false, false, false]);
  llm.close();
  assert.ok(standbys.every((s) => s.killed));
  const after = llm.complete(REQ);
  await tick();
  const n = f.list.length;
  f.list[n - 1].say(message('still works'));
  assert.equal((await after).text, 'still works');
  assert.equal(f.list.length, n, 'no standby is started after close()');
});

test('the program started is `claude` unless a command is given, whose own arguments come first', async () => {
  const { llm, list } = cold({ command: ['node', 'C:\\tools\\claude\\cli.js'] });
  const p = llm.complete(REQ);
  await tick();
  const [child] = list;
  assert.equal(child.cmd, 'node');
  assert.equal(child.args[0], 'C:\\tools\\claude\\cli.js');
  assert.equal(child.args[1], '-p');
  child.say(message('ok'));
  assert.equal((await p).text, 'ok');
});
