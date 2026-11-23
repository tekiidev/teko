import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { esconderSegredos, esconderNaConversa, provedorLocal, arquivoSecreto, MARCADOR } from '../src/privacy.ts';
import { readFile } from '../src/tools/fs.ts';

// Chaves falsas montadas em pedaços, pra nenhum scanner achar que vazou algo de verdade.
const openai = 'sk-' + 'proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
const groq = 'gsk' + '_' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe';
const aws = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const gh = 'ghp' + '_' + 'a'.repeat(20) + '1234567890abcdef';

test('esconde chaves conhecidas e conta quantas', () => {
  const r = esconderSegredos(`minha chave ${openai} e ${groq}, aws ${aws}, github ${gh}`);
  assert.equal(r.n, 4);
  assert.ok(!r.texto.includes(openai) && !r.texto.includes(groq) && !r.texto.includes(aws) && !r.texto.includes(gh));
  assert.ok(r.texto.includes(MARCADOR));
});

test('esconde linha de config com cara de segredo, mas não código comum', () => {
  const env = esconderSegredos('DB_PASSWORD=Xk29fjQ81mzPq07LwT\nAPP_NAME=teko');
  assert.equal(env.n, 1);
  assert.match(env.texto, /DB_PASSWORD=\[segredo/);
  assert.match(env.texto, /APP_NAME=teko/);
  const codigo = 'const token = getToken();\nconst apiKey = process.env.OPENAI_API_KEY;\nconst password = form.password;';
  assert.deepEqual(esconderSegredos(codigo), { texto: codigo, n: 0 });
});

test('esconde chave privada inteira', () => {
  const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\nxyz\n-----END OPENSSH PRIVATE KEY-----';
  const r = esconderSegredos(`arquivo:\n${pem}\nfim`);
  assert.equal(r.n, 1);
  assert.ok(!r.texto.includes('abc123'));
});

test('limpa system e mensagens, inclusive partes de texto', () => {
  const r = esconderNaConversa(`chave ${openai}`, [
    { role: 'user', content: `usa ${groq}` },
    { role: 'user', content: [{ type: 'text', text: aws }, { type: 'image', data: 'x' }] },
  ]);
  assert.equal(r.n, 3);
  assert.ok(!JSON.stringify(r).includes(groq));
});

test('local é só Ollama ou loopback', () => {
  assert.equal(provedorLocal({ id: 'ollama' }), true);
  assert.equal(provedorLocal({ id: 'x', base_url: 'http://127.0.0.1:1234/v1' }), true);
  assert.equal(provedorLocal({ id: 'openai', base_url: 'https://api.openai.com/v1' }), false);
});

test('arquivos de segredo não são lidos', async () => {
  assert.equal(arquivoSecreto('.env'), true);
  assert.equal(arquivoSecreto('apps/x/.env.local'), true);
  assert.equal(arquivoSecreto('.env.example'), false);
  assert.equal(arquivoSecreto('id_ed25519'), true);
  assert.equal(arquivoSecreto('cert.pem'), true);
  assert.equal(arquivoSecreto('src/env.ts'), false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teko-priv-'));
  fs.writeFileSync(path.join(root, '.env'), 'X=1');
  await assert.rejects(readFile({ path: '.env' }, { root }), /guarda segredos/);
});
