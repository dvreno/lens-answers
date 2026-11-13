import { createAnthropicBackend } from './anthropic-api.mjs';
import { createClaudeCodeBackend } from './claude-code.mjs';

/**
 * @param {import('../types.mjs').Config} config
 * @param {{client?:object, spawn?:Function, timeoutMs?:number, warm?:boolean}} [deps]  test seams: Anthropic client, child_process.spawn
 * @returns {import('../types.mjs').Llm}
 */
export function createLlm(config, deps = {}) {
  const backend = config.llm.backend;
  let impl;
  if (backend === 'anthropic-api') impl = createAnthropicBackend({ client: deps.client });
  else if (backend === 'claude-code') {
    impl = createClaudeCodeBackend({
      spawn: deps.spawn, command: config.llm.claudeCommand, timeoutMs: deps.timeoutMs, warm: deps.warm ?? config.llm.warm,
    });
  }
  else throw new Error(`Unknown llm backend: ${backend}`);
  const models = { fast: config.llm.fastModel, answer: config.llm.answerModel, work: config.llm.workModel };
  return {
    async complete(req) {
      const model = models[req.model];
      if (!model) throw new Error(`Unknown model alias: ${req.model}`);
      return impl.complete({ ...req, model });
    },
    /** Release anything the back end keeps between calls (the claude-code warm standby processes). */
    close() { impl.close?.(); },
  };
}
