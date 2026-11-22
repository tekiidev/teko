// Skills: pastas com SKILL.md (frontmatter `name` e `description` + instruções em Markdown).
// Só o índice (nome + descrição) vai no system prompt; o corpo entra quando a skill é usada.
// Ficam em data/skills/, fora do git, porque costumam ter dados pessoais.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_CHARS = 40_000;

export type Skill = { name: string; description: string; body: string; chars: number };

export function isValidSkillName(name: unknown): name is string {
  return typeof name === 'string' && NAME_RE.test(name);
}

/** Lê o frontmatter simples (`chave: valor`, com ou sem aspas) e o corpo. */
export function parseSkill(markdown: string) {
  const text = String(markdown || '').replace(/^﻿/, '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta: Record<string, string> = {};
  let body = text;
  if (match) {
    body = match[2];
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!kv) continue;
      let value = kv[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      meta[kv[1]] = value;
    }
  }
  return { name: meta.name || '', description: meta.description || '', body: body.trim() };
}

function skillFile(name: string, dir = SKILLS_DIR) {
  return path.join(dir, name, 'SKILL.md');
}

export function getSkill(name: string, dir = SKILLS_DIR): Skill | null {
  if (!isValidSkillName(name)) return null;
  const file = skillFile(name, dir);
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parseSkill(raw);
  return { name, description: parsed.description, body: parsed.body, chars: raw.length };
}

export function listSkills(dir = SKILLS_DIR): Skill[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isValidSkillName(entry.name))
    .map((entry) => getSkill(entry.name, dir))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Índice estável (ordenado) pro system prompt. Vazio se não houver skills. */
export function skillIndex(skills = listSkills()) {
  if (!skills.length) return '';
  const lines = skills.map((s) => `- ${s.name}: ${s.description || '(sem descrição)'}`);
  return [
    '## Skills disponíveis',
    'Instruções especializadas, carregadas sob demanda. O usuário ativa com /nome no início da mensagem; quando houver ferramentas, use `use_skill` para carregar a skill certa antes de responder.',
    ...lines,
  ].join('\n');
}

/** `/vagas texto...` → { skill, rest }. Só reconhece skills que existem. */
export function parseSkillCommand(text: string, dir = SKILLS_DIR) {
  const match = String(text || '').match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+|$)([\s\S]*)$/);
  if (!match) return null;
  const skill = getSkill(match[1], dir);
  return skill ? { skill, rest: match[2].trim() } : null;
}

export function renderSkill(skill: Skill) {
  return `<skill nome="${skill.name}">\n${skill.body}\n</skill>`;
}

export function saveSkill(name: string, markdown: string, dir = SKILLS_DIR) {
  if (!isValidSkillName(name)) throw new Error('nome de skill inválido (use letras minúsculas, números e hífen)');
  if (String(markdown).length > MAX_SKILL_CHARS) throw new Error(`skill grande demais (máx. ${MAX_SKILL_CHARS} caracteres)`);
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(skillFile(name, dir), markdown, { mode: 0o600 });
  return getSkill(name, dir);
}

export function deleteSkill(name: string, dir = SKILLS_DIR) {
  if (!isValidSkillName(name)) return false;
  const folder = path.join(dir, name);
  if (!fs.existsSync(folder)) return false;
  fs.rmSync(folder, { recursive: true, force: true });
  return true;
}

export const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/** Procura SKILL.md em outra pasta (padrão: ~/.claude/skills), até 4 níveis. */
export function findImportable(root = CLAUDE_SKILLS_DIR) {
  const found = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === 'SKILL.md') {
        const parsed = parseSkill(fs.readFileSync(full, 'utf8'));
        const name = (parsed.name || path.basename(dir)).toLowerCase();
        if (isValidSkillName(name)) found.push({ name, description: parsed.description, source: full });
      }
    }
  };
  walk(root, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** Copia as skills escolhidas (por nome) da pasta de origem para data/skills/. */
export function importSkills(names: string[], root = CLAUDE_SKILLS_DIR, dir = SKILLS_DIR) {
  const wanted = new Set(names);
  const imported = [];
  for (const item of findImportable(root)) {
    if (!wanted.has(item.name)) continue;
    saveSkill(item.name, fs.readFileSync(item.source, 'utf8'), dir);
    imported.push(item.name);
  }
  return imported;
}
