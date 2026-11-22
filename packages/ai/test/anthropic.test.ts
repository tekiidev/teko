import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anthropic, buildAnthropicBody } from '../src/providers/anthropic.ts';

test('breakpoints de cache no system e na última mensagem', () => {
  const body = buildAnthropicBody({
    model: 'claude-x',
    system: 'regras estáveis',
    messages: [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: 'olá' },
      { role: 'user', content: 'tudo bem?' },
    ],
    maxTokens: 100,
    tools: null,
  });
  assert.deepEqual(body.system, [{ type: 'text', text: 'regras estáveis', cache_control: { type: 'ephemeral' } }]);
  const last = body.messages.at(-1);
  assert.deepEqual(last.content, [{ type: 'text', text: 'tudo bem?', cache_control: { type: 'ephemeral' } }]);
  // mensagens anteriores ficam intactas (prefixo idêntico entre chamadas)
  assert.equal(body.messages[0].content, 'oi');
});

test('não altera as mensagens originais', () => {
  const messages = [{ role: 'user', content: 'oi' }];
  buildAnthropicBody({ model: 'm', system: '', messages, maxTokens: 10, tools: null });
  assert.equal(messages[0].content, 'oi');
});

test('soma os tokens de cache no total de entrada', async () => {
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', usage: { output_tokens: 7 } },
  ];
  const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const original = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = (async (_url, init) => {
    sentBody = JSON.parse(String(init.body));
    return new Response(sse, { status: 200 });
  }) as typeof fetch;
  try {
    let text = '';
    const r = await anthropic({
      model: 'claude-x', system: 's', messages: [{ role: 'user', content: 'oi' }], maxTokens: 10,
      apiKey: 'k', baseUrl: 'https://api.example', signal: undefined, onDelta: (d) => { text += d; }, tools: null,
    });
    assert.equal(text, 'ok');
    assert.equal(r.inputTokens, 1000);
    assert.equal(r.cachedInputTokens, 900);
    assert.equal(r.cacheWriteTokens, 50);
    assert.equal(r.outputTokens, 7);
    assert.equal(sentBody.system[0].cache_control.type, 'ephemeral');
  } finally {
    globalThis.fetch = original;
  }
});

function mockStream(events) {
  const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

const call = () => anthropic({
  model: 'claude-x', system: 's', messages: [{ role: 'user', content: 'oi' }], maxTokens: 10,
  apiKey: 'k', baseUrl: 'https://api.example', signal: undefined, onDelta: () => {}, tools: null,
});

test('guarda thinking com assinatura e tool_use na ordem, pra repassar no loop', async () => {
  const restore = mockStream([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pensando' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } },
    { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
  ]);
  try {
    const r = await call();
    assert.deepEqual(r.toolCalls, [{ id: 'tu_1', name: 'read_file', args: { path: 'a.ts' } }]);
    assert.deepEqual(r.providerContent.anthropic, [
      { type: 'thinking', thinking: 'pensando', signature: 'sig123' },
      { type: 'tool_use', id: 'tu_1', name: 'read_file', input: { path: 'a.ts' } },
    ]);
  } finally {
    restore();
  }
});

test('repassa os blocos brutos na rodada seguinte', () => {
  const raw = [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'tool_use', id: 't', name: 'n', input: {} }];
  const body = buildAnthropicBody({
    model: 'm', system: '', maxTokens: 10, tools: null,
    messages: [
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'n', args: {} }], providerContent: { anthropic: raw } },
      { role: 'tool', toolCallId: 't', name: 'n', content: 'ok' },
    ],
  });
  assert.deepEqual(body.messages[1].content, raw);
});

test('refusal vira erro com code "refusal" (o roteador tenta o próximo modelo)', async () => {
  const restore = mockStream([
    { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } },
  ]);
  try {
    await assert.rejects(call(), (err: any) => err.code === 'refusal');
  } finally {
    restore();
  }
});

test('max_tokens tem piso de 16000 (thinking divide o limite com a resposta)', () => {
  const body = buildAnthropicBody({ model: 'm', system: '', messages: [{ role: 'user', content: 'x' }], maxTokens: 4096, tools: null });
  assert.equal(body.max_tokens, 16000);
});
