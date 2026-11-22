import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, buildTurnContext, withTurnContext } from '../src/context.ts';

test('system prompt é idêntico entre chamadas (cacheável)', async () => {
  const a = buildSystemPrompt({ profileId: 'code' });
  await new Promise((r) => setTimeout(r, 1100));
  const b = buildSystemPrompt({ profileId: 'code' });
  assert.equal(a, b);
  assert.doesNotMatch(a, /\d{2}:\d{2}:\d{2}/);
});

test('contexto volátil vai junto da mensagem, não do system', () => {
  const ctx = buildTurnContext({ retrieved: 'trecho X', now: new Date(2026, 10, 22) });
  assert.match(ctx, /22\/11\/2026/);
  assert.match(ctx, /trecho X/);
  assert.equal(withTurnContext('pergunta', ctx), `${ctx}\n\npergunta`);
  assert.equal(withTurnContext('pergunta', ''), 'pergunta');
});

test('skill ativada entra no contexto da mensagem', () => {
  const ctx = buildTurnContext({ skill: { name: 'vagas', description: 'd', body: 'Responda em tópicos.', chars: 10 } });
  assert.match(ctx, /skill \/vagas/);
  assert.match(ctx, /<skill nome="vagas">\nResponda em tópicos.\n<\/skill>/);
});
