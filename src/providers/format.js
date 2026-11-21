// Converte a conversa normalizada do teko pro formato de cada provider.
// Normalizada: { role: 'user'|'assistant', content }
//              { role: 'assistant', content, toolCalls: [{ id, name, args }] }
//              { role: 'tool', toolCallId, name, content }

export function toOpenAI(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });

  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
        })),
      });
      continue;
    }
    out.push({ role: message.role, content: message.content || '' });
  }

  return out;
}

export function toAnthropic(messages, system) {
  const out = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.__toolResults) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block], __toolResults: true });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls || []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args || {} });
      }
      out.push({ role: 'assistant', content: content.length ? content : message.content || '' });
      continue;
    }

    out.push({ role: 'user', content: message.content || '' });
  }

  // Remove marcador interno usado pra agrupar tool_results.
  for (const message of out) delete message.__toolResults;

  // Anthropic exige que a conversa comece com user.
  if (out.length && out[0].role !== 'user') {
    out.unshift({ role: 'user', content: '(continuação)' });
  }

  return out;
}

export function toGoogle(messages, system) {
  const out = [];

  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'user',
        parts: [{ functionResponse: { name: message.name, response: { result: message.content } } }],
      });
      continue;
    }

    if (message.role === 'assistant') {
      const parts = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls || []) {
        parts.push({ functionCall: { name: call.name, args: call.args || {} } });
      }
      out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }

    out.push({ role: 'user', parts: [{ text: message.content || '' }] });
  }

  return out;
}

export function toolSchemas(tools) {
  return {
    openai: tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
    anthropic: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    })),
    google: [{ functionDeclarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })) }],
  };
}
