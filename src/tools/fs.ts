import fs from 'node:fs';
import path from 'node:path';

const IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', 'vendor', 'data',
]);

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_READ_CHARS = 40_000;
const MAX_LIST = 400;

export function resolveInside(root, target = '.') {
  if (!root) throw new Error('projeto sem caminho local configurado');
  let relTarget = String(target ?? '').trim();
  if (!relTarget || relTarget === '/') relTarget = '.';

  let abs;
  if (path.isAbsolute(relTarget)) {
    // Caminho absoluto dentro do projeto é aceito; fora dele, tentamos como relativo.
    const relFromRoot = path.relative(root, relTarget);
    abs = !relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)
      ? path.resolve(relTarget)
      : path.resolve(root, relTarget.replace(/^\/+/, ''));
  } else {
    abs = path.resolve(root, relTarget);
  }

  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('caminho fora do projeto (bloqueado)');
  }
  return abs;
}

function readTextFile(abs, rel) {
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`${rel} é um diretório; use list_files`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`${rel} é grande demais (${stat.size} bytes)`);
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new Error(`${rel} parece binário`);
  return buf.toString('utf8');
}

export async function listFiles({ path: sub = '.', depth = 3 } = {}, ctx) {
  const base = resolveInside(ctx.root, sub);
  const maxDepth = Math.min(Math.max(Number(depth) || 3, 1), 6);
  const out = [];

  const walk = (dir, level) => {
    if (level > maxDepth || out.length >= MAX_LIST) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= MAX_LIST) return;
      if (entry.name.startsWith('.') || IGNORE.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs, level + 1);
      } else {
        out.push(rel);
      }
    }
  };

  walk(base, 1);
  const header = `arquivos em ${sub} (profundidade ${maxDepth})`;
  return {
    ok: true,
    output: out.length ? `${header}\n${out.join('\n')}${out.length >= MAX_LIST ? '\n[lista truncada]' : ''}` : `${header}\n(vazio)`,
  };
}

export async function readFile({ path: target, start, end } = {}, ctx) {
  if (!target) throw new Error('informe o path do arquivo');
  const abs = resolveInside(ctx.root, target);
  const text = readTextFile(abs, target);
  const lines = text.split('\n');
  const from = Math.max(1, Number(start) || 1);
  const to = Math.min(lines.length, Number(end) || Math.min(lines.length, from + 399));
  const slice = lines.slice(from - 1, to);
  let body = slice.map((line, i) => `${String(from + i).padStart(4)}| ${line}`).join('\n');
  if (body.length > MAX_READ_CHARS) body = `${body.slice(0, MAX_READ_CHARS)}\n[leitura truncada]`;
  return { ok: true, output: `${target} (linhas ${from}-${to} de ${lines.length})\n${body}` };
}

export async function writeFile({ path: target, content = '' } = {}, ctx) {
  if (!target) throw new Error('informe o path do arquivo');
  const abs = resolveInside(ctx.root, target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content), 'utf8');
  return { ok: true, output: `escrito ${Buffer.byteLength(String(content))} bytes em ${target}` };
}

export async function editFile({ path: target, old: from = '', new: to = '', all = false } = {}, ctx) {
  if (!target) throw new Error('informe o path do arquivo');
  if (!from) throw new Error('informe o trecho antigo (old)');
  const abs = resolveInside(ctx.root, target);
  const text = readTextFile(abs, target);
  const occurrences = text.split(from).length - 1;
  if (occurrences === 0) throw new Error('trecho antigo não encontrado no arquivo');
  if (occurrences > 1 && !all) {
    throw new Error(`trecho aparece ${occurrences} vezes; inclua mais contexto ou passe all:true`);
  }
  const next = all ? text.split(from).join(to) : text.replace(from, to);
  fs.writeFileSync(abs, next, 'utf8');
  return { ok: true, output: `editado ${target} (${occurrences} ocorrência(s))` };
}
