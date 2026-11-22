import crypto from 'node:crypto';
import { db, getSetting, nowIso } from './db.js';

/**
 * Cache local de respostas: a mesma pergunta, no mesmo contexto, não paga o modelo de novo.
 * Só vale pra conversas sem ferramentas (sem leitura de arquivo nem escrita), porque aí
 * a resposta depende apenas do que foi enviado.
 * A data do dia vai no contexto da mensagem, então o cache também expira na virada do dia.
 */

db.exec(`
CREATE TABLE IF NOT EXISTS response_cache (
  key           TEXT PRIMARY KEY,
  model_id      TEXT NOT NULL,
  provider_id   TEXT NOT NULL,
  label         TEXT,
  text          TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost          REAL NOT NULL DEFAULT 0,
  hits          INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_response_cache_created ON response_cache(created_at);
`);

export const DEFAULT_TTL_HOURS = 24;
const MAX_TEXT = 200_000;

export function cacheSettings() {
  const cfg = getSetting('responseCache', {}) || {};
  const ttlHours = Number(cfg.ttlHours);
  return {
    enabled: cfg.enabled !== false,
    ttlHours: Number.isFinite(ttlHours) && ttlHours > 0 ? ttlHours : DEFAULT_TTL_HOURS,
  };
}

/** Hash de tudo que define a resposta: rota pedida, system e mensagens (texto e papel). */
export function cacheKey({ profileId = null, modelId = null, system = '', messages = [] }) {
  const payload = JSON.stringify({
    v: 1,
    profileId,
    modelId,
    system,
    messages: messages.map((m) => [m.role, m.content]),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function getCached(key, { ttlHours = DEFAULT_TTL_HOURS, now = Date.now() } = {}) {
  const row = db.prepare('SELECT * FROM response_cache WHERE key = ?').get(key);
  if (!row) return null;
  if (now - Date.parse(row.created_at) > ttlHours * 3600_000) {
    db.prepare('DELETE FROM response_cache WHERE key = ?').run(key);
    return null;
  }
  db.prepare('UPDATE response_cache SET hits = hits + 1 WHERE key = ?').run(key);
  return row;
}

export function putCached(key, { modelId, providerId, label = null, text, inputTokens = 0, outputTokens = 0, cost = 0 }) {
  if (!text || text.length > MAX_TEXT) return;
  db.prepare(
    `INSERT INTO response_cache (key, model_id, provider_id, label, text, input_tokens, output_tokens, cost, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       model_id = excluded.model_id, provider_id = excluded.provider_id, label = excluded.label,
       text = excluded.text, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
       cost = excluded.cost, hits = 0, created_at = excluded.created_at`,
  ).run(key, modelId, providerId, label, text, Math.round(inputTokens), Math.round(outputTokens), cost, nowIso());
}

/** Remove entradas vencidas. Retorna quantas saíram. */
export function pruneCache({ ttlHours = DEFAULT_TTL_HOURS, now = Date.now() } = {}) {
  const cutoff = new Date(now - ttlHours * 3600_000).toISOString();
  return Number(db.prepare('DELETE FROM response_cache WHERE created_at < ?').run(cutoff).changes);
}

export function clearCache() {
  return Number(db.prepare('DELETE FROM response_cache').run().changes);
}

export function cacheStats() {
  const row = db
    .prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(hits * cost),0) AS saved FROM response_cache')
    .get();
  return { entries: row.entries, hits: row.hits, saved: row.saved };
}
