import { normalizeMessages, sseData, toProviderError } from './http.js';

export async function anthropic({ model, system, messages, maxTokens, apiKey, baseUrl, signal, onDelta }) {
  const body = {
    model,
    max_tokens: maxTokens || 4096,
    messages: normalizeMessages(messages),
    stream: true,
  };
  if (system) body.system = system;

  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await toProviderError(res);

  let inputTokens = 0;
  let outputTokens = 0;

  for await (const data of sseData(res)) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    switch (event.type) {
      case 'message_start':
        inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
        outputTokens = event.message?.usage?.output_tokens ?? outputTokens;
        break;
      case 'content_block_delta':
        if (event.delta?.type === 'text_delta' && event.delta.text) onDelta(event.delta.text);
        break;
      case 'message_delta':
        if (event.usage?.output_tokens != null) outputTokens = event.usage.output_tokens;
        break;
      case 'error':
        throw new Error(event.error?.message || 'Erro do provider Anthropic');
      default:
        break;
    }
  }

  return { inputTokens, outputTokens };
}
