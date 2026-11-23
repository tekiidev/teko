import { test } from 'node:test';
import assert from 'node:assert/strict';
import { criarDetectorEstalo } from './estalo.js';

const TAXA = 48000;
const QUADRO = 4096; // mesmo tamanho que o microfone entrega

// Gerador pseudoaleatório fixo: o teste dá sempre o mesmo resultado.
function aleatorio(semente = 7) {
  let s = semente;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return (s / 2147483648) * 2 - 1;
  };
}

/** Monta um áudio de `duracaoMs` com ruído de sala e os eventos pedidos. */
function audio(duracaoMs, eventos) {
  const n = Math.round((duracaoMs / 1000) * TAXA);
  const sinal = new Float32Array(n);
  const rnd = aleatorio();
  for (let i = 0; i < n; i += 1) sinal[i] = rnd() * 0.004;
  const somar = (em, dur, f) => {
    const ini = Math.round((em / 1000) * TAXA);
    for (let k = 0; k < dur * TAXA && ini + k < n; k += 1) sinal[ini + k] += f(k, k / TAXA);
  };
  for (const ev of eventos) {
    if (ev.tipo === 'estalo') {
      // Estalo de dedo: ressonância aguda (~2,6 kHz) + um pouco de chiado, some em ~6 ms.
      somar(ev.em, 0.06, (k, t) => (0.55 * Math.sin(2 * Math.PI * 2600 * t) + 0.25 * rnd()) * Math.exp(-k / (TAXA * 0.006)));
    } else if (ev.tipo === 'tecla') {
      // Clique de teclado: curto e agudo, mais fraco que o estalo.
      somar(ev.em, 0.02, (k) => 0.12 * rnd() * Math.exp(-k / (TAXA * 0.002)));
    } else if (ev.tipo === 'voz') {
      // Vogal: grave (180 Hz + harmônicos), sobe em 30 ms e sustenta.
      somar(ev.em, ev.ms / 1000, (k, t) => Math.min(1, k / (TAXA * 0.03)) * 0.35 * (Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t)));
    } else if (ev.tipo === 'pancada') {
      // Batida na mesa ou porta: sobe rápido, mas é grave.
      somar(ev.em, 0.12, (k, t) => 0.8 * Math.sin(2 * Math.PI * 90 * t) * Math.exp(-k / (TAXA * 0.04)));
    }
  }
  return sinal;
}

function contar(sinal) {
  let disparos = 0;
  const det = criarDetectorEstalo({ taxa: TAXA, aoDetectar: () => { disparos += 1; } });
  for (let i = 0; i < sinal.length; i += QUADRO) det.quadro(sinal.subarray(i, i + QUADRO));
  return disparos;
}

const estalo = (em) => ({ tipo: 'estalo', em });

test('um estalo de dedos liga', () => {
  assert.equal(contar(audio(2000, [estalo(600)])), 1);
});

test('dois estalos bem separados ligam duas vezes', () => {
  assert.equal(contar(audio(3500, [estalo(500), estalo(2200)])), 2);
});

test('digitar (cliques seguidos) não liga', () => {
  const teclas = Array.from({ length: 20 }, (_, i) => ({ tipo: 'tecla', em: 300 + i * 110 + (i % 3) * 25 }));
  assert.equal(contar(audio(3500, teclas)), 0);
});

test('estalo no meio da digitação não liga (não está sozinho)', () => {
  const teclas = Array.from({ length: 10 }, (_, i) => ({ tipo: 'tecla', em: 300 + i * 120 }));
  assert.equal(contar(audio(2500, [...teclas, estalo(900)])), 0);
});

test('estalos em sequência (ritmo, música) não ligam', () => {
  assert.equal(contar(audio(3000, [estalo(500), estalo(800), estalo(1100), estalo(1400)])), 0);
});

test('voz não liga', () => {
  assert.equal(contar(audio(3000, [{ tipo: 'voz', em: 400, ms: 400 }, { tipo: 'voz', em: 1100, ms: 300 }])), 0);
});

test('batida grave (mesa, porta) não liga', () => {
  assert.equal(contar(audio(2500, [{ tipo: 'pancada', em: 500 }])), 0);
});

test('uma tecla sozinha (mais fraca que um estalo) não liga', () => {
  assert.equal(contar(audio(2000, [{ tipo: 'tecla', em: 700 }])), 0);
});
