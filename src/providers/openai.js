import { normalizeMessages, sseData, toProviderError } from './http.js';

/**
 * Adapter para qualquer endpoint compatível com OpenAI Chat Completions:
 * OpenAI, DeepSeek, Qwen/DashScope, GLM, Kimi, xAI, OpenRouter, Ollama.
 */
export async function openaiCompatible({
  model,
  system,
  messages,
  maxTokens,
  apiKey,
  baseUrl,
  signal,
  onDelta,
  headers: extraHeaders,
}) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const chatMessages = normalizeMessages(messages);
  if (system) chatMessages.unshift({ role: 'system', content: system });

  const baseBody = {
    model,
    messages: chatMessages,
    stream: true,
  };
  if (maxTokens) baseBody.max_tokens = maxTokens;

  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(extraHeaders || {}),
  };

  let res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...baseBody, stream_options: { include_usage: true } }),
    signal,
  });

  // Alguns compatíveis rejeitam stream_options; tenta de novo sem.
  if (res.status === 400) {
    const text = await res.clone().text().catch(() => '');
    if (/stream_options/i.test(text)) {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(baseBody),
        signal,
      });
    }
  }

  if (!res.ok) throw await toProviderError(res);

  let inputTokens = 0;
  let outputTokens = 0;
  let chars = 0;

  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error) throw new Error(json.error.message || 'Erro do provider');

    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      chars += delta.length;
      onDelta(delta);
    }
    if (json.usage) {
      inputTokens = json.usage.prompt_tokens ?? inputTokens;
      outputTokens = json.usage.completion_tokens ?? outputTokens;
    }
  }

  // Fallback grosseiro quando o provider não devolve usage.
  if (!inputTokens) {
    inputTokens = Math.ceil(chatMessages.reduce((n, m) => n + m.content.length, 0) / 4);
  }
  if (!outputTokens) outputTokens = Math.ceil(chars / 4);

  return { inputTokens, outputTokens };
}
