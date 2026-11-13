import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { loadConfig } from '../server/config.mjs';
import { createLlm } from '../server/llm/index.mjs';
import { parseJson } from '../server/llm/json.mjs';
import { createAnthropicBackend } from '../server/llm/anthropic-api.mjs';

const cfg = (backend) => {
  const c = loadConfig({}, '/nonexistent');
  c.llm.backend = backend;
  return c;
};

test('parseJson pulls JSON out of prose and fences', () => {
  assert.deepEqual(parseJson('ok ```json\n{"a":1}\n``` done'), { a: 1 });
  assert.deepEqual(parseJson('Sure: {"a":{"b":"}"}} thanks'), { a: { b: '}' } });
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.equal(parseJson('no json here'), null);
  assert.equal(parseJson('{broken'), null);
  assert.equal(parseJson(undefined), null);
});

test('anthropic back end maps model alias and returns text', async () => {
  const calls = [];
  const client = { messages: { create: async (p) => { calls.push(p); return {
    stop_reason: 'end_turn',
    content: [
      { type: 'web_search_tool_result', content: [
        { type: 'web_search_result', url: 'https://a.example/x' },
        { type: 'web_search_result', url: 'https://a.example/x' },
        { type: 'web_search_result', url: 'https://b.example/y' }] },
      { type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }],
  }; } } };
  const llm = createLlm(cfg('anthropic-api'), { client });
  const r = await llm.complete({ model: 'fast', system: 'SYS', user: 'hi', maxTokens: 50 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'claude-haiku-5-5');
  assert.equal(calls[0].system, 'SYS');
  assert.equal(calls[0].max_tokens, 50);
  assert.deepEqual(calls[0].messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(calls[0].tools, undefined);
  assert.equal(r.text, 'Hello there');
  assert.deepEqual(r.sources, ['https://a.example/x', 'https://b.example/y']);

  await llm.complete({ model: 'answer', system: 's', user: 'u', maxTokens: 10, webSearch: true });
  assert.equal(calls[1].tools.length, 1);
  assert.equal(calls[1].tools[0].name, 'web_search');
  assert.match(calls[1].tools[0].type, /^web_search_/);
});

test('anthropic back end uses configured model ids per alias', async () => {
  const c = cfg('anthropic-api');
  c.llm.answerModel = 'claude-sonnet-5-5';
  let seen;
  const client = { messages: { create: async (p) => { seen = p; return { content: [{ type: 'text', text: 'ok' }] }; } } };
  await createLlm(c, { client }).complete({ model: 'answer', system: 's', user: 'u', maxTokens: 5, webSearch: true });
  assert.equal(seen.model, 'claude-sonnet-5-5');
  assert.equal(seen.tools[0].type, 'web_search_20260209');
});

// A fake `claude` that answers the first line written to it. `stdout` is the raw text it prints (one
// stream-json line; see `result()`), then it exits with `code`. test/claude-code.test.mjs covers the
// stream protocol and the warm standby in detail.
const result = (text, is_error = false) => `${JSON.stringify({ type: 'result', result: text, is_error })}\n`;
function fakeSpawn({ stdout = '', stderr = '', code = 0, hang = false } = {}) {
  const rec = { args: null, cmd: null, stdin: '', killed: false };
  const spawn = (cmd, args) => {
    rec.cmd = cmd; rec.args = args;
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { rec.killed = true; };
    child.stdin.once('data', (d) => {
      rec.stdin += d;
      if (hang) return;
      setImmediate(() => {
        child.stdout.write(stdout); child.stderr.write(stderr);
        setImmediate(() => setImmediate(() => child.emit('close', code)));
      });
    });
    return child;
  };
  return { spawn, rec };
}

test('claude-code back end spawns claude -p and reads stdout', async () => {
  const { spawn, rec } = fakeSpawn({ stdout: result(' answer text \n') });
  const llm = createLlm(cfg('claude-code'), { spawn });
  const r = await llm.complete({ model: 'fast', system: 'BE BRIEF', user: 'the question', maxTokens: 50 });
  assert.equal(r.text, 'answer text');
  assert.deepEqual(r.sources, []);
  assert.equal(rec.cmd, 'claude');
  assert.ok(rec.args.includes('-p'));
  assert.equal(rec.args[rec.args.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(rec.args[rec.args.indexOf('--output-format') + 1], 'stream-json');
  assert.equal(rec.args[rec.args.indexOf('--append-system-prompt') + 1], 'BE BRIEF');
  assert.equal(JSON.parse(rec.stdin).message.content, 'the question');
  assert.ok(rec.args.includes('--safe-mode'), 'owner customizations are not loaded into the prompt');
  assert.ok(!rec.args.includes('--allowedTools'));
  assert.equal(rec.args[rec.args.indexOf('--tools') + 1], '', 'no tools unless webSearch');
});

test('claude-code back end adds WebSearch only when asked', async () => {
  const { spawn, rec } = fakeSpawn({ stdout: result('x') });
  await createLlm(cfg('claude-code'), { spawn }).complete({ model: 'answer', system: 's', user: 'u', maxTokens: 5, webSearch: true });
  assert.equal(rec.args[rec.args.indexOf('--allowedTools') + 1], 'WebSearch');
  assert.equal(rec.args[rec.args.indexOf('--tools') + 1], 'WebSearch');
});

test('back end failure rejects with an Error, never returns empty text silently', async () => {
  const req = { model: 'fast', system: 's', user: 'u', maxTokens: 5 };
  const cc = (opts, extra) => createLlm(cfg('claude-code'), { spawn: fakeSpawn(opts).spawn, ...extra }).complete(req);
  await assert.rejects(cc({ code: 1, stderr: 'boom' }), /code 1.*boom/);
  await assert.rejects(cc({ stdout: 'not json\n' }), /without an answer/);
  await assert.rejects(cc({ stdout: result('   ') }), /empty text/);
  await assert.rejects(cc({ stdout: result('rate limited', true) }), /reported an error/);
  const hung = fakeSpawn({ hang: true });
  await assert.rejects(
    createLlm(cfg('claude-code'), { spawn: hung.spawn, timeoutMs: 20 }).complete(req), /timed out/);
  assert.equal(hung.rec.killed, true);

  const emptyClient = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [] }) } };
  await assert.rejects(createLlm(cfg('anthropic-api'), { client: emptyClient }).complete(req), /no text/);
  const failClient = { messages: { create: async () => { throw new Error('401'); } } };
  await assert.rejects(createLlm(cfg('anthropic-api'), { client: failClient }).complete(req), /401/);
  const refusal = { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } };
  await assert.rejects(createLlm(cfg('anthropic-api'), { client: refusal }).complete(req), /declined/);
  await assert.rejects(createLlm(cfg('claude-code'), { spawn: fakeSpawn().spawn }).complete({ ...req, model: 'bogus' }), /alias/);
  assert.throws(() => createLlm(cfg('nope')), /Unknown llm backend/);
});

const webReq = { model: 'answer', system: 'SYS', user: 'u', maxTokens: 5, webSearch: true };
const runWeb = async (text) => {
  const { spawn, rec } = fakeSpawn({ stdout: result(text) });
  const r = await createLlm(cfg('claude-code'), { spawn }).complete(webReq);
  return { r, rec };
};

test('claude-code web search asks for a SOURCES line and returns its http(s) URLs', async () => {
  const { r, rec } = await runWeb('The pond is deep.\nSOURCES: https://www.example.org/a http://other.example.net/b ftp://bad.example/c javascript:alert(1)\n');
  assert.equal(r.text, 'The pond is deep.');
  assert.deepEqual(r.sources, ['https://www.example.org/a', 'http://other.example.net/b']);
  const sys = rec.args[rec.args.indexOf('--append-system-prompt') + 1];
  assert.ok(sys.startsWith('SYS'));
  assert.match(sys, /SOURCES: <url> <url>/);
  assert.match(sys, /SOURCES: none/);
});

test('claude-code web search: SOURCES: none gives no sources and strips the line', async () => {
  const { r } = await runWeb('Plain answer.\nSOURCES: none');
  assert.equal(r.text, 'Plain answer.');
  assert.deepEqual(r.sources, []);
});

test('claude-code web search: no SOURCES line leaves text unchanged', async () => {
  const { r } = await runWeb('Plain answer, sources: none cited here.');
  assert.equal(r.text, 'Plain answer, sources: none cited here.');
  assert.deepEqual(r.sources, []);
});

test('claude-code without web search does not ask for or strip a SOURCES line', async () => {
  const { spawn, rec } = fakeSpawn({ stdout: result('A.\nSOURCES: https://x.example') });
  const r = await createLlm(cfg('claude-code'), { spawn }).complete({ ...webReq, webSearch: false });
  assert.equal(r.text, 'A.\nSOURCES: https://x.example');
  assert.deepEqual(r.sources, []);
  assert.equal(rec.args[rec.args.indexOf('--append-system-prompt') + 1], 'SYS');
});

test('claude-code web search: a SOURCES marker at the end of the answer line is still split off', async () => {
  const { r } = await runWeb('Plain answer. SOURCES: https://www.example.org/a');
  assert.equal(r.text, 'Plain answer.');
  assert.deepEqual(r.sources, ['https://www.example.org/a']);
  const none = await runWeb('Plain answer. SOURCES: none');
  assert.equal(none.r.text, 'Plain answer.');
  assert.deepEqual(none.r.sources, []);
});

test('anthropic-api: each request carries a 20 s timeout and a hung call rejects', async () => {
  let opts;
  const ok = { messages: { create: async (p, o) => { opts = o; return { content: [{ type: 'text', text: 'ok' }] }; } } };
  await createAnthropicBackend({ client: ok }).complete({ model: 'm', system: 's', user: 'u', maxTokens: 10 });
  assert.equal(opts?.timeout, 20000);

  const hung = { messages: { create: () => new Promise(() => {}) } };
  const t0 = Date.now();
  await assert.rejects(
    createAnthropicBackend({ client: hung, timeoutMs: 50 }).complete({ model: 'm', system: 's', user: 'u', maxTokens: 10 }),
    /timed out/);
  assert.ok(Date.now() - t0 < 1000);
});

test('the work alias uses the configured work model', async () => {
  const calls = [];
  const client = { messages: { create: async (p) => { calls.push(p); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }; } } };
  const c = cfg('anthropic-api');
  c.llm.workModel = 'work-model-id';
  await createLlm(c, { client }).complete({ model: 'work', system: 's', user: 'u', maxTokens: 5 });
  assert.equal(calls[0].model, 'work-model-id');
});
