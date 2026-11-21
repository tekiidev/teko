import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../src/config.js';

if (!process.argv.includes('--yes')) {
  console.log('Isso apaga o banco local (projetos, bugs, uso, chaves).');
  console.log('Rode: npm run reset -- --yes');
  process.exit(1);
}

for (const file of fs.readdirSync(DATA_DIR)) {
  if (file.startsWith('teko.db') || file.startsWith('orquestrador.db')) {
    fs.rmSync(path.join(DATA_DIR, file), { force: true });
  }
}
console.log('Banco removido. O próximo start recria tudo do zero.');
