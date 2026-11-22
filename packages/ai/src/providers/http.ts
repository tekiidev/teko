export class ProviderError extends Error {
  status: number;
  code: string | null;
  retryAfter: number | null;
  body: string;

  constructor(message, { status = 0, code = null, retryAfter = null, body = '' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.body = body;
  }
}

export function retryAfterSeconds(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.round((date - Date.now()) / 1000));
  return null;
}

export async function toProviderError(res) {
  const text = await res.text().catch(() => '');
  let message = `HTTP ${res.status}`;
  let code = null;
  try {
    const json = JSON.parse(text);
    message = json.error?.message || json.message || json.error?.type || message;
    code = json.error?.code || json.code || null;
  } catch {
    if (text) message = `${message}: ${text.slice(0, 300)}`;
  }
  return new ProviderError(message, {
    status: res.status,
    code,
    retryAfter: retryAfterSeconds(res),
    body: text.slice(0, 2000),
  });
}

/**
 * Lê um stream SSE e devolve o conteúdo de cada linha `data:`.
 * Aceita fim de linha \n ou \r\n (o Google usa \r\n) e o último bloco sem linha em branco no fim.
 */
export async function* sseData(res) {
  const decoder = new TextDecoder();
  let buffer = '';
  let pendingCR = false;

  function* drain(block) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data) yield data;
    }
  }

  for await (const chunk of res.body) {
    let text = (pendingCR ? '\r' : '') + decoder.decode(chunk, { stream: true });
    // Um \r no fim do pedaço pode ser metade de um \r\n: espera o próximo.
    pendingCR = text.endsWith('\r');
    if (pendingCR) text = text.slice(0, -1);
    buffer += text.replace(/\r\n?/g, '\n');
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      yield* drain(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield* drain(buffer.replace(/\r\n?/g, '\n'));
}

export function normalizeMessages(messages) {
  return messages
    .filter((m) => m && m.content && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: String(m.content) }));
}
