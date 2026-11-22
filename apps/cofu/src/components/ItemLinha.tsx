'use client';

import { useState } from 'react';
import { rotuloQuantidade, type Item } from '@/lib/items.ts';
import { reais } from '@/lib/money.ts';

type Props = {
  item: Item;
  onCofo: (item: Item) => void;
  onCasa: (item: Item) => void;
  onVoltar: (item: Item) => void;
  onPreco: (item: Item, preco: number | null) => void;
  onRemover: (item: Item) => void;
};

/** Tocar no item = ele cai no cofo. "Tem em casa" manda pra prateleira. */
export function ItemLinha({ item, onCofo, onCasa, onVoltar, onPreco, onRemover }: Props) {
  const [saindo, setSaindo] = useState(false);
  const [editando, setEditando] = useState(false);
  const noCofo = item.estado === 'cofo';
  const qtd = rotuloQuantidade(item);

  function tocar() {
    if (noCofo) return onVoltar(item);
    setSaindo(true);
    setTimeout(() => onCofo(item), 240);
  }

  return (
    <li className={`flex items-center gap-2 rounded-2xl bg-white/80 p-2 ring-1 ring-babacu/10 ${saindo ? 'cair' : ''}`}>
      <button
        type="button"
        onClick={tocar}
        aria-label={noCofo ? `Tirar ${item.nome} do cofo` : `Colocar ${item.nome} no cofo`}
        className="flex min-h-12 flex-1 items-center gap-3 rounded-xl px-2 text-left"
      >
        <span
          aria-hidden="true"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 ${
            noCofo ? 'border-folha bg-folha text-areia' : 'border-babacu/40'
          }`}
        >
          {noCofo && '✓'}
        </span>
        <span className="min-w-0">
          <span className={`block truncate text-lg ${noCofo ? 'text-babacu/50 line-through' : ''}`}>{item.nome}</span>
          {qtd && <span className="block text-base text-babacu/70">{qtd}</span>}
        </span>
      </button>

      {editando ? (
        <input
          autoFocus
          inputMode="decimal"
          defaultValue={item.preco != null ? String(item.preco).replace('.', ',') : ''}
          aria-label={`Preço de ${item.nome}`}
          placeholder="R$"
          className="h-12 w-24 rounded-xl border border-babacu/30 bg-areia px-2 text-right text-base"
          onBlur={(e) => {
            const v = Number(e.target.value.replace(/[^\d,.]/g, '').replace(',', '.'));
            onPreco(item, Number.isFinite(v) && v > 0 ? v : null);
            setEditando(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditando(true)}
          className="min-h-12 min-w-20 rounded-xl px-2 text-right text-base text-babacu"
          aria-label={item.preco != null ? `Preço de ${item.nome}: ${reais(item.preco)}. Toque pra mudar` : `Colocar preço de ${item.nome}`}
        >
          {item.preco != null ? `~${reais(item.preco)}` : <span className="text-babacu/40">R$ ?</span>}
        </button>
      )}

      {!noCofo && (
        <button
          type="button"
          onClick={() => onCasa(item)}
          className="min-h-12 rounded-xl px-2 text-sm font-bold text-folha"
          aria-label={`${item.nome}: tem em casa`}
        >
          Tem em casa
        </button>
      )}
      <button
        type="button"
        onClick={() => onRemover(item)}
        className="flex h-12 w-11 items-center justify-center rounded-xl text-xl text-babacu/40"
        aria-label={`Apagar ${item.nome}`}
      >
        ×
      </button>
    </li>
  );
}
