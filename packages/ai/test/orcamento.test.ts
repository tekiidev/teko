import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toolDefs, toolsForModel, tokensDasFerramentas } from '../src/tools/index.ts';

test('sem skills instaladas, use_skill não vai pro modelo', () => {
  // O teste roda com TEKO_ROOT vazio: nenhuma skill.
  assert.equal(toolDefs().some((t) => t.name === 'use_skill'), false);
});

test('modelo local recebe só o básico e gasta menos tokens', () => {
  const todas = toolDefs();
  const local = toolsForModel(todas, ['code', 'offline']);
  assert.ok(local.length < todas.length);
  assert.equal(local.some((t) => t.name === 'run_command'), false);
  assert.ok(local.some((t) => t.name === 'read_file'));
  assert.ok(tokensDasFerramentas(local) < tokensDasFerramentas(todas));
  // Modelo de API não perde nada.
  assert.equal(toolsForModel(todas, ['code']).length, todas.length);
});

test('ferramenta já usada na conversa continua mesmo no modelo local', () => {
  const local = toolsForModel(toolDefs(), ['offline'], new Set(['run_command']));
  assert.ok(local.some((t) => t.name === 'run_command'));
});
