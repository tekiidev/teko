import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { db, getSetting, safeJson } from './db.js';

const MAX_CONTEXT_CHARS = 14000;

function clip(text, n) {
  if (!text) return '';
  const s = String(text).trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function repoTree(projectPath) {
  if (!projectPath) return null;
  try {
    if (!fs.statSync(projectPath).isDirectory()) return null;
  } catch {
    return null;
  }
  try {
    const out = execFileSync('git', ['-C', projectPath, 'ls-files'], {
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const files = out.split('\n').filter(Boolean);
    if (!files.length) return null;
    const shown = files.slice(0, 250);
    return `${shown.join('\n')}${files.length > shown.length ? `\n… (+${files.length - shown.length} arquivos)` : ''}`;
  } catch {
    return null;
  }
}

export function projectContext(projectId) {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) return '';

  const parts = [];
  const stack = safeJson(project.stack, []);

  parts.push(
    [
      '## Projeto atual',
      `Nome: ${project.name}`,
      project.description ? `Descrição: ${project.description}` : null,
      stack.length ? `Stack: ${stack.join(', ')}` : null,
      project.path ? `Caminho local: ${project.path}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const decisions = db
    .prepare(
      `SELECT title, status, decision, consequences FROM decisions
        WHERE project_id = ? AND status != 'descartada'
        ORDER BY created_at DESC LIMIT 8`,
    )
    .all(projectId);
  if (decisions.length) {
    parts.push(
      '## Decisões registradas\n' +
        decisions
          .map(
            (d) =>
              `- [${d.status}] ${d.title}: ${clip(d.decision, 400)}` +
              (d.consequences ? ` (consequências: ${clip(d.consequences, 200)})` : ''),
          )
          .join('\n'),
    );
  }

  const bugs = db
    .prepare(
      `SELECT title, severity, status, area, actual FROM bugs
        WHERE project_id = ? AND status != 'resolvido'
        ORDER BY CASE severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
                 created_at DESC
        LIMIT 8`,
    )
    .all(projectId);
  if (bugs.length) {
    parts.push(
      '## Bugs abertos\n' +
        bugs
          .map((b) => `- [${b.severity}/${b.status}] ${b.title}${b.area ? ` (${b.area})` : ''}: ${clip(b.actual, 240)}`)
          .join('\n'),
    );
  }

  const docs = db
    .prepare(
      `SELECT kind, title, content FROM memory
        WHERE project_id = ? ORDER BY created_at DESC LIMIT 10`,
    )
    .all(projectId);
  if (docs.length) {
    parts.push(
      '## Memória e documentos\n' +
        docs
          .map((m) => `### ${m.title || m.kind}\n${clip(m.content, 1200)}`)
          .join('\n\n'),
    );
  }

  const tree = repoTree(project.path);
  if (tree) {
    parts.push(`## Arquivos do repositório (git ls-files)\n${tree}`);
  }

  const summaries = db
    .prepare(
      `SELECT title, summary FROM sessions
        WHERE project_id = ? AND summary IS NOT NULL AND summary != ''
        ORDER BY updated_at DESC LIMIT 3`,
    )
    .all(projectId);
  if (summaries.length) {
    parts.push(
      '## Resumos de conversas anteriores\n' +
        summaries.map((s) => `### ${s.title}\n${clip(s.summary, 900)}`).join('\n\n'),
    );
  }

  return parts.join('\n\n');
}

export function buildSystemPrompt({ projectId = null, profileId = 'code' } = {}) {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  const chunks = [];

  if (profile?.system_prompt) chunks.push(profile.system_prompt);

  const globalNotes = getSetting('globalNotes', '');
  if (globalNotes) chunks.push(`## Preferências permanentes\n${clip(globalNotes, 2000)}`);

  if (projectId) {
    const ctx = projectContext(projectId);
    if (ctx) chunks.push(ctx);
  }

  chunks.push(
    `## Sessão\nData: ${new Date().toLocaleString('pt-BR')}\nPerfil de tarefa: ${profile?.label || profileId}`,
  );

  let text = chunks.join('\n\n');
  if (text.length > MAX_CONTEXT_CHARS) {
    text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[contexto truncado]`;
  }
  return text;
}
