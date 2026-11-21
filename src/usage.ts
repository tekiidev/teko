import { db, newId } from './db.js';

export function localMidnight(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function windowStart(kind, now = new Date()) {
  if (kind === 'today') return localMidnight(now);
  if (kind === 'week') {
    const d = localMidnight(now);
    const offset = (d.getDay() + 6) % 7; // segunda = 0
    d.setDate(d.getDate() - offset);
    return d;
  }
  if (kind === 'month') return new Date(now.getFullYear(), now.getMonth(), 1);
  return null; // total
}

function emptyTotals() {
  return { input: 0, output: 0, tokens: 0, cost: 0, requests: 0 };
}

function sumUsage({ since = null, sessionId = null, modelId = null } = {}) {
  const where = [];
  const params = [];
  if (since) {
    where.push('ts >= ?');
    params.push(since.toISOString());
  }
  if (sessionId) {
    where.push('session_id = ?');
    params.push(sessionId);
  }
  if (modelId) {
    where.push('model_id = ?');
    params.push(modelId);
  }
  const sql = `
    SELECT COALESCE(SUM(input_tokens),0) AS input,
           COALESCE(SUM(output_tokens),0) AS output,
           COALESCE(SUM(cost),0) AS cost,
           COUNT(*) AS requests
      FROM usage_events
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
  `;
  const row = db.prepare(sql).get(...params);
  return {
    input: row.input,
    output: row.output,
    tokens: row.input + row.output,
    cost: row.cost,
    requests: row.requests,
  };
}

export function tokensSince(since, modelId) {
  if (!since) {
    const row = db
      .prepare('SELECT COALESCE(SUM(input_tokens + output_tokens),0) AS n FROM usage_events WHERE model_id = ?')
      .get(modelId);
    return row.n;
  }
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(input_tokens + output_tokens),0) AS n FROM usage_events WHERE model_id = ? AND ts >= ?',
    )
    .get(modelId, since.toISOString());
  return row.n;
}

export function usageSummary({ sessionId = null } = {}) {
  const out = {
    session: emptyTotals(),
    today: sumUsage({ since: windowStart('today') }),
    week: sumUsage({ since: windowStart('week') }),
    month: sumUsage({ since: windowStart('month') }),
    total: sumUsage({}),
  };
  if (sessionId) out.session = sumUsage({ sessionId });

  out.byModelWeek = db
    .prepare(
      `SELECT model_id, provider_id,
              COALESCE(SUM(input_tokens),0) AS input,
              COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cost),0) AS cost,
              COUNT(*) AS requests
         FROM usage_events
        WHERE ts >= ?
        GROUP BY model_id, provider_id
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`,
    )
    .all(windowStart('week').toISOString())
    .map((r) => ({ ...r, tokens: r.input + r.output }));

  out.byProviderWeek = db
    .prepare(
      `SELECT provider_id,
              COALESCE(SUM(input_tokens),0) AS input,
              COALESCE(SUM(output_tokens),0) AS output,
              COALESCE(SUM(cost),0) AS cost,
              COUNT(*) AS requests
         FROM usage_events
        WHERE ts >= ?
        GROUP BY provider_id
        ORDER BY (SUM(input_tokens) + SUM(output_tokens)) DESC`,
    )
    .all(windowStart('week').toISOString())
    .map((r) => ({ ...r, tokens: r.input + r.output }));

  // Série dos últimos 14 dias (para o gráfico).
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const start = localMidnight(new Date(Date.now() - i * 86400000));
    const end = new Date(start.getTime() + 86400000);
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(input_tokens + output_tokens),0) AS tokens,
                COALESCE(SUM(cost),0) AS cost
           FROM usage_events WHERE ts >= ? AND ts < ?`,
      )
      .get(start.toISOString(), end.toISOString());
    days.push({ date: start.toISOString().slice(0, 10), tokens: row.tokens, cost: row.cost });
  }
  out.series = days;

  return out;
}

export function recordUsage({
  sessionId = null,
  projectId = null,
  modelId,
  providerId,
  inputTokens = 0,
  outputTokens = 0,
  cost = 0,
  kind = 'chat',
}) {
  db.prepare(
    `INSERT INTO usage_events
       (id, ts, session_id, project_id, model_id, provider_id, input_tokens, output_tokens, cost, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId('use'),
    new Date().toISOString(),
    sessionId,
    projectId,
    modelId,
    providerId,
    Math.round(inputTokens),
    Math.round(outputTokens),
    cost,
    kind,
  );
}
