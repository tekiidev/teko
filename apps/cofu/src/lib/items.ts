import { z } from 'zod';

export const CATEGORIAS = [
  'Hortifrúti',
  'Carnes e peixes',
  'Laticínios e ovos',
  'Mercearia',
  'Padaria',
  'Bebidas',
  'Limpeza',
  'Higiene',
  'Outros',
] as const;

export type Categoria = (typeof CATEGORIAS)[number];

/** Item como a IA (ou o leitor simples) devolve. Tudo é validado antes de entrar na lista. */
export const ItemSugeridoSchema = z.object({
  nome: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .transform((n) => n.charAt(0).toUpperCase() + n.slice(1)),
  quantidade: z.number().positive().max(999).nullable(),
  unidade: z.string().trim().max(12).nullable(),
  categoria: z.enum(CATEGORIAS).catch('Outros'),
  // Preço estimado da linha inteira (quantidade x preço da unidade), em reais.
  preco: z.number().min(0).max(5000).nullable(),
});

export const ListaSugeridaSchema = z.object({
  itens: z.array(ItemSugeridoSchema).max(60),
});

export type ItemSugerido = z.infer<typeof ItemSugeridoSchema>;

export type Estado = 'lista' | 'cofo' | 'casa';

export type Item = ItemSugerido & {
  id: string;
  estado: Estado;
  criadoEm: number;
};

export function rotuloQuantidade(item: Pick<Item, 'quantidade' | 'unidade'>) {
  if (item.quantidade == null) return '';
  const q = Number.isInteger(item.quantidade) ? String(item.quantidade) : item.quantidade.toLocaleString('pt-BR');
  return item.unidade ? `${q} ${item.unidade}` : q;
}
