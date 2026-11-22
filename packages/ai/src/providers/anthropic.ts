import { ProviderError, sseData, toProviderError } from './http.js';
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
const MIN_MAX_TOKENS = 16000;

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
    // Nos modelos atuais o thinking fica sempre ligado e divide o limite com a resposta.
    // Com streaming, um teto alto não custa nada a mais: só se paga o que é gerado.
    max_tokens: Math.max(maxTokens || 0, MIN_MAX_TOKENS),
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
  let stopReason = null;
  // Todos os blocos da resposta, na ordem, pra repassar ao modelo no loop de ferramentas.
  // Blocos de thinking precisam voltar intactos (com assinatura) ou a API recusa a continuação.
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
        const block = event.content_block || {};
        if (block.type === 'tool_use') {
          blocks.set(event.index, { type: 'tool_use', id: block.id, name: block.name, argsText: '' });
        } else if (block.type === 'text') {
          blocks.set(event.index, { type: 'text', text: block.text || '' });
        } else if (block.type === 'thinking') {
          blocks.set(event.index, { type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' });
        } else if (block.type === 'redacted_thinking') {
          blocks.set(event.index, { type: 'redacted_thinking', data: block.data });
        }
        break;
      }
      case 'content_block_delta': {
        const delta = event.delta || {};
        const current = blocks.get(event.index);
        if (delta.type === 'text_delta' && delta.text) {
          if (current?.type === 'text') current.text += delta.text;
          onDelta(delta.text);
        } else if (delta.type === 'input_json_delta' && current?.type === 'tool_use') {
          current.argsText += delta.partial_json || '';
        } else if (delta.type === 'thinking_delta' && current?.type === 'thinking') {
          current.thinking += delta.thinking || '';
        } else if (delta.type === 'signature_delta' && current?.type === 'thinking') {
          current.signature += delta.signature || '';
        }
        break;
      }
      case 'message_delta':
        if (event.usage?.output_tokens != null) outputTokens = event.usage.output_tokens;
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        break;
      case 'error':
        throw new Error(event.error?.message || 'Erro do provider Anthropic');
      default:
        break;
    }
  }

  // Recusa do classificador de segurança: vira erro pro roteador tentar o próximo modelo.
  if (stopReason === 'refusal') {
    throw new ProviderError('O modelo recusou a solicitação (refusal)', { status: 0, code: 'refusal' });
  }

  const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
  const toolCalls = ordered
    .filter((block) => block.type === 'tool_use' && block.name)
    .map((block) => ({ id: block.id, name: block.name, args: parseArgs(block.argsText) }));

  // Conteúdo bruto no formato da API, usado só se a próxima rodada for na Anthropic.
  const providerContent = ordered
    .filter((block) => block.type !== 'text' || block.text)
    .map((block) => {
      if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: parseArgs(block.argsText) };
      return block;
    });

  // A Anthropic informa input_tokens sem os tokens de cache; o Teko guarda o total.
  return {
    inputTokens: inputTokens + cachedInputTokens + cacheWriteTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    toolCalls,
    providerContent: { anthropic: providerContent },
  };
}
