// Fake notes bridge: the JSON-lines protocol of bridge/README.md with canned, invented data.
// FAKE_MODE picks the behaviour; FAKE_LOG (optional) gets one line per request id.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const mode = process.env.FAKE_MODE || 'current';
const result = (over = {}) => ({
  source_path: 'sample/guide-v02.md', title: 'Sample Guide', version: 'v02', status: 'current', authority: 'official',
  section: 'Setup', excerpts: ['First excerpt.', 'Second excerpt.'], ...over,
});

if (process.env.FAKE_LINGER) { // on SIGTERM, exit only after FAKE_LINGER ms
  process.on('SIGTERM', () => setTimeout(() => process.exit(0), Number(process.env.FAKE_LINGER)));
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${req.id}\n`);
  const reply = (obj) => process.stdout.write(JSON.stringify({ id: req.id, ...obj }) + '\n');
  switch (mode) {
    case 'current': return reply({ mode: 'hybrid', results: [result()] });
    case 'keyword': return reply({ mode: 'keyword_only', results: [result()] });
    case 'superseded': return reply({ mode: 'hybrid', results: [result({ status: 'superseded', version: 'v01' })] });
    case 'long-title': return reply({ mode: 'keyword_only', results: [result({ title: 'T'.repeat(70), version: 'v01', status: 'superseded' })] });
    case 'noversion': return reply({ mode: 'hybrid', results: [result({ version: null })] });
    case 'long': return reply({ mode: 'hybrid', results: [result({ excerpts: ['x'.repeat(2000), 'y'.repeat(2000)] })] });
    case 'deep': { // honours top_k, full and exact the way the real bridge does
      const text = req.full ? 'w'.repeat(3000) : 'preview';
      const results = Array.from({ length: req.top_k }, (_, i) => result({
        source_path: `sample/doc-${i + 1}.md`, title: `Doc ${i + 1}`, excerpts: [text] }));
      const exact = [
        result({ source_path: 'sample/doc-1.md', title: 'Doc 1', excerpts: [text] }), // already a search result
        result({ source_path: 'sample/exact-only.md', title: 'Exact Only', status: 'draft', excerpts: [text] }),
      ];
      return reply({ mode: 'hybrid', results, ...(req.exact ? { exact } : {}) });
    }
    case 'none': return reply({ mode: 'none', results: [], error: 'RuntimeError' });
    case 'garbage': return process.stdout.write('not json\n');
    case 'silent': return undefined;
    case 'crash': return process.exit(1);
    case 'slow': { // answers after FAKE_DELAY ms
      setTimeout(() => reply({ mode: 'hybrid', results: [result()] }), Number(process.env.FAKE_DELAY || 0));
      return undefined;
    }
    case 'silent-once': { // a hung first bridge; later ones (FAKE_FLAG set) answer
      if (!process.env.FAKE_FLAG) return undefined;
      return reply({ mode: 'hybrid', results: [result()] });
    }
    case 'crash-once': {
      if (!process.env.FAKE_FLAG) return process.exit(1);
      return reply({ mode: 'hybrid', results: [result()] });
    }
    case 'reverse': { // answers id 1 only after id 2 has been answered
      globalThis.held ??= [];
      if (req.id % 2 === 1) { globalThis.held.push(req); return undefined; }
      reply({ mode: 'hybrid', results: [result({ title: 'Second Doc', source_path: 'sample/second.md' })] });
      for (const h of globalThis.held.splice(0)) {
        process.stdout.write(JSON.stringify({ id: h.id, mode: 'hybrid', results: [result({ title: 'First Doc', source_path: 'sample/first.md' })] }) + '\n');
      }
      return undefined;
    }
    default: return undefined;
  }
});
