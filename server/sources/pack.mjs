// The knowledge base's context pack: a short notes file kept inside the knowledge base folder (terms,
// systems, people, known issues, common questions). It is read once when the server starts, held in memory
// and given to the work-mode model with each question. It is never copied, cached on disk or logged; the
// log line carries its size only. Read-only: nothing under the knowledge base folder is ever written.
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { kbEnabled } from '../config.mjs';

export const PACK_MAX_CHARS = 24000;

/**
 * @param {{kb: {root: string, command?: string[]}, work?: {contextPack?: string}}} config
 * @param {{log?: (line: string) => void}} [deps]
 * @returns {string} the trimmed text, or '' (unset, no notes source, outside the folder, missing, unreadable or empty)
 */
export function loadContextPack(config, { log = () => {} } = {}) {
  const name = config.work?.contextPack;
  // No notes folder or no bridge means no work mode, so no pack (and '' must never resolve to the current folder).
  if (typeof name !== 'string' || !name.trim() || !config.kb?.root || !kbEnabled(config)) { log('context-pack off'); return ''; }
  const root = resolve(config.kb.root);
  const file = resolve(root, name);
  const rel = relative(root, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) { log('context-pack refused'); return ''; }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { log('context-pack missing'); return ''; }
  text = text.trim().slice(0, PACK_MAX_CHARS);
  log(text ? `context-pack chars=${text.length}` : 'context-pack empty');
  return text;
}
