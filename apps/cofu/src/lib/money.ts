import type { Item } from './items.ts';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function reais(valor: number) {
  return BRL.format(valor);
}

export function somar(itens: Pick<Item, 'preco'>[]) {
  return itens.reduce((total, item) => total + (item.preco ?? 0), 0);
}

// Referência pra comparações concretas no lugar de porcentagem.
// Valor aproximado; serve só pra dar escala ("uns 2 kg de frango").
export const REFERENCIA = { nome: 'frango', unidade: 'kg', preco: 13 };

export function comparacao(valor: number) {
  const qtd = Math.floor(valor / REFERENCIA.preco);
  if (qtd < 1) return null;
  return `uns ${qtd} ${REFERENCIA.unidade} de ${REFERENCIA.nome}`;
}

export type Situacao = {
  noCofo: number;
  totalLista: number;
  orcamento: number | null;
  /** 0 a 1 (pode passar de 1 quando estoura o orçamento). */
  progresso: number;
  estourou: boolean;
  mensagem: string;
};

/** Resume a feira em uma frase simples, com valores em reais. */
export function situacao(itens: Pick<Item, 'preco' | 'estado'>[], orcamento: number | null): Situacao {
  const noCofo = somar(itens.filter((i) => i.estado === 'cofo'));
  const totalLista = noCofo + somar(itens.filter((i) => i.estado === 'lista'));
  if (!orcamento || orcamento <= 0) {
    return {
      noCofo,
      totalLista,
      orcamento: null,
      progresso: totalLista > 0 ? noCofo / totalLista : 0,
      estourou: false,
      mensagem: noCofo > 0 ? `${reais(noCofo)} no cofo` : 'Toque nos itens pra colocar no cofo',
    };
  }
  const resto = orcamento - noCofo;
  const estourou = resto < 0;
  const extra = comparacao(Math.abs(resto));
  return {
    noCofo,
    totalLista,
    orcamento,
    progresso: noCofo / orcamento,
    estourou,
    mensagem: estourou
      ? `Passou ${reais(-resto)} do orçamento${extra ? ` (${extra})` : ''}`
      : `Ainda cabem ${reais(resto)}${extra ? `, ${extra}` : ''}`,
  };
}
