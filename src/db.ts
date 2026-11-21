import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { DB_PATH } from './config.js';
import { PROVIDERS, MODELS, PROFILES } from './catalog.js';

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id        TEXT PRIMARY KEY,
  label     TEXT NOT NULL,
  kind      TEXT NOT NULL,
  base_url  TEXT NOT NULL,
  key_env   TEXT,
  enabled   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS models (
  id          TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model       TEXT NOT NULL,
  label       TEXT NOT NULL,
  ctx         INTEGER NOT NULL DEFAULT 128000,
  price_in    REAL NOT NULL DEFAULT 0,
  price_out   REAL NOT NULL DEFAULT 0,
  tags        TEXT NOT NULL DEFAULT '[]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS profiles (
  id            TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  description   TEXT,
  chain         TEXT NOT NULL DEFAULT '[]',
  system_prompt TEXT NOT NULL DEFAULT '',
  sort          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE,
  path        TEXT,
  description TEXT,
  stack       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'aceita',
  context       TEXT,
  decision      TEXT,
  consequences  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bugs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'media',
  status      TEXT NOT NULL DEFAULT 'aberto',
  area        TEXT,
  repro       TEXT,
  expected    TEXT,
  actual      TEXT,
  logs        TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  title       TEXT NOT NULL DEFAULT 'Nova conversa',
  profile_id  TEXT NOT NULL DEFAULT 'code',
  summary     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  role          TEXT NOT NULL,
  content       TEXT NOT NULL,
  model_id      TEXT,
  provider_id   TEXT,
  input_tokens  INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost          REAL DEFAULT 0,
  meta          TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  session_id    TEXT,
  project_id    TEXT,
  model_id      TEXT,
  provider_id   TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost          REAL NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'chat'
);

CREATE TABLE IF NOT EXISTS memory (
  id          TEXT PRIMARY KEY,
  project_id  TEXT,
  kind        TEXT NOT NULL DEFAULT 'nota',
  title       TEXT,
  content     TEXT NOT NULL,
  source      TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_health (
  model_id       TEXT PRIMARY KEY,
  cooldown_until TEXT,
  last_error     TEXT,
  reason         TEXT,
  failures       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_bugs_project ON bugs(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_id);
`);

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM providers').get().n;
  if (count > 0) return;

  const insProvider = db.prepare(
    'INSERT INTO providers (id, label, kind, base_url, key_env) VALUES (?, ?, ?, ?, ?)',
  );
  for (const p of PROVIDERS) {
    insProvider.run(p.id, p.label, p.kind, p.baseUrl, p.keyEnv ?? null);
  }

  const insModel = db.prepare(
    'INSERT INTO models (id, provider_id, model, label, ctx, price_in, price_out, tags, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  MODELS.forEach((m, i) => {
    insModel.run(m.id, m.provider, m.model, m.label, m.ctx, m.priceIn, m.priceOut, JSON.stringify(m.tags), i);
  });

  const insProfile = db.prepare(
    'INSERT INTO profiles (id, label, description, chain, system_prompt, sort) VALUES (?, ?, ?, ?, ?, ?)',
  );
  PROFILES.forEach((p, i) => {
    insProfile.run(p.id, p.label, p.description, JSON.stringify(p.chain), p.systemPrompt, i);
  });

  setSetting('budgets', {});
  setSetting('router', { maxAttempts: 6, requestTimeoutMs: 180000 });
  setSetting('google', {});

  const projectId = newId('prj');
  db.prepare(
    'INSERT INTO projects (id, name, slug, path, description, stack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    projectId,
    'teko',
    'teko',
    null,
    'Hub pessoal de IAs: roteamento, contexto de projetos, decisões, bugs e uso.',
    JSON.stringify(['Node 24', 'SQLite', 'Vanilla JS']),
    nowIso(),
  );
}

seed();

export function getModel(id) {
  const row = db.prepare('SELECT * FROM models WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, tags: safeJson(row.tags, []) };
}

export function getProvider(id) {
  return db.prepare('SELECT * FROM providers WHERE id = ?').get(id) ?? null;
}

export function listModels() {
  return db
    .prepare('SELECT * FROM models ORDER BY provider_id, sort, label')
    .all()
    .map((m) => ({ ...m, tags: safeJson(m.tags, []) }));
}

export function listProfiles() {
  return db
    .prepare('SELECT * FROM profiles ORDER BY sort, label')
    .all()
    .map((p) => ({ ...p, chain: safeJson(p.chain, []) }));
}

export function safeJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
