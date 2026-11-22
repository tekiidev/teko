'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * O cofo é a barra de progresso: enche conforme os itens entram.
 * Palha enquanto cabe no orçamento; terracota e transbordando quando passa.
 */
export function Cofo({ progresso, estourou, pulso }: { progresso: number; estourou: boolean; pulso: number }) {
  const nivel = Math.max(0, Math.min(progresso, 1));
  // Corpo do cofo vai de y=232 (boca) a y=420 (fundo).
  const altura = 188 * nivel;
  const cor = estourou ? '#C8553D' : '#D9A441';
  const [balanca, setBalanca] = useState(false);
  const primeira = useRef(true);

  useEffect(() => {
    if (primeira.current) {
      primeira.current = false;
      return;
    }
    setBalanca(true);
    const t = setTimeout(() => setBalanca(false), 450);
    return () => clearTimeout(t);
  }, [pulso]);

  return (
    <svg viewBox="80 110 352 330" className={`h-28 w-28 shrink-0 ${balanca ? 'balancar' : ''}`} aria-hidden="true">
      <defs>
        <clipPath id="corpo-cofo">
          <path d="M104 224 H408 L372 404 Q368 424 348 424 H164 Q144 424 140 404 Z" />
        </clipPath>
      </defs>
      <path d="M164 228 C164 120 348 120 348 228" fill="none" stroke="#6B4423" strokeWidth="22" strokeLinecap="round" />
      <path d="M104 224 H408 L372 404 Q368 424 348 424 H164 Q144 424 140 404 Z" fill="#F1E7D3" />
      <rect
        x="90"
        y={424 - altura}
        width="340"
        height={altura}
        fill={cor}
        clipPath="url(#corpo-cofo)"
        style={{ transition: 'y 400ms ease, height 400ms ease, fill 300ms' }}
      />
      <g stroke="#6B4423" strokeWidth="9" strokeLinecap="round" opacity="0.45">
        <path d="M118 282 H394" />
        <path d="M128 340 H384" />
        <path d="M190 232 L202 416" />
        <path d="M256 232 V416" />
        <path d="M322 232 L310 416" />
      </g>
      <path
        d="M104 224 H408 L372 404 Q368 424 348 424 H164 Q144 424 140 404 Z"
        fill="none"
        stroke="#6B4423"
        strokeWidth="12"
        strokeLinejoin="round"
      />
      {estourou && (
        <g fill="#C8553D" stroke="#6B4423" strokeWidth="6">
          <circle cx="200" cy="200" r="22" />
          <circle cx="250" cy="186" r="26" />
          <circle cx="306" cy="198" r="20" />
        </g>
      )}
      <rect x="92" y="208" width="328" height="30" rx="15" fill="#6B4423" />
    </svg>
  );
}
