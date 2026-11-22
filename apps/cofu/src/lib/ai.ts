import { CATEGORIAS, ListaSugeridaSchema, type ItemSugerido } from './items.ts';

/**
 * Chamada à IA, só no servidor (a chave nunca vai pro navegador).
 * Modelo barato e rápido: a tarefa é extrair e classificar, não pensar.
 * A resposta vem em JSON pelo schema e é validada com Zod antes de usar.
 */

// Ordem de tentativa: se um modelo estiver sobrecarregado (503/429) ou demorar, tenta o próximo.
const MODELOS = (process.env.COFU_GEMINI_MODEL || 'gemini-flash-lite-latest,gemini-3.5-flash-lite,gemini-flash-latest')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const TIMEOUT_MS = 12_000;
const PRAZO_TOTAL_MS = 25_000;

const SISTEMA = [
  'Você monta listas de feira a partir do que a pessoa escreveu ou falou.',
  'Extraia cada item com nome curto em português do Brasil, quantidade, unidade e categoria.',
  'Unidades: kg, g, L, ml, un, pct, cx, dz, lata, garrafa, maço, bandeja, vidro, saco. Sem unidade clara: null.',
  'Sem quantidade dita: null. Não invente itens que a pessoa não pediu.',
  'preco: estimativa do preço total da linha em reais num supermercado de São Luís (MA), ou null se não souber.',
  'Ignore o que não for item de compra.',
].join(' ');

const SCHEMA = {
  type: 'object',
  properties: {
    itens: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          quantidade: { type: 'number', nullable: true },
          unidade: { type: 'string', nullable: true },
          categoria: { type: 'string', enum: [...CATEGORIAS] },
          preco: { type: 'number', nullable: true },
        },
        required: ['nome', 'quantidade', 'unidade', 'categoria', 'preco'],
      },
    },
  },
  required: ['itens'],
};

export class IAIndisponivel extends Error {
  constructor(
    message: string,
    /** true quando vale tentar outro modelo (sobrecarga, demora, formato). */
    public tentarOutro = false,
  ) {
    super(message);
  }
}

async function chamar(modelo: string, texto: string, chave: string, ms: number): Promise<ItemSugerido[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(ms),
      headers: { 'content-type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SISTEMA }] },
        contents: [{ role: 'user', parts: [{ text: texto }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: SCHEMA,
          temperature: 0.2,
          maxOutputTokens: 2048,
        },
      }),
    },
  ).catch((err) => {
    throw new IAIndisponivel(err?.name === 'TimeoutError' ? `${modelo}: demorou demais` : `${modelo}: falha de rede`, true);
  });

  if (!res.ok) throw new IAIndisponivel(`${modelo}: respondeu ${res.status}`, res.status === 429 || res.status >= 500);
  const json = await res.json();
  const bruto = (json.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('');

  let dados: unknown;
  try {
    dados = JSON.parse(bruto);
  } catch {
    throw new IAIndisponivel(`${modelo}: resposta fora do formato`, true);
  }
  const validado = ListaSugeridaSchema.safeParse(dados);
  if (!validado.success) throw new IAIndisponivel(`${modelo}: resposta fora do formato`, true);
  return validado.data.itens;
}

export async function montarLista(texto: string): Promise<ItemSugerido[]> {
  const chave = process.env.GOOGLE_API_KEY;
  if (!chave) throw new IAIndisponivel('sem chave configurada');

  const inicio = Date.now();
  let ultimo: IAIndisponivel | null = null;
  for (const modelo of MODELOS) {
    const resta = PRAZO_TOTAL_MS - (Date.now() - inicio);
    if (resta < 2_000) break;
    try {
      return await chamar(modelo, texto, chave, Math.min(TIMEOUT_MS, resta));
    } catch (err) {
      ultimo = err instanceof IAIndisponivel ? err : new IAIndisponivel(`${modelo}: erro inesperado`);
      if (!ultimo.tentarOutro) break;
    }
  }
  throw ultimo || new IAIndisponivel('nenhum modelo respondeu');
}
