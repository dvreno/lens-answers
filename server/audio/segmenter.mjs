// Cuts a 16 kHz mono Int16 PCM stream into utterances with an energy (RMS) VAD.
// Nothing is returned (so nothing is transcribed) until real speech is heard.

const RATE = 16000;
const FRAME = 320; // 20 ms
const FRAME_MS = 20;
const START_THRESHOLD = 500; // RMS used until the noise floor has been measured
const FLOOR_FACTOR = 3; // to START an utterance, a frame must beat the noise floor by this much
// Once an utterance has started, a frame only has to beat the floor by this much to count
// as "still talking". Soft words and trailing ends sit between the two factors; without
// the lower bar they were counted as silence and ended the sentence early.
const CONTINUE_FACTOR = 1.5;
// Frames kept from just before the first loud frame (300 ms), so a soft first word
// ("what", "how") that did not reach the start threshold is still sent to speech-to-text.
const PRE_ROLL_FRAMES = 15;
const FLOOR_MIN = 50; // never trust a floor quieter than this (threshold >= 150)
const FLOOR_ALPHA = 0.05; // per quiet frame
// Noise-step recovery: if STEADY_FRAMES uninterrupted "speech" frames stay within
// STEADY_RATIO of each other it is a constant noise (fan, TV, gain change), not
// speech. The floor is re-seeded to that level, so the longest a noise step can
// keep the segmenter "in speech" is STEADY_FRAMES x 20 ms = 3 s (well under
// maxUtteranceMs), and the clip made only of that noise is dropped, never sent on.
const STEADY_FRAMES = 150;
const STEADY_RATIO = 2.5;

function rms(pcm, from) {
  let sum = 0;
  for (let i = from; i < from + FRAME; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / FRAME);
}

/**
 * Group talk rarely leaves a long pause, so two more rules end a sentence (both optional):
 *   - `shorten`: once the talk has run `afterMs` (counted up to the last word), `silenceMs` of quiet is
 *     enough, e.g. [{afterMs: 4000, silenceMs: 400}, {afterMs: 8000, silenceMs: 200}];
 *   - `cutSearchMs`: at `maxUtteranceMs` the clip is cut at the quietest slice of its last `cutSearchMs`
 *     (usually between words) instead of at the limit, and what follows the cut starts the next clip.
 * @param {{silenceMs:number, minSpeechMs:number, maxUtteranceMs:number,
 *   shorten?: {afterMs:number, silenceMs:number}[], cutSearchMs?: number}} vad
 * @returns {{push(pcm: Int16Array): Int16Array|null, reset(): void, setSilenceMs(ms: number): void,
 *   stats(): {quiet: number, speech: number, floor: number, lastEnd: null|'quiet'|'max'}}}
 *
 * push() returns at most one finished utterance per call. If a chunk holds more
 * audio after the point where an utterance ended, that audio is kept and
 * processed on the next push (push an empty array to drain it).
 */
export function createSegmenter(vad) {
  let silenceFrames = Math.ceil(vad.silenceMs / FRAME_MS);
  const minSpeechFrames = Math.ceil(vad.minSpeechMs / FRAME_MS);
  const maxFrames = Math.floor(vad.maxUtteranceMs / FRAME_MS);
  const shorten = (Array.isArray(vad.shorten) ? vad.shorten : [])
    .filter((r) => r && r.afterMs > 0 && r.silenceMs > 0)
    .map((r) => ({ after: Math.ceil(r.afterMs / FRAME_MS), silence: Math.ceil(r.silenceMs / FRAME_MS) }));
  const cutFrames = vad.cutSearchMs > 0 ? Math.ceil(vad.cutSearchMs / FRAME_MS) : 0;

  let carry = new Int16Array(0); // samples not yet framed
  let floor = START_THRESHOLD / FLOOR_FACTOR;
  let lead = []; // the last quiet frames while waiting for speech (the look-back)
  let frames = []; // frames of the utterance in progress, speech or not
  let levels = []; // parallel to `frames`: each frame's loudness (Infinity for look-back frames, never a cut point)
  let flags = []; // parallel to `frames`: whether the frame counted as speech
  let leadCount = 0; // how many look-back frames `frames` starts with
  let speechFrames = 0;
  let lastSpeech = -1; // index into frames
  let quietRun = 0;
  let runLen = 0; // consecutive speech frames, with their level range
  let runMin = Infinity;
  let runMax = 0;
  const totals = { quiet: 0, speech: 0 }; // slices judged quiet or speech since the start (never reset)
  let lastEnd = null; // why the last returned sentence ended: 'quiet' or 'max'

  function clearRun() {
    runLen = 0;
    runMin = Infinity;
    runMax = 0;
  }

  function clearUtterance() {
    frames = [];
    levels = [];
    flags = [];
    leadCount = 0;
    speechFrames = 0;
    lastSpeech = -1;
    quietRun = 0;
    clearRun();
  }

  function join(list) {
    const out = new Int16Array(list.length * FRAME);
    list.forEach((f, i) => out.set(f, i * FRAME));
    return out;
  }

  function finish(end, why) {
    const keep = speechFrames >= minSpeechFrames ? join(frames.slice(0, end)) : null;
    if (keep) lastEnd = why;
    clearUtterance();
    return keep;
  }

  // Quiet needed to end the sentence now: less once the talk (up to its last word) has run long.
  function silenceNeeded() {
    const spoken = lastSpeech + 1 - leadCount;
    let need = silenceFrames;
    for (const r of shorten) if (spoken >= r.after && r.silence < need) need = r.silence;
    return need;
  }

  // The length limit: cut at the quietest of the last `cutFrames` frames (the latest of equals, so a clip
  // with no dip is cut at the limit). The frames after the cut become the start of the next utterance.
  function cutAtLimit() {
    let cut = frames.length - 1;
    if (cutFrames > 0) {
      let best = Infinity;
      for (let i = Math.max(leadCount + minSpeechFrames, frames.length - cutFrames); i < frames.length; i++) {
        if (levels[i] <= best) { best = levels[i]; cut = i; }
      }
    }
    const rest = { frames: frames.slice(cut + 1), levels: levels.slice(cut + 1), flags: flags.slice(cut + 1) };
    const spoken = flags.slice(0, cut + 1).filter(Boolean).length;
    const keep = spoken >= minSpeechFrames ? join(frames.slice(0, cut + 1)) : null;
    if (keep) lastEnd = 'max';
    clearUtterance();
    if (rest.frames.length) {
      ({ frames, levels, flags } = rest);
      speechFrames = flags.filter(Boolean).length;
      lastSpeech = flags.lastIndexOf(true);
      quietRun = flags.length - 1 - lastSpeech;
    }
    return keep;
  }

  function onFrame(frame, level) {
    const waiting = frames.length === 0;
    const speech = level > floor * (waiting ? FLOOR_FACTOR : CONTINUE_FACTOR);
    if (speech) totals.speech++;
    else totals.quiet++;
    if (!speech) {
      floor = Math.max(FLOOR_MIN, floor + (level - floor) * FLOOR_ALPHA);
      clearRun();
    } else {
      runLen++;
      runMin = Math.min(runMin, level);
      runMax = Math.max(runMax, level);
    }
    if (waiting && !speech) { // still waiting for speech
      lead.push(frame);
      if (lead.length > PRE_ROLL_FRAMES) lead.shift();
      return null;
    }
    if (waiting) {
      frames = lead;
      leadCount = lead.length;
      levels = lead.map(() => Infinity);
      flags = lead.map(() => false);
      lead = [];
    }
    frames.push(frame);
    levels.push(level);
    flags.push(speech);
    if (speech) {
      speechFrames++;
      lastSpeech = frames.length - 1;
      quietRun = 0;
    } else {
      quietRun++;
    }
    if (runLen >= STEADY_FRAMES) {
      if (runMax <= runMin * STEADY_RATIO) {
        floor = Math.max(FLOOR_MIN, runMin);
        if (frames.length - leadCount <= runLen) clearUtterance(); // nothing but the noise
      }
      clearRun();
      if (frames.length === 0) return null;
    }
    if (quietRun >= silenceNeeded()) return finish(lastSpeech + 1, 'quiet'); // drop the trailing quiet
    if (frames.length >= maxFrames) return cutAtLimit();
    return null;
  }

  function push(pcm) {
    if (pcm.length) {
      const all = new Int16Array(carry.length + pcm.length);
      all.set(carry);
      all.set(pcm, carry.length);
      carry = all;
    }
    let at = 0;
    while (at + FRAME <= carry.length) {
      const level = rms(carry, at);
      const frame = carry.slice(at, at + FRAME);
      at += FRAME;
      const done = onFrame(frame, level);
      if (done) {
        carry = carry.slice(at);
        return done;
      }
    }
    carry = carry.slice(at);
    return null;
  }

  function reset() {
    carry = new Int16Array(0);
    floor = START_THRESHOLD / FLOOR_FACTOR;
    lead = [];
    clearUtterance();
  }

  /** Change the quiet that ends a sentence (work mode waits longer). Applies from the next frame. */
  function setSilenceMs(ms) {
    if (typeof ms === 'number' && ms > 0) silenceFrames = Math.ceil(ms / FRAME_MS);
  }

  /**
   * Numbers for the log, never audio: slices judged quiet and speech so far, the measured background level,
   * and why the last sentence ended. Mostly-speech audio whose sentences end by 'max' means the quiet between
   * sentences is not being recognised (or there is none).
   */
  const stats = () => ({ quiet: totals.quiet, speech: totals.speech, floor: Math.round(floor), lastEnd });

  return { push, reset, setSilenceMs, stats };
}
