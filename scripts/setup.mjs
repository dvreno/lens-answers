#!/usr/bin/env node
// First-run setup: copies the MemoMind Web SDK into phone/vendor, creates your config from the example when
// you have none, and checks the things the server needs. It never overwrites a config, never prints what a
// config or a key holds, and never fails half-way: every check becomes one line.
//
//   npm run setup
//
// "todo" lines must be dealt with before the server is useful; "note" lines are optional extras.
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_CONFIG_PATH, expandHome, kbEnabled, loadConfig } from '../server/config.mjs';
import { syncSdk as realSyncSdk } from './sync-sdk.mjs';

const MIN_NODE = 20;
const SPEECH_TIMEOUT_MS = 1500;
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** True when `name` is a program on the PATH of `env`. */
export function isOnPath(name, env = process.env) {
  return String(env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => {
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { return false; }
  });
}

/**
 * @param {{env?: object, nodeVersion?: string, configPath?: string, examplePath?: string,
 *   syncSdk?: () => Promise<{version: string}>, onPath?: (name: string) => boolean, fetchImpl?: typeof fetch}} [deps]
 * @returns {Promise<{lines: string[], ready: boolean}>} `ready`: no todo line was written
 */
export async function runSetup({
  env = process.env,
  nodeVersion = process.versions.node,
  configPath = expandHome(DEFAULT_CONFIG_PATH),
  examplePath = join(REPO, 'config.example.json'),
  syncSdk = realSyncSdk,
  onPath = (name) => isOnPath(name, env),
  fetchImpl = globalThis.fetch,
} = {}) {
  const lines = ['Lens Answers setup', ''];
  let ready = true;
  const ok = (text) => lines.push(`  ok    ${text}`);
  const note = (text) => lines.push(`  note  ${text}`);
  const todo = (text) => { ready = false; lines.push(`  todo  ${text}`); };

  if (Number(nodeVersion.split('.')[0]) >= MIN_NODE) ok(`Node ${nodeVersion}`);
  else todo(`Node ${nodeVersion} is too old: version ${MIN_NODE} or newer is needed.`);

  try {
    const { version } = await syncSdk();
    ok(`MemoMind Web SDK ${version} copied to phone/vendor`);
  } catch {
    todo('MemoMind Web SDK not found. Clone https://github.com/memomind-open/plugin-open-platform next to this '
      + 'folder (or set MEMOMIND_SDK to where it is), then run setup again.');
  }

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

  let config = null;
  try { config = loadConfig(env, configPath); } catch (e) {
    // loadConfig's messages name the file or the setting, never what it holds.
    const why = /not valid JSON/.test(e?.message ?? '') ? 'is not valid JSON' : `holds a wrong value (${e?.message ?? 'unknown'})`;
    todo(`Config ${configPath} ${why}. Fix it, then run setup again.`);
  }
  if (config) {
    const backend = config.llm.backend;
    if (backend === 'anthropic-api') {
      if (env.ANTHROPIC_API_KEY) ok('Model back end: anthropic-api (ANTHROPIC_API_KEY is set)');
      else todo('Model back end: anthropic-api needs ANTHROPIC_API_KEY in the environment when you start the server.');
    } else if (onPath('claude')) ok(`Model back end: ${backend} (the \`claude\` command is installed)`);
    else todo(`Model back end: ${backend} needs the \`claude\` command (Claude Code), installed and logged in.`);

    let speechUp = false;
    try {
      await fetchImpl(config.asr.url, { signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS) });
      speechUp = true; // any answer at all: only a refused or timed-out connection means nothing is there
    } catch { /* not running */ }
    if (speechUp) ok(`Speech-to-text: a server answers at ${config.asr.url}`);
    else todo(`Speech-to-text: nothing answers at ${config.asr.url}. Start your speech server (README, "Speech-to-text").`);

    if (kbEnabled(config)) ok('Notes source: a bridge is configured (work mode is available)');
    else note('Notes source: none, so work mode is off. bridge/README.md says how to add one.');
  }

  if (onPath('tailscale')) ok('Tailscale is installed (for reaching the server from your phone)');
  else note('Tailscale not found. It is only needed to reach the server from a phone (README, "Reaching the server from the phone").');

  lines.push('');
  if (ready) {
    lines.push('Ready. Next:', '  1. npm start', '  2. Load the phone/ folder as a plugin in MemoMind Studio (README, "Phone plugin").',
      '  3. On the plugin page enter the server address and the token from the token file, then Save and connect.');
  } else lines.push('Not ready yet: deal with the todo lines above, then run `npm run setup` again.');
  return { lines, ready };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { lines, ready } = await runSetup();
  console.log(lines.join('\n'));
  process.exitCode = ready ? 0 : 1;
}
