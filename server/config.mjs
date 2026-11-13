import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG_PATH = '~/.config/lens-answers/config.json';

export function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}

// `~` at the start of each entry of a path list (PYTHONPATH and the like; entries separated by : or, on Windows, ;).
const expandHomeList = (value) => String(value).replace(/(^|[:;])~(?=[\\/:;]|$)/g, (_, before) => `${before}${homedir()}`);

/** True when a bridge to the wearer's own notes is configured (the work route and work mode exist). */
export function kbEnabled(config) {
  return Array.isArray(config?.kb?.command) && config.kb.command.length > 0;
}

export function defaults() {
  return {
    port: 8790,
    tokenFile: '~/.config/lens-answers/token',
    // warm: claude-code only; keep a started `claude` process waiting for the next call (faster cards).
    // workModel: writes the answer in work mode (stronger and slower than answerModel).
    // claudeCommand: claude-code only; how to start Claude Code (the program, then any arguments of its own).
    // Change it when `claude` is not a program your system can start directly, e.g. on Windows with an npm
    // install: ["node", "C:\\path\\to\\claude-code\\cli.js"].
    llm: {
      backend: 'claude-code', fastModel: 'claude-haiku-5-5', answerModel: 'claude-haiku-5-5',
      workModel: 'claude-sonnet-5-5', warm: true, claudeCommand: ['claude'],
    },
    asr: {
      url: 'http://127.0.0.1:8089',
      model: 'qwen3-asr',
      backup: { enabled: false, url: '', model: '', keyEnv: 'LENS_ASR_BACKUP_KEY' },
    },
    // Who wears the glasses. Both are optional and go into prompts as written, so keep them short.
    profile: {
      wearer: '', // a sentence for the question classifier, e.g. 'The wearer runs a bike shop, so ... are usually "work".'
      audience: '', // who the work-mode answer is for, e.g. 'someone who runs a bike shop'
    },
    // Your own notes and documents (the "work" route and work mode). Off until `command` names a bridge:
    // the program (and its arguments) that searches them, speaking the JSON-lines protocol in bridge/README.md.
    // `root` is the folder it searches (passed to it as KB_ROOT); `env` adds environment variables.
    kb: { root: '', command: [], env: {}, timeoutMs: 4000 },
    // What sends a question to the work route besides the model's own judgement. Each pattern is a regular
    // expression: a string (matched without regard to case) or {pattern, flags} (flags '' = case matters).
    routing: {
      work: {
        about: '', // what work questions are about, e.g. 'shop systems, repairs, suppliers, procedures'
        always: [], // a match always makes a question a work question
        lean: [], // a match turns a question the model called general or web into a work question
      },
    },
    // Live lookup of Nevada Revised Statutes sections (the "statute" route). Off by default.
    statutes: {
      enabled: false,
      about: 'Nevada Revised Statutes (NRS)', // what the classifier is told the statute route is for
      chapterExamples: ['118A', '484B'], // example chapter numbers shown to the classifier
      sectionExample: '118A.200',
    },
    projects: [],
    sharedNotePaths: [],
    briefsDir: '~/.local/share/lens-answers/briefs',
    card: { ttlMs: 7000, heardMax: 80, sourceMax: 60, answerMax: 180, nothingSolid: 'show' },
    // shorten / cutSearchMs: how a sentence ends when people keep talking (see server/audio/segmenter.mjs).
    vad: {
      silenceMs: 1000, minSpeechMs: 400, maxUtteranceMs: 10000,
      shorten: [{ afterMs: 4000, silenceMs: 400 }, { afterMs: 8000, silenceMs: 200 }], cutSearchMs: 2000,
    },
    callMode: false,
    // Work mode (switched on from the phone page or a long press on the glasses button): every question
    // goes to the knowledge base, which is searched more widely and answered by llm.workModel.
    work: {
      silenceMs: 1500, // quiet that ends a sentence in work mode (vad.silenceMs otherwise)
      topK: 10, // documents asked for
      exact: true, // also sections that hold every content word of the question
      followUp: true, // one more search, phrased by the model, when the first finds no answer
      contextPack: 'KB_CONTEXT_PACK.md', // notes file inside kb.root given to the model; '' turns it off
      passageChars: 4000, // characters kept per passage
      totalChars: 36000, // characters kept over all passages
    },
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
  for (const [k, v] of Object.entries(over)) {
    if (isObj(v) && isObj(base[k])) merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

const num = (s) => Number(s);
const bool = (s) => /^(1|true|yes|on)$/i.test(String(s).trim());

// env var -> [path into config, converter]
const ENV_MAP = {
  LENS_PORT: [['port'], num],
  LENS_TOKEN_FILE: [['tokenFile']],
  LENS_LLM_BACKEND: [['llm', 'backend']],
  LENS_FAST_MODEL: [['llm', 'fastModel']],
  LENS_ANSWER_MODEL: [['llm', 'answerModel']],
  LENS_LLM_WARM: [['llm', 'warm'], bool],
  LENS_WORK_MODEL: [['llm', 'workModel']],
  LENS_WORK_SILENCE_MS: [['work', 'silenceMs'], num],
  LENS_ASR_URL: [['asr', 'url']],
  LENS_ASR_MODEL: [['asr', 'model']],
  LENS_ASR_BACKUP_ENABLED: [['asr', 'backup', 'enabled'], bool],
  LENS_ASR_BACKUP_URL: [['asr', 'backup', 'url']],
  LENS_ASR_BACKUP_MODEL: [['asr', 'backup', 'model']],
  LENS_KB_ROOT: [['kb', 'root']],
  LENS_KB_TIMEOUT_MS: [['kb', 'timeoutMs'], num],
  LENS_BRIEFS_DIR: [['briefsDir']],
  LENS_CARD_TTL_MS: [['card', 'ttlMs'], num],
  LENS_CALL_MODE: [['callMode'], bool],
};

function setPath(obj, path, value) {
  let o = obj;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path[path.length - 1]] = value;
}

/**
 * Defaults, then the config file, then LENS_* env vars.
 * A missing file is fine; an unreadable-as-JSON file throws.
 */
export function loadConfig(env = process.env, path = DEFAULT_CONFIG_PATH) {
  const cfg = defaults();
  let raw = null;
  try {
    raw = readFileSync(expandHome(path), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
  }
  if (raw !== null) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // The parser's own message quotes the text around the mistake, which may be one of your private words.
      throw new Error(`Config file ${path} is not valid JSON`);
    }
    if (!isObj(parsed)) throw new Error(`Config file ${path} must contain a JSON object`);
    merge(cfg, parsed);
  }
  for (const [name, [p, conv]] of Object.entries(ENV_MAP)) {
    if (env[name] === undefined || env[name] === '') continue;
    const v = conv ? conv(env[name]) : env[name];
    if (typeof v === 'number' && Number.isNaN(v)) throw new Error(`${name} must be a number`);
    setPath(cfg, p, v);
  }
  // A section set to null or to the wrong kind of value would otherwise crash somewhere far from here.
  for (const key of ['llm', 'asr', 'profile', 'kb', 'routing', 'statutes', 'card', 'vad', 'work']) {
    if (!isObj(cfg[key])) throw new Error(`${key} must be an object`);
  }
  if (!isObj(cfg.routing.work)) throw new Error('routing.work must be an object');
  for (const key of ['projects', 'sharedNotePaths']) {
    if (!Array.isArray(cfg[key])) throw new Error(`${key} must be a list`);
  }
  cfg.tokenFile = expandHome(cfg.tokenFile);
  cfg.briefsDir = expandHome(cfg.briefsDir);
  const claude = cfg.llm.claudeCommand;
  if (!Array.isArray(claude) || !claude.length || claude.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('llm.claudeCommand must be a list of strings: the program, then its arguments');
  }
  cfg.llm.claudeCommand = claude.map(expandHome);
  cfg.kb.root = expandHome(cfg.kb.root);
  const command = cfg.kb.command ?? [];
  if (!Array.isArray(command) || command.some((part) => typeof part !== 'string' || !part)) {
    throw new Error('kb.command must be a list of strings: the bridge program, then its arguments');
  }
  cfg.kb.command = command.map(expandHome);
  cfg.kb.env = Object.fromEntries(Object.entries(isObj(cfg.kb.env) ? cfg.kb.env : {}).map(([k, v]) => [k, expandHomeList(v)]));
  cfg.sharedNotePaths = cfg.sharedNotePaths.map(expandHome);
  cfg.projects = cfg.projects.map((pr) => ({ ...pr, paths: (pr.paths || []).map(expandHome) }));
  return cfg;
}
