import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso } from './db.js';
import { arquivoSecreto } from './privacy.js';

// Índice local de busca (FTS5 do SQLite, zero dependências).
// Indexa código, docs, memória, decisões e bugs de cada projeto.

const IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', 'vendor', 'data',
  '.idea', '.vscode',
]);

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 3000;
const MAX_CHUNKS = 6000;
const CHUNK_LINES = 45;
const OVERLAP_LINES = 8;

let ftsReady = false;

function ensureFts() {
  if (ftsReady) return;
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      title, content, path,
      project_id UNINDEXED,
      kind UNINDEXED,
      ref UNINDEXED,
      start_line UNINDEXED,
      end_line UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE TABLE IF NOT EXISTS search_meta (
      project_id TEXT PRIMARY KEY,
      indexed_at TEXT,
      files      INTEGER NOT NULL DEFAULT 0,
      chunks     INTEGER NOT NULL DEFAULT 0,
      chars      INTEGER NOT NULL DEFAULT 0,
      error      TEXT
    );
  `);
  ftsReady = true;
}

function isText(buf) {
  if (buf.includes(0)) return false;
  // Heurística: muitos bytes de controle indicam binário.
  let control = 0;
  const sample = buf.subarray(0, 4096);
  for (const byte of sample) {
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / Math.max(sample.length, 1) < 0.02;
}

function walkFiles(root, limit) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name.startsWith('.') || IGNORE.has(entry.name) || arquivoSecreto(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) continue;
      out.push({ abs, rel: path.relative(root, abs), size: stat.size });
    }
  };
  walk(root);
  return out;
}

function chunksFor(text) {
  const lines = text.split('\n');
  const chunks = [];
  if (lines.length <= CHUNK_LINES) {
    return [{ start: 1, end: lines.length, content: text }];
  }
  let start = 0;
  while (start < lines.length) {
    const end = Math.min(start + CHUNK_LINES, lines.length);
    const content = lines.slice(start, end).join('\n');
    if (content.trim()) chunks.push({ start: start + 1, end, content });
    if (end >= lines.length) break;
    start = end - OVERLAP_LINES;
  }
  return chunks;
}

function docsFromDb(projectId) {
  const docs = [];

  for (const row of db
    .prepare('SELECT id, kind, title, content, source FROM memory WHERE project_id = ?')
    .all(projectId)) {
    docs.push({
      kind: `memoria:${row.kind}`,
      ref: row.id,
      title: row.title || row.kind,
      path: row.source || null,
      content: row.content,
    });
  }

  for (const row of db
    .prepare('SELECT id, title, context, decision, consequences, status FROM decisions WHERE project_id = ?')
    .all(projectId)) {
    docs.push({
      kind: 'decisao',
      ref: row.id,
      title: `Decisão: ${row.title} [${row.status}]`,
      content: [row.context, row.decision, row.consequences].filter(Boolean).join('\n'),
    });
  }

  for (const row of db
    .prepare('SELECT id, title, severity, status, area, repro, expected, actual, logs FROM bugs WHERE project_id = ?')
    .all(projectId)) {
    docs.push({
      kind: 'bug',
      ref: row.id,
      title: `Bug: ${row.title} [${row.severity}/${row.status}]`,
      content: [
        row.area ? `Área: ${row.area}` : null,
        row.expected ? `Esperado: ${row.expected}` : null,
        row.actual ? `Atual: ${row.actual}` : null,
        row.repro ? `Reprodução: ${row.repro}` : null,
        row.logs ? `Logs: ${row.logs}` : null,
      ].filter(Boolean).join('\n'),
    });
  }

  return docs;
}

/** Reindexa um projeto inteiro. Retorna estatísticas. */
export function indexProject(projectId) {
  ensureFts();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('projeto não encontrado');

  let files = [];
  if (project.path) {
    try {
      const stat = fs.statSync(project.path);
      if (stat.isDirectory()) {
        files = walkFiles(project.path, MAX_FILES);
      }
    } catch {
      // Caminho inexistente ou inacessível: segue indexando os docs do banco
    }
  }

  const started = Date.now();
  let chunks = 0;
  let chars = 0;

  const del = db.prepare('DELETE FROM search_fts WHERE project_id = ?');
  const ins = db.prepare(
    `INSERT INTO search_fts (title, content, path, project_id, kind, ref, start_line, end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    del.run(projectId);

    for (const file of files) {
      if (chunks >= MAX_CHUNKS) break;
      let buf;
      try {
        buf = fs.readFileSync(file.abs);
      } catch {
        continue;
      }
      if (!isText(buf)) continue;
      const text = buf.toString('utf8');
      if (!text.trim()) continue;

      for (const chunk of chunksFor(text)) {
        if (chunks >= MAX_CHUNKS) break;
        ins.run(file.rel, chunk.content, file.rel, projectId, 'arquivo', file.rel, chunk.start, chunk.end);
        chunks += 1;
        chars += chunk.content.length;
      }
    }

    const dbDocs = docsFromDb(projectId);
    for (const doc of dbDocs) {
      if (chunks >= MAX_CHUNKS) break;
      for (const chunk of chunksFor(doc.content || '')) {
        if (chunks >= MAX_CHUNKS) break;
        ins.run(doc.title, chunk.content, doc.path ?? null, projectId, doc.kind, doc.ref, chunk.start, chunk.end);
        chunks += 1;
        chars += chunk.content.length;
      }
    }

    db.prepare(
      `INSERT INTO search_meta (project_id, indexed_at, files, chunks, chars, error)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(project_id) DO UPDATE SET
         indexed_at = excluded.indexed_at,
         files = excluded.files,
         chunks = excluded.chunks,
         chars = excluded.chars,
         error = NULL`,
    ).run(projectId, nowIso(), files.length, chunks, chars);

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    db.prepare(
      `INSERT INTO search_meta (project_id, indexed_at, files, chunks, chars, error)
       VALUES (?, ?, 0, 0, 0, ?)
       ON CONFLICT(project_id) DO UPDATE SET indexed_at = excluded.indexed_at, error = excluded.error`,
    ).run(projectId, nowIso(), String(err.message || err));
    throw err;
  }

  return {
    ok: true,
    projectId,
    files: files.length,
    chunks,
    chars,
    ms: Date.now() - started,
    indexedAt: nowIso(),
  };
}

export function indexStatus(projectId) {
  ensureFts();
  const meta = db.prepare('SELECT * FROM search_meta WHERE project_id = ?').get(projectId);
  const project = db.prepare('SELECT id, name, path FROM projects WHERE id = ?').get(projectId);
  return {
    projectId,
    project: project?.name || null,
    path: project?.path || null,
    indexed: Boolean(meta?.indexed_at && !meta.error),
    ...(meta || {}),
  };
}

function ftsQuery(text) {
  const terms = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2)
    .slice(0, 12);
  const unique = [...new Set(terms)];
  if (!unique.length) return null;
  const quoted = unique.map((t) => `"${t.replace(/"/g, '""')}"*`);
  return { and: quoted.join(' AND '), or: quoted.join(' OR '), terms: unique };
}

/**
 * Busca no índice. Sem projectId, busca em todos os projetos.
 * Retorna trechos ordenados por relevância (BM25).
 */
export function search(text, { projectId = null, kind = null, limit = 10 } = {}) {
  ensureFts();
  const q = ftsQuery(text);
  if (!q) return { query: text, results: [], total: 0, terms: [] };

  const capped = Math.min(Math.max(Number(limit) || 10, 1), 40);
  const filters = ['search_fts MATCH ?'];
  const params = [];

  if (projectId) {
    filters.push('project_id = ?');
  }
  if (kind) {
    filters.push('kind LIKE ?');
  }

  const run = (match) => {
    const args = [match];
    if (projectId) args.push(projectId);
    if (kind) args.push(`${kind}%`);
    args.push(capped);
    return db
      .prepare(
        `SELECT project_id, kind, ref, path, title, start_line, end_line,
                snippet(search_fts, 1, '<<', '>>', ' … ', 18) AS snippet,
                bm25(search_fts, 2.0, 1.0, 1.5) AS score
           FROM search_fts
          WHERE ${filters.join(' AND ')}
          ORDER BY score ASC
          LIMIT ?`,
      )
      .all(...args);
  };

  let rows = run(q.and);
  if (!rows.length && q.terms.length > 1) rows = run(q.or);

  const projects = new Map(
    db.prepare('SELECT id, name FROM projects').all().map((p) => [p.id, p.name]),
  );

  const deduped = [];
  for (const row of rows) {
    const prev = deduped[deduped.length - 1];
    const sameFile =
      prev &&
      prev.project_id === row.project_id &&
      prev.path === row.path &&
      row.start_line != null &&
      prev.start_line != null &&
      Math.abs(prev.start_line - row.start_line) < CHUNK_LINES;
    if (sameFile) continue;
    deduped.push(row);
  }

  return {
    query: text,
    terms: q.terms,
    total: deduped.length,
    results: deduped.map((row) => ({
      projectId: row.project_id,
      project: projects.get(row.project_id) || null,
      kind: row.kind,
      ref: row.ref,
      path: row.path,
      title: row.title,
      startLine: row.start_line,
      endLine: row.end_line,
      snippet: row.snippet,
      score: Number(row.score?.toFixed?.(4) ?? row.score),
    })),
  };
}

/** Bloco de contexto pra injetar no system prompt. */
export function searchForPrompt(projectId, text, { limit = 5, maxChars = 6000 } = {}) {
  const out = search(text, { projectId, limit });
  if (!out.results.length) return '';

  const parts = ['## Trechos relevantes (busca local no projeto)'];
  let used = 0;
  for (const hit of out.results) {
    const loc = hit.path
      ? `${hit.path}${hit.startLine ? `:${hit.startLine}-${hit.endLine}` : ''}`
      : hit.kind;
    const body = String(hit.snippet || '').replace(/<</g, '').replace(/>>/g, '').trim();
    const block = `### ${loc} — ${hit.title || hit.kind}\n${body}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }
  return parts.length > 1 ? parts.join('\n\n') : '';
}

export function ensureIndex(projectId) {
  ensureFts();
  const meta = db.prepare('SELECT indexed_at, error FROM search_meta WHERE project_id = ?').get(projectId);
  if (meta?.indexed_at && !meta.error) return { skipped: true };
  return indexProject(projectId);
}

export function clearIndex(projectId) {
  ensureFts();
  db.prepare('DELETE FROM search_fts WHERE project_id = ?').run(projectId);
  db.prepare('DELETE FROM search_meta WHERE project_id = ?').run(projectId);
}
