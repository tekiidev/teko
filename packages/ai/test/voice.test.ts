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
