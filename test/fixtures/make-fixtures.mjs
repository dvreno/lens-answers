// The audio fixture for tests: 2.4 s of a wavering two-tone hum as Ogg Opus (16 kHz mono, 20 ms frames).
// It is a committed file (test/fixtures/tone.ogg), so the tests need no speech synthesiser and no ffmpeg
// and run the same on macOS, Linux and Windows. It is loud from its first frame and never silent.
//
// To make it again (needs ffmpeg on the PATH):
//   ffmpeg -y -f lavfi -i "aevalsrc='0.45*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*3*t))+0.2*sin(2*PI*540*t)*(0.5+0.5*sin(2*PI*5*t))':s=16000:d=2.4" \
//     -c:a libopus -b:a 16k -ar 16000 -ac 1 -frame_duration 20 -map_metadata -1 test/fixtures/tone.ogg
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let bytes = null;

/** Ogg Opus bytes of the fixture. */
export function fixtureOgg() {
  bytes ??= new Uint8Array(readFileSync(fileURLToPath(new URL('./tone.ogg', import.meta.url))));
  return Promise.resolve(bytes);
}
