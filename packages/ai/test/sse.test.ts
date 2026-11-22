import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sseData } from '../src/providers/http.ts';

function fakeRes(chunks: string[]) {
  const enc = new TextEncoder();
  return { body: (async function* () { for (const c of chunks) yield enc.encode(c); })() };
}

async function all(res) {
  const out = [];
  for await (const d of sseData(res)) out.push(d);
  return out;
}

test('lê eventos separados por \\n\\n', async () => {
  assert.deepEqual(await all(fakeRes(['data: a\n\ndata: b\n\n'])), ['a', 'b']);
});

test('lê eventos separados por \\r\\n\\r\\n (Google)', async () => {
  assert.deepEqual(await all(fakeRes(['data: a\r\n\r\ndata: b\r\n\r\n'])), ['a', 'b']);
});

test('\\r\\n partido entre pedaços não quebra nem duplica', async () => {
  assert.deepEqual(await all(fakeRes(['data: a\r', '\n\r', '\ndata: b\r\n', '\r\n'])), ['a', 'b']);
});

test('último bloco sem linha em branco no fim também sai', async () => {
  assert.deepEqual(await all(fakeRes(['data: a\n\ndata: fim'])), ['a', 'fim']);
});
