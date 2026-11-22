import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Raiz do monorepo: .env e data/ ficam lá, não dentro do pacote.
export const ROOT = process.env.TEKO_ROOT || path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const DATA_DIR = process.env.ORQ_DATA_DIR || path.join(ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

// Loader mínimo de .env (sem dependências).
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

export const PORT = Number(process.env.PORT || 4780);
export const HOST = process.env.HOST || '127.0.0.1';
export const DB_PATH = path.join(DATA_DIR, 'teko.db');
export const APP_VERSION = '0.3.0';

// Migra o banco da versão anterior (orquestrador.db) sem perder nada.
const legacyDb = path.join(DATA_DIR, 'orquestrador.db');
if (fs.existsSync(legacyDb) && !fs.existsSync(DB_PATH)) {
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(`${legacyDb}${suffix}`)) {
      fs.renameSync(`${legacyDb}${suffix}`, `${DB_PATH}${suffix}`);
    }
  }
}

export function env(name) {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}
