// Opus frame -> 16 kHz mono PCM (Int16).
import { OpusDecoder } from 'opus-decoder';

const SAMPLE_RATE = 16000;

/**
 * @returns {Promise<{decode(frame: Uint8Array): Int16Array, free(): void}>}
 * decode() returns however many samples the packet holds (320 for 20 ms).
 */
export async function createOpusDecoder() {
  const dec = new OpusDecoder({ sampleRate: SAMPLE_RATE, channels: 1 });
  await dec.ready;
  return {
    decode(frame) {
      const { channelData, samplesDecoded } = dec.decodeFrame(frame);
      const f32 = channelData[0];
      const out = new Int16Array(samplesDecoded);
      for (let i = 0; i < samplesDecoded; i++) {
        const v = Math.round(f32[i] * 32768);
        out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
      return out;
    },
    free() { dec.free(); },
  };
}
