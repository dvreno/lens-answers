// Browser Studio smoke test: loads the phone plugin into the PhoneSDK Browser Studio (virtual glasses),
// runs the Lens Answers server IN THIS PROCESS, connects the plugin to it, speaks one synthetic question
// and waits for the card text to be drawn on the virtual lens. Then it speaks two more questions and, while
// both model slots are busy, a spoken pause: the lens must read paused at once and no card may follow.
// Saves screenshots to OUT_DIR.
//
// Studio has no microphone and the server takes one client, so the audio does not travel over the socket:
// synthetic PCM goes in through the server's local `feedPcm` test hook (segmenter -> pipeline, skipping only
// the WebSocket and the Opus decode). The plugin's capture path is therefore NOT exercised here.
// Speech-to-text, the model and the card are real (audio.cpp server and `claude` must be available);
// set FAKE_ASR=1 to use a fixed synthetic sentence in place of the speech server.
//
// Prereqs:  npm run setup;  Browser Studio running with this plugin:
//   node <plugin-open-platform>/PhoneSDK/tools/run-browser-studio.mjs --plugin <repo>/phone --port 4173
// Run:      STUDIO_URL=http://127.0.0.1:4173 OUT_DIR=/some/dir node test/studio-smoke.mjs
// The token is a throwaway one in os.tmpdir(), never printed. The sentence and card are synthetic.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { startServer } from '../server/server.mjs';
import { createUnderstand } from '../server/understand.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const STUDIO = process.env.STUDIO_URL || 'http://127.0.0.1:4173';
const OUT = process.env.OUT_DIR || mkdtempSync(join(tmpdir(), 'lens-smoke-out-')); // never inside the repo by default
const FFMPEG = process.env.FFMPEG || 'ffmpeg'; // from the PATH, or the program named in FFMPEG
const SENTENCE = 'How tall is Mount Everest?';
const KEYWORD = 'Everest';

// 16 kHz mono PCM of the sentence plus 1.2 s of silence, built in memory (the temp file is removed at once).
function synthPcm(text) {
  const dir = mkdtempSync(join(tmpdir(), 'lens-smoke-'));
  try {
    const aiff = join(dir, 's.aiff');
    execFileSync('say', ['-o', aiff, text]);
    const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', aiff, '-af', 'apad=pad_dur=1.2', '-f', 's16le', '-ar', '16000', '-ac', '1', '-'],
      { maxBuffer: 64 * 1024 * 1024 });
    const pcm = new Int16Array(raw.length >> 1);
    for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(i * 2);
    return pcm;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const dir = mkdtempSync(join(tmpdir(), 'lens-studio-smoke-'));
const config = { ...loadConfig(), port: 0, tokenFile: join(dir, 'token') };
// Counts understand (model) calls so the pause scenario can prove a spoken pause never waited for one.
const understandStats = { calls: 0, inFlight: 0, inFlightAtPause: null };
const deps = {
  briefsAreStale: () => false,
  log: (line) => { if (line === 'intent pause') understandStats.inFlightAtPause = understandStats.inFlight; },
  createUnderstand: (args) => {
    const real = createUnderstand(args);
    return async (...a) => {
      understandStats.calls++;
      understandStats.inFlight++;
      try { return await real(...a); } finally { understandStats.inFlight--; }
    };
  },
};
if (process.env.FAKE_ASR) deps.createAsr = () => ({ async transcribe() { return { text: SENTENCE, via: 'local' }; } });
const server = await startServer(config, deps);
const token = readFileSync(config.tokenFile, 'utf8').trim();

// CHROMIUM_PATH: use a browser already on disk when the installed Playwright expects a newer download.
const launchOptions = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
let browser = null;
let failed = null;
try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('dialog', (dialog) => dialog.accept());
  // Record every request the plugin makes to the Studio host: the text drawn on the lens is in them.
  await page.addInitScript(() => {
    window.__requests = [];
    window.addEventListener('message', (m) => {
      if (m.data?.type === 'gm-plugin:request') window.__requests.push(JSON.stringify(m.data.request));
    });
  });
  await page.goto(STUDIO);

  // Studio asks for permissions first (the dialog text may be in Chinese): tick everything, then start.
  const approve = page.getByRole('button', { name: /按所选权限启动|start with|approve|allow|grant|confirm/i }).first();
  if (await approve.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
    for (const box of await page.locator('dialog input[type=checkbox], [role=dialog] input[type=checkbox]').all()) await box.check();
    await approve.click();
  }

  const frame = page.frameLocator('#plugin-frame');
  await frame.locator('#server-url').fill(`127.0.0.1:${server.port}`);
  await frame.locator('#server-token').fill(token);
  await frame.locator('#save').click();
  await frame.locator('#status[data-state="listening"]').waitFor({ timeout: 15000 });
  console.log('• plugin connected to the server, status listening');

  // The plugin opens a capture session for the (silent) Studio mic; the segmenter ignores silence.
  const pcm = synthPcm(SENTENCE);
  const sentAt = Date.now();
  assert.equal(server.feedPcm(pcm), true, 'a client is connected');
  console.log('• synthetic question fed in');

  await page.waitForFunction((word) => window.__requests.some((r) => r.includes(word) && r.includes('updateText')),
    KEYWORD, { timeout: 60000 });
  const seen = Date.now() - sentAt;
  await page.waitForTimeout(500);
  await page.locator('#device-canvas').screenshot({ path: join(OUT, 'lens-answers-card.png') });
  const requests = await page.evaluate(() => window.__requests);
  const drawn = requests.filter((r) => r.includes('updateText'));
  assert.ok(drawn.some((r) => r.includes('They ask')), 'the heard line was drawn');
  assert.ok(drawn.some((r) => r.includes('General knowledge')), 'the source line was drawn');
  console.log(`• card text drawn on the virtual lens ${seen} ms after feeding audio (includes 1.2 s of trailing silence)`);
  console.log(`• screenshot written to ${join(OUT, 'lens-answers-card.png')}`);

  // Pause scenario: two questions hold both understand slots, then a spoken pause. The lens must read
  // paused while both model calls are still in flight, and no card may follow.
  await frame.locator('#status[data-state="listening"]').waitFor({ timeout: 15000 });
  const callsBefore = understandStats.calls;
  const cardsBefore = (await page.evaluate(() => window.__requests)).filter((r) => r.includes('They ask')).length;
  server.feedPcm(synthPcm('What is the capital of France?'));
  server.feedPcm(synthPcm('How far away is the moon?'));
  const busyBy = Date.now() + 15000;
  while (understandStats.inFlight < 2 && Date.now() < busyBy) await new Promise((r) => setTimeout(r, 25));
  assert.equal(understandStats.inFlight, 2, 'both understand slots are busy');
  console.log('• two questions in flight, both model slots busy');
  const pausePcm = synthPcm('Okay, stop listening.');
  const pauseAt = Date.now();
  server.feedPcm(pausePcm);
  await frame.locator('#status[data-state="paused"]').waitFor({ timeout: 30000 });
  const pausedMs = Date.now() - pauseAt;
  await page.waitForFunction(() => window.__requests.some((r) => r.includes('updateText') && r.includes('paused')),
    null, { timeout: 5000 });
  await page.waitForTimeout(500);
  await page.locator('#device-canvas').screenshot({ path: join(OUT, 'lens-answers-paused.png') });
  console.log(`• lens read paused ${pausedMs} ms after feeding the pause audio; ` +
    `model calls in flight at that moment: ${understandStats.inFlightAtPause}; ` +
    `model calls made for the three sentences: ${understandStats.calls - callsBefore}`);
  await page.waitForTimeout(12000); // long enough for both discarded questions to have answered
  const cardsAfter = (await page.evaluate(() => window.__requests)).filter((r) => r.includes('They ask')).length;
  console.log(`• cards drawn after the pause: ${cardsAfter - cardsBefore}`);
  assert.equal(understandStats.inFlightAtPause, 2, 'the pause acted while both model calls were still in flight');
  assert.equal(understandStats.calls - callsBefore, 2, 'the pause sentence never went to the model');
  assert.equal(cardsAfter, cardsBefore, 'no card follows a spoken pause');
  assert.equal(await frame.locator('#status').getAttribute('data-state'), 'paused', 'still paused');
  console.log(`• screenshot written to ${join(OUT, 'lens-answers-paused.png')}`);
} catch (e) {
  failed = e;
} finally {
  await browser?.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
}
if (failed) {
  console.error(`studio-smoke FAILED: ${failed.message}`);
  process.exit(1);
}
console.log('studio-smoke OK');
process.exit(0);
