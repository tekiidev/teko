import fs from 'node:fs';
import path from 'node:path';
import { db, newId, nowIso } from '@teko/ai/db';

const root = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('Uso: npm run discover:projects -- <pasta-raiz>');
  process.exit(1);
}

function slugify(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'projeto';
}

function readDescription(dir: string) {
  const readme = ['README.md', 'README'].map((file) => path.join(dir, file)).find(fs.existsSync);
  if (!readme) return null;
  const line = fs.readFileSync(readme, 'utf8').split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry && !entry.startsWith('#') && !entry.startsWith('['));
  return line ? line.slice(0, 500) : null;
}

const insert = db.prepare(
  'INSERT INTO projects (id, name, slug, path, description, stack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
);
const added = [];
const skipped = [];

for (const entry of fs.readdirSync(root, { withFileTypes: true }).filter((item) => item.isDirectory() && !item.name.startsWith('.'))) {
  const dir = path.join(root, entry.name);
  if (!fs.existsSync(path.join(dir, '.git'))) continue;

  const existing = db.prepare('SELECT id FROM projects WHERE path = ?').get(dir);
  if (existing) {
    skipped.push(entry.name);
    continue;
  }

  const base = slugify(entry.name);
  let slug = base;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) slug = `${base}-${suffix++}`;

  const id = newId('prj');
  insert.run(id, entry.name, slug, dir, readDescription(dir), JSON.stringify([]), nowIso());
  added.push({ name: entry.name, slug, path: dir });
}

console.log(JSON.stringify({ added, skipped }, null, 2));
