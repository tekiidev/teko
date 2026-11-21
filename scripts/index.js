import { db } from '../src/db.js';
import { indexProject } from '../src/search-index.js';

const arg = process.argv[2];
const projects = arg
  ? db.prepare('SELECT id, name, path FROM projects WHERE id = ? OR name = ?').all(arg, arg)
  : db.prepare('SELECT id, name, path FROM projects WHERE path IS NOT NULL').all();

if (!projects.length) {
  console.log('Nenhum projeto com caminho local. Configure na aba Projetos.');
  process.exit(0);
}

for (const project of projects) {
  try {
    const out = indexProject(project.id);
    console.log(`${project.name}: ${out.files} arquivos, ${out.chunks} trechos (${out.ms} ms)`);
  } catch (err) {
    console.log(`${project.name}: falhou — ${err.message}`);
  }
}
