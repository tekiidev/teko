import { db } from './db.js';
import './response-cache.js';

/**
 * Apaga conversas do banco local (data/teko.db). Não mexe em nada fora do Mac:
 * o que cada provedor guarda das chamadas de API segue a política de cada um.
 * O histórico de custo (usage_events) fica, pra o /uso continuar certo.
 */
export type Alvo = { tipo: 'todas' } | { tipo: 'voz' } | { tipo: 'projeto'; projectId: string };

function where(alvo: Alvo): [string, unknown[]] {
  if (alvo.tipo === 'voz') return ["profile_id = 'voice'", []];
  if (alvo.tipo === 'projeto') return ['project_id = ?', [alvo.projectId]];
  return ['1 = 1', []];
}

export function contarConversas(alvo: Alvo) {
  const [cond, args] = where(alvo);
  const sessoes = db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${cond}`).get(...args).n as number;
  const mensagens = db
    .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE ${cond})`)
    .get(...args).n as number;
  return { sessoes, mensagens };
}

export function limparConversas(alvo: Alvo) {
  const [cond, args] = where(alvo);
  const total = contarConversas(alvo);
  db.exec('BEGIN');
  try {
    db.prepare(`DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE ${cond})`).run(...args);
    db.prepare(`DELETE FROM sessions WHERE ${cond}`).run(...args);
    // O cache guarda textos de respostas; apagar tudo leva ele junto.
    if (alvo.tipo === 'todas') db.prepare('DELETE FROM response_cache').run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return total;
}
