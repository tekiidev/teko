import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upgradeChain } from '../src/db.ts';
import { MODELS, PROFILES, MODEL_UPGRADES } from '../src/catalog.ts';

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

test('todo modelo citado nos perfis e nas substituições existe no catálogo', () => {
  const ids = new Set(MODELS.map((m) => m.id));
  for (const p of PROFILES) for (const id of p.chain) assert.ok(ids.has(id), `${p.id}: ${id}`);
  for (const [from, to] of Object.entries(MODEL_UPGRADES)) {
    assert.ok(ids.has(from), from);
    assert.ok(ids.has(to), to);
  }
});
