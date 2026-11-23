import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, newId, nowIso } from './db.js';

/**
 * Desfazer: antes de a IA escrever um arquivo, guarda como ele estava.
 * Desfazer volta o conteúdo (ou apaga o arquivo, se ele não existia), mas só se o arquivo
 * ainda estiver do jeito que a IA deixou: se você mexeu depois, ele não passa por cima.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS undo_log (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  root        TEXT NOT NULL,
  path        TEXT NOT NULL,
  existed     INTEGER NOT NULL,
  before      TEXT,
  after_hash  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_undo_session ON undo_log(session_id, created_at);
`);

const MAX_GUARDADO = 2 * 1024 * 1024;
const hash = (texto: string) => crypto.createHash('sha256').update(texto).digest('hex');

/** Chame antes de escrever. Devolve uma função pra chamar depois de escrever (grava o resultado). */
export function guardarAntes({ sessionId = null, root, abs }: { sessionId?: string | null; root: string; abs: string }) {
  const existed = fs.existsSync(abs);
  let before: string | null = null;
  if (existed) {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_GUARDADO) return () => {}; // grande demais pra guardar: sem desfazer
    before = fs.readFileSync(abs, 'utf8');
  }
  const id = newId('undo');
  const rel = path.relative(root, abs);
  db.prepare('INSERT INTO undo_log (id, session_id, root, path, existed, before, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, sessionId, root, rel, existed ? 1 : 0, before, nowIso());
  return (depois: string) => db.prepare('UPDATE undo_log SET after_hash = ? WHERE id = ?').run(hash(depois), id);
}

function ultimas(sessionId: string | null, root: string, n: number) {
  const limite = Math.min(Math.max(Number(n) || 1, 1), 20);
  return sessionId
    ? db.prepare('SELECT * FROM undo_log WHERE session_id = ? AND root = ? AND after_hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?').all(sessionId, root, limite)
    : db.prepare('SELECT * FROM undo_log WHERE root = ? AND after_hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?').all(root, limite);
}

/** O que seria desfeito (pra mostrar antes de pedir aprovação). */
export function previaDesfazer({ sessionId = null, root, n = 1 }) {
  if (!root) return [];
  return ultimas(sessionId, root, n).map((r) => `${r.existed ? 'voltar' : 'apagar'} ${r.path}`);
}

export function desfazer({ sessionId = null, root, n = 1 }) {
  if (!root) return { ok: false, output: 'desfazer precisa de um projeto ativo' };
  const linhas = ultimas(sessionId, root, n);
  if (!linhas.length) return { ok: false, output: 'nada pra desfazer nesta conversa' };
  const feitos: string[] = [];
  const pulados: string[] = [];
  for (const r of linhas) {
    const abs = path.resolve(root, r.path);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { pulados.push(`${r.path} (fora do projeto)`); continue; }
    const atual = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (atual === null || hash(atual) !== r.after_hash) {
      pulados.push(`${r.path} (mudou depois da IA; não mexi)`);
      continue;
    }
    if (r.existed) fs.writeFileSync(abs, r.before ?? '', 'utf8');
    else fs.rmSync(abs);
    db.prepare('DELETE FROM undo_log WHERE id = ?').run(r.id);
    feitos.push(`${r.existed ? 'voltei' : 'apaguei'} ${r.path}`);
  }
  const partes = [];
  if (feitos.length) partes.push(feitos.join('\n'));
  if (pulados.length) partes.push(`não desfeito:\n${pulados.join('\n')}`);
  return { ok: feitos.length > 0, output: partes.join('\n\n') };
}
