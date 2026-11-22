import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, newId, nowIso } from '../src/db.ts';
import {
  compactHistory,
  estimateTokens,
  loadSessionHistory,
  planCompression,
  summaryPrompt,
  withSummary,
} from '../src/compress.ts';

const big = 'x'.repeat(4000); // ~1000 tokens
const settings = { enabled: true, thresholdTokens: 3000, keepRecent: 2, profileId: 'terse' };

function convo(n) {
  return Array.from({ length: n }, (_, i) => ({ rid: i + 1, role: i % 2 ? 'assistant' : 'user', content: `${i} ${big}` }));
}

test('estimativa ~4 caracteres por token', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens(''), 0);
});

test('conversa curta não comprime', () => {
  assert.equal(planCompression(convo(2), settings), null);
});

test('corte mantém as últimas e começa no usuário', () => {
  const msgs = convo(7); // termina em usuário
  const plan = planCompression(msgs, { ...settings, keepRecent: 3 });
  assert.equal(plan.recent[0].role, 'user');
  assert.equal(plan.old.length + plan.recent.length, 7);
  assert.ok(plan.recent.length >= 3);
});

test('prompt inclui o resumo anterior', () => {
  const p = summaryPrompt('antigo', [{ role: 'user', content: 'oi' }]);
  assert.match(p, /<resumo_anterior>\nantigo/);
  assert.match(p, /Usuário: oi/);
});

test('withSummary põe o resumo antes e limpa campos extras', () => {
  const out = withSummary('R', [{ rid: 9, role: 'user', content: 'q' }]);
  assert.equal(out.length, 3);
  assert.match(out[0].content, /<resumo_da_conversa>[\s\S]*R/);
  assert.equal(out[1].role, 'assistant');
  assert.deepEqual(out[2], { role: 'user', content: 'q' });
});

test('compacta, salva na sessão e a próxima carga começa depois do corte', async () => {
  const sessionId = newId('ses');
  db.prepare('INSERT INTO sessions (id, title, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(sessionId, 't', 'code', nowIso(), nowIso());
  const ins = db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 6; i += 1) ins.run(newId('msg'), sessionId, i % 2 ? 'assistant' : 'user', `${i} ${big}`, nowIso());

  const stored = loadSessionHistory(sessionId);
  assert.equal(stored.messages.length, 6);
  stored.messages.push({ role: 'user', content: 'nova pergunta' });

  let calls = 0;
  const out = await compactHistory({
    sessionId,
    summary: stored.summary,
    messages: stored.messages,
    settings,
    summarize: async () => {
      calls += 1;
      return { text: 'resumo curto', modelId: 'm', providerId: 'p', cost: 0.001 };
    },
  });
  assert.equal(calls, 1);
  assert.equal(out.summary, 'resumo curto');
  assert.equal(out.messages.at(-1).content, 'nova pergunta');
  assert.ok(out.compressed.savedTokens > 3000);

  const again = loadSessionHistory(sessionId);
  assert.equal(again.summary, 'resumo curto');
  assert.ok(again.messages.length < 6);
  assert.ok(again.savedTokens > 3000);
});

test('falha no resumo mantém o histórico inteiro', async () => {
  const msgs = convo(7);
  const out = await compactHistory({ sessionId: null, summary: null, messages: msgs, settings, summarize: async () => { throw new Error('x'); } });
  assert.equal(out.messages.length, 7);
  assert.equal(out.compressed, null);
});

test('desligado não chama o modelo', async () => {
  let called = false;
  const out = await compactHistory({ sessionId: null, summary: null, messages: convo(7), settings: { ...settings, enabled: false }, summarize: async () => { called = true; return { text: 'r' }; } });
  assert.equal(called, false);
  assert.equal(out.messages.length, 7);
});
