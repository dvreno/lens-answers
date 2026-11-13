import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeChunk, decodeChunk } from '../phone/lib/wire.js';

const frames = (d) => d.frames.map((f) => [...f]);

test('chunk round trip', () => {
  const d = decodeChunk(encodeChunk([3, 2], Uint8Array.of(1, 2, 3, 4, 5)));
  assert.deepEqual(frames(d), [[1, 2, 3], [4, 5]]);
});

test('layout is u16 LE count, u16 LE lengths, then payload', () => {
  assert.deepEqual([...encodeChunk([3, 2], Uint8Array.of(1, 2, 3, 4, 5))],
    [2, 0, 3, 0, 2, 0, 1, 2, 3, 4, 5]);
});

test('lengths above 255 use both bytes', () => {
  const data = new Uint8Array(300).fill(7);
  const d = decodeChunk(encodeChunk([300], data));
  assert.equal(d.frames.length, 1);
  assert.equal(d.frames[0].length, 300);
});

test('empty chunk has no frames', () => {
  assert.deepEqual(decodeChunk(encodeChunk([], new Uint8Array(0))).frames, []);
});

test('decoded frames are independent of the input buffer', () => {
  const buf = encodeChunk([2], Uint8Array.of(9, 8));
  const d = decodeChunk(buf);
  buf.fill(0);
  assert.deepEqual([...d.frames[0]], [9, 8]);
});

test('decoded frames are copies even when the input is a Node Buffer', () => {
  const buf = Buffer.from(encodeChunk([2], Uint8Array.of(9, 8)));
  const d = decodeChunk(buf);
  buf.fill(0);
  assert.deepEqual([...d.frames[0]], [9, 8]);
});

test('decodeChunk reads a view at a non-zero byteOffset', () => {
  const enc = encodeChunk([2], Uint8Array.of(5, 6));
  const padded = new Uint8Array(enc.length + 3);
  padded.set(enc, 3);
  assert.deepEqual(frames(decodeChunk(padded.subarray(3))), [[5, 6]]);
});

test('bad lengths throw', () =>
  assert.throws(() => decodeChunk(Uint8Array.of(1, 0, 9, 0, 1)), RangeError));

test('lengths shorter than payload throw', () =>
  assert.throws(() => decodeChunk(Uint8Array.of(1, 0, 1, 0, 1, 2)), RangeError));

test('truncated header throws', () => {
  assert.throws(() => decodeChunk(Uint8Array.of(1)), RangeError);
  assert.throws(() => decodeChunk(Uint8Array.of(2, 0, 1, 0)), RangeError);
});

test('encodeChunk rejects lengths that do not match data', () => {
  assert.throws(() => encodeChunk([3], Uint8Array.of(1, 2)), RangeError);
});
