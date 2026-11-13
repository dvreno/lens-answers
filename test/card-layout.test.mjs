import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutCard, REGIONS, DEFAULT_LIMITS } from '../phone/card-layout.js';

const L = { heardMax: 80, sourceMax: 60, answerMax: 180 };

test('long heard/source/answer are cut with …', () => {
  const out = layoutCard({ heard: 'h'.repeat(200), source: 's'.repeat(200), answer: 'a'.repeat(500) }, L);
  assert.equal(out.heard.length, 80);
  assert.equal(out.source.length, 60);
  assert.equal(out.answer.length, 180);
  for (const v of Object.values(out)) assert.ok(v.endsWith('…'));
  assert.equal(out.heard, `${'h'.repeat(79)}…`);
});

test('text at or under the limit is untouched', () => {
  const out = layoutCard({ heard: 'h'.repeat(80), source: 'library.example', answer: 'Fridays 9 to 5.' }, L);
  assert.equal(out.heard, 'h'.repeat(80));
  assert.equal(out.source, 'library.example');
  assert.equal(out.answer, 'Fridays 9 to 5.');
});

test('blank fields become a single space', () => {
  assert.equal(layoutCard({ heard: '', source: '', answer: '' }, L).answer, ' ');
  const out = layoutCard({ heard: '   ', source: undefined, answer: null }, L);
  assert.deepEqual(out, { heard: ' ', source: ' ', answer: ' ' });
});

test('limits default to heard 80, source 60, answer 180', () => {
  assert.deepEqual(DEFAULT_LIMITS, L);
  const out = layoutCard({ heard: 'h'.repeat(300), source: 's'.repeat(300), answer: 'a'.repeat(300) });
  assert.deepEqual([out.heard.length, out.source.length, out.answer.length], [80, 60, 180]);
});

test('a cut never splits a surrogate pair', () => {
  const out = layoutCard({ heard: '😀'.repeat(100), source: '', answer: '' }, L);
  assert.equal(Array.from(out.heard).length, 80);
  assert.ok(!/[\ud800-\udbff]$/.test(out.heard));
});

test('REGIONS fit inside the 600x350 lens and do not overlap', () => {
  const list = Object.values(REGIONS);
  assert.deepEqual(Object.values(REGIONS).map((r) => r.id), [1, 2, 3, 4]);
  for (const r of list) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= 600 && r.y + r.height <= 350, `region ${r.id} on the lens`);
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]; const b = list[j];
      const apart = a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y;
      assert.ok(apart, `regions ${a.id} and ${b.id} overlap`);
    }
  }
});
