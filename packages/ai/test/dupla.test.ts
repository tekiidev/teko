import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { db } from '../src/db.ts';
import { delegateAgent } from '../src/tools/agent.ts';
import { parseReview } from '../src/agents/review.ts';

// Revisor falso (compatível com OpenAI, em localhost): aponta um problema médio.
const revisao = { aprovado: false, resumo: 'Faltou tratar entrada vazia.', problemas: [{ arquivo: 'feito.txt', problema: 'conteúdo vazio não é tratado', gravidade: 'media' }] };
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(revisao) } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 40 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
db.prepare("UPDATE providers SET base_url = ? WHERE id = 'ollama'").run(`http://127.0.0.1:${(server.address() as any).port}/v1`);
after(() => server.close());

test('parseReview: problema grave nunca conta como aprovado', () => {
  const r = parseReview('ok {"aprovado": true, "resumo": "x", "problemas": [{"arquivo": "a", "problema": "b", "gravidade": "alta"}]}');
  assert.equal(r.aprovado, false);
  assert.equal(parseReview('sem json'), null);
});

test('dupla: implementa, revisor de outra IA aponta problema, Claude Code corrige', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teko-dupla-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  // 1ª chamada cria feito.txt; 2ª (correção) cria corrigido.txt.
  const bin = path.join(os.tmpdir(), `claude-falso-${Date.now()}`);
  fs.writeFileSync(bin, `#!/bin/sh
if [ -f feito.txt ]; then echo ok > corrigido.txt; R="Corrigi a entrada vazia."; else echo oi > feito.txt; R="Criei feito.txt."; fi
echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"$R\\",\\"total_cost_usd\\":0.01,\\"num_turns\\":2}"
`, { mode: 0o755 });
  process.env.CLAUDE_BIN = bin;
  process.env.TEKO_REVIEWER = 'ollama/qwen3:8b';
  try {
    const r = await delegateAgent({ task: 'cria um arquivo' }, { root: repo });
    assert.equal(r.ok, true);
    assert.match(r.output, /REVISÃO \(Qwen3 8B \(local\)\): 1 problema\(s\)/);
    assert.match(r.output, /\[media\] feito\.txt: conteúdo vazio não é tratado/);
    assert.match(r.output, /CORREÇÃO \(Claude Code\): ok/);
    assert.match(r.output, /- feito\.txt/);
    assert.match(r.output, /- corrigido\.txt/);
    assert.match(r.output, /CUSTO TOTAL: US\$ 0\.02/);
  } finally {
    delete process.env.CLAUDE_BIN;
    delete process.env.TEKO_REVIEWER;
    fs.rmSync(bin, { force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
