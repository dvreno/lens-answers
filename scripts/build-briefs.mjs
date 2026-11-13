#!/usr/bin/env node
// Builds the daily project briefs. Prints one line per project (name and result), never note text.
import { loadConfig } from '../server/config.mjs';
import { createLlm } from '../server/llm/index.mjs';
import { buildBriefs } from '../server/sources/projects.mjs';

const config = loadConfig();
const written = await buildBriefs(config, createLlm(config), { now: new Date() });
for (const p of config.projects) console.log(`${p.name}: ${written.failed.includes(p.name) ? 'failed' : 'written'}`);
process.exitCode = written.failed.length ? 1 : 0;
