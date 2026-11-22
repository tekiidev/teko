import { db, ensureColumns, getSetting } from './db.js';

/**
 * Compressão do histórico: quando a parte da conversa ainda não resumida passa do limite,
 * as mensagens antigas viram um resumo (feito por um modelo barato) e só as últimas vão inteiras.
 * O resumo fica salvo na sessão e é reaproveitado; ele só muda na próxima compressão,
 * então o começo da conversa continua igual entre mensagens e segue aproveitando o cache do provider.
 */

ensureColumns('sessions', {
  compact_summary: 'TEXT',
  compact_until: 'INTEGER NOT NULL DEFAULT 0', // rowid da última mensagem já resumida
  compact_saved_tokens: 'INTEGER NOT NULL DEFAULT 0',
});

export const DEFAULTS = { enabled: true, thresholdTokens: 12000, keepRecent: 6, profileId: 'terse' };
const MAX_LOAD = 400;

export function compressionSettings() {
  const cfg = getSetting('compression', {}) || {};
  const num = (v, d, min) => (Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : d);
  return {
    enabled: cfg.enabled !== false,
    thresholdTokens: num(cfg.thresholdTokens, DEFAULTS.thresholdTokens, 1000),
    keepRecent: Math.floor(num(cfg.keepRecent, DEFAULTS.keepRecent, 2)),
    profileId: typeof cfg.profileId === 'string' && cfg.profileId ? cfg.profileId : DEFAULTS.profileId,
  };
}

/** Estimativa barata (~4 caracteres por token). Serve pra decidir, não pra cobrar. */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

export function historyTokens(messages) {
  return messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
}

/**
 * Decide o corte: devolve as mensagens a resumir e as que seguem inteiras,
 * ou null se ainda cabe. A parte mantida sempre começa numa mensagem do usuário.
 */
export function planCompression(messages, { thresholdTokens = DEFAULTS.thresholdTokens, keepRecent = DEFAULTS.keepRecent } = {}) {
  if (messages.length <= keepRecent || historyTokens(messages) <= thresholdTokens) return null;
  let cut = messages.length - keepRecent;
  while (cut > 0 && messages[cut].role !== 'user') cut -= 1;
  if (cut <= 0) return null;
  return { old: messages.slice(0, cut), recent: messages.slice(cut) };
}

export function summaryPrompt(previous, old) {
  const transcript = old
    .map((m) => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${String(m.content).slice(0, 6000)}`)
    .join('\n\n');
  return [
    previous ? `<resumo_anterior>\n${previous}\n</resumo_anterior>\n` : '',
    `<conversa>\n${transcript}\n</conversa>`,
  ].join('');
}

export const SUMMARY_SYSTEM =
  'Você resume conversas para que outro modelo continue o trabalho sem o histórico completo. ' +
  'Junte o resumo anterior (se houver) com a conversa nova em um único resumo. ' +
  'Mantenha: objetivo, decisões e o motivo, nomes de arquivos, funções, comandos, erros, valores exatos e pendências. ' +
  'Corte cumprimentos e repetições. Tópicos curtos, no máximo 40 linhas. Sem introdução.';

/** Mensagens que vão pro modelo no lugar do histórico antigo. */
export function summaryMessages(summary) {
  if (!summary) return [];
  return [
    { role: 'user', content: `<resumo_da_conversa>\nResumo das mensagens anteriores desta conversa:\n${summary}\n</resumo_da_conversa>` },
    { role: 'assistant', content: 'Entendido, sigo a partir desse resumo.' },
  ];
}

/** Histórico da sessão a partir do último resumo (com rowid pra marcar o corte). */
export function loadSessionHistory(sessionId) {
  const session = db
    .prepare('SELECT compact_summary, compact_until, compact_saved_tokens FROM sessions WHERE id = ?')
    .get(sessionId) || {};
  const messages = db
    .prepare(
      `SELECT rowid AS rid, role, content FROM messages
        WHERE session_id = ? AND rowid > ?
        ORDER BY rowid DESC LIMIT ${MAX_LOAD}`,
    )
    .all(sessionId, session.compact_until || 0)
    .reverse();
  return { summary: session.compact_summary || null, savedTokens: session.compact_saved_tokens || 0, messages };
}

/**
 * Comprime se precisar. `summarize(system, prompt)` chama o modelo e devolve { text, ... };
 * fica injetável pra testar sem rede. Se o resumo falhar, segue com o histórico inteiro.
 */
export async function compactHistory({ sessionId, summary, messages, summarize, settings = compressionSettings() }) {
  const base = { summary, messages, compressed: null };
  if (!settings.enabled) return base;
  const plan = planCompression(messages, settings);
  if (!plan) return base;

  let result;
  try {
    result = await summarize(SUMMARY_SYSTEM, summaryPrompt(summary, plan.old));
  } catch {
    return base;
  }
  const text = String(result?.text || '').trim();
  if (!text) return base;

  const before = estimateTokens(summary || '') + historyTokens(plan.old);
  const saved = Math.max(0, before - estimateTokens(text));
  const until = plan.old[plan.old.length - 1].rid;
  if (sessionId && until) {
    db.prepare(
      'UPDATE sessions SET compact_summary = ?, compact_until = ?, compact_saved_tokens = compact_saved_tokens + ? WHERE id = ?',
    ).run(text, until, saved, sessionId);
  }
  return {
    summary: text,
    messages: plan.recent,
    compressed: { messages: plan.old.length, savedTokens: saved, result },
  };
}

/** Monta o histórico final: resumo (se houver) + mensagens recentes, só com role e content. */
export function withSummary(summary, messages) {
  return [...summaryMessages(summary), ...messages.map(({ role, content }) => ({ role, content }))];
}
