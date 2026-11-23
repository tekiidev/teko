import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { delegateAgent, parseAgentOutput } from '../src/tools/agent.ts';
import { toolDefs } from '../src/tools/index.ts';
import { parseProjectCommand } from '../src/chat.ts';

test('delegate_agent roda o agente no projeto e lista o que mudou', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'teko-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  // Claude Code falso: escreve um arquivo e devolve o JSON do modo -p.
  const bin = path.join(repo, '..', `claude-falso-${Date.now()}`);
  fs.writeFileSync(bin, `#!/bin/sh\necho "oi" > feito.txt\necho '{"type":"result","is_error":false,"result":"Criei feito.txt.","total_cost_usd":0.0123,"num_turns":3}'\n`, { mode: 0o755 });
  process.env.CLAUDE_BIN = bin;
  try {
    process.env.TEKO_AGENT_REVIEW = '0';
    const r = await delegateAgent({ task: 'cria um arquivo' }, { root: repo });
    delete process.env.TEKO_AGENT_REVIEW;
    assert.equal(r.ok, true);
    assert.match(r.output, /IMPLEMENTAÇÃO \(Claude Code\): ok · US\$ 0\.0123 · 3 passos/);
    assert.match(r.output, /Criei feito\.txt\./);
    assert.match(r.output, /- feito\.txt/);
  } finally {
    delete process.env.CLAUDE_BIN;
    fs.rmSync(bin, { force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('delegate_agent sem projeto não roda', async () => {
  const r = await delegateAgent({ task: 'x' }, { root: null });
  assert.equal(r.ok, false);
});

test('saída inválida do agente vira erro legível', () => {
  assert.equal(parseAgentOutput('deu ruim').ok, false);
  assert.equal(parseAgentOutput('{"is_error":false,"result":"ok"}').result, 'ok');
});

test('voz recebe só ferramentas de leitura', () => {
  const nomes = toolDefs({ readOnly: true }).map((t) => t.name);
  assert.ok(nomes.includes('read_file'));
  assert.ok(!nomes.includes('write_file'));
  assert.ok(!nomes.includes('delegate_agent'));
  // delegate_agent só vai pro modelo quando o Claude Code existe nesta máquina.
  const antes = process.env.CLAUDE_BIN;
  process.env.CLAUDE_BIN = '/caminho/do/claude';
  assert.ok(toolDefs().some((t) => t.name === 'delegate_agent'));
  if (antes === undefined) delete process.env.CLAUDE_BIN; else process.env.CLAUDE_BIN = antes;
});

test('troca de projeto falada só com projeto que existe', () => {
  const projetos = [{ id: 'p1', name: 'Cofu', slug: 'cofu' }, { id: 'p2', name: 'teko', slug: 'teko' }];
  assert.deepEqual(parseProjectCommand('Teko, trabalha no projeto Cofu.', projetos), { projectId: 'p1', name: 'Cofu' });
  assert.deepEqual(parseProjectCommand('muda pro teko', projetos), { projectId: 'p2', name: 'teko' });
  assert.deepEqual(parseProjectCommand('Sai do projeto', projetos), { projectId: null, name: null });
  assert.equal(parseProjectCommand('abre o mapa', projetos), undefined);
  assert.equal(parseProjectCommand('qual a capital do Maranhão?', projetos), undefined);
});
