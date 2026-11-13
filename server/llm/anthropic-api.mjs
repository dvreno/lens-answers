// Anthropic SDK back end. Key comes from ANTHROPIC_API_KEY (SDK default resolution).

// Haiku models take the basic web search tool; newer families take the dynamic-filtering one.
function webSearchTool(model) {
  const type = /haiku/i.test(model) ? 'web_search_20250305' : 'web_search_20260209';
  return { type, name: 'web_search', max_uses: 3 };
}

export function collectSources(content) {
  const urls = [];
  for (const block of content || []) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === 'web_search_result' && r.url && !urls.includes(r.url)) urls.push(r.url);
      }
    }
  }
  return urls;
}

// One whole call (SDK retries included) rejects after this long; each HTTP attempt has the same SDK timeout.
const REQUEST_TIMEOUT_MS = 20000;

export function createAnthropicBackend(deps = {}) {
  let client = deps.client;
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  async function getClient() {
    if (!client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      client = new Anthropic();
    }
    return client;
  }
  return {
    async complete({ model, system, user, maxTokens, webSearch }) {
      const c = await getClient();
      const params = {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      };
      if (webSearch) params.tools = [webSearchTool(model)];
      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Anthropic request timed out after ${timeoutMs} ms`)), timeoutMs);
      });
      let res;
      try {
        res = await Promise.race([c.messages.create(params, { timeout: timeoutMs }), timedOut]);
      } finally {
        clearTimeout(timer);
      }
      if (res.stop_reason === 'refusal') throw new Error('Model declined the request');
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (!text) throw new Error(`Anthropic returned no text (stop_reason: ${res.stop_reason})`);
      return { text, sources: collectSources(res.content) };
    },
  };
}
