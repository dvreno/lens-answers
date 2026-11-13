#!/usr/bin/env node
// Guided first-run setup. It walks through what the server needs, one step at a time, and offers to do the
// parts it can: fetch MemoMind's Web SDK, create your config, pick how to reach Claude, test the speech
// server, copy the plugin into Studio, and show what to type into the plugin page.
//
//   npm run setup            asks before it does anything beyond checking
//   npm run setup -- --check checks only, asks nothing (also what happens when there is no terminal)
//
// It never overwrites a config (it changes single settings, and says which), never asks for or prints an
// API key, shows the token only if you say so, and never fails half-way: every step becomes one line.
// "todo" lines must be dealt with before the server is useful; "note" lines are optional extras.
import { accessSync, chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG_PATH, expandHome, kbEnabled, loadConfig } from '../server/config.mjs';
import { pcmToWav } from '../server/audio/asr.mjs';
import { syncSdk as realSyncSdk, sdkRoot } from './sync-sdk.mjs';

const MIN_NODE = 22;
const SPEECH_TIMEOUT_MS = 20000; // the first clip may have to wait for the speech model to load
const SDK_URL = 'https://github.com/memomind-open/plugin-open-platform';
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * True when `name` is a program on the PATH of `env`. On Windows a program is found by its extension
 * (claude.exe, claude.cmd: the PATHEXT list), and the PATH variable may be spelled Path.
 */
export function isOnPath(name, env = process.env, platform = process.platform) {
  const windows = platform === 'win32';
  const dirs = String(env.PATH ?? env.Path ?? '').split(windows ? ';' : delimiter).filter(Boolean);
  const names = windows
    ? ['', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)].map((ext) => `${name}${ext}`)
    : [name];
  return dirs.some((dir) => names.some((file) => {
    try { accessSync(join(dir, file), windows ? constants.F_OK : constants.X_OK); return true; } catch { return false; }
  }));
}

// Half a second of a quiet 220 Hz tone as a WAV file: enough for a speech server to accept and answer.
function testClip() {
  const pcm = new Int16Array(8000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / 16000));
  return pcmToWav(pcm);
}

// Changes one setting in the config file and leaves the rest of it as it was.
function setInConfig(configPath, path, value) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  let at = config;
  for (const key of path.slice(0, -1)) {
    if (at[key] === null || typeof at[key] !== 'object' || Array.isArray(at[key])) at[key] = {};
    at = at[key];
  }
  at[path[path.length - 1]] = value;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(configPath, 0o600);
}

async function realTestModel(config) {
  const { createLlm } = await import('../server/llm/index.mjs');
  const llm = createLlm({ ...config, llm: { ...config.llm, warm: false } });
  try {
    const { text } = await llm.complete({ model: 'fast', system: 'Reply with the single word: ready', user: 'Say ready.', maxTokens: 10 });
    if (!String(text ?? '').trim()) throw new Error('empty reply');
    return text;
  } finally { llm.close?.(); }
}

async function realReadToken(tokenFile) {
  const { loadToken } = await import('../server/server.mjs');
  return loadToken(tokenFile);
}

/**
 * @param {{env?: object, nodeVersion?: string, configPath?: string, examplePath?: string, sdkDir?: string,
 *   syncSdk?: () => Promise<{version: string}>, fetchSdk?: (dir: string) => Promise<void>|void,
 *   onPath?: (name: string) => boolean, fetchImpl?: typeof fetch,
 *   testModel?: (config: object) => Promise<string>, copyPlugin?: (from: string, to: string) => void,
 *   readToken?: (tokenFile: string) => Promise<string>|string,
 *   ask?: (question: string) => Promise<string>, print?: (line: string) => void}} [deps]
 *   `ask`: given, setup is guided and offers to do things; left out, it only checks.
 * @returns {Promise<{lines: string[], ready: boolean}>} `ready`: no todo line was written
 */
export async function runSetup({
  env = process.env,
  nodeVersion = process.versions.node,
  configPath = expandHome(DEFAULT_CONFIG_PATH),
  examplePath = join(REPO, 'config.example.json'),
  sdkDir = sdkRoot(),
  syncSdk = realSyncSdk,
  fetchSdk = (dir) => { execFileSync('git', ['clone', '--depth', '1', SDK_URL, dir], { stdio: 'inherit' }); },
  onPath = (name) => isOnPath(name, env),
  fetchImpl = globalThis.fetch,
  testModel = realTestModel,
  copyPlugin = (from, to) => cpSync(from, to, { recursive: true }),
  readToken = realReadToken,
  ask,
  print = () => {},
} = {}) {
  const lines = [];
  let ready = true;
  const say = (line) => { lines.push(line); print(line); };
  const ok = (text) => say(`  ok    ${text}`);
  const note = (text) => say(`  note  ${text}`);
  const todo = (text) => { ready = false; say(`  todo  ${text}`); };
  // A question with a yes/no answer; Enter takes the default. Never asked when setup only checks.
  const agree = async (question, byDefault) => {
    if (!ask) return false;
    const answer = String(await ask(`${question} ${byDefault ? '[Y/n]' : '[y/N]'} `) ?? '').trim().toLowerCase();
    return answer ? answer.startsWith('y') : byDefault;
  };

  say('Lens Answers setup');
  say('');

  // 1. Node
  if (Number(nodeVersion.split('.')[0]) >= MIN_NODE) ok(`Node ${nodeVersion}`);
  else todo(`Node ${nodeVersion} is too old: version ${MIN_NODE} or newer is needed.`);

  // 2. MemoMind's Web SDK (theirs, so it is fetched or pointed to, never shipped here)
  let sdk = false;
  const sync = async () => {
    const { version } = await syncSdk();
    sdk = true;
    ok(`MemoMind Web SDK ${version} copied to phone/vendor`);
  };
  try { await sync(); } catch {
    if (await agree(`MemoMind's Web SDK is not on this computer. Fetch it now into ${sdkDir}? (git clone ${SDK_URL})`, true)) {
      try { await fetchSdk(sdkDir); await sync(); } catch {
        todo(`MemoMind Web SDK could not be fetched. Clone ${SDK_URL} next to this folder yourself, then run setup again.`);
      }
    } else {
      todo(`MemoMind Web SDK not found. Clone ${SDK_URL} next to this folder (or set MEMOMIND_SDK to where it is), then run setup again.`);
    }
  }

  // 3. Your config
  if (existsSync(configPath)) ok(`Config found at ${configPath} (left as it is)`);
  else {
    try {
      mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
      copyFileSync(examplePath, configPath);
      chmodSync(configPath, 0o600);
      ok(`Config created at ${configPath}`);
    } catch (e) {
      todo(`Config could not be created at ${configPath} (${e.code ?? 'error'}). The server runs on its defaults without one.`);
    }
  }
  const load = () => {
    try { return loadConfig(env, configPath); } catch (e) {
      // loadConfig's messages name the file or the setting, never what it holds.
      const why = /not valid JSON/.test(e?.message ?? '') ? 'is not valid JSON' : `holds a wrong value (${e?.message ?? 'unknown'})`;
      todo(`Config ${configPath} ${why}. Fix it, then run setup again.`);
      return null;
    }
  };
  let config = load();

  if (config) {
    // 4. How to reach Claude
    if (ask && existsSync(configPath)) {
      const now = config.llm.backend === 'anthropic-api' ? '2' : '1';
      const answer = String(await ask('How will it reach Claude? 1 = Claude Code (the `claude` command, your subscription), '
        + `2 = an Anthropic API key in the ANTHROPIC_API_KEY variable. [${now}] `) ?? '').trim();
      const backend = { 1: 'claude-code', 2: 'anthropic-api' }[answer];
      if (backend && backend !== config.llm.backend) {
        setInConfig(configPath, ['llm', 'backend'], backend);
        note(`Set llm.backend to "${backend}" in your config.`);
        config = load() ?? config;
      }
    }
    const backend = config.llm.backend;
    let reachable = false;
    if (backend === 'anthropic-api') {
      reachable = Boolean(env.ANTHROPIC_API_KEY);
      if (reachable) ok('Model back end: anthropic-api (ANTHROPIC_API_KEY is set)');
      else todo('Model back end: anthropic-api needs ANTHROPIC_API_KEY in the environment when you start the server.');
    } else {
      // A command of your own (llm.claudeCommand) is checked by its program: a full path, or a name on the PATH.
      const program = config.llm.claudeCommand[0];
      reachable = /[\\/]/.test(program) ? existsSync(program) : onPath(program);
      if (reachable && program === 'claude') ok(`Model back end: ${backend} (the \`claude\` command is installed)`);
      else if (reachable) ok(`Model back end: ${backend} (started with your own llm.claudeCommand)`);
      else if (program === 'claude') todo(`Model back end: ${backend} needs the \`claude\` command (Claude Code), installed and logged in.`);
      else todo(`Model back end: ${backend} cannot find the program named first in llm.claudeCommand.`);
    }
    if (reachable && await agree('Send one test question to Claude now? (one small model call)', true)) {
      try {
        await testModel(config);
        ok('Claude answered the test question');
      } catch (e) {
        todo(`Claude did not answer the test question (${e?.constructor?.name || 'error'}). `
          + (backend === 'anthropic-api' ? 'Check the key and your network.' : 'Run `claude` once by itself and make sure it is logged in.'));
      }
    }

    // 5. Speech-to-text: send it a short clip, the way the server will
    const probe = async (base) => {
      const form = new FormData();
      form.append('model', config.asr.model);
      form.append('file', new Blob([testClip()], { type: 'audio/wav' }), 'setup-test.wav');
      const response = await fetchImpl(`${base.replace(/\/+$/, '')}/v1/audio/transcriptions`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
      });
      let text;
      try { text = response.ok ? (await response.json())?.text : undefined; } catch { /* not JSON */ }
      if (typeof text === 'string') ok(`Speech-to-text: ${base} transcribed a test clip (model ${config.asr.model})`);
      else {
        todo(`Speech-to-text: ${base} answered with status ${response.status}. Check asr.model ("${config.asr.model}") `
          + 'and that the server offers /v1/audio/transcriptions.');
      }
    };
    const nothing = (base) => todo(`Speech-to-text: nothing answers at ${base}. Start your speech server (README, "Speech-to-text").`);
    try { await probe(config.asr.url); } catch {
      const typed = ask
        ? String(await ask(`No speech server answers at ${config.asr.url}. If yours is at another address, type it (or press Enter to skip): `) ?? '').trim().replace(/\/+$/, '')
        : '';
      if (!typed) nothing(config.asr.url);
      else {
        setInConfig(configPath, ['asr', 'url'], typed);
        note(`Set asr.url to ${typed} in your config.`);
        config = load() ?? config;
        try { await probe(typed); } catch { nothing(typed); }
      }
    }

    // 6. Your own notes (optional)
    if (kbEnabled(config)) ok('Notes source: a bridge is configured (work mode is available)');
    else note('Notes source: none, so work mode is off. bridge/README.md says how to add one.');
  }

  // 7. The plugin where Desktop Studio looks for it
  const studioCopy = join(sdkDir, 'PhoneSDK', 'examples', 'lens-answers');
  if (sdk && await agree(`Copy the plugin into Studio's examples folder (${studioCopy}) so Desktop Studio lists it?`, true)) {
    try {
      copyPlugin(join(REPO, 'phone'), studioCopy);
      ok(`Plugin copied to ${studioCopy} (run setup again after changing the plugin)`);
    } catch (e) {
      todo(`The plugin could not be copied to ${studioCopy} (${e?.code ?? 'error'}).`);
    }
  }

  // 8. Reaching the server from a phone (optional)
  if (onPath('tailscale')) ok('Tailscale is installed (for reaching the server from your phone)');
  else note('Tailscale not found. It is only needed to reach the server from a phone (README, "Reaching the server from the phone").');

  say('');
  if (!ready) {
    say('Not ready yet: deal with the todo lines above, then run `npm run setup` again.');
    return { lines, ready };
  }
  say('Ready. Next:');
  say('  1. npm start');
  say('  2. Open the plugin: Desktop Studio lists it under examples, or see README, "Phone plugin".');
  say('  3. On the plugin page type this in, then Save and connect:');
  if (config) {
    say(`       Address:  127.0.0.1:${config.port}   (Studio on this computer; from a phone, your Tailscale address)`);
    let token = null;
    if (await agree('Show the token here now? (anyone who can see this screen can read it)', false)) {
      try { token = await readToken(config.tokenFile); } catch { /* shown as the file below */ }
    }
    say(token ? `       Token:    ${token}` : `       Token:    in the file ${config.tokenFile} (made when the server first starts)`);
  }
  return { lines, ready };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const guided = process.stdin.isTTY && process.stdout.isTTY && !process.argv.includes('--check');
  const rl = guided ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const { ready } = await runSetup({ ask: rl ? (question) => rl.question(`\n${question}`) : undefined, print: (line) => console.log(line) });
    process.exitCode = ready ? 0 : 1;
  } finally { rl?.close(); }
}
