import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiCompatible } from '../src/providers/openai.ts';

async function run(usage) {
  const chunks = [
    { choices: [{ delta: { content: 'oi' } }] },
    { choices: [], usage },
  ];
  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch;
  try {
    return await openaiCompatible({
      model: 'm', system: 's', messages: [{ role: 'user', content: 'x' }], maxTokens: 10,
      apiKey: 'k', baseUrl: 'https://api.example', signal: undefined, onDelta: () => {}, tools: null, headers: undefined,
    });
  } finally {
    globalThis.fetch = original;
  }
}

test('OpenAI: lê prompt_tokens_details.cached_tokens', async () => {
  const r = await run({ prompt_tokens: 2000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 1536 } });
  assert.equal(r.inputTokens, 2000);
  assert.equal(r.cachedInputTokens, 1536);
});

test('DeepSeek: lê prompt_cache_hit_tokens', async () => {
  const r = await run({ prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 640 });
  assert.equal(r.cachedInputTokens, 640);
});

test('modelos novos da OpenAI usam max_completion_tokens; compatíveis seguem com max_tokens', async () => {
  const { tokenLimitParam } = await import('../src/providers/openai.ts');
  assert.equal(tokenLimitParam('gpt-5.4-nano', 'https://api.openai.com/v1'), 'max_completion_tokens');
  assert.equal(tokenLimitParam('gpt-4.1-mini', 'https://api.openai.com/v1'), 'max_completion_tokens');
  assert.equal(tokenLimitParam('gpt-6-luna', 'https://openrouter.ai/api/v1'), 'max_completion_tokens');
  assert.equal(tokenLimitParam('deepseek-chat', 'https://api.deepseek.com/v1'), 'max_tokens');
  assert.equal(tokenLimitParam('qwen3:8b', 'http://localhost:11434/v1'), 'max_tokens');
});
