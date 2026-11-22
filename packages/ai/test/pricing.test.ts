import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addUsage, computeCost, normalizeUsage } from '../src/pricing.ts';

const sonnet = { price_in: 3, price_out: 15 };

test('sem cache: custo igual ao preço cheio e nada economizado', () => {
  const r = computeCost(sonnet, 'anthropic', { inputTokens: 1_000_000, outputTokens: 100_000 });
  assert.equal(r.cost, 3 + 1.5);
  assert.equal(r.saved, 0);
});

test('anthropic: leitura de cache custa 10% e gravação 125%', () => {
  const r = computeCost(sonnet, 'anthropic', {
    inputTokens: 1_000_000,
    cachedInputTokens: 800_000,
    cacheWriteTokens: 100_000,
    outputTokens: 0,
  });
  // 100k frescos a 3 + 800k a 0,3 + 100k a 3,75 (por milhão)
  assert.ok(Math.abs(r.cost - (0.3 + 0.24 + 0.375)) < 1e-9);
  assert.ok(Math.abs(r.costWithoutCache - 3) < 1e-9);
  assert.ok(r.saved > 0);
});

test('provider sem desconto conhecido: estimativa conservadora (preço cheio)', () => {
  const r = computeCost(sonnet, 'xai', { inputTokens: 1_000_000, cachedInputTokens: 1_000_000 });
  assert.equal(r.cost, 3);
  assert.equal(r.saved, 0);
});

test('normalizeUsage: cache nunca passa do total de entrada', () => {
  const u = normalizeUsage({ inputTokens: 100, cachedInputTokens: 500, cacheWriteTokens: 50 });
  assert.deepEqual(u, { inputTokens: 100, outputTokens: 0, cachedInputTokens: 100, cacheWriteTokens: 0 });
});

test('addUsage soma as rodadas do loop de ferramentas', () => {
  const total = addUsage({ inputTokens: 10, cachedInputTokens: 4 }, { inputTokens: 20, outputTokens: 5, cachedInputTokens: 15 });
  assert.deepEqual(total, { inputTokens: 30, outputTokens: 5, cachedInputTokens: 19, cacheWriteTokens: 0 });
});
