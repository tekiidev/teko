// Importa skills de ~/.claude/skills (ou de outra pasta) para data/skills/.
// Uso: npm run skills:import                → lista o que dá pra importar
//      npm run skills:import -- vagas outra  → importa essas
//      npm run skills:import -- --from <pasta> nome
import { CLAUDE_SKILLS_DIR, findImportable, importSkills, SKILLS_DIR } from '../src/skills.js';

const args = process.argv.slice(2);
const fromIndex = args.indexOf('--from');
const root = fromIndex >= 0 ? args[fromIndex + 1] : CLAUDE_SKILLS_DIR;
const names = args.filter((arg, i) => arg !== '--from' && i !== fromIndex + 1);

if (!names.length) {
  const found = findImportable(root);
  if (!found.length) {
    console.log(`Nenhuma skill encontrada em ${root}`);
  } else {
    console.log(`Skills em ${root}:\n`);
    for (const item of found) console.log(`  ${item.name.padEnd(28)} ${item.description.slice(0, 90)}`);
    console.log('\nImporte com: npm run skills:import -- <nome> [outro-nome]');
  }
} else {
  const imported = importSkills(names, root);
  const missing = names.filter((name) => !imported.includes(name));
  if (imported.length) console.log(`Importadas para ${SKILLS_DIR}: ${imported.join(', ')}`);
  if (missing.length) console.log(`Não encontradas: ${missing.join(', ')}`);
}
