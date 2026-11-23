import { ListaSugeridaSchema, type ItemSugerido } from './items.ts';

/**
 * A IA da lista roda num serviço separado (COFU_SERVER_URL): prompt, modelos e
 * ajustes ficam lá. Este app só repassa o pedido, com o token compartilhado,
 * e valida a resposta com Zod antes de usar.
 * Sem o servidor configurado, ou se ele falhar, o app usa o leitor simples no aparelho.
 */

const TIMEOUT_MS = 28_000;

export class IAIndisponivel extends Error {}

export async function montarLista(texto: string, clienteIp = 'desconhecido'): Promise<ItemSugerido[]> {
  const url = process.env.COFU_SERVER_URL;
  const token = process.env.COFU_SERVER_TOKEN;
  if (!url || !token) throw new IAIndisponivel('servidor do Cofu não configurado');

  const res = await fetch(`${url.replace(/\/$/, '')}/v1/lista`, {
    method: 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-cliente-ip': clienteIp },
    body: JSON.stringify({ texto }),
  }).catch((err) => {
    throw new IAIndisponivel(err?.name === 'TimeoutError' ? 'servidor demorou demais' : 'servidor fora do ar');
  });
  if (!res.ok) throw new IAIndisponivel(`servidor respondeu ${res.status}`);

  const validado = ListaSugeridaSchema.safeParse(await res.json().catch(() => null));
  if (!validado.success) throw new IAIndisponivel('resposta fora do formato');
  return validado.data.itens;
}
