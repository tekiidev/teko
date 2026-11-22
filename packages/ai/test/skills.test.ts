import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteSkill, findImportable, getSkill, importSkills, isValidSkillName, listSkills,
  parseSkill, parseSkillCommand, saveSkill, skillIndex,
} from '../src/skills.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'teko-skills-'));
const md = (name, description, body = 'Faça X.') => `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`;

test('parseSkill lê frontmatter com e sem aspas', () => {
  assert.deepEqual(parseSkill(md('vagas', 'Analisa vagas')), { name: 'vagas', description: 'Analisa vagas', body: 'Faça X.' });
  assert.equal(parseSkill('---\nname: a\ndescription: b c\n---\ncorpo').description, 'b c');
  assert.equal(parseSkill('sem frontmatter').body, 'sem frontmatter');
});

test('nomes inválidos são recusados (sem path traversal)', () => {
  for (const bad of ['../x', 'A', 'x/y', '', '.oculta', 'a'.repeat(70)]) assert.equal(isValidSkillName(bad), false, bad);
  const dir = tmp();
  assert.throws(() => saveSkill('../fora', 'x', dir));
  assert.equal(getSkill('../fora', dir), null);
  assert.equal(deleteSkill('..', dir), false);
});

test('salvar, listar em ordem, ler e apagar', () => {
  const dir = tmp();
  saveSkill('roteiro', md('roteiro', 'Pauta'), dir);
  saveSkill('vagas', md('vagas', 'Analisa vagas', 'Responda em tópicos.'), dir);
  assert.deepEqual(listSkills(dir).map((s) => s.name), ['roteiro', 'vagas']);
  assert.equal(getSkill('vagas', dir).body, 'Responda em tópicos.');
  assert.ok(deleteSkill('roteiro', dir));
  assert.deepEqual(listSkills(dir).map((s) => s.name), ['vagas']);
});

test('índice só tem nome e descrição e é estável', () => {
  const dir = tmp();
  saveSkill('vagas', md('vagas', 'Analisa vagas', 'CORPO SECRETO'.repeat(50)), dir);
  const index = skillIndex(listSkills(dir));
  assert.match(index, /- vagas: Analisa vagas/);
  assert.doesNotMatch(index, /CORPO SECRETO/);
  assert.equal(index, skillIndex(listSkills(dir)));
  assert.equal(skillIndex([]), '');
});

test('/nome ativa só skills que existem', () => {
  const dir = tmp();
  saveSkill('vagas', md('vagas', 'Analisa vagas'), dir);
  const cmd = parseSkillCommand('/vagas Dev Frontend Pleno na Nubank', dir);
  assert.equal(cmd.skill.name, 'vagas');
  assert.equal(cmd.rest, 'Dev Frontend Pleno na Nubank');
  assert.equal(parseSkillCommand('/naoexiste oi', dir), null);
  assert.equal(parseSkillCommand('texto normal /vagas', dir), null);
});

test('importa de outra pasta só os nomes escolhidos', () => {
  const source = tmp();
  const dest = tmp();
  for (const name of ['vagas', 'docx']) {
    fs.mkdirSync(path.join(source, 'sync', name), { recursive: true });
    fs.writeFileSync(path.join(source, 'sync', name, 'SKILL.md'), md(name, `skill ${name}`));
  }
  assert.deepEqual(findImportable(source).map((s) => s.name), ['docx', 'vagas']);
  assert.deepEqual(importSkills(['vagas'], source, dest), ['vagas']);
  assert.deepEqual(listSkills(dest).map((s) => s.name), ['vagas']);
});
