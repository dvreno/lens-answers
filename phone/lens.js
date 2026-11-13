// Draws on the lens through a gm-like object (gm.display.*). One page is
// created once; card text and status live in fixed regions. Draws are
// serialised so Bridge requests never interleave.

import { DEFAULT_LIMITS, REGIONS, layoutCard } from './card-layout.js';

export const STATUS_TEXT = Object.freeze({
  listening: '● listening',
  paused: '⊘ paused',
  thinking: '… thinking',
  offline: 'offline',
  backup: '● listening (backup)',
  work: '● work mode', // listening, with work mode on
  'work-backup': '● work (backup)',
});

const BLANK = ' ';
const DEFAULT_TTL_MS = 7000;

/**
 * @param {{display:{createPage():Promise<unknown>, updateText(o:object):Promise<unknown>, closePage?():Promise<unknown>}}} gm
 * @param {{setTimeout?:Function, clearTimeout?:Function, limits?:object, onError?:(e:Error)=>void}} [deps]
 */
export function createLens(gm, deps = {}) {
  const setTimer = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout ?? ((id) => globalThis.clearTimeout(id));
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const onError = deps.onError ?? (() => {});

  let queue = Promise.resolve();
  let pageOpen = false;
  let status = null;
  let timer = null;
  let generation = 0; // bumped by every show/clear so stale timers and writes can tell
  let showing = false;

  // `bare` drops the border, so an idle lens shows no empty frame.
  const box = (region, text, bare = false) => ({
    id: region.id, x: region.x, y: region.y, width: region.width, height: region.height,
    border: bare ? 0 : region.border ?? 0, radius: bare ? 0 : region.radius ?? 0, text,
  });

  // Run a draw after everything queued before it. A failure forgets the page
  // (so the next draw recreates it) but never stalls the queue.
  function enqueue(op) {
    const run = queue.then(async () => {
      try {
        if (!pageOpen) {
          await gm.display.createPage();
          pageOpen = true;
          if (status) await gm.display.updateText(box(REGIONS.status, STATUS_TEXT[status]));
        }
        await op();
      } catch (error) {
        pageOpen = false;
        onError(error);
        throw error;
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  async function writeCard(text, bare = false) {
    await gm.display.updateText(box(REGIONS.heard, text.heard, bare));
    await gm.display.updateText(box(REGIONS.source, text.source, bare));
    await gm.display.updateText(box(REGIONS.answer, text.answer, bare));
  }

  return {
    /** @param {{heard:string, source:string, answer:string, ttlMs?:number}} card */
    showCard(card) {
      const mine = ++generation;
      stopTimer();
      showing = true;
      const text = layoutCard(card, limits);
      const ttl = Number.isFinite(card?.ttlMs) && card.ttlMs > 0 ? card.ttlMs : DEFAULT_TTL_MS;
      return enqueue(async () => {
        await writeCard(text);
        if (mine !== generation) return; // replaced or cleared while drawing
        timer = setTimer(() => {
          timer = null;
          this.clearCard().catch(() => {}); // already reported through onError
        }, ttl);
      }).catch((error) => {
        if (mine === generation) showing = false;
        throw error;
      });
    },

    clearCard() {
      generation++;
      stopTimer();
      showing = false;
      return enqueue(() => writeCard({ heard: BLANK, source: BLANK, answer: BLANK }, true));
    },

    /** @param {'listening'|'paused'|'thinking'|'offline'|'backup'|'work'|'work-backup'} next */
    setStatus(next) {
      if (!Object.hasOwn(STATUS_TEXT, next)) return Promise.reject(new RangeError(`unknown status: ${next}`));
      status = next;
      return enqueue(() => gm.display.updateText(box(REGIONS.status, STATUS_TEXT[next])));
    },

    isShowing() {
      return showing;
    },

    /** The host recreated the page: forget ours so the next draw makes a new one. */
    reset() {
      pageOpen = false;
    },

    /** Stop the timer and close the page. */
    async close() {
      generation++;
      stopTimer();
      showing = false;
      await queue;
      if (pageOpen) {
        pageOpen = false;
        await gm.display.closePage?.();
      }
    },
  };
}
