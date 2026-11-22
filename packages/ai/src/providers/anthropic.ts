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

const EPHEMERAL = { type: 'ephemeral' };

/** Marca o último bloco da última mensagem como breakpoint de cache. */
function withMessageBreakpoint(messages) {
  if (!messages.length) return messages;
  const out = messages.slice();
  const last = { ...out[out.length - 1] };
  const blocks = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content || ' ' }]
    : (last.content || []).map((block) => ({ ...block }));
  if (!blocks.length) return messages;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
  last.content = blocks;
  out[out.length - 1] = last;
  return out;
}

/**
 * Monta o corpo da requisição com prompt caching:
 * - breakpoint no system (cobre ferramentas + system, estáveis entre mensagens)
 * - breakpoint na última mensagem (reaproveita a conversa nas rodadas de ferramentas)
 * Prefixos abaixo do mínimo do modelo simplesmente não entram no cache, sem erro.
 */
export function buildAnthropicBody({ model, system, messages, maxTokens, tools }) {
  const body: Record<string, any> = {
    model,
    max_tokens: maxTokens || 4096,
    messages: withMessageBreakpoint(toAnthropic(messages, system)),
    stream: true,
  };
  if (system) body.system = [{ type: 'text', text: system, cache_control: EPHEMERAL }];
  if (tools?.length) body.tools = toolSchemas(tools).anthropic;
  return body;
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
  const body = buildAnthropicBody({ model, system, messages, maxTokens, tools });

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
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  const blocks = new Map();

  for await (const data of sseData(res)) {
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage || {};
        inputTokens = usage.input_tokens ?? inputTokens;
        outputTokens = usage.output_tokens ?? outputTokens;
        cachedInputTokens = usage.cache_read_input_tokens ?? cachedInputTokens;
        cacheWriteTokens = usage.cache_creation_input_tokens ?? cacheWriteTokens;
        break;
      }
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

  // A Anthropic informa input_tokens sem os tokens de cache; o Teko guarda o total.
  return {
    inputTokens: inputTokens + cachedInputTokens + cacheWriteTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    toolCalls,
  };
}
