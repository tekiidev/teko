import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comandoLocal, comandoComChamadoParecido, pareceTeko } from './comandos.js';

const acao = (t) => comandoLocal(t)?.acao ?? null;

test('abrir o mapa', () => {
  for (const t of ['Teko, abrir mapa neural.', 'abre o mapa', 'Mostra o mapa neural', 'mapa neural', 'Teco, abrir o mapa']) {
    assert.equal(acao(t), 'mapa', t);
  }
});

test('farmar aura (e o que o reconhecimento costuma ouvir)', () => {
  for (const t of ['Teko, farmar aura', 'farma a aura', 'formar áurea', 'Teko, liga a aura', 'ativar aura']) {
    assert.equal(acao(t), 'aura-ligar', t);
  }
});

test('brochar desliga a aura', () => {
  for (const t of ['Teko, brochar.', 'broxar', 'Teko brocha', 'desliga a aura', 'esconder aura']) {
    assert.equal(acao(t), 'aura-desligar', t);
  }
});

test('autodestruir responde e fecha', () => {
  const c = comandoLocal('Teko, autodestruir!');
  assert.deepEqual(c, { acao: 'sair', fala: 'Foi um prazer, senhor.' });
  assert.equal(acao('auto destruir'), 'sair');
  assert.equal(acao('Teko, autodestruição'), 'sair');
});

test('ativar e desativar gestos', () => {
  assert.equal(acao('Teko, ativar gestos.'), 'gestos-ligar');
  assert.equal(acao('liga os gestos'), 'gestos-ligar');
  assert.equal(acao('Teko, desativar gestos.'), 'gestos-desligar');
  assert.equal(acao('desliga os gestos'), 'gestos-desligar');
  assert.equal(acao('para os gestos'), 'gestos-desligar');
});

test('Teko mal ouvido vale quando o resto é um comando', () => {
  const ac = (t) => comandoComChamadoParecido(t)?.acao ?? null;
  assert.equal(ac('Deco, farmar aura.'), 'aura-ligar');
  assert.equal(ac('Tecu brochar'), 'aura-desligar');
  assert.equal(ac('Tico, abrir mapa neural'), 'mapa');
  assert.equal(ac('Ei, Teco, autodestruir'), 'sair');
  assert.equal(ac('Tekô, ativar gestos'), 'gestos-ligar');
});

test('Teko mal ouvido com pergunta comum não dispara', () => {
  const ac = (t) => comandoComChamadoParecido(t)?.acao ?? null;
  assert.equal(ac('Deco, qual a capital do Maranhão?'), null);
  assert.equal(ac('Pedro, abre o mapa'), null); // nome longe de Teko
  assert.equal(ac('farmar aura'), null); // sem chamado nenhum
  assert.equal(pareceTeko('Diego'), false);
  assert.equal(pareceTeko('Teco'), true);
});

test('pergunta longa ou comum segue pra IA', () => {
  assert.equal(acao('como eu faço pra abrir o mapa neural no código do projeto?'), null);
  assert.equal(acao('qual a capital do Maranhão?'), null);
  assert.equal(acao('o que é aura farming na internet e de onde veio isso'), null);
  assert.equal(acao(''), null);
});
