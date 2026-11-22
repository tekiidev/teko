import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { db } from '../src/db.ts';
import { runTurn } from '../src/chat.ts';
import { clearCache } from '../src/response-cache.ts';

// Provider falso em localhost (compatível com OpenAI): nada sai da máquina e não gasta token.
let calls = 0;
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    calls += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'resposta falsa' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
const port = (server.address() as any).port;
db.prepare("UPDATE providers SET base_url = ? WHERE id = 'ollama'").run(`http://127.0.0.1:${port}/v1`);
after(() => server.close());

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test('runTurn grava a conversa, registra uso e a repetição vem do cache local', async () => {
  clearCache();
  const first = await collect(runTurn({ text: 'oi teko', profileId: 'code', modelId: 'ollama/qwen3:8b' }));
  const meta = first.find((e) => e.type === 'meta');
  const end = first.at(-1);
  assert.equal(end.type, 'end');
  assert.equal(end.ok, true);
  assert.equal(calls, 1);

  const rows = db.prepare('SELECT role, content FROM messages WHERE session_id = ? ORDER BY rowid').all(meta.sessionId);
  assert.deepEqual(rows.map((r) => r.role), ['user', 'assistant']);
  assert.equal(rows[1].content, 'resposta falsa');
  const usage = db.prepare("SELECT kind, input_tokens FROM usage_events WHERE session_id = ?").all(meta.sessionId);
  assert.equal(usage[0].kind, 'chat');
  assert.equal(usage[0].input_tokens, 100);

  const again = await collect(runTurn({ text: 'oi teko', profileId: 'code', modelId: 'ollama/qwen3:8b' }));
  assert.equal(again.at(-1).cacheHit, true);
  assert.equal(calls, 1);
  const hit = db.prepare("SELECT kind FROM usage_events WHERE session_id = ?").get(again[0].sessionId);
  assert.equal(hit.kind, 'cache_hit');
});
