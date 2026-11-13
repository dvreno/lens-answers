import test from 'node:test';
import assert from 'node:assert/strict';
import { oggPackets } from './helpers/ogg-packets.mjs';
import { fixtureOgg } from './fixtures/make-fixtures.mjs';
import { createOpusDecoder } from '../server/audio/opus.mjs';

test('decodes a 20 ms frame to 320 samples', async () => {
  const [pkt] = oggPackets(await fixtureOgg('hello'));
  const dec = await createOpusDecoder();
  const pcm = dec.decode(pkt);
  assert.ok(pcm instanceof Int16Array);
  assert.equal(pcm.length, 320);
  dec.free();
});

test('decoded speech carries signal and stays within int16', async () => {
  const packets = oggPackets(await fixtureOgg('library'));
  assert.ok(packets.length > 20);
  const dec = await createOpusDecoder();
  let peak = 0;
  let total = 0;
  for (const p of packets) {
    const pcm = dec.decode(p);
    total += pcm.length;
    for (const s of pcm) peak = Math.max(peak, Math.abs(s));
  }
  assert.equal(total, packets.length * 320);
  assert.ok(peak > 1000, `peak ${peak} too quiet`);
  assert.ok(peak <= 32768);
  dec.free();
});

test('decoders are independent instances', async () => {
  const [pkt] = oggPackets(await fixtureOgg('hello'));
  const a = await createOpusDecoder();
  const b = await createOpusDecoder();
  a.free();
  assert.equal(b.decode(pkt).length, 320);
  b.free();
});
