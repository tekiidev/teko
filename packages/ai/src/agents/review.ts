import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Revisor da dupla: uma IA de OUTRA empresa lê o diff que o Claude Code fez.
 * Modelos diferentes erram em lugares diferentes; um pega o erro do outro.
 */

const MAX_DIFF = 60_000;
// Ordem de preferência do revisor (nunca Anthropic, que é quem implementa).
const REVISORES = ['openai/gpt-5.5', 'google/gemini-pro-latest', 'openai/gpt-6-luna', 'deepseek/deepseek-reasoner'];

export const REVIEW_SYSTEM = [
  'Você é revisor de código sênior. Outro agente acabou de fazer as mudanças abaixo para cumprir a tarefa.',
  'Procure: bugs, casos não tratados, quebra de comportamento existente, problemas de segurança e se a tarefa foi cumprida.',
  'Ignore estilo e preferências pessoais. Não invente problemas: se estiver bom, aprove.',
  'Responda SÓ com JSON, sem texto fora dele:',
  '{"aprovado": true|false, "resumo": "1 frase", "problemas": [{"arquivo": "caminho", "problema": "o que está errado e como corrigir", "gravidade": "alta"|"media"|"baixa"}]}',
].join(' ');

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
  });
}

/** Diff das mudanças (inclui arquivos novos, lendo o conteúdo; não mexe no índice do git). */
export async function collectDiff(root: string) {
  let diff = await git(['diff'], root);
  const novos = (await git(['ls-files', '--others', '--exclude-standard'], root)).split('\n').filter(Boolean);
  for (const arquivo of novos.slice(0, 30)) {
    const cheio = path.join(root, arquivo);
    try {
      if (fs.statSync(cheio).size > 200_000) continue;
      const conteudo = fs.readFileSync(cheio, 'utf8');
      diff += `\n--- /dev/null\n+++ b/${arquivo} (novo)\n${conteudo.split('\n').map((l) => `+${l}`).join('\n')}\n`;
    } catch {
      /* binário ou sumiu */
    }
  }
  return diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncado]` : diff;
}

export function parseReview(texto: string) {
  const t = String(texto || '');
  const ini = t.indexOf('{');
  const fim = t.lastIndexOf('}');
  try {
    const d = JSON.parse(t.slice(ini, fim + 1));
    const problemas = Array.isArray(d.problemas) ? d.problemas.filter((p) => p && p.problema) : [];
    return {
      aprovado: d.aprovado === true && !problemas.some((p) => p.gravidade === 'alta'),
      resumo: String(d.resumo || ''),
      problemas: problemas.map((p) => ({ arquivo: String(p.arquivo || ''), problema: String(p.problema), gravidade: ['alta', 'media', 'baixa'].includes(p.gravidade) ? p.gravidade : 'media' })),
    };
  } catch {
    return null;
  }
}

/** Escolhe o revisor: o primeiro da lista que estiver pronto (chave e sem cooldown). */
export async function pickReviewer() {
  const { planRoute } = await import('../router.js');
  const preferidos = process.env.TEKO_REVIEWER ? [process.env.TEKO_REVIEWER] : REVISORES;
  for (const id of preferidos) {
    const [c] = planRoute({ profileId: 'review', modelId: id });
    if (c?.modelId === id && c.status === 'ready') return id;
  }
  return null;
}

export async function reviewDiff({ task, diff, sessionId = null, projectId = null }) {
  const modelId = await pickReviewer();
  if (!modelId) return { skipped: 'nenhum revisor de outra empresa disponível (coloque uma chave OpenAI ou Google)' };
  const { runChat } = await import('../router.js');
  const { recordUsage } = await import('../usage.js');
  const conteudo = `TAREFA:\n${task}\n\nMUDANÇAS (diff):\n${diff || '(nenhuma mudança)'}`;
  let done = null;
  for await (const ev of runChat({ profileId: 'review', modelId, system: REVIEW_SYSTEM, messages: [{ role: 'user', content: conteudo }], noCache: true, maxTokens: 8000 })) {
    if (ev.type === 'done') done = ev;
  }
  if (!done) return { skipped: 'o revisor não respondeu' };
  recordUsage({
    sessionId, projectId, modelId: done.modelId, providerId: done.providerId,
    inputTokens: done.usage?.inputTokens || 0, outputTokens: done.usage?.outputTokens || 0,
    cachedInputTokens: done.usage?.cachedInputTokens || 0, latencyMs: done.usage?.latencyMs ?? null,
    cost: done.cost || 0, kind: 'review',
  });
  const parsed = parseReview(done.text);
  return { label: done.label, modelId: done.modelId, cost: done.cost || 0, review: parsed, raw: parsed ? null : String(done.text).slice(0, 1500) };
}
