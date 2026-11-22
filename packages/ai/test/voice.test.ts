import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, speakable } from '../src/voice.ts';

test('transcrição: tira marcações do whisper', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('Oi, Teko (música) tudo bem?\n'), 'Oi, Teko tudo bem?');
});

test('fala: sem markdown, código vira aviso, links viram "um link"', () => {
  const out = speakable('## Título\n**Olá** `npm test` veja [docs](https://x.com) e https://y.com\n```js\nconst a = 1\n```\n- item');
  assert.equal(out, 'Título Olá npm test veja docs e um link (tem um código na tela) item');
});

test('fala: limite de tamanho', () => {
  assert.ok(speakable('a '.repeat(2000)).length <= 1500);
});

test('ativação: "Teko" no começo, com ou sem "ei/oi", e o resto vira pergunta', async () => {
  const { detectWake } = await import('../src/voice.ts');
  assert.deepEqual(detectWake('Teko.'), { wake: true, rest: '' });
  assert.deepEqual(detectWake('Ei, Teko, que horas são?'), { wake: true, rest: 'que horas são?' });
  assert.deepEqual(detectWake('Oi Teco qual a capital do Maranhão'), { wake: true, rest: 'qual a capital do Maranhão' });
  assert.deepEqual(detectWake('Téko!'), { wake: true, rest: '' });
  for (const w of ['Teku.', 'Tireku.', 'Tico', 'Tecko']) assert.equal(detectWake(w).wake, true, w);
});

test('ativação: no meio da frase ou palavra parecida não dispara', async () => {
  const { detectWake } = await import('../src/voice.ts');
  assert.equal(detectWake('eu falei com o Teko ontem').wake, false);
  assert.equal(detectWake('o teto caiu').wake, false);
  for (const w of ['Teto.', 'Taco', 'Tchau!', 'Tudo bem?', 'Toque aqui']) assert.equal(detectWake(w).wake, false, w);
  assert.equal(detectWake('').wake, false);
});
