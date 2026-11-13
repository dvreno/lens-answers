// Live lookup of Nevada Revised Statutes sections. Fetches a chapter page, parses its sections,
// and returns the most relevant as labelled passages. Nothing is stored on disk.

const BASE = 'https://www.leg.state.nv.us/NRS/NRS-';
const CHAPTER_RE = /^\d{1,3}[A-C]?$/;
const SECTION_CHAPTER_RE = /^(\d{1,3}[A-C]?)\.\d/;
const MAX_CHAPTERS = 2;
const MAX_PASSAGES = 3;
const TEXT_MAX = 2500;
const CONTINUES = ' […section continues]'; // tells the model a section was cut (counted inside TEXT_MAX)
const TIMEOUT_MS = 8000;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const STOP = new Set(['the', 'and', 'for', 'are', 'who', 'what', 'when', 'where', 'how', 'does', 'can', 'must', 'with', 'that', 'this', 'from', 'have', 'there', 'under', 'about']);
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ldquo: '"', rdquo: '"', lsquo: "'", rsquo: "'", ndash: '–', mdash: '—', sect: '§' };

// Only real section anchors (<a name=NRS484BSec100>) start a section; table-of-contents links use href.
const ANCHOR_RE = /<a\s+name\s*=\s*["']?NRS\d{1,3}[A-C]?Sec\d+[A-Z]?["']?\s*>\s*<\/a>/gi;
const SKIPPED_BLOCK_RE = /<(p|div|h\d)\b[^>]*class\s*=\s*["']?(?:SourceNote|DocHeading)[^>]*>[\s\S]*?<\/\1\s*>/gi;
const SPAN_RE = (cls) => new RegExp(`<span\\b[^>]*class\\s*=\\s*["']?${cls}["']?[^>]*>([\\s\\S]*?)</span\\s*>`, 'i');

function decode(s) {
  return s.replace(/&#(x[0-9a-f]+|\d+);|&([a-z]+);/gi, (m, num, name) => {
    if (num) {
      const code = num[0] === 'x' || num[0] === 'X' ? parseInt(num.slice(1), 16) : parseInt(num, 10);
      return code === 8194 || code === 8195 ? ' ' : String.fromCodePoint(code);
    }
    return NAMED[name.toLowerCase()] ?? m;
  });
}

const oneLine = (html) => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

/** @param {string} html @returns {{number:string, leadline:string, text:string}[]} */
export function parseChapter(html) {
  const anchors = [...html.matchAll(ANCHOR_RE)];
  const sections = [];
  anchors.forEach((a, i) => {
    const start = a.index + a[0].length;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const chunk = html.slice(start, end).replace(SKIPPED_BLOCK_RE, '');
    const numberSpan = chunk.match(SPAN_RE('Section'));
    if (!numberSpan) return;
    const number = oneLine(numberSpan[1]);
    if (!number) return;
    const leadSpan = chunk.match(SPAN_RE('Leadline'));
    const leadline = leadSpan ? oneLine(leadSpan[1]) : '';
    const bodyStart = leadSpan ? leadSpan.index + leadSpan[0].length : numberSpan.index + numberSpan[0].length;
    const text = chunk.slice(bodyStart)
      .replace(/<\/p\s*>|<br\s*\/?>/gi, '\u0000')
      .split('\u0000').map(oneLine).filter(Boolean).join('\n');
    sections.push({ number, leadline, text });
  });
  return sections;
}

const words = (s) => s.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function score(section, terms) {
  const lead = words(section.leadline);
  const body = words(section.text);
  const hit = (ws, t) => ws.some((w) => w.startsWith(t));
  return terms.reduce((sum, t) => sum + (hit(lead, t) ? 3 : 0) + (hit(body, t) ? 1 : 0), 0);
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

function toPassage(s) {
  const full = `${s.leadline}\n${s.text}`.trim();
  const text = full.length <= TEXT_MAX ? full : `${full.slice(0, TEXT_MAX - CONTINUES.length).trimEnd()}${CONTINUES}`;
  return { label: `leg.state.nv.us · NRS ${s.number}`, text };
}

// "NRS 484B.165a" -> "484B.165A"
const normaliseSection = (section) => (typeof section === 'string' ? section.trim().replace(/^NRS\s*/i, '').trim().toUpperCase() : '');

/**
 * @param {{fetchImpl?: typeof fetch, now?: () => Date, timeoutMs?: number}} [deps]
 */
export function createStatutes({ fetchImpl = globalThis.fetch, now = () => new Date(), timeoutMs = TIMEOUT_MS } = {}) {
  /** @type {Map<string, {day:string, sections:ReturnType<typeof parseChapter>}>} */
  const cache = new Map();

  async function load(chapter) {
    const day = dayKey(now());
    const hit = cache.get(chapter);
    if (hit && hit.day === day) return hit.sections;
    try {
      const res = await fetchImpl(`${BASE}${chapter}.html`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return [];
      const html = new TextDecoder('windows-1252').decode(await res.arrayBuffer());
      const sections = parseChapter(html);
      if (sections.length) cache.set(chapter, { day, sections });
      return sections;
    } catch {
      return [];
    }
  }

  return {
    /** @param {{chapters?:string[], section?:string, query?:string}} req @returns {Promise<import('../types.mjs').SourceResult>} */
    async lookup({ chapters = [], section, query = '' } = {}) {
      const wanted = normaliseSection(section);
      let list = Array.isArray(chapters) ? chapters.filter((c) => typeof c === 'string' && CHAPTER_RE.test(c)) : [];
      if (!list.length && wanted) {
        const m = wanted.match(SECTION_CHAPTER_RE);
        if (m) list = [m[1]];
      }
      list = [...new Set(list)].slice(0, MAX_CHAPTERS);
      if (!list.length) return { passages: [] };

      const all = (await Promise.all(list.map(load))).flat();
      const picked = [];
      const exact = wanted && all.find((s) => s.number.toUpperCase() === wanted);
      if (wanted && !exact) return { passages: [] }; // a named section that is not there: nothing solid, no guessing
      if (exact) picked.push(exact);

      // "nrs" and bare numbers (chapter digits) match nearly every section, so they never rank.
      const terms = [...new Set(words(String(query)).filter((w) => w.length >= 3 && !STOP.has(w) && w !== 'nrs' && !/^\d+$/.test(w)))];
      if (terms.length) {
        const ranked = all
          .filter((s) => s !== exact)
          .map((s) => ({ s, n: score(s, terms) }))
          .filter((x) => x.n > 0)
          .sort((a, b) => b.n - a.n);
        picked.push(...ranked.map((x) => x.s));
      }
      return { passages: picked.slice(0, MAX_PASSAGES).map(toPassage) };
    },
  };
}
