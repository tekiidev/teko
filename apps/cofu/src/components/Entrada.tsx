'use client';

import { useEffect, useRef, useState } from 'react';
import { lerLista } from '@/lib/parse.ts';
import type { ItemSugerido } from '@/lib/items.ts';

type Reconhecimento = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

function criarReconhecimento(): Reconhecimento | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => Reconhecimento; webkitSpeechRecognition?: new () => Reconhecimento };
  const Classe = w.SpeechRecognition || w.webkitSpeechRecognition;
  return Classe ? new Classe() : null;
}

/** Monta a lista: tenta a IA online; sem internet ou se ela falhar, usa o leitor simples. */
async function montar(texto: string): Promise<{ itens: ItemSugerido[]; semIA: boolean; aviso?: string }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { itens: lerLista(texto), semIA: true };
  try {
    const res = await fetch('/api/lista', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texto }),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(json.itens)) return { itens: json.itens, semIA: false };
    if (res.status === 400 || res.status === 413 || res.status === 429) {
      return { itens: res.status === 429 ? lerLista(texto) : [], semIA: true, aviso: json.erro };
    }
  } catch {
    // rede caiu no meio: segue pro leitor simples
  }
  return { itens: lerLista(texto), semIA: true };
}

export function Entrada({ onItens }: { onItens: (itens: ItemSugerido[], semIA: boolean, aviso?: string) => void }) {
  const [texto, setTexto] = useState('');
  const [ouvindo, setOuvindo] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [temVoz, setTemVoz] = useState(false);
  const rec = useRef<Reconhecimento | null>(null);
  const base = useRef('');

  useEffect(() => {
    setTemVoz(Boolean(criarReconhecimento()));
  }, []);

  function alternarVoz() {
    if (ouvindo) {
      rec.current?.stop();
      return;
    }
    const r = criarReconhecimento();
    if (!r) return;
    r.lang = 'pt-BR';
    r.interimResults = true;
    r.continuous = true;
    base.current = texto ? `${texto.trim()}, ` : '';
    r.onresult = (e) => {
      let falado = '';
      for (let i = 0; i < e.results.length; i += 1) falado += e.results[i][0].transcript;
      setTexto(base.current + falado.trim());
    };
    r.onend = () => setOuvindo(false);
    r.onerror = () => setOuvindo(false);
    rec.current = r;
    r.start();
    setOuvindo(true);
  }

  async function enviar() {
    const t = texto.trim();
    if (!t || carregando) return;
    rec.current?.stop();
    setCarregando(true);
    const { itens, semIA, aviso } = await montar(t);
    setCarregando(false);
    onItens(itens, semIA, aviso);
    if (itens.length) setTexto('');
  }

  return (
    <section className="rounded-3xl bg-white/70 p-4 shadow-sm ring-1 ring-babacu/10">
      <label htmlFor="entrada" className="font-titulo text-lg text-babacu">
        O que vai comprar?
      </label>
      <textarea
        id="entrada"
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) enviar();
        }}
        rows={3}
        maxLength={1200}
        placeholder="Ex.: 2 kg de arroz, feijão, uma dúzia de ovos e café"
        className="mt-2 w-full resize-none rounded-2xl border border-babacu/20 bg-areia px-4 py-3 text-base placeholder:text-babacu/50 focus:border-folha focus:outline-none"
      />
      <div className="mt-3 flex items-center gap-3">
        {temVoz && (
          <button
            type="button"
            onClick={alternarVoz}
            aria-pressed={ouvindo}
            aria-label={ouvindo ? 'Parar de ouvir' : 'Falar a lista'}
            className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full text-areia shadow-md transition ${
              ouvindo ? 'animate-pulse bg-terracota' : 'bg-folha'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-8 w-8" fill="currentColor" aria-hidden="true">
              <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={enviar}
          disabled={!texto.trim() || carregando}
          className="min-h-14 flex-1 rounded-2xl bg-babacu px-5 text-lg font-bold text-areia shadow-md transition disabled:opacity-40"
        >
          {carregando ? 'Montando…' : 'Montar lista'}
        </button>
      </div>
      {ouvindo && <p className="mt-2 text-base text-terracota">Ouvindo… fale os itens e toque de novo pra parar.</p>}
    </section>
  );
}
