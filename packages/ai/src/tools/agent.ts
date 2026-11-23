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

/** Roda o Claude Code uma vez na pasta e devolve resultado, custo e arquivos que mudaram. */
export async function runClaude(task: string, root: string) {
  const bin = findClaude();
  if (!bin) return { ok: false, result: 'Claude Code não encontrado (instale ou defina CLAUDE_BIN)', costUsd: 0, turns: 0, changed: [], timeout: false };
  const antes = await changedFiles(root);
  const argv = [
    '-p', task,
    '--output-format', 'json',
    '--permission-mode', 'acceptEdits',
    '--max-budget-usd', String(MAX_BUDGET_USD),
    '--append-system-prompt',
    'Você foi chamado pelo Teko (orquestrador). Faça só o que a tarefa pede, sem commitar. No fim, resuma em português o que mudou e por quê, em poucas linhas.',
  ];
  const r: any = await new Promise((resolve) => {
    const filho = spawn(bin, argv, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => filho.kill('SIGTERM'), TIMEOUT_MS);
    filho.stdout.on('data', (d) => { stdout += d; });
    filho.stderr.on('data', (d) => { stderr += d; });
    filho.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(err.message) }); });
    filho.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  const depois = await changedFiles(root);
  const parsed = parseAgentOutput(r.stdout);
  return {
    ok: parsed.ok && r.code === 0,
    result: parsed.result || String(r.stderr || '').slice(0, 1500),
    costUsd: parsed.costUsd,
    turns: parsed.turns,
    changed: [...depois].filter((f) => !antes.has(f)),
    timeout: r.signal === 'SIGTERM',
  };
}

function registrarCusto(custo: number, ctx) {
  if (!custo) return;
  import('../usage.js').then(({ recordUsage }) =>
    recordUsage({ projectId: ctx?.projectId || null, modelId: 'anthropic/claude-code', providerId: 'anthropic', cost: custo, kind: 'agent' }),
  ).catch(() => {});
}

/**
 * Dupla: o Claude Code implementa, uma IA de outra empresa revisa o diff e, se ela achar
 * problema médio ou grave, o Claude Code corrige uma vez. Devolve um relatório pro Teko resumir.
 */
export async function delegateAgent(args: any = {}, ctx) {
  const task = String(args.task || '').trim();
  if (!task) throw new Error('informe a tarefa');
  if (!ctx?.root) return { ok: false, output: 'sem projeto ativo: escolha um projeto com caminho local' };

  const impl = await runClaude(task, ctx.root);
  registrarCusto(impl.costUsd, ctx);
  const linhas = [
    `IMPLEMENTAÇÃO (Claude Code): ${impl.ok ? 'ok' : impl.timeout ? 'parou por tempo' : 'erro'} · US$ ${impl.costUsd.toFixed(4)} · ${impl.turns} passos`,
    impl.result.slice(0, MAX_OUTPUT),
  ];
  const arquivos = new Set(impl.changed);
  let custoTotal = impl.costUsd;

  const revisar = process.env.TEKO_AGENT_REVIEW !== '0' && impl.ok;
  if (revisar) {
    const { collectDiff, reviewDiff } = await import('../agents/review.js');
    const rev: any = await reviewDiff({ task, diff: await collectDiff(ctx.root), projectId: ctx.projectId || null });
    if (rev.skipped) {
      linhas.push(`REVISÃO: pulada (${rev.skipped})`);
    } else if (!rev.review) {
      custoTotal += rev.cost;
      linhas.push(`REVISÃO (${rev.label}): resposta fora do formato · US$ ${rev.cost.toFixed(4)}\n${rev.raw}`);
    } else {
      custoTotal += rev.cost;
      const { aprovado, resumo, problemas } = rev.review;
      linhas.push(
        `REVISÃO (${rev.label}): ${aprovado ? 'aprovado' : `${problemas.length} problema(s)`} · US$ ${rev.cost.toFixed(4)}` +
          (resumo ? `\n${resumo}` : '') +
          (problemas.length ? `\n${problemas.map((p) => `- [${p.gravidade}] ${p.arquivo}: ${p.problema}`).join('\n')}` : ''),
      );
      const corrigir = problemas.filter((p) => p.gravidade !== 'baixa');
      if (corrigir.length) {
        const fix = await runClaude(
          `Um revisor apontou problemas nas mudanças que você fez para a tarefa "${task}". Corrija só estes pontos:\n` +
            corrigir.map((p) => `- ${p.arquivo}: ${p.problema}`).join('\n'),
          ctx.root,
        );
        registrarCusto(fix.costUsd, ctx);
        custoTotal += fix.costUsd;
        fix.changed.forEach((f) => arquivos.add(f));
        linhas.push(`CORREÇÃO (Claude Code): ${fix.ok ? 'ok' : 'erro'} · US$ ${fix.costUsd.toFixed(4)}\n${fix.result.slice(0, 2500)}`);
      }
    }
  }

  linhas.push(arquivos.size ? `ARQUIVOS ALTERADOS:\n${[...arquivos].map((f) => `- ${f}`).join('\n')}` : 'Nenhum arquivo novo alterado.');
  linhas.push(`CUSTO TOTAL: US$ ${custoTotal.toFixed(4)}`);
  return { ok: impl.ok, output: linhas.join('\n\n') };
}
