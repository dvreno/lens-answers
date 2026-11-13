// Tolerant JSON extraction: models wrap JSON in prose or code fences.
export function parseJson(text) {
  if (typeof text !== 'string') return null;
  const candidates = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  candidates.push(text);
  for (const c of candidates) {
    const direct = tryParse(c.trim());
    if (isObject(direct)) return direct;
    const found = firstBalanced(c);
    if (found !== null) {
      const v = tryParse(found);
      if (isObject(v)) return v;
    }
  }
  return null;
}

const isObject = (v) => v !== null && typeof v === 'object';

function tryParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}

// Scan for the first balanced {...} that parses, respecting strings.
function firstBalanced(s) {
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        const cand = s.slice(start, i + 1);
        if (tryParse(cand) !== undefined) return cand;
        break;
      }
    }
  }
  return null;
}
