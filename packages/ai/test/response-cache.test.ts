import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheKey, getCached, putCached, pruneCache, clearCache, cacheStats } from '../src/response-cache.ts';
import { runChat } from '../src/router.ts';
import { setSetting } from '../src/db.ts';

const base = { profileId: 'code', modelId: null, system: 'sys', messages: [{ role: 'user', content: 'oi' }] };

test('chave muda com system, mensagens e rota', () => {
  const k = cacheKey(base);
  assert.equal(k, cacheKey({ ...base, messages: [{ role: 'user', content: 'oi', extra: 1 }] }));
  assert.notEqual(k, cacheKey({ ...base, system: 'outro' }));
  assert.notEqual(k, cacheKey({ ...base, messages: [{ role: 'user', content: 'olá' }] }));
  assert.notEqual(k, cacheKey({ ...base, profileId: 'terse' }));
  assert.notEqual(k, cacheKey({ ...base, modelId: 'anthropic/claude-haiku-5-5' }));
});

test('guarda, lê, conta hit e expira pelo TTL', () => {
  clearCache();
  const key = cacheKey(base);
  putCached(key, { modelId: 'm', providerId: 'p', text: 'resposta', inputTokens: 100, outputTokens: 20, cost: 0.01 });
  const hit = getCached(key, { ttlHours: 1 });
  assert.equal(hit.text, 'resposta');
  assert.equal(cacheStats().hits, 1);
  assert.equal(getCached(key, { ttlHours: 1, now: Date.now() + 2 * 3600_000 }), null);
  assert.equal(getCached(key, { ttlHours: 1 }), null);
});

test('pruneCache remove só o que venceu', () => {
  clearCache();
  putCached('a', { modelId: 'm', providerId: 'p', text: 'x' });
  assert.equal(pruneCache({ ttlHours: 1 }), 0);
  assert.equal(pruneCache({ ttlHours: 1, now: Date.now() + 2 * 3600_000 }), 1);
});

test('texto vazio não entra no cache', () => {
  clearCache();
  putCached('b', { modelId: 'm', providerId: 'p', text: '' });
  assert.equal(cacheStats().entries, 0);
});

// Perfil sem fila: quando o cache não responde, o router para na hora, sem rede e sem gastar token.
const offline = { ...base, profileId: 'sem-fila' };

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('runChat responde do cache sem chamar modelo e respeita noCache', async () => {
  clearCache();
  setSetting('responseCache', { enabled: true });
  const key = cacheKey(offline);
  putCached(key, { modelId: 'anthropic/claude-haiku-5-5', providerId: 'anthropic', label: 'Haiku', text: 'guardada', inputTokens: 50, outputTokens: 10, cost: 0.002 });

  const events = await collect(runChat(offline));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.cacheHit, true);
  assert.equal(done.text, 'guardada');
  assert.equal(done.cost, 0);
  assert.equal(done.saved, 0.002);
  assert.equal(done.usage.savedTokens, 60);

  const fresh = await collect(runChat({ ...offline, noCache: true }));
  assert.ok(!fresh.some((e) => e.cacheHit));
  assert.ok(fresh.some((e) => e.type === 'error'));
});

test('com ferramentas ativas o cache é ignorado', async () => {
  const events = await collect(runChat({ ...offline, tools: [{ name: 'read_file' }], projectPath: '/tmp' }));
  assert.ok(!events.some((e) => e.cacheHit));
});

test('cache desligado nas configurações', async () => {
  setSetting('responseCache', { enabled: false });
  const events = await collect(runChat(offline));
  assert.ok(!events.some((e) => e.cacheHit));
  setSetting('responseCache', { enabled: true });
});
