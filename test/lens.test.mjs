import test from 'node:test';
import assert from 'node:assert/strict';
import { createLens } from '../phone/lens.js';
import { REGIONS } from '../phone/card-layout.js';

function fakeGm({ failNextUpdate = false } = {}) {
  const calls = [];
  let fail = failNextUpdate;
  return {
    calls,
    display: {
      createPage: async () => { calls.push(['createPage']); },
      updateText: async (o) => {
        if (fail) { fail = false; throw new Error('boom'); }
        calls.push(['updateText', o]);
      },
      closePage: async () => { calls.push(['closePage']); },
    },
  };
}

function fakeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    pending,
    fire() { const [[id, t]] = [...pending]; pending.delete(id); t.fn(); },
  };
}

const CARD = { id: 1, heard: 'They ask: Library hours?', source: 'library.example', answer: 'Open 9 to 5 on Friday.', solid: true, ttlMs: 7000 };
const texts = (gm) => gm.calls.filter((c) => c[0] === 'updateText').map((c) => c[1]);
const settle = () => new Promise((r) => setImmediate(r));

test('showCard writes regions 1-3 then clears after ttlMs', async () => {
  const gm = fakeGm(); const timers = fakeTimers();
  const lens = createLens(gm, timers);
  await lens.showCard(CARD);
  assert.equal(gm.calls.filter((c) => c[0] === 'createPage').length, 1);
  const written = texts(gm);
  assert.deepEqual(written.map((o) => o.id), [1, 2, 3]);
  assert.equal(written[0].text, CARD.heard);
  assert.equal(written[1].text, CARD.source);
  assert.equal(written[2].text, CARD.answer);
  for (const o of written) {
    const r = Object.values(REGIONS).find((x) => x.id === o.id);
    assert.deepEqual({ x: o.x, y: o.y, width: o.width, height: o.height }, { x: r.x, y: r.y, width: r.width, height: r.height });
    assert.equal(typeof o.border, 'number');
    assert.equal(typeof o.radius, 'number');
  }
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0].ms, 7000);
  assert.equal(lens.isShowing(), true);

  gm.calls.length = 0;
  timers.fire();
  await settle();
  assert.deepEqual(texts(gm).map((o) => [o.id, o.text]), [[1, ' '], [2, ' '], [3, ' ']]);
  assert.equal(lens.isShowing(), false);
});

test('a second card replaces the first and restarts the timer', async () => {
  const gm = fakeGm(); const timers = fakeTimers();
  const lens = createLens(gm, timers);
  await lens.showCard(CARD);
  const first = [...timers.pending.keys()][0];
  await lens.showCard({ ...CARD, id: 2, answer: 'Second.', ttlMs: 3000 });
  assert.equal(timers.pending.size, 1);
  assert.ok(!timers.pending.has(first), 'old timer cancelled');
  assert.equal([...timers.pending.values()][0].ms, 3000);
  assert.equal(texts(gm).at(-1).text, 'Second.');
  assert.equal(gm.calls.filter((c) => c[0] === 'createPage').length, 1, 'page created once');
});

test('long text is fitted to the limits before it is drawn', async () => {
  const gm = fakeGm(); const timers = fakeTimers();
  const lens = createLens(gm, { ...timers, limits: { heardMax: 10, sourceMax: 10, answerMax: 20 } });
  await lens.showCard({ ...CARD, heard: 'x'.repeat(50), answer: 'y'.repeat(50) });
  const written = texts(gm);
  assert.equal(written[0].text.length, 10);
  assert.equal(written[2].text, `${'y'.repeat(19)}…`);
});

test('clearCard cancels the timer and blanks the card', async () => {
  const gm = fakeGm(); const timers = fakeTimers();
  const lens = createLens(gm, timers);
  await lens.showCard(CARD);
  await lens.clearCard();
  assert.equal(timers.pending.size, 0);
  assert.deepEqual(texts(gm).slice(-3).map((o) => o.text), [' ', ' ', ' ']);
  assert.equal(lens.isShowing(), false);
});

test('a card draws the source frame and clearing removes it', async () => {
  const gm = fakeGm(); const timers = fakeTimers();
  const lens = createLens(gm, timers);
  await lens.showCard(CARD);
  const shown = texts(gm).find((o) => o.id === REGIONS.source.id);
  assert.deepEqual([shown.border, shown.radius], [REGIONS.source.border, REGIONS.source.radius]);
  await lens.clearCard();
  const cleared = texts(gm).filter((o) => o.id === REGIONS.source.id).at(-1);
  assert.deepEqual([cleared.border, cleared.radius], [0, 0]);
});

test('setStatus writes the status region with the exact text', async () => {
  const gm = fakeGm(); const timers = fakeTimers();
  const lens = createLens(gm, timers);
  const expected = {
    listening: '● listening', paused: '⊘ paused', thinking: '… thinking',
    offline: 'offline', backup: '● listening (backup)',
  };
  for (const [status, text] of Object.entries(expected)) {
    await lens.setStatus(status);
    const last = texts(gm).at(-1);
    assert.equal(last.id, REGIONS.status.id);
    assert.equal(last.text, text);
  }
  await assert.rejects(() => lens.setStatus('nonsense'), RangeError);
});

test('status survives a card and is redrawn after the page is recreated', async () => {
  const gm = fakeGm(); const timers = fakeTimers();
  const lens = createLens(gm, timers);
  await lens.setStatus('paused');
  await lens.showCard(CARD);
  gm.calls.length = 0;
  lens.reset(); // page was recreated by the host
  await lens.showCard(CARD);
  assert.equal(gm.calls[0][0], 'createPage');
  assert.ok(texts(gm).some((o) => o.id === REGIONS.status.id && o.text === '⊘ paused'));
});

test('a failed draw is reported, does not stall later draws, and recreates the page', async () => {
  const gm = fakeGm({ failNextUpdate: true }); const timers = fakeTimers();
  const errors = [];
  const lens = createLens(gm, { ...timers, onError: (e) => errors.push(e.message) });
  await assert.rejects(() => lens.showCard(CARD), /boom/);
  assert.deepEqual(errors, ['boom']);
  assert.equal(lens.isShowing(), false);
  assert.equal(timers.pending.size, 0);
  await lens.showCard(CARD);
  assert.equal(gm.calls.filter((c) => c[0] === 'createPage').length, 2);
  assert.equal(lens.isShowing(), true);
});

test('overlapping calls are drawn in order', async () => {
  const gm = fakeGm(); const timers = fakeTimers();
  const lens = createLens(gm, timers);
  const a = lens.showCard(CARD);
  const b = lens.showCard({ ...CARD, id: 2, answer: 'B' });
  await Promise.all([a, b]);
  const answers = texts(gm).filter((o) => o.id === 3).map((o) => o.text);
  assert.deepEqual(answers, [CARD.answer, 'B']);
  assert.equal(timers.pending.size, 1);
});

test('work mode has its own status texts, short enough for the status region', async () => {
  const gm = fakeGm();
  const lens = createLens(gm, fakeTimers());
  for (const [status, text] of [['work', '● work mode'], ['work-backup', '● work (backup)']]) {
    await lens.setStatus(status);
    const last = texts(gm).at(-1);
    assert.equal(last.id, REGIONS.status.id);
    assert.equal(last.text, text);
    assert.ok(text.length <= '● listening (backup)'.length);
  }
});
