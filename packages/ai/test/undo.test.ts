import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFile, editFile } from '../src/tools/fs.ts';
import { desfazer, previaDesfazer } from '../src/undo.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teko-undo-'));
const ctx = { root, sessionId: 'sessao-undo' };
const ler = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('desfaz edição, depois a criação do arquivo', async () => {
  await writeFile({ path: 'a.txt', content: 'um' }, ctx);
  await editFile({ path: 'a.txt', old: 'um', new: 'dois' }, ctx);
  assert.deepEqual(previaDesfazer({ ...ctx, n: 2 }), ['voltar a.txt', 'apagar a.txt']);

  assert.equal(desfazer(ctx).ok, true);
  assert.equal(ler('a.txt'), 'um');
  assert.equal(desfazer(ctx).ok, true);
  assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
  assert.equal(desfazer(ctx).ok, false); // nada mais
});

test('não passa por cima do que você mexeu depois da IA', async () => {
  fs.writeFileSync(path.join(root, 'b.txt'), 'original');
  await editFile({ path: 'b.txt', old: 'original', new: 'da ia' }, ctx);
  fs.writeFileSync(path.join(root, 'b.txt'), 'meu ajuste');
  const r = desfazer(ctx);
  assert.equal(r.ok, false);
  assert.match(r.output, /mudou depois/);
  assert.equal(ler('b.txt'), 'meu ajuste');
});

test('outra conversa não desfaz o que esta fez', async () => {
  await writeFile({ path: 'c.txt', content: 'x' }, ctx);
  assert.equal(desfazer({ root, sessionId: 'outra' }).ok, false);
  assert.equal(ler('c.txt'), 'x');
});
