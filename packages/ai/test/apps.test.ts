import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acharApp, normalizar } from '../src/tools/apps.ts';
import { wantsSystemTools } from '../src/chat.ts';
import { toolDefs, executeTool } from '../src/tools/index.ts';

const apps = [
  { name: 'Spotify', target: '/Applications/Spotify.app' },
  { name: 'Visual Studio Code', target: '/Applications/Visual Studio Code.app' },
  { name: 'Google Chrome', target: '/Applications/Google Chrome.app' },
  { name: 'Calculator', target: '/System/Applications/Calculator.app' },
];

test('acha app por nome aproximado e apelido', () => {
  assert.equal(acharApp('spotify', apps).app?.name, 'Spotify');
  assert.equal(acharApp('Spotify.app', apps).app?.name, 'Spotify');
  assert.equal(acharApp('vscode', apps).app?.name, 'Visual Studio Code');
  assert.equal(acharApp('chrome', apps).app?.name, 'Google Chrome');
  assert.equal(acharApp('calculadora', apps).app?.name, 'Calculator');
  assert.equal(normalizar('Calendário'), 'calendario');
});

test('app inexistente devolve sugestões, sem abrir nada', () => {
  const r = acharApp('spotfy music', apps);
  assert.equal(r.app, null);
  assert.ok(r.sugestoes.includes('Spotify'));
});

test('ferramentas do sistema só quando pedem pra abrir algo, ou na voz', () => {
  assert.equal(wantsSystemTools('abre o spotify', 'code'), true);
  assert.equal(wantsSystemTools('o que é uma closure?', 'code'), false);
  assert.equal(wantsSystemTools('qualquer coisa', 'voice'), true);
  assert.deepEqual(toolDefs({ systemOnly: true }).map((t) => t.name), ['open_app']);
});

test('sem projeto, ferramentas de arquivo são recusadas', async () => {
  const r = await executeTool('write_file', { path: 'x', content: 'y' }, { root: null });
  assert.equal(r.ok, false);
  assert.match(r.output, /projeto ativo/);
});
