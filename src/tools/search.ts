import fs from 'node:fs';
import path from 'node:path';
import { resolveInside } from './fs.js';

const IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', 'coverage',
  '.venv', 'venv', '__pycache__', '.cache', '.turbo', 'target', 'vendor', 'data',
]);

const MAX_FILES = 4000;
const MAX_MATCHES = 60;
const MAX_BYTES = 1024 * 1024;

function globToRegex(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/§§/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export async function grep(args: any = {}, ctx) {
  const { pattern, path: sub = '.', glob = '', ignoreCase = true, max = MAX_MATCHES } = args;
  if (!pattern) throw new Error('informe o pattern (regex)');
  let regex;
  try {
    regex = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new Error(`regex inválida: ${err.message}`);
  }

  const base = resolveInside(ctx.root, sub);
  const globRegex = glob ? globToRegex(glob) : null;
  const matches = [];
  let scanned = 0;

  const walk = (dir) => {
    if (matches.length >= max || scanned >= MAX_FILES) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= max || scanned >= MAX_FILES) return;
      if (entry.name.startsWith('.') || IGNORE.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      const rel = path.relative(base, abs);
      if (globRegex && !globRegex.test(rel) && !globRegex.test(entry.name)) continue;
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_BYTES) continue;
      let buf;
      try {
        buf = fs.readFileSync(abs);
      } catch {
        continue;
      }
      if (buf.includes(0)) continue;
      scanned += 1;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (matches.length >= max) return;
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
        }
      }
    }
  };

  walk(base);

  return {
    ok: true,
    output: matches.length
      ? `${matches.length} resultado(s) para /${pattern}/:\n${matches.join('\n')}`
      : `nenhum resultado para /${pattern}/ em ${sub}`,
  };
}
