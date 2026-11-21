import { normalizeMessages, sseData, toProviderError } from './http.js';

export async function google({ model, system, messages, maxTokens, apiKey, baseUrl, signal, onDelta }) {
  const url =
    `${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}` +
    `:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: normalizeMessages(messages).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    generationConfig: { maxOutputTokens: maxTokens || 4096 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await toProviderError(res);

  let inputTokens = 0;
  let outputTokens = 0;

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
    }
    if (json.usageMetadata) {
      inputTokens = json.usageMetadata.promptTokenCount ?? inputTokens;
      outputTokens = json.usageMetadata.candidatesTokenCount ?? outputTokens;
    }
  }

  return { inputTokens, outputTokens };
}
