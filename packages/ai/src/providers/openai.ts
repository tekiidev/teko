import { sseData, toProviderError } from './http.js';
import { toOpenAI, toolSchemas } from './format.js';

function parseArgs(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

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
  tools,
  headers: extraHeaders,
}) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const chatMessages = toOpenAI(messages, system);

  const baseBody: Record<string, any> = { model, messages: chatMessages, stream: true };
  if (model === 'gpt-6-luna') baseBody.reasoning_effort = 'none';
  if (maxTokens) baseBody.max_tokens = maxTokens;
  if (tools?.length) baseBody.tools = toolSchemas(tools).openai;

  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(extraHeaders || {}),
  };

  const request = (body) =>
    fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });

  let res = await request({ ...baseBody, stream_options: { include_usage: true } });

  // Alguns compatíveis rejeitam stream_options; tenta de novo sem.
  if (res.status === 400) {
    const text = await res.clone().text().catch(() => '');
    if (/stream_options/i.test(text)) res = await request(baseBody);
  }

  if (!res.ok) throw await toProviderError(res);

  let inputTokens = 0;
  let outputTokens = 0;
  let chars = 0;
  const calls = new Map();

  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error) throw new Error(json.error.message || 'Erro do provider');

    const delta = json.choices?.[0]?.delta;
    if (!delta) continue;

    if (typeof delta.content === 'string' && delta.content) {
      chars += delta.content.length;
      onDelta(delta.content);
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = part.index ?? 0;
        const current = calls.get(index) || { id: '', name: '', argsText: '' };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.argsText += part.function.arguments;
        calls.set(index, current);
      }
    }

    if (json.usage) {
      inputTokens = json.usage.prompt_tokens ?? inputTokens;
      outputTokens = json.usage.completion_tokens ?? outputTokens;
    }
  }

  if (!inputTokens) {
    inputTokens = Math.ceil(chatMessages.reduce((n, m) => n + String(m.content || '').length, 0) / 4);
  }
  if (!outputTokens) outputTokens = Math.ceil(chars / 4);

  const toolCalls = [...calls.entries()]
    .filter(([, call]) => call.name)
    .map(([index, call]) => ({
      id: call.id || `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
      name: call.name,
      args: parseArgs(call.argsText),
    }));

  return { inputTokens, outputTokens, toolCalls };
}
