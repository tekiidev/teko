import { sseData, toProviderError } from './http.js';
import { toAnthropic, toolSchemas } from './format.js';

function parseArgs(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function anthropic({
  model,
  system,
  messages,
  maxTokens,
  apiKey,
  baseUrl,
  signal,
  onDelta,
  tools,
}) {
  const body = {
    model,
    max_tokens: maxTokens || 4096,
    messages: toAnthropic(messages, system),
    stream: true,
  };
  if (system) body.system = system;
  if (tools?.length) body.tools = toolSchemas(tools).anthropic;

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
  const blocks = new Map();

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
      case 'content_block_start': {
        const block = event.content_block;
        if (block?.type === 'tool_use') {
          blocks.set(event.index, { id: block.id, name: block.name, argsText: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta;
        if (delta?.type === 'text_delta' && delta.text) onDelta(delta.text);
        if (delta?.type === 'input_json_delta') {
          const current = blocks.get(event.index);
          if (current) current.argsText += delta.partial_json || '';
        }
        break;
      }
      case 'message_delta':
        if (event.usage?.output_tokens != null) outputTokens = event.usage.output_tokens;
        break;
      case 'error':
        throw new Error(event.error?.message || 'Erro do provider Anthropic');
      default:
        break;
    }
  }

  const toolCalls = [...blocks.values()]
    .filter((block) => block.name)
    .map((block) => ({
      id: block.id,
      name: block.name,
      args: parseArgs(block.argsText),
    }));

  return { inputTokens, outputTokens, toolCalls };
}
