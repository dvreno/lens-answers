import test from 'node:test';
import assert from 'node:assert/strict';
import { createSegmenter } from '../server/audio/segmenter.mjs';

const RATE = 16000;
// Pinned here (not read from the defaults) so these tests describe the segmenter, not the config.
const vad = { silenceMs: 700, minSpeechMs: 400, maxUtteranceMs: 20000 };

const tone = (ms, amp = 8000) =>
  Int16Array.from({ length: (RATE * ms) / 1000 }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * 1000 * i) / RATE)));
const zeros = (ms) => new Int16Array((RATE * ms) / 1000);
const cat = (...parts) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

// Feed `pcm` in 20 ms pieces, collect every non-null result.
function feed(seg, pcm, chunk = 320) {
  const out = [];
  for (let i = 0; i < pcm.length; i += chunk) {
    const r = seg.push(pcm.subarray(i, i + chunk));
    if (r) out.push(r);
  }
  return out;
}

test('silence only yields nothing', () => {
  const seg = createSegmenter(vad);
  assert.deepEqual(feed(seg, zeros(3000)), []);
});

test('speech then 700 ms silence yields one utterance', () => {
  const seg = createSegmenter(vad);
  const out = feed(seg, cat(tone(1000), zeros(800)));
  assert.equal(out.length, 1);
  assert.ok(out[0] instanceof Int16Array);
  assert.ok(Math.abs(out[0].length - 16000) <= 1600, `length ${out[0].length}`);
  assert.ok(out[0].some((s) => Math.abs(s) > 4000), 'utterance carries the tone');
});

test('a 200 ms blip is ignored', () => {
  const seg = createSegmenter(vad);
  assert.deepEqual(feed(seg, cat(tone(200), zeros(1500))), []);
  // and the segmenter still works afterwards
  assert.equal(feed(seg, cat(tone(1000), zeros(800))).length, 1);
});

test('cuts at maxUtteranceMs', () => {
  const seg = createSegmenter(vad);
  // Varying loudness (a perfectly steady tone would be treated as noise after 3 s).
  const syllables = cat(...Array.from({ length: 250 }, (_, i) => tone(100, i % 2 ? 2000 : 8000)));
  const out = feed(seg, syllables);
  assert.equal(out.length, 1);
  assert.equal(out[0].length, (RATE * vad.maxUtteranceMs) / 1000);
});

test('accepts chunks that are not frame-aligned', () => {
  const seg = createSegmenter(vad);
  const out = feed(seg, cat(tone(1000), zeros(800)), 137);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].length - 16000) <= 1600);
});

test('a short pause inside speech does not split the utterance', () => {
  const seg = createSegmenter(vad);
  const out = feed(seg, cat(tone(600), zeros(300), tone(600), zeros(800)));
  assert.equal(out.length, 1);
  assert.ok(out[0].length >= 16000 + 4000, `length ${out[0].length}`); // keeps the gap
});

test('threshold adapts to the noise floor', () => {
  // On a quiet line, a tone of amplitude 1500 (RMS ~1060) is speech (> 500)...
  const quiet = createSegmenter(vad);
  assert.equal(feed(quiet, cat(tone(1000, 1500), zeros(800))).length, 1);
  // ...but after 3 s of steady 600-amplitude hum (RMS ~424, under 500) the floor rises
  // to ~424, the threshold to ~1270, and the same tone is now background.
  const noisy = createSegmenter(vad);
  assert.deepEqual(feed(noisy, tone(3000, 600)), []);
  assert.deepEqual(feed(noisy, cat(tone(1000, 1500), tone(800, 600))), []);
  // Clearly louder speech still gets through.
  assert.equal(feed(noisy, cat(tone(1000, 8000), tone(800, 600))).length, 1);
});

test('a sustained noise step stops producing utterances, and speech over it still works', () => {
  const seg = createSegmenter(vad);
  // Long quiet stretch: the floor decays to its minimum (threshold ~150).
  assert.deepEqual(feed(seg, zeros(5000)), []);
  // Fan switches on: steady RMS ~566. Bound: the segmenter re-seeds its floor after
  // 3 s of steady noise, so it must never emit (no 20 s clips) over 15 s of it.
  assert.deepEqual(feed(seg, tone(15000, 800)), []);
  // Speech on top of the new noise level: one utterance, hum around it ignored.
  const out = feed(seg, cat(tone(1000, 8000), tone(1500, 800)));
  assert.equal(out.length, 1);
  // 1 s of speech plus the 300 ms look-back (hum) in front of it.
  assert.ok(Math.abs(out[0].length - (16000 + 4800)) <= 1600, `length ${out[0].length}`);
});

test('reset discards a half-finished utterance', () => {
  const seg = createSegmenter(vad);
  assert.deepEqual(feed(seg, tone(1000)), []);
  seg.reset();
  assert.deepEqual(feed(seg, zeros(1500)), []);
});

test('a soft first word just before the loud part is kept (300 ms look-back)', () => {
  const seg = createSegmenter(vad);
  // 1 s of quiet settles the floor at its minimum (start threshold ~150 RMS). The soft
  // onset (amplitude 150, RMS ~106) is under that threshold, so it cannot start an utterance.
  const out = feed(seg, cat(zeros(1000), tone(300, 150), tone(1000), zeros(800)));
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].length - (16000 + 4800)) <= 320, `length ${out[0].length}`);
  const lead = out[0].subarray(0, 4800);
  const peak = lead.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  assert.ok(peak > 100 && peak <= 150, `the look-back holds the soft onset, peak ${peak}`);
});

test('the look-back never reaches into the previous utterance', () => {
  const seg = createSegmenter(vad);
  const out = feed(seg, cat(tone(1000), zeros(720), tone(1000, 4000), zeros(800)));
  assert.equal(out.length, 2);
  assert.ok(!out[1].some((s) => Math.abs(s) > 4000), 'second utterance holds none of the first tone');
});

test('soft speech in the middle of a sentence does not end it', () => {
  const seg = createSegmenter(vad);
  // After 1 s of quiet the floor is 50: starting needs RMS > 150, continuing only > 75.
  // The middle 900 ms (amplitude 180, RMS ~127) is longer than silenceMs and under the
  // start threshold, but it is still someone talking.
  const out = feed(seg, cat(zeros(1000), tone(600), tone(900, 180), tone(600), zeros(800)));
  assert.equal(out.length, 1);
  assert.ok(out[0].length >= (RATE * 2100) / 1000, `length ${out[0].length}`);
});

test('soft sound alone still cannot start an utterance', () => {
  const seg = createSegmenter(vad);
  assert.deepEqual(feed(seg, cat(zeros(1000), tone(2000, 180), zeros(1000))), []);
});

test('noise-only clips are still dropped when a look-back is in front of them', () => {
  const seg = createSegmenter(vad);
  // Quiet room noise, then a fan: nothing but steady noise, so nothing may come out.
  assert.deepEqual(feed(seg, cat(tone(2000, 60), tone(15000, 800), tone(3000, 60))), []);
});

test('setSilenceMs changes how long a pause may be before the sentence ends', () => {
  const seg = createSegmenter(vad);
  const pausedSentence = cat(tone(600), zeros(1000), tone(600), zeros(1700));
  assert.equal(feed(seg, pausedSentence).length, 2, 'at 700 ms a 1 s pause splits the sentence');
  seg.setSilenceMs(1500);
  const out = feed(seg, pausedSentence);
  assert.equal(out.length, 1, 'at 1500 ms the same pause is part of one sentence');
  assert.ok(out[0].length >= 16000 * 2.2, `both halves and the pause: ${out[0].length}`);
  seg.setSilenceMs(700);
  assert.equal(feed(seg, pausedSentence).length, 2);
});

test('setSilenceMs ignores values that are not a positive number', () => {
  const seg = createSegmenter(vad);
  for (const bad of [0, -5, NaN, '1500', undefined]) seg.setSilenceMs(bad);
  assert.equal(feed(seg, cat(tone(600), zeros(1000), tone(600), zeros(1000))).length, 2, 'still 700 ms');
});

test('stats: how many slices were quiet or speech, the background level, and why the last sentence ended', () => {
  const seg = createSegmenter({ ...vad, maxUtteranceMs: 2000 });
  assert.deepEqual(seg.stats(), { quiet: 0, speech: 0, floor: 167, lastEnd: null });
  assert.equal(feed(seg, cat(tone(600), zeros(800))).length, 1);
  let s = seg.stats();
  assert.equal(s.speech, 30);
  assert.equal(s.quiet, 40, 'every quiet slice is counted, also the ones after the sentence ended');
  assert.equal(s.lastEnd, 'quiet');
  assert.ok(s.floor >= 50 && s.floor < 167, `the background level followed the silence: ${s.floor}`);
  assert.equal(feed(seg, tone(2500)).length, 1); // never quiet: cut at the 2 s limit
  s = seg.stats();
  assert.equal(s.lastEnd, 'max');
  assert.equal(s.quiet, 40);
  assert.equal(s.speech, 30 + 125);
});

// ---- group talk: no long pauses ---------------------------------------------------

// Loud talk whose loudness varies from syllable to syllable (a steady tone would be taken for noise).
const talk = (ms) => cat(...Array.from({ length: ms / 100 }, (_, i) => tone(100, i % 2 ? 2000 : 8000)));
const seconds = (pcm) => pcm.length / RATE;
const near = (actual, expected, slack = 0.15) => assert.ok(Math.abs(actual - expected) <= slack, `${actual} s, expected about ${expected} s`);
const groupVad = { silenceMs: 1000, minSpeechMs: 400, maxUtteranceMs: 10000,
  shorten: [{ afterMs: 4000, silenceMs: 400 }, { afterMs: 8000, silenceMs: 200 }], cutSearchMs: 2000 };

test('once a sentence has run 4 s, a 400 ms pause ends it', () => {
  const audio = cat(talk(5000), zeros(500), talk(2000), zeros(1100));
  const out = feed(createSegmenter(groupVad), audio);
  assert.equal(out.length, 2);
  near(seconds(out[0]), 5.0);
  near(seconds(out[1]), 2.0 + 0.1, 0.25); // plus the look-back left over from the pause
  assert.equal(feed(createSegmenter({ ...groupVad, shorten: [] }), audio).length, 1, 'without the rule the pause is too short');
});

test('a short sentence still gets the full wait', () => {
  const out = feed(createSegmenter(groupVad), cat(talk(2000), zeros(500), talk(1000), zeros(1100)));
  assert.equal(out.length, 1);
  near(seconds(out[0]), 3.5);
});

test('the 4 s are counted up to the last word, not through the pause after it', () => {
  // 3.7 s of talk: the pause that follows must not push it over 4 s and end it early.
  const out = feed(createSegmenter(groupVad), cat(talk(3700), zeros(600), talk(1000), zeros(1100)));
  assert.equal(out.length, 1);
});

test('once a sentence has run 8 s, a 200 ms pause ends it', () => {
  const audio = cat(talk(8500), zeros(260), talk(1000), zeros(1100));
  assert.equal(feed(createSegmenter(groupVad), audio).length, 2);
  assert.equal(feed(createSegmenter({ ...groupVad, shorten: [groupVad.shorten[0]] }), audio).length, 1);
});

test('work mode: the longer first wait applies, the shorter later waits stay', () => {
  const seg = createSegmenter(groupVad);
  seg.setSilenceMs(1500);
  assert.equal(feed(seg, cat(talk(2000), zeros(1200), talk(1000), zeros(1600))).length, 1, 'a 1.2 s pause early on does not end it');
  assert.equal(feed(seg, cat(talk(5000), zeros(500), talk(1000), zeros(1600))).length, 2, 'after 4 s a 400 ms pause does');
});

test('talk with no pause is cut at its quietest moment near the limit, and nothing is lost', () => {
  // 13 s without a pause; the only dip is 100 ms of soft speech at 9.0 s (softer, but not quiet).
  const audio = cat(talk(9000), tone(100, 600), talk(3900), zeros(1100));
  const seg = createSegmenter(groupVad);
  const out = feed(seg, audio);
  assert.equal(out.length, 2);
  near(seconds(out[0]), 9.1, 0.001); // cut at the end of the dip, not at the 10 s limit
  near(seconds(out[1]), 3.9, 0.001); // what followed the cut starts the next clip
  assert.equal(seg.stats().lastEnd, 'quiet');
  const dipFrame = out[0].subarray(out[0].length - 320);
  assert.ok(Math.max(...dipFrame.map(Math.abs)) <= 600, 'the first clip ends on the soft part');
  assert.ok(Math.max(...out[1].subarray(0, 320).map(Math.abs)) >= 2000, 'the second starts with the talk after it');
});

test('without a dip to find, the cut is at the limit as before', () => {
  const out = feed(createSegmenter({ ...groupVad, cutSearchMs: 0 }), cat(talk(9000), tone(100, 600), talk(3900), zeros(1100)));
  near(seconds(out[0]), 10.0, 0.001);
});
