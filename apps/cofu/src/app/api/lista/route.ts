import { NextResponse } from 'next/server';
import { IAIndisponivel, montarLista } from '@/lib/ai.ts';

/**
 * POST /api/lista { texto } -> { itens }
 * Rota pública: limita tamanho do texto e quantas chamadas cada IP faz, e repassa
 * pro serviço da IA (COFU_SERVER_URL). Se ele falhar, responde 503
 * e o app usa o leitor simples no aparelho.
 */

const MAX_TEXTO = 1200;
const JANELA_MS = 10 * 60_000;
const MAX_POR_JANELA = 20;
const chamadas = new Map<string, number[]>();

function limitado(ip: string) {
  const agora = Date.now();
  const recentes = (chamadas.get(ip) || []).filter((t) => agora - t < JANELA_MS);
  if (recentes.length >= MAX_POR_JANELA) {
    chamadas.set(ip, recentes);
    return true;
  }
  recentes.push(agora);
  chamadas.set(ip, recentes);
  // Limpeza simples pra o mapa não crescer pra sempre.
  if (chamadas.size > 5000) for (const [k, v] of chamadas) if (!v.some((t) => agora - t < JANELA_MS)) chamadas.delete(k);
  return false;
}

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'local';
  if (limitado(ip)) {
    return NextResponse.json({ erro: 'Muitos pedidos seguidos. Espere uns minutos.' }, { status: 429 });
  }

  let texto = '';
  try {
    const body = await req.json();
    texto = typeof body?.texto === 'string' ? body.texto.trim() : '';
  } catch {
    return NextResponse.json({ erro: 'Pedido inválido.' }, { status: 400 });
  }
  if (!texto) return NextResponse.json({ erro: 'Escreva ou fale o que vai comprar.' }, { status: 400 });
  if (texto.length > MAX_TEXTO) {
    return NextResponse.json({ erro: `Texto muito longo (máximo ${MAX_TEXTO} letras).` }, { status: 413 });
  }

  try {
    const itens = await montarLista(texto, ip);
    return NextResponse.json({ itens });
  } catch (err) {
    const motivo = err instanceof IAIndisponivel ? err.message : 'erro inesperado';
    console.error('[cofu/lista]', motivo);
    return NextResponse.json({ erro: 'IA indisponível agora.' }, { status: 503 });
  }
}
