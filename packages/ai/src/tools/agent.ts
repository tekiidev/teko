import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

/**
 * Maestro: o Teko não tenta programar melhor que um agente de código; ele delega.
 * Roda o Claude Code sem interface (`claude -p`) dentro do projeto ativo e devolve
 * o resumo, o custo e os arquivos que mudaram.
 *
 * Limites: só edita arquivos (permission-mode acceptEdits: não roda comandos por conta
 * própria), gasto máximo por tarefa e tempo máximo.
 */

const MAX_BUDGET_USD = Number(process.env.TEKO_AGENT_MAX_USD || 2);
const TIMEOUT_MS = Number(process.env.TEKO_AGENT_TIMEOUT_MS || 15 * 60_000);
const MAX_OUTPUT = 6000;

/** Acha o binário do Claude Code: CLAUDE_BIN, PATH ou o instalador padrão (~/.local/bin). */
export function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const bin = path.join(dir, 'claude');
    if (dir && fs.existsSync(bin)) return bin;
  }
  return null;
}

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15_000 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** Arquivos com mudança (git status), pra mostrar o que o agente alterou. */
async function changedFiles(cwd: string) {
  const out = await git(['status', '--porcelain'], cwd);
  return new Set(out.split('\n').map((l) => l.slice(3).trim()).filter(Boolean));
}

export function parseAgentOutput(stdout: string) {
  // --output-format json devolve um objeto: { type: "result", result, total_cost_usd, is_error, num_turns, ... }
  const text = String(stdout || '').trim();
  const start = text.lastIndexOf('\n{') >= 0 ? text.lastIndexOf('\n{') + 1 : text.indexOf('{');
  try {
    const data = JSON.parse(text.slice(Math.max(0, start)));
    return {
      ok: !data.is_error,
      result: String(data.result ?? ''),
      costUsd: Number(data.total_cost_usd ?? 0),
      turns: Number(data.num_turns ?? 0),
    };
  } catch {
    return { ok: false, result: text.slice(0, MAX_OUTPUT), costUsd: 0, turns: 0 };
  }
}

export async function delegateAgent(args: any = {}, ctx) {
  const task = String(args.task || '').trim();
  if (!task) throw new Error('informe a tarefa');
  if (!ctx?.root) return { ok: false, output: 'sem projeto ativo: escolha um projeto com caminho local' };
  const bin = findClaude();
  if (!bin) return { ok: false, output: 'Claude Code não encontrado (instale ou defina CLAUDE_BIN)' };

  const antes = await changedFiles(ctx.root);
  const argv = [
    '-p', task,
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--max-budget-usd', String(MAX_BUDGET_USD),
    '--append-system-prompt',
    'Você foi chamado pelo Teko (orquestrador). Faça só o que a tarefa pede, sem commitar. No fim, resuma em português o que mudou e por quê, em poucas linhas.',
  ];

  const resultado: any = await new Promise((resolve) => {
    const filho = spawn(bin, argv, { cwd: ctx.root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => filho.kill('SIGTERM'), TIMEOUT_MS);
    filho.stdout.on('data', (d) => { stdout += d; });
    filho.stderr.on('data', (d) => { stderr += d; });
    filho.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err.message) }); });
    filho.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });

  const depois = await changedFiles(ctx.root);
  const novos = [...depois].filter((f) => !antes.has(f));
  const parsed = parseAgentOutput(resultado.stdout);
  const timeout = resultado.signal === 'SIGTERM';

  const partes = [
    `Claude Code ${parsed.ok && resultado.code === 0 ? 'terminou' : timeout ? 'parou por tempo' : 'terminou com erro'}` +
      (parsed.costUsd ? ` · US$ ${parsed.costUsd.toFixed(4)}` : '') +
      (parsed.turns ? ` · ${parsed.turns} passos` : ''),
    parsed.result.slice(0, MAX_OUTPUT) || String(resultado.stderr || '').slice(0, 1500),
    novos.length ? `Arquivos alterados:\n${novos.map((f) => `- ${f}`).join('\n')}` : 'Nenhum arquivo novo alterado.',
  ];
  return { ok: parsed.ok && resultado.code === 0, output: partes.filter(Boolean).join('\n\n') };
}
