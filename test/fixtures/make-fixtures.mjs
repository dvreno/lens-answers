// Synthetic speech fixtures for audio tests. Uses macOS `say` and ffmpeg.
// Files live under os.tmpdir() only, are removed once read, and are cached
// per process so `say` runs once per sentence.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFMPEG = '/opt/homebrew/bin/ffmpeg';

export const SENTENCES = {
  hello: 'Hello there, this is a test.',
  library: 'What time does the library open on Friday?',
};

const cache = new Map();

/** Ogg Opus bytes (16 kHz mono, 20 ms frames) of a synthetic sentence. */
export function fixtureOgg(name) {
  const text = SENTENCES[name];
  if (!text) throw new Error(`unknown fixture ${name}`);
  if (!cache.has(name)) {
    const dir = mkdtempSync(join(tmpdir(), 'lens-fixture-'));
    try {
      const aiff = join(dir, `${name}.aiff`);
      const ogg = join(dir, `${name}.ogg`);
      execFileSync('say', ['-o', aiff, text]);
      execFileSync(FFMPEG, ['-v', 'error', '-y', '-i', aiff, '-c:a', 'libopus',
        '-ar', '16000', '-ac', '1', '-frame_duration', '20', ogg]);
      cache.set(name, new Uint8Array(readFileSync(ogg)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return Promise.resolve(cache.get(name));
}
