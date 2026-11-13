import test from 'node:test';
import assert from 'node:assert/strict';
import { createLink, normalizeServerUrl, replaceLink } from '../phone/link.js';
import { decodeChunk } from '../phone/lib/wire.js';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url; this.sent = []; this.readyState = 0; this.bufferedAmount = 0;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close(code) { this.closedWith = code; }
  open() { this.readyState = 1; this.onopen?.({}); }
  message(obj) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    pending,
    fire() { const [[id, t]] = [...pending]; pending.delete(id); t.fn(); return t.ms; },
  };
}

function setup(extra = {}) {
  FakeWebSocket.instances = [];
  const timers = fakeTimers();
  const statuses = []; const messages = [];
  const link = createLink({
    url: 'ws://host:8790/ws', token: 'secret-token', WebSocketImpl: FakeWebSocket,
    onMessage: (m) => messages.push(m), onStatus: (s, why) => statuses.push(why ? `${s}:${why}` : s),
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, ...extra,
  });
  return { link, timers, statuses, messages, sockets: FakeWebSocket.instances };
}

test('link sends hello on open and is online after the server answers', () => {
  const { sockets, statuses, messages } = setup();
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://host:8790/ws');
  assert.ok(!sockets[0].url.includes('secret-token'), 'token never goes in the URL');
  sockets[0].open();
  assert.deepEqual(JSON.parse(sockets[0].sent[0]), { type: 'hello', token: 'secret-token' });
  assert.deepEqual(statuses, ['offline:connecting']);
  sockets[0].message({ type: 'state', state: 'listening', asr: 'local' });
  assert.deepEqual(statuses, ['offline:connecting', 'online']);
  assert.deepEqual(messages, [{ type: 'state', state: 'listening', asr: 'local' }]);
});

test('link reconnects after close with backoff 1 s, 2 s, 5 s, 5 s and reports offline', () => {
  const { sockets, timers, statuses } = setup();
  const delays = [];
  for (let i = 0; i < 4; i++) {
    sockets.at(-1).drop();
    delays.push(timers.fire());
    assert.equal(sockets.length, i + 2, 'a new socket per attempt');
  }
  assert.deepEqual(delays, [1000, 2000, 5000, 5000]);
  assert.ok(statuses.includes('offline:closed'));
});

test('a successful hello resets the backoff', () => {
  const { sockets, timers } = setup();
  sockets[0].drop(); assert.equal(timers.fire(), 1000);
  sockets[1].drop(); assert.equal(timers.fire(), 2000);
  sockets[2].open(); sockets[2].message({ type: 'state', state: 'listening', asr: 'local' });
  sockets[2].drop();
  assert.equal(timers.fire(), 1000);
});

test('going offline then back online is reported in order', () => {
  const { sockets, timers, statuses } = setup();
  sockets[0].open(); sockets[0].message({ type: 'state', state: 'listening', asr: 'local' });
  sockets[0].drop();
  timers.fire();
  sockets[1].open(); sockets[1].message({ type: 'state', state: 'listening', asr: 'local' });
  assert.deepEqual(statuses, ['offline:connecting', 'online', 'offline:closed', 'online']);
});

test('close 4401 does not reconnect and says the token is wrong', () => {
  const { sockets, timers, statuses } = setup();
  sockets[0].open();
  sockets[0].drop(4401);
  assert.equal(timers.pending.size, 0);
  assert.equal(sockets.length, 1);
  assert.equal(statuses.at(-1), 'offline:unauthorized');
});

test('close 4409 does not reconnect and says it was replaced', () => {
  const { sockets, timers, statuses } = setup();
  sockets[0].open(); sockets[0].message({ type: 'state', state: 'listening', asr: 'local' });
  sockets[0].drop(4409);
  assert.equal(timers.pending.size, 0);
  assert.equal(statuses.at(-1), 'offline:replaced');
});

test('reconnect() after a no-retry close tries again from 1 s', () => {
  const { link, sockets, timers } = setup();
  sockets[0].open();
  sockets[0].drop(4409);
  link.reconnect();
  assert.equal(sockets.length, 2);
  sockets[1].drop();
  assert.equal(timers.fire(), 1000);
});

test('audio is sent as a wire chunk only while the socket is open', () => {
  const { link, sockets } = setup();
  assert.equal(link.sendAudio([2, 1], Uint8Array.of(1, 2, 3)), false, 'still connecting');
  sockets[0].open();
  assert.equal(link.sendAudio([2, 1], Uint8Array.of(1, 2, 3)), true);
  const chunk = sockets[0].sent.at(-1);
  assert.ok(chunk instanceof Uint8Array);
  assert.deepEqual(decodeChunk(chunk).frames.map((f) => [...f]), [[1, 2], [3]]);
});

test('audio sent while offline is dropped, not queued', () => {
  const { link, sockets, timers } = setup();
  sockets[0].open(); sockets[0].message({ type: 'state', state: 'listening', asr: 'local' });
  sockets[0].drop();
  assert.equal(link.sendAudio([1], Uint8Array.of(9)), false);
  assert.equal(link.sendAudio([1], Uint8Array.of(9)), false);
  timers.fire();
  sockets[1].open();
  // only the hello went out on the new socket; nothing was queued behind it
  assert.equal(sockets[1].sent.length, 1);
  assert.equal(JSON.parse(sockets[1].sent[0]).type, 'hello');
  assert.equal(sockets[0].sent.length, 1);
});

test('audio is dropped when the socket is backed up or the chunk is over 64 KiB', () => {
  const { link, sockets } = setup();
  sockets[0].open();
  sockets[0].bufferedAmount = 1024 * 1024;
  assert.equal(link.sendAudio([1], Uint8Array.of(1)), false);
  sockets[0].bufferedAmount = 0;
  const big = new Uint8Array(70000);
  assert.equal(link.sendAudio([35000, 35000], big), false, 'over the 64 KiB message limit');
  assert.equal(link.sendAudio([5], Uint8Array.of(1)), false, 'lengths that do not match the data are dropped, not thrown');
});

test('send() writes JSON while open and returns false otherwise', () => {
  const { link, sockets } = setup();
  assert.equal(link.send({ type: 'pause' }), false);
  sockets[0].open();
  assert.equal(link.send({ type: 'call', on: true }), true);
  assert.deepEqual(JSON.parse(sockets[0].sent.at(-1)), { type: 'call', on: true });
});

test('close() stops reconnecting and closes the socket', () => {
  const { link, sockets, timers, statuses } = setup();
  sockets[0].open();
  sockets[0].drop();
  link.close();
  assert.equal(timers.pending.size, 0);
  const n = statuses.length;
  link.close();
  assert.equal(statuses.length, n);
  const { link: l2, sockets: s2 } = setup();
  s2[0].open();
  l2.close();
  assert.equal(s2[0].closedWith, 1000);
  s2[0].drop();
  assert.equal(s2.length, 1);
});

test('non-JSON and binary server messages are ignored', () => {
  const { sockets, messages } = setup();
  sockets[0].open();
  sockets[0].message('not json');
  sockets[0].onmessage({ data: new ArrayBuffer(4) });
  assert.deepEqual(messages, []);
});

test('an address the WebSocket constructor rejects is reported and not retried', () => {
  FakeWebSocket.instances = [];
  const timers = fakeTimers();
  const statuses = [];
  class Throwing { constructor() { throw new SyntaxError('bad url'); } }
  createLink({ url: 'nope', token: 't', WebSocketImpl: Throwing, onMessage() {}, onStatus: (s, w) => statuses.push(`${s}:${w}`), ...timers });
  assert.deepEqual(statuses, ['offline:bad-address']);
  assert.equal(timers.pending.size, 0);
});

test('normalizeServerUrl accepts host:port, http(s) and ws(s) and ends at /ws', () => {
  assert.equal(normalizeServerUrl('192.168.1.5:8790'), 'ws://192.168.1.5:8790/ws');
  assert.equal(normalizeServerUrl(' ws://mac.local:8790 '), 'ws://mac.local:8790/ws');
  assert.equal(normalizeServerUrl('http://mac.local:8790/'), 'ws://mac.local:8790/ws');
  assert.equal(normalizeServerUrl('https://x.example/ws'), 'wss://x.example/ws');
  assert.equal(normalizeServerUrl('wss://x.example/custom'), 'wss://x.example/custom');
  assert.throws(() => normalizeServerUrl(''), /address/i);
  assert.throws(() => normalizeServerUrl('ftp://x'), /address/i);
  assert.throws(() => normalizeServerUrl('ws://user:pw@x:1'), /address/i);
});

test('replaceLink: a bad address throws before the working link is touched', () => {
  let closed = 0;
  const current = { close() { closed++; } };
  for (const bad of ['', 'ftp://x', 'ws://user:pw@host']) {
    assert.throws(() => replaceLink(current, { url: bad, token: 't', WebSocketImpl: FakeWebSocket }));
  }
  assert.equal(closed, 0, 'the old link is still open');
});

test('replaceLink: a good address closes the old link, then opens one on the normalised URL', () => {
  FakeWebSocket.instances = [];
  const order = [];
  const current = { close() { order.push('closed'); } };
  const timers = fakeTimers();
  const next = replaceLink(current, { url: 'mac.example:8790', token: 't', WebSocketImpl: FakeWebSocket,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  assert.deepEqual(order, ['closed']);
  assert.equal(FakeWebSocket.instances.at(-1).url, 'ws://mac.example:8790/ws');
  next.close();
  assert.ok(replaceLink(null, { url: 'mac.example:8790', token: 't', WebSocketImpl: FakeWebSocket,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }), 'no old link is fine');
});
