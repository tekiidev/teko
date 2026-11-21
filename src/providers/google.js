import { sseData, toProviderError } from './http.js';
import { toGoogle, toolSchemas } from './format.js';

export async function google({ model, system, messages, maxTokens, apiKey, baseUrl, signal, onDelta, tools }) {
  const url =
    `${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: toGoogle(messages, system),
    generationConfig: { maxOutputTokens: maxTokens || 4096 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) body.tools = toolSchemas(tools).google;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await toProviderError(res);

  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls = [];

  for await (const data of sseData(res)) {
    let json;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json.error) throw new Error(json.error.message || 'Erro do provider Google');

    const parts = json.candidates?.[0]?.content?.parts || [];
    for (const part of parts) {
      if (part.text) onDelta(part.text);
      if (part.functionCall) {
        toolCalls.push({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          name: part.functionCall.name,
          args: part.functionCall.args || {},
        });
      }
    }
    if (json.usageMetadata) {
      inputTokens = json.usageMetadata.promptTokenCount ?? inputTokens;
      outputTokens = json.usageMetadata.candidatesTokenCount ?? outputTokens;
    }
  }

  return { inputTokens, outputTokens, toolCalls };
}
