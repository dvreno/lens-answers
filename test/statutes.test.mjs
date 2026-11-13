import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChapter, createStatutes } from '../server/sources/statutes.mjs';

const sample = readFileSync(new URL('./fixtures/nrs-sample.html', import.meta.url), 'utf8');

// Fake fetch returning the given bytes with a status; records each requested call.
function fakeFetch(body = sample, status = 200) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const bytes = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    return {
      ok: status >= 200 && status < 300,
      status,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  impl.calls = calls;
  return impl;
}

const fixedNow = () => new Date(2026, 10, 11, 9, 0, 0);

test('parses sections, not the table of contents', () => {
  const sections = parseChapter(sample);
  assert.equal(sections.length, 3);
  assert.deepEqual(sections.map((s) => s.number), ['999.010', '999.020', '999.0215']);
  assert.deepEqual(sections.map((s) => s.leadline), ['Definitions.', 'Gadget registration; fees.', 'Widget inspection.']);
});

test('strips markup and entities; leadline separated; notes and headings excluded', () => {
  const [def, reg] = parseChapter(sample);
  assert.ok(def.text.startsWith('As used in this chapter'));
  assert.ok(def.text.includes('NRS 999.020 and'), 'link text kept');
  assert.ok(!/[<>]/.test(def.text) && !def.text.includes('&#8194;'));
  assert.ok(!def.text.includes('Added to NRS') && !def.text.includes('REGISTRATION'));
  assert.ok(!reg.text.includes('GENERAL PROVISIONS'));
  assert.ok(reg.text.includes('1. Each owner of a gadget'));
  assert.ok(reg.text.includes('\n2. The fee for registration is $5'), 'paragraphs on separate lines');
  assert.ok(!reg.text.includes('1965, 12'));
});

test('exact section wins', async () => {
  const s = createStatutes({ fetchImpl: fakeFetch(), now: fixedNow });
  const r = await s.lookup({ chapters: ['999'], section: '999.020', query: 'inspection widget' });
  assert.equal(r.passages[0].label, 'leg.state.nv.us · NRS 999.020');
  assert.ok(r.passages[0].text.startsWith('Gadget registration; fees.\n'));
  assert.equal(r.passages[1].label, 'leg.state.nv.us · NRS 999.0215');
});

test('section without chapters derives the chapter and fetches it', async () => {
  const f = fakeFetch();
  const s = createStatutes({ fetchImpl: f, now: fixedNow });
  const r = await s.lookup({ chapters: [], section: '999.010' });
  assert.equal(f.calls[0].url, 'https://www.leg.state.nv.us/NRS/NRS-999.html');
  assert.equal(r.passages[0].label, 'leg.state.nv.us · NRS 999.010');
});

test('ranks by query terms when no section given; leadline weighs more', async () => {
  const s = createStatutes({ fetchImpl: fakeFetch(), now: fixedNow });
  const r = await s.lookup({ chapters: ['999'], query: 'when must a widget be inspected' });
  assert.equal(r.passages[0].label, 'leg.state.nv.us · NRS 999.0215');
  // leadline hit on "gadget" (3x) beats the single body mention in 999.010 ("gadget" + "widget")
  const g = await s.lookup({ chapters: ['999'], query: 'gadget' });
  assert.equal(g.passages[0].label, 'leg.state.nv.us · NRS 999.020');
  const none = await s.lookup({ chapters: ['999'], query: 'zebra' });
  assert.deepEqual(none, { passages: [] });
});

test('caps passages at 3 and text at 2500 chars', async () => {
  const big = 'x'.repeat(5000);
  const html = sample.replace('Definitions.</span><span class="Empty">&#8194;&#8194;</span>As',
    `Definitions.</span><span class="Empty">&#8194;&#8194;</span>${big} As`);
  const s = createStatutes({ fetchImpl: fakeFetch(html), now: fixedNow });
  const r = await s.lookup({ chapters: ['999'], section: '999.010', query: 'gadget widget inspection registration' });
  assert.ok(r.passages.length <= 3);
  assert.equal(r.passages[0].text.length, 2500);
  assert.ok(r.passages[0].text.endsWith(' […section continues]'), 'a cut section says so, inside the cap');
  assert.ok(r.passages.slice(1).every((p) => !p.text.includes('[…section continues]')), 'an uncut section has no marker');
});

test('a named section that is not in the fetched chapter gives nothing, not fuzzy ranking', async () => {
  const s = createStatutes({ fetchImpl: fakeFetch(), now: fixedNow });
  assert.deepEqual(await s.lookup({ chapters: ['999'], section: '999.030', query: 'NRS 999.030 gadget widget inspection' }), { passages: [] });
  assert.deepEqual(await s.lookup({ chapters: [], section: 'NRS 999.031', query: 'gadget' }), { passages: [] });
});

test('the section is normalised: leading NRS stripped, trimmed, letter suffix upper-cased', async () => {
  const s = createStatutes({ fetchImpl: fakeFetch(), now: fixedNow });
  for (const section of ['NRS 999.020', ' nrs999.020 ', 'NRS999.020', '  999.020']) {
    const r = await s.lookup({ chapters: [], section, query: '' });
    assert.equal(r.passages[0]?.label, 'leg.state.nv.us · NRS 999.020', section);
  }
  const lettered = sample.replaceAll('999.0215', '999.0215A').replaceAll('Sec0215', 'Sec0215A');
  const l = createStatutes({ fetchImpl: fakeFetch(lettered), now: fixedNow });
  const r = await l.lookup({ chapters: ['999'], section: 'nrs 999.0215a', query: '' });
  assert.equal(r.passages[0]?.label, 'leg.state.nv.us · NRS 999.0215A');
});

test('ranking without a section ignores the word NRS and pure numbers', async () => {
  const s = createStatutes({ fetchImpl: fakeFetch(), now: fixedNow });
  assert.deepEqual(await s.lookup({ chapters: ['999'], query: 'NRS 999 020' }), { passages: [] });
  const r = await s.lookup({ chapters: ['999'], query: 'nrs 999 widget inspected' });
  assert.equal(r.passages[0].label, 'leg.state.nv.us · NRS 999.0215');
});

test('requests the chapter url with a generic user agent; at most 2 chapters; invalid ones never fetched', async () => {
  const f = fakeFetch();
  const s = createStatutes({ fetchImpl: f, now: fixedNow });
  await s.lookup({ chapters: ['999', '../etc', '484B', '10', '118A'], query: 'gadget' });
  assert.deepEqual(f.calls.map((c) => c.url), [
    'https://www.leg.state.nv.us/NRS/NRS-999.html',
    'https://www.leg.state.nv.us/NRS/NRS-484B.html',
  ]);
  const ua = f.calls[0].opts.headers['User-Agent'];
  assert.match(ua, /^Mozilla\/5\.0/);
  assert.ok(f.calls[0].opts.signal);
});

test('no chapters and no section returns empty without fetching', async () => {
  const f = fakeFetch();
  const s = createStatutes({ fetchImpl: f, now: fixedNow });
  assert.deepEqual(await s.lookup({ chapters: [], query: 'gadget' }), { passages: [] });
  assert.deepEqual(await s.lookup({ query: 'gadget' }), { passages: [] });
  assert.equal(f.calls.length, 0);
});

test('second lookup the same day does not fetch again; after midnight it does', async () => {
  const f = fakeFetch();
  let t = new Date(2026, 10, 11, 9, 0, 0);
  const s = createStatutes({ fetchImpl: f, now: () => t });
  await s.lookup({ chapters: ['999'], query: 'gadget' });
  t = new Date(2026, 10, 11, 23, 59, 0);
  await s.lookup({ chapters: ['999'], query: 'widget' });
  assert.equal(f.calls.length, 1);
  t = new Date(2026, 10, 12, 0, 1, 0);
  await s.lookup({ chapters: ['999'], query: 'widget' });
  assert.equal(f.calls.length, 2);
});

test('timeout, network error or 500 gives empty passages', async () => {
  const hang = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const slow = createStatutes({ fetchImpl: hang, now: fixedNow, timeoutMs: 20 });
  // The timeout's own timer does not keep Node running on every version, so this test holds it open.
  const hold = setInterval(() => {}, 1000);
  try {
    assert.deepEqual(await slow.lookup({ chapters: ['999'], query: 'gadget' }), { passages: [] });
  } finally { clearInterval(hold); }

  const boom = createStatutes({ fetchImpl: async () => { throw new Error('down'); }, now: fixedNow });
  assert.deepEqual(await boom.lookup({ chapters: ['999'], query: 'gadget' }), { passages: [] });

  const five = createStatutes({ fetchImpl: fakeFetch(sample, 500), now: fixedNow });
  assert.deepEqual(await five.lookup({ chapters: ['999'], query: 'gadget' }), { passages: [] });

  const empty = createStatutes({ fetchImpl: fakeFetch('<html>no sections</html>'), now: fixedNow });
  assert.deepEqual(await empty.lookup({ chapters: ['999'], query: 'gadget' }), { passages: [] });
});

test('windows-1252 bytes decode (0x97 -> em dash)', async () => {
  const bytes = Buffer.from(sample.replace('A\nwidget must', 'A\nwidget \u0097 must'), 'latin1');
  assert.ok(bytes.includes(0x97));
  const s = createStatutes({ fetchImpl: fakeFetch(bytes), now: fixedNow });
  const r = await s.lookup({ chapters: ['999'], section: '999.0215' });
  assert.ok(r.passages[0].text.includes('widget — must'));
});
