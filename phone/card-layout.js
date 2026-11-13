// Pure layout for the 600x350 lens: where each text box goes and how card
// text is fitted into it. No SDK, no DOM, no Node APIs.

// Region geometry (ids are page text-box ids). Tuned in the Studio check.
export const REGIONS = Object.freeze({
  heard: Object.freeze({ id: 1, x: 20, y: 16, width: 560, height: 70 }),
  source: Object.freeze({ id: 2, x: 20, y: 96, width: 560, height: 48, border: 1, radius: 6 }),
  answer: Object.freeze({ id: 3, x: 20, y: 158, width: 560, height: 150 }),
  status: Object.freeze({ id: 4, x: 440, y: 314, width: 150, height: 28 }),
});

// Matches `card.heardMax / sourceMax / answerMax` in server/config.mjs.
export const DEFAULT_LIMITS = Object.freeze({ heardMax: 80, sourceMax: 60, answerMax: 180 });

const BLANK = ' '; // updateText rejects empty text

function fit(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return BLANK;
  const chars = Array.from(text); // code points, so an emoji is never cut in half
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

/**
 * @param {{heard?:string, source?:string, answer?:string}} card
 * @param {{heardMax:number, sourceMax:number, answerMax:number}} [limits]
 * @returns {{heard:string, source:string, answer:string}} never empty
 */
export function layoutCard(card, limits = DEFAULT_LIMITS) {
  return {
    heard: fit(card?.heard, limits.heardMax),
    source: fit(card?.source, limits.sourceMax),
    answer: fit(card?.answer, limits.answerMax),
  };
}
