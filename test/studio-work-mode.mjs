// Browser Studio check of the work-mode switch in the phone plugin (phone/plugin.js has no unit tests).
// Runs the Lens Answers server IN THIS PROCESS with a fake for every outside dependency: no speech server,
// no model, no notes. Everything spoken, asked and answered here is synthetic.
//
// Checks: ticking "Work mode" is confirmed by the server and shown on the phone page and the lens; a question
// asked in work mode gets the work answerer's card; a long press on the glasses button turns work mode off
// and on; after a reconnect the plugin asks the server for work mode again; on a server with no notes source
// the box switches itself off, a long press does nothing, and the saved choice returns afterwards.
// Not checked here: that the choice is still there after the plugin page is reloaded (Browser Studio does
// not keep plugin storage across a reload).
//
// Prereqs:  npm run setup;  Browser Studio running with this plugin:
//   node <plugin-open-platform>/PhoneSDK/tools/run-browser-studio.mjs --plugin <repo>/phone --port 4173
// Run:      STUDIO_URL=http://127.0.0.1:4173 node test/studio-work-mode.mjs

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults } from '../server/config.mjs';
import { startServer } from '../server/server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const STUDIO = process.env.STUDIO_URL || 'http://127.0.0.1:4173';

// 600 ms of tone then 1.8 s of quiet: one sentence in either mode (work mode waits 1.5 s).
const sentence = () => {
  const pcm = new Int16Array(16000 * 2.4);
  for (let i = 0; i < 16000 * 0.6; i++) pcm[i] = Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 16000));
  return pcm;
};

const dir = mkdtempSync(join(tmpdir(), 'lens-studio-work-'));
const config = { ...defaults(), port: 0, tokenFile: join(dir, 'token'),
  kb: { root: join(dir, 'kb'), command: ['fake-bridge'], env: {}, timeoutMs: 1000 } };
const card = (heard, source) => ({ heard: `They ask: ${heard}`, source, answer: 'A synthetic answer.', solid: true, ttlMs: 4000 });
const fakes = {
  createAsr: () => ({ async transcribe() { return { text: 'what colour is the sample widget', via: 'local' }; } }),
  createUnderstand: () => async (heard) => ({ kind: 'question', route: 'general', query: heard }),
  createKb: () => ({ async search() { return { passages: [], paths: [], mode: 'none' }; }, close() {} }),
  createStatutes: () => ({ async lookup() { return { passages: [] }; } }),
  createProjects: () => ({ async lookup() { return { passages: [] }; } }),
  createLlm: () => ({ async complete() { return { text: '', sources: [] }; }, close() {} }),
  writeAnswer: async ({ heard }) => card(heard, 'Quick path'),
  loadContextPack: () => '',
  createWorkAnswerer: () => async ({ heard }) => ({ card: card(heard, 'KB · Deep path'), passages: [], paths: [], cited: '', rounds: 1 }),
  briefsAreStale: () => false,
};
const server = await startServer(config, fakes);
const token = readFileSync(config.tokenFile, 'utf8').trim();
// A second server with nothing configured: no notes bridge, so no work mode.
const plainConfig = { ...defaults(), port: 0, tokenFile: join(dir, 'plain-token') };
const plain = await startServer(plainConfig, fakes);
const plainToken = readFileSync(plainConfig.tokenFile, 'utf8').trim();

const launchOptions = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
let browser = null;
let failed = null;
try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  page.on('dialog', (dialog) => dialog.accept());
  await page.addInitScript(() => {
    window.__requests = [];
    window.addEventListener('message', (m) => {
      if (m.data?.type === 'gm-plugin:request') window.__requests.push(JSON.stringify(m.data.request));
    });
  });
  const drawn = (text) => page.waitForFunction(
    ([t, from]) => window.__requests.slice(from).some((r) => r.includes('updateText') && r.includes(t)),
    [text, mark], { timeout: 15000 });
  let mark = 0; // only lens draws after this point count
  const markNow = async () => { mark = await page.evaluate(() => window.__requests.length); };
  const open = async () => {
    await page.goto(STUDIO);
    const approve = page.getByRole('button', { name: /按所选权限启动|start with|approve|allow|grant|confirm/i }).first();
    if (await approve.waitFor({ timeout: 8000 }).then(() => true, () => false)) {
      for (const box of await page.locator('dialog input[type=checkbox], [role=dialog] input[type=checkbox]').all()) await box.check();
      await approve.click();
    }
  };
  const frame = page.frameLocator('#plugin-frame');
  const status = (state) => frame.locator(`#status[data-state="${state}"]`).waitFor({ timeout: 15000 });

  await open();
  await frame.locator('#server-url').fill(`127.0.0.1:${server.port}`);
  await frame.locator('#server-token').fill(token);
  await frame.locator('#save').click();
  await status('listening');
  assert.equal(await frame.locator('#work').isChecked(), false);
  console.log('• connected, automatic mode');

  await markNow();
  await frame.locator('#work').check();
  await status('work');
  assert.equal(await frame.locator('#status').textContent(), 'listening (work mode)');
  await drawn('work mode');
  console.log('• ticking Work mode: confirmed by the server, shown on the phone page and the lens');

  await markNow();
  assert.equal(server.feedPcm(sentence()), true);
  await drawn('KB · Deep path');
  console.log('• a question in work mode got the work answerer\'s card');
  await status('work');

  await markNow();
  await page.locator('[data-button="long"]').click();
  await status('listening');
  assert.equal(await frame.locator('#work').isChecked(), false);
  await drawn('listening');
  server.feedPcm(sentence());
  await drawn('Quick path');
  console.log('• long press: work mode off, the next question took the quick path');
  await status('listening');

  await page.locator('[data-button="long"]').click();
  await status('work');
  assert.equal(await frame.locator('#work').isChecked(), true);
  console.log('• long press again: work mode on');

  // A new connection starts in automatic mode on the server; the plugin must ask for work mode again.
  await frame.locator('#save').click();
  await status('work');
  assert.equal(await frame.locator('#work').isChecked(), true);
  console.log('• after reconnecting, the plugin put the server back in work mode by itself');

  // A server with no notes source: the box switches itself off and a long press does nothing.
  const connectTo = async (port, itsToken) => {
    await frame.locator('#server-url').fill(`127.0.0.1:${port}`);
    await frame.locator('#server-token').fill(itsToken);
    await frame.locator('#save').click();
  };
  await connectTo(plain.port, plainToken);
  await status('listening');
  await frame.locator('#work:disabled').waitFor({ timeout: 15000 });
  assert.equal(await frame.locator('#work').isChecked(), false);
  await page.locator('[data-button="long"]').click();
  await page.waitForTimeout(700);
  assert.equal(await frame.locator('#status').getAttribute('data-state'), 'listening');
  assert.equal(await frame.locator('#work').isChecked(), false);
  console.log('• a server with no notes source: the Work mode box is off and a long press does nothing');
  await connectTo(server.port, token);
  await status('work');
  assert.equal(await frame.locator('#work').isChecked(), true);
  assert.equal(await frame.locator('#work').isDisabled(), false);
  console.log('• back on the server with notes, the saved choice returned by itself');
  await frame.locator('#work').uncheck();
  await status('listening');
} catch (e) {
  failed = e;
  try { // what the phone page said at that moment (status and notice only)
    const f = browser.contexts()[0].pages()[0].frameLocator('#plugin-frame');
    console.error(`phone page: status "${await f.locator('#status').textContent({ timeout: 2000 })}", `
      + `notice "${await f.locator('#notice').textContent({ timeout: 2000 })}"`);
  } catch { /* the page is gone */ }
} finally {
  await browser?.close();
  await server.close();
  await plain.close();
  rmSync(dir, { recursive: true, force: true });
}
if (failed) {
  console.error(`studio-work-mode FAILED: ${failed.message}`);
  process.exit(1);
}
console.log('studio-work-mode OK');
process.exit(0);
