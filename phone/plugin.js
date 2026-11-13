// Lens Answers phone plugin: captures the glasses microphone, streams it to
// the Lens Answers server and draws answer cards on the lens. Thin wiring;
// the logic lives in link.js, lens.js and card-layout.js.

import { createGMPlugin } from './vendor/gm-plugin-web-sdk.esm.js';
import { replaceLink } from './link.js';
import { createLens } from './lens.js';

const STORAGE_KEY = 'lens-answers.settings';
const CAPTURE_OPTIONS = { profile: 'interactive', pickupMode: 'meetingAuto', noiseReduction: true, maxDurationMs: null };

const gm = createGMPlugin();
const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), notice: $('notice'), toggle: $('toggle-pause'), call: $('call'), work: $('work'),
  url: $('server-url'), token: $('server-token'), save: $('save'),
};

const lens = createLens(gm, { onError: (error) => setNotice(`Lens draw failed: ${error.message || error}`, true) });

let link = null;
let linkOnline = false;
let offlineReason = 'connecting';
let greeted = false; // the first state message after each connect is the server's greeting
let paused = false;
let serverState = 'listening'; // listening | thinking
let asr = 'local';
let callOn = false;
let workOn = false; // what this phone wants (kept in storage, sent after every connect)
let serverMode = 'auto'; // what the server last confirmed: auto | work
let workAvailable = true; // false once the server says it has no notes source (state messages carry noWork)
let settings = {}; // what is in storage: { url, token, work }
let settingsLoaded = false; // until storage has been read, nothing may be written over it
let audioAvailable = true;
let session = null; // open capture session while the mic is really open
let micProblem = '';
let reconciling = Promise.resolve();
let drawnStatus = null;

// ---- status ---------------------------------------------------------------------

function currentStatus() {
  if (!linkOnline) return 'offline';
  if (paused) return 'paused';
  if (serverState === 'thinking') return 'thinking';
  if (serverMode === 'work') return asr === 'backup' ? 'work-backup' : 'work';
  return asr === 'backup' ? 'backup' : 'listening';
}

const STATUS_LABEL = { backup: 'listening (backup)', work: 'listening (work mode)', 'work-backup': 'listening (work mode, backup)' };

const REASON_NOTE = {
  unauthorized: 'The server refused the token. Check token, then Save and connect.',
  replaced: 'Another phone connected to the server. Tap Save and connect to take over again.',
  'bad-address': 'Check the server address.',
};

function setNotice(message, problem = false) {
  ui.notice.textContent = message;
  ui.notice.classList.toggle('problem', problem);
}

function refresh() {
  const status = currentStatus();
  ui.status.textContent = STATUS_LABEL[status] ?? status;
  ui.status.dataset.state = status;
  ui.toggle.textContent = paused ? 'Resume' : 'Pause';
  ui.toggle.disabled = !link;
  if (micProblem) setNotice(micProblem, true);
  else if (!linkOnline && REASON_NOTE[offlineReason]) setNotice(REASON_NOTE[offlineReason], true);
  else if (!linkOnline) setNotice(link ? 'Connecting to the server…' : 'Enter the server address and token, then Save and connect.');
  else if (paused) setNotice('Paused. The microphone is closed.');
  else if (!audioAvailable) setNotice('This MemoMind app version cannot stream the microphone.', true);
  else if (serverMode === 'work') setNotice('Work mode: every question goes to your own notes and documents.');
  else setNotice('Listening through the glasses.');
  if (status !== drawnStatus) {
    drawnStatus = status;
    lens.setStatus(status).catch(() => {}); // reported through the lens onError
  }
}

// ---- microphone -----------------------------------------------------------------

const wantMic = () => linkOnline && !paused && audioAvailable;

// Serialised so open and close never overlap.
function reconcile() {
  reconciling = reconciling.then(async () => {
    if (wantMic() && !session) await openMic();
    else if (!wantMic() && session) await closeMic();
  }).catch((error) => {
    micProblem = `Microphone: ${error.message || error}`;
    refresh();
  });
  return reconciling;
}

async function openMic() {
  micProblem = '';
  const opened = await gm.audio.openCapture(CAPTURE_OPTIONS);
  if (!wantMic()) { // state changed while the mic was opening
    await opened.stop().catch(() => {});
    return;
  }
  session = opened;
  void pump(opened);
}

async function closeMic() {
  const closing = session;
  session = null; // pump stops forwarding at once
  try { await closing.stop(); } catch { /* already stopped */ }
}

async function pump(opened) {
  if (typeof opened.stream?.getReader !== 'function') {
    session = null;
    micProblem = 'The host returned no audio stream.';
    refresh();
    return;
  }
  const reader = opened.stream.getReader();
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done || session !== opened) break;
      link?.sendAudio(chunk.frameLengths, chunk.data); // dropped when the link is down
    }
  } catch (error) {
    if (session === opened) micProblem = `Microphone stopped: ${error.message || error}`;
  } finally {
    reader.releaseLock?.();
    if (session === opened) { // ended by itself; the next resume or toggle reopens it
      session = null;
      if (!micProblem) micProblem = 'The microphone stopped. Pause and resume to restart it.';
      refresh();
    }
  }
}

// ---- pause, call ------------------------------------------------------------------

function setPaused(next) {
  if (paused === next) return;
  paused = next;
  if (next) micProblem = '';
  link?.send({ type: next ? 'pause' : 'resume' });
  refresh();
  void reconcile();
}

// Work mode: the phone remembers the choice; the server confirms it in its next state message.
function setWork(next) {
  if (!settingsLoaded) { ui.work.checked = workOn; return; } // too early: saving now would wipe the address and token
  if (!workAvailable) { ui.work.checked = false; return; } // no notes source on the server: the saved choice is left alone
  workOn = next;
  ui.work.checked = next;
  link?.send({ type: 'mode', mode: next ? 'work' : 'auto' });
  settings = { ...settings, work: next };
  gm.storage.set(STORAGE_KEY, settings).catch(() => {}); // not saved: the choice still holds until the page closes
}

function onButton(event) {
  if (event.action === 'long') { setWork(!workOn); return; }
  if (event.action !== 'single') return;
  if (lens.isShowing()) lens.clearCard().catch(() => {});
  else setPaused(!paused);
}

ui.toggle.addEventListener('click', () => { micProblem = ''; setPaused(!paused); });
ui.work.addEventListener('change', () => setWork(ui.work.checked));
ui.call.addEventListener('change', () => {
  callOn = ui.call.checked;
  link?.send({ type: 'call', on: callOn });
});

// ---- server link ------------------------------------------------------------------

function onServerMessage(message) {
  if (message.type === 'state') {
    const wasGreeting = !greeted;
    greeted = true;
    if (wasGreeting) {
      // A fresh connection starts listening on the server; restore what this phone wants.
      if (paused) link.send({ type: 'pause' });
      if (callOn) link.send({ type: 'call', on: true });
      if (workOn && message.noWork !== true) link.send({ type: 'mode', mode: 'work' });
    }
    // No notes source on the server: the box is switched off (the saved choice is kept for when there is one).
    workAvailable = message.noWork !== true;
    ui.work.disabled = !settingsLoaded || !workAvailable;
    ui.work.checked = workAvailable && workOn;
    if (message.mode === 'work' || message.mode === 'auto') serverMode = message.mode;
    asr = message.asr === 'backup' ? 'backup' : 'local';
    if (!(wasGreeting && paused)) {
      if (message.state === 'paused') paused = true;
      else if (message.state === 'listening' || message.state === 'thinking') paused = false;
    }
    if (message.state === 'thinking' || message.state === 'listening') serverState = message.state;
    refresh();
    void reconcile();
  } else if (message.type === 'card') {
    lens.showCard(message).catch(() => {});
  } else if (message.type === 'error') {
    setNotice(`Server: ${String(message.message ?? 'error')}`, true);
  }
}

function onLinkStatus(status, reason) {
  linkOnline = status === 'online';
  if (!linkOnline) {
    greeted = false;
    serverState = 'listening';
    serverMode = 'auto'; // a new connection starts in automatic mode until this phone asks again
    offlineReason = reason ?? 'closed';
  }
  refresh();
  void reconcile(); // closes the mic while offline, reopens it when back
}

function connect(url, token) {
  // replaceLink checks the address before closing the old link: a typo throws and leaves it working.
  link = replaceLink(link, { url, token, onMessage: onServerMessage, onStatus: onLinkStatus });
  linkOnline = false;
  offlineReason = 'connecting';
  greeted = false;
  refresh();
}

ui.save.addEventListener('click', async () => {
  const url = ui.url.value.trim();
  const token = ui.token.value.trim();
  if (!token) { setNotice('Enter the token.', true); return; }
  try {
    connect(url, token);
    settings = { url, token, work: workOn };
    await gm.storage.set(STORAGE_KEY, settings);
  } catch (error) {
    setNotice(error.message || String(error), true);
  }
});

// ---- startup and lifecycle ----------------------------------------------------------

async function start() {
  try {
    await gm.ready();
    const capabilities = await gm.runtime.getCapabilities();
    audioAvailable = capabilities?.audio?.transport === 'message-port' && capabilities?.audio?.payload === 'binary-envelope-v1';
    await gm.device.subscribeEvents(['button', 'connection']);
    gm.device.onButton(onButton);
    gm.device.onConnection((event) => {
      if (event.connected === false) return;
      lens.reset(); // the glasses lost the page; draw it again
      drawnStatus = null;
      refresh();
    });
    gm.audio.onCaptureState((event) => {
      if (event.state === 'error' && session && event.sessionId === session.sessionId) {
        session = null;
        micProblem = `Microphone error: ${event.errorCode || 'unknown'}`;
        refresh();
      }
    });
    gm.on('runtime.lifecycleChanged', (event) => {
      if (event.state === 'suspended') return; // keep the capture session; nothing else to do
      void resumeChecks();
    });

    const saved = (await gm.storage.get(STORAGE_KEY)).value || {};
    settings = saved;
    settingsLoaded = true;
    ui.work.disabled = false;
    ui.url.value = saved.url || '';
    ui.token.value = saved.token || '';
    workOn = saved.work === true;
    ui.work.checked = workOn;
    refresh();
    if (saved.url && saved.token) connect(saved.url, saved.token);
  } catch (error) {
    setNotice(`${error.code || 'ERROR'}: ${error.message || error}. Check permissions, then reload.`, true);
  }
}

// After the app comes back: make sure the host is still ready, the link is up
// and the mic is open if it should be.
async function resumeChecks() {
  try { await gm.ready(); } catch (error) { setNotice(`${error.code || 'ERROR'}: ${error.message || error}`, true); return; }
  if (link && !linkOnline && offlineReason === 'closed') link.reconnect();
  void reconcile();
}

window.addEventListener('pagehide', () => {
  link?.close();
  const closing = session;
  session = null;
  closing?.stop().catch(() => {});
  gm.close();
});

void start();
