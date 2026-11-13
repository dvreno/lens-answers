#!/usr/bin/env node
// Text-level evaluation of the work-question path, for a notes folder that keeps its own question file.
// No audio. Prints COUNTS AND TIMINGS ONLY: never a query, a path, a title, a passage or an answer. The
// question file is read from the notes folder at run time (<kb.root>/tests/eval/retrieval_eval.yml: a YAML
// list of {id, query, kind, expected: [document paths]}) and is never copied or written anywhere; nothing is
// saved to disk.
//
//   node scripts/eval.mjs [--backend anthropic-api|claude-code] [--limit N] [--retrieval-only]
//                         [--work-mode] [--work-model <model id>]
//
// --work-mode      answer the way work mode does (server/work.mjs): every question except a statute one goes
//                  to the knowledge base, searched widely, with the context pack, answered by llm.workModel
// --work-model id  use this model as llm.workModel for the run (with --work-mode)
// --limit N        evaluate N questions spread evenly through the file (deterministic), not the first N
// --retrieval-only no model calls: counts questions the hard rules route to "work", and top-passage hits
// Full run: understand -> kb.search -> writeAnswer per question. A question is answered only when
// understand routes it to "work" (so no work question is ever sent to a web search); the knowledge base is
// searched for every question, so the hit count measures retrieval alone. It also counts solid cards whose
// cited passage is an expected document, and the routes of questions understand did not send to "work".
// Question categories are printed as "category 1..n" (file order), never by the file's own names.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from 'yaml';
import { loadConfig, kbEnabled } from '../server/config.mjs';
import { createLlm } from '../server/llm/index.mjs';
import { createUnderstand, routingFrom, routeByRule, leansWork } from '../server/understand.mjs';
import { createKb } from '../server/sources/kb.mjs';
import { writeAnswer } from '../server/answer.mjs';
import { createWorkAnswerer } from '../server/work.mjs';
import { loadContextPack } from '../server/sources/pack.mjs';

// Ten synthetic lines of ordinary talk. None should produce a card.
export const SMALL_TALK = [
  'Yeah I think we should probably head out around five.',
  'Wow, that was a really long meeting today.',
  'Can you believe how windy it got this afternoon?',
  'I told her I would call back tomorrow morning.',
  'Honestly I could eat pizza every single day.',
  'Hold on, let me grab my coat real quick.',
  'Did you see that game last night, it was unreal.',
  'Why does the printer always jam when I am in a hurry?',
  'Okay sounds good, talk to you later then.',
  'I am so tired, I barely slept at all.',
];

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** n entries spread evenly through the list (all of them when n is missing or large enough). */
export function sample(entries, n) {
  if (!Number.isInteger(n) || n <= 0 || n >= entries.length) return [...entries];
  return Array.from({ length: n }, (_, i) => entries[Math.floor((i * entries.length) / n)]);
}

/** True when a result path is one of the expected paths (exact, or one is the other's trailing part). */
export function isHit(resultPath, expected) {
  if (typeof resultPath !== 'string' || !resultPath) return false;
  return (Array.isArray(expected) ? expected : []).some((e) =>
    typeof e === 'string' && e && (resultPath === e || resultPath.endsWith(`/${e}`) || e.endsWith(`/${resultPath}`)));
}

export function parseEval(text) {
  const doc = YAML.parse(text);
  const list = Array.isArray(doc) ? doc : Object.values(doc ?? {}).find(Array.isArray) ?? [];
  return list.filter((e) => e && typeof e.query === 'string' && Array.isArray(e.expected));
}

const timed = async (stage, timings, fn) => {
  const t = performance.now();
  try { return await fn(); } finally { (timings[stage] ??= []).push(performance.now() - t); }
};
const ms = (v) => (v === null ? 'n/a' : `${Math.round(v)} ms`);
const stageLine = (name, arr) => `  ${name.padEnd(10)} n=${String(arr.length).padStart(3)}  median ${ms(percentile(arr, 50))}  p90 ${ms(percentile(arr, 90))}`;

/** The path of the passage a card cites (matched by its source label), or '' when none matches. */
export function citedPath(card, passages, paths) {
  const i = (passages ?? []).findIndex((p) => p.label === card?.source);
  return i >= 0 ? String((paths ?? [])[i] ?? '') : '';
}

/**
 * @param {{config: object, entries: object[], retrievalOnly: boolean, print?: Function, llm?: object|null,
 *   kb?: object, kinds?: string[], workMode?: boolean, pack?: string, answerWork?: Function}} args
 *   `kinds`: every category in file order (numbers them); `kb` and `answerWork` for tests
 */
export async function run({ config, entries, retrievalOnly, print = console.log, llm = null, kb = createKb(config), kinds,
  workMode = false, pack = '', answerWork = null }) {
  const timings = {};
  const counts = { questions: entries.length, ruleWork: 0, ruleOrVocab: 0, routedWork: 0, answered: 0, top1: 0, top3: 0,
    noPassages: 0, solid: 0, solidCitingExpected: 0, solidCitingPack: 0, nothingSolid: 0, readExpected: 0, secondSearch: 0,
    notQuestion: 0, notWorkRoutes: {}, byKind: {} };
  const deep = workMode && !retrievalOnly ? (answerWork ?? createWorkAnswerer({ kb, llm, config, pack })) : null;
  const order = [...new Set([...(kinds ?? []), ...entries.map((e) => String(e.kind ?? 'unknown'))])];
  for (const k of order) counts.byKind[k] = { n: 0, top1: 0 };
  try {
    await kb.search('warm up the search index'); // first call loads the bridge, the index and the embedder
    const routing = routingFrom(config); // the same routes, instructions and patterns the server would use
    const understand = retrievalOnly ? null : createUnderstand({ llm, routing });
    for (const e of entries) {
      const kind = String(e.kind ?? 'unknown');
      const k = counts.byKind[kind];
      k.n++;
      let query = e.query;
      let intent = null;
      if (retrievalOnly) {
        const rule = routeByRule(e.query, routing);
        if (rule === 'work') counts.ruleWork++;
        if (rule === 'work' || (rule === null && leansWork(e.query, routing))) counts.ruleOrVocab++;
      } else {
        intent = await timed('understand', timings, () => understand(e.query, []));
        // Work mode sends every question except a statute one to the knowledge base (as the pipeline does).
        if (deep && intent.kind === 'question' && intent.route !== 'statute') intent = { ...intent, route: 'work' };
        if (intent.kind === 'question') query = intent.query;
        if (intent.kind === 'question' && intent.route === 'work') counts.routedWork++;
        else if (intent.kind !== 'question') counts.notQuestion++; // classified "none": counted, never answered
        if (!(intent.kind === 'question' && intent.route === 'work')) {
          const route = intent.kind === 'question' ? intent.route : 'none';
          counts.notWorkRoutes[route] = (counts.notWorkRoutes[route] ?? 0) + 1;
        }
      }
      if (deep) {
        if (!(intent.kind === 'question' && intent.route === 'work')) continue;
        const r = await timed('work', timings, () => deep({ intent, heard: e.query }));
        counts.answered++;
        if (r.rounds === 2) counts.secondSearch++;
        if ((r.paths ?? []).some((p) => isHit(p, e.expected))) counts.readExpected++;
        if (!r.card?.solid) counts.nothingSolid++;
        else {
          counts.solid++;
          if (r.cited === 'pack') counts.solidCitingPack++;
          else if (isHit(r.cited, e.expected)) counts.solidCitingExpected++;
        }
        continue;
      }
      const result = await timed('kb.search', timings, () => kb.search(query));
      const paths = result.paths ?? [];
      if (!result.passages.length) counts.noPassages++;
      if (isHit(paths[0], e.expected)) { counts.top1++; k.top1++; }
      if (paths.slice(0, 3).some((p) => isHit(p, e.expected))) counts.top3++;
      if (intent?.kind === 'question' && intent.route === 'work') {
        if (paths.some((p) => isHit(p, e.expected))) counts.readExpected++;
        const card = await timed('answer', timings, () => writeAnswer({
          intent, heard: e.query, passages: result.passages, llm, card: config.card }));
        counts.answered++;
        if (card.solid) {
          counts.solid++;
          if (isHit(citedPath(card, result.passages, paths), e.expected)) counts.solidCitingExpected++;
        } else counts.nothingSolid++;
      }
    }
  } finally {
    kb.close();
  }

  print(`questions: ${counts.questions}${retrievalOnly ? '  (retrieval only: no model calls)' : ''}`);
  if (retrievalOnly) {
    print(`routed to work by the hard rules alone: ${counts.ruleWork}`);
    print(`routed to work by the hard rules or the lean-to-work vocabulary: ${counts.ruleOrVocab}  (the vocabulary applies only when the model says general or web)`);
  }
  else print(`routed to work by understand: ${counts.routedWork}  (classified as not a question: ${counts.notQuestion})`);
  if (!deep) {
    print(`expected document is the top passage: ${counts.top1}/${counts.questions}`);
    print(`expected document within the top 3:   ${counts.top3}/${counts.questions}`);
    print(`searches that returned no passages:   ${counts.noPassages}`);
    const byCategory = Object.values(counts.byKind).map((v, i) => (v.n ? `category ${i + 1} ${v.top1}/${v.n}` : null));
    print(`by category (top passage): ${byCategory.filter(Boolean).join(', ')}`);
  }
  if (!retrievalOnly) {
    if (deep) {
      print(`work mode: answered ${counts.answered}  solid: ${counts.solid}  nothing solid: ${counts.nothingSolid}`);
      print(`solid cards citing an expected document: ${counts.solidCitingExpected}/${counts.solid}  citing the context pack: ${counts.solidCitingPack}/${counts.solid}`);
      print(`second searches: ${counts.secondSearch}`);
    } else {
      print(`answered (work route only): ${counts.answered}  solid: ${counts.solid}  nothing solid: ${counts.nothingSolid}`);
      print(`solid cards citing an expected document: ${counts.solidCitingExpected}/${counts.solid}`);
    }
    print(`expected document among the passages read: ${counts.readExpected}/${counts.answered}`);
    print('KB questions not routed to work, by route: ' + (Object.keys(counts.notWorkRoutes).sort()
      .map((r) => `${r} ${counts.notWorkRoutes[r]}`).join(', ') || 'none'));
  }
  print('time per stage:');
  for (const [name, arr] of Object.entries(timings)) print(stageLine(name, arr));
  return { counts, timings };
}

export async function smallTalk({ llm, routing, print = console.log }) {
  const understand = createUnderstand({ llm, routing }); // the instructions the server would use
  const timings = { understand: [] };
  let cards = 0;
  for (const line of SMALL_TALK) {
    const intent = await timed('understand', timings, () => understand(line, []));
    if (intent.kind === 'question') cards++; // a question would be answered, so it would put a card on the lens
  }
  print(`small talk: ${SMALL_TALK.length} lines, ${cards} would produce a card (target 0)`);
  print(stageLine('understand', timings.understand));
  return cards;
}

async function main() {
  const args = process.argv.slice(2);
  const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const config = loadConfig();
  const backend = val('--backend');
  if (backend) config.llm.backend = backend;
  const limit = val('--limit') === undefined ? undefined : Number(val('--limit'));
  const retrievalOnly = args.includes('--retrieval-only');
  const workMode = args.includes('--work-mode') && !retrievalOnly;
  if (val('--work-model')) config.llm.workModel = val('--work-model');
  if (!retrievalOnly && config.llm.backend === 'anthropic-api' && !process.env.ANTHROPIC_API_KEY) {
    console.error('anthropic-api back end needs ANTHROPIC_API_KEY in the environment; not measured.');
    process.exit(2);
  }
  if (!config.kb.root || !kbEnabled(config)) {
    console.error('no notes source is configured (kb.root and kb.command): nothing to evaluate.');
    process.exit(1);
  }
  const file = join(config.kb.root, 'tests', 'eval', 'retrieval_eval.yml');
  let all;
  try { all = parseEval(readFileSync(file, 'utf8')); } catch (e) {
    console.error(`cannot read the eval file (${e.code ?? e.name})`);
    process.exit(1);
  }
  const entries = sample(all, limit);
  const kinds = [...new Set(all.map((e) => String(e.kind ?? 'unknown')))];
  console.log(`back end: ${retrievalOnly ? 'none' : config.llm.backend}   questions in file: ${all.length}   evaluated: ${entries.length}`);
  const llm = retrievalOnly ? null : createLlm(config);
  let pack = '';
  if (workMode) {
    console.log(`work mode: model ${config.llm.workModel}  documents ${config.work.topK}  all-terms matches ${config.work.exact}  follow-up search ${config.work.followUp}`);
    pack = loadContextPack(config, { log: (line) => console.log(line) }); // prints its size only
  }
  await run({ config, entries, retrievalOnly, llm, kinds, workMode, pack });
  if (!retrievalOnly && !workMode) await smallTalk({ llm, routing: routingFrom(config) }); // work mode does not change how small talk is judged
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => { console.error(`eval failed: ${e.name}`); process.exit(1); });
}
