import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { db, getSetting, safeJson } from './db.js';
import { renderSkill, skillIndex, type Skill } from './skills.js';

// Keep durable context small; details are retrieved from FTS5 for each prompt.
const MAX_CONTEXT_CHARS = 12000;

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
    const shown = files.slice(0, 100);
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
        ORDER BY created_at DESC LIMIT 5`,
    )
    .all(projectId);
  if (decisions.length) {
    parts.push(
      '## Decisões registradas\n' +
        decisions
          .map(
            (d) =>
              `- [${d.status}] ${d.title}: ${clip(d.decision, 260)}` +
              (d.consequences ? ` (consequências: ${clip(d.consequences, 120)})` : ''),
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
        LIMIT 4`,
    )
    .all(projectId);
  if (bugs.length) {
    parts.push(
      '## Bugs abertos\n' +
        bugs
          .map((b) => `- [${b.severity}/${b.status}] ${b.title}${b.area ? ` (${b.area})` : ''}: ${clip(b.actual, 160)}`)
          .join('\n'),
    );
  }

  const tree = repoTree(project.path);
  if (tree) {
    parts.push(`## Arquivos do repositório (git ls-files)\n${tree}`);
  }

  return parts.join('\n\n');
}

/**
 * System prompt ESTÁVEL: perfil, preferências e contexto do projeto.
 * Não pode ter nada que mude a cada mensagem (hora, trechos da busca), senão
 * o prompt caching dos providers nunca acerta. O que é volátil vai em buildTurnContext.
 */
export function buildSystemPrompt({ projectId = null, profileId = 'code' }: { projectId?: string | null; profileId?: string } = {}) {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  const chunks = [];

  if (profile?.system_prompt) chunks.push(profile.system_prompt);

  const globalNotes = getSetting('globalNotes', '');
  if (globalNotes) chunks.push(`## Preferências permanentes\n${clip(globalNotes, 2000)}`);

  if (projectId) {
    const ctx = projectContext(projectId);
    if (ctx) chunks.push(ctx);
  }

  const skills = skillIndex();
  if (skills) chunks.push(skills);

  chunks.push(`## Sessão\nPerfil de tarefa: ${profile?.label || profileId}`);

  let text = chunks.join('\n\n');
  if (text.length > MAX_CONTEXT_CHARS) {
    text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[contexto truncado]`;
  }
  return text;
}

/** Contexto volátil da mensagem atual: data e trechos recuperados pela busca. */
export function buildTurnContext({
  retrieved = '',
  skill = null,
  now = new Date(),
}: { retrieved?: string; skill?: Skill | null; now?: Date } = {}) {
  const chunks = [`Data de hoje: ${now.toLocaleDateString('pt-BR')}`];
  if (skill) chunks.push(`O usuário ativou a skill /${skill.name}. Siga estas instruções nesta resposta:\n${renderSkill(skill)}`);
  if (retrieved) chunks.push(retrieved);
  return `<contexto_da_mensagem>\n${chunks.join('\n\n')}\n</contexto_da_mensagem>`;
}

/** Junta o contexto volátil à mensagem do usuário (só no que vai pro modelo, não no banco). */
export function withTurnContext(text: string, turnContext: string) {
  return turnContext ? `${turnContext}\n\n${text}` : text;
}
