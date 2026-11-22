import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeChain } from '../src/db.ts';
import { MODELS, PROFILES, MODEL_UPGRADES, CHAIN_ADDITIONS } from '../src/catalog.ts';

test('substituto entra logo antes do modelo antigo, mantendo a ordem do usuário', () => {
  const chain = ['openai/gpt-6-luna', 'anthropic/claude-haiku-4-5', 'deepseek/deepseek-chat'];
  assert.deepEqual(upgradeChain(chain), [
    'openai/gpt-6-luna', 'anthropic/claude-haiku-5-5', 'anthropic/claude-haiku-4-5', 'deepseek/deepseek-chat',
  ]);
});

test('não duplica se o substituto já está na fila', () => {
  const chain = ['anthropic/claude-sonnet-5-5', 'anthropic/claude-sonnet-4-5'];
  assert.deepEqual(upgradeChain(chain), chain);
});

test('todo modelo citado nos perfis, substituições e adições existe no catálogo', () => {
  const ids = new Set(MODELS.map((m) => m.id));
  for (const p of PROFILES) for (const id of p.chain) assert.ok(ids.has(id), `${p.id}: ${id}`);
  // O modelo antigo pode ter saído do catálogo (aposentado); o substituto precisa existir.
  for (const to of Object.values(MODEL_UPGRADES)) assert.ok(ids.has(to), to);
  for (const add of CHAIN_ADDITIONS) assert.ok(ids.has(add.model), add.model);
});

test('addToChain insere antes do primeiro local e não duplica', async () => {
  const { addToChain } = await import('../src/db.ts');
  assert.deepEqual(addToChain(['a', 'ollama/qwen3:8b'], 'g', ['ollama/qwen3:8b']), ['a', 'g', 'ollama/qwen3:8b']);
  assert.deepEqual(addToChain(['a'], 'g', ['x']), ['a', 'g']);
  assert.deepEqual(addToChain(['g', 'a'], 'g', ['a']), ['g', 'a']);
});
