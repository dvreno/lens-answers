// WebSocket client for the Lens Answers server. Sends `hello` first, reconnects
// with backoff, and never queues audio: chunks sent while the link is down are
// dropped. The token travels only in the hello message, never in the URL.

import { encodeChunk } from './lib/wire.js';

const BACKOFF_MS = [1000, 2000, 5000]; // then stays at the last value
const CLOSE_UNAUTHORIZED = 4401; // bad or missing token
const CLOSE_REPLACED = 4409; // another phone connected
const MAX_MESSAGE_BYTES = 64 * 1024; // server limit
const MAX_BUFFERED_BYTES = 32 * 1024; // about 8 s of audio; beyond this we drop rather than lag
const OPEN = 1;

/**
 * Turn what the user typed into a WebSocket URL. `host:port`, http(s) and ws(s)
 * are accepted; the path defaults to /ws.
 * @param {string} input
 * @returns {string}
 */
export function normalizeServerUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('Enter the server address');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `ws://${raw}`;
  let url;
  try { url = new URL(withScheme); } catch { throw new Error('That server address is not valid'); }
  const scheme = { 'ws:': 'ws:', 'wss:': 'wss:', 'http:': 'ws:', 'https:': 'wss:' }[url.protocol];
  if (!scheme || !url.hostname || url.username || url.password) throw new Error('That server address is not valid');
  url.protocol = scheme;
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Swap the server link for one to a new address. The address is checked first: a bad one throws and the
 * working link (and with it the open microphone and the status) is left exactly as it was.
 * @param {null|{close():void}} current
 * @param {Parameters<typeof createLink>[0]} options  `url` as the user typed it
 */
export function replaceLink(current, options) {
  const url = normalizeServerUrl(options.url); // throws before anything is closed
  current?.close();
  return createLink({ ...options, url });
}

/**
 * @param {{url:string, token:string, WebSocketImpl?:Function,
 *   onMessage?:(m:object)=>void, onStatus?:(status:'online'|'offline', reason?:string)=>void,
 *   setTimeout?:Function, clearTimeout?:Function}} options
 *   Offline reasons: connecting, closed, unauthorized, replaced, bad-address.
 */
export function createLink(options) {
  const { url, token, onMessage = () => {}, onStatus = () => {} } = options;
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const setTimer = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = options.clearTimeout ?? ((id) => globalThis.clearTimeout(id));

  let socket = null;
  let retryTimer = null;
  let attempt = 0;
  let closed = false;
  let status = null; // last reported, so repeats are not re-announced
  let reason = null;

  function report(next, why) {
    if (closed || (status === next && reason === (why ?? null))) return;
    status = next;
    reason = why ?? null;
    onStatus(next, why);
  }

  function scheduleRetry() {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
    attempt++;
    retryTimer = setTimer(() => { retryTimer = null; connect(); }, delay);
  }

  function connect() {
    if (closed) return;
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch {
      report('offline', 'bad-address'); // will not get better by retrying
      return;
    }
    socket = ws;
    ws.binaryType = 'arraybuffer';
    if (status === null) report('offline', 'connecting');
    ws.onopen = () => {
      if (socket !== ws) return;
      ws.send(JSON.stringify({ type: 'hello', token }));
    };
    ws.onmessage = (event) => {
      if (socket !== ws || typeof event.data !== 'string') return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message === null || typeof message !== 'object') return;
      // The first reply means the server accepted the hello.
      if (status !== 'online') { attempt = 0; report('online'); }
      onMessage(message);
    };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      if (event?.code === CLOSE_UNAUTHORIZED) { report('offline', 'unauthorized'); return; }
      if (event?.code === CLOSE_REPLACED) { report('offline', 'replaced'); return; }
      report('offline', 'closed');
      if (!closed) scheduleRetry();
    };
    // Browsers always follow an error with a close, which is where we react.
    ws.onerror = () => {};
  }

  connect();

  return {
    /** @returns {boolean} true when the chunk went out */
    sendAudio(frameLengths, data) {
      if (!socket || socket.readyState !== OPEN || socket.bufferedAmount > MAX_BUFFERED_BYTES) return false;
      let chunk;
      try { chunk = encodeChunk(frameLengths, data); } catch { return false; } // malformed chunk: drop it
      if (chunk.length > MAX_MESSAGE_BYTES) return false;
      socket.send(chunk);
      return true;
    },

    /** @returns {boolean} true when the message went out */
    send(message) {
      if (!socket || socket.readyState !== OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },

    /** Try again now, e.g. after a no-retry close (replaced) or when the app resumes. */
    reconnect() {
      if (closed || socket) return;
      if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
      attempt = 0;
      connect();
    },

    close() {
      if (closed) return;
      closed = true;
      if (retryTimer !== null) clearTimer(retryTimer);
      retryTimer = null;
      const ws = socket;
      socket = null;
      try { ws?.close(1000); } catch { /* already gone */ }
    },
  };
}
