import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categorizar, lerItem, lerLista } from '../src/lib/parse.ts';
import { ListaSugeridaSchema } from '../src/lib/items.ts';

test('quantidade, unidade e "de"', () => {
  assert.deepEqual(lerItem('2 kg de arroz'), { nome: 'Arroz', quantidade: 2, unidade: 'kg', categoria: 'Mercearia', preco: null });
});

test('número por extenso e unidade no plural', () => {
  const i = lerItem('uma dúzia de ovos');
  assert.equal(i?.quantidade, 1);
  assert.equal(i?.unidade, 'dz');
  assert.equal(i?.categoria, 'Laticínios e ovos');
});

test('"2kg" grudado e decimal com vírgula', () => {
  assert.equal(lerItem('2kg frango')?.unidade, 'kg');
  assert.equal(lerItem('1,5 l de leite')?.quantidade, 1.5);
});

test('item sem quantidade', () => {
  assert.deepEqual(lerItem('café'), { nome: 'Café', quantidade: null, unidade: null, categoria: 'Bebidas', preco: null });
});

test('lista falada com vírgulas e "e"', () => {
  const itens = lerLista('2 kg de arroz, feijão, uma dúzia de ovos e café');
  assert.deepEqual(itens.map((i) => i.nome), ['Arroz', 'Feijão', 'Ovos', 'Café']);
});

test('categoria: frase mais específica ganha', () => {
  assert.equal(categorizar('leite em pó'), 'Mercearia');
  assert.equal(categorizar('leite'), 'Laticínios e ovos');
  assert.equal(categorizar('papel higiênico'), 'Higiene');
  assert.equal(categorizar('juçara'), 'Hortifrúti');
  assert.equal(categorizar('coisa estranha'), 'Outros');
});

test('texto vazio não vira item', () => {
  assert.deepEqual(lerLista(' , ; \n'), []);
});

test('schema da IA: categoria desconhecida vira Outros e item inválido é recusado', () => {
  const ok = ListaSugeridaSchema.safeParse({ itens: [{ nome: 'Arroz', quantidade: 2, unidade: 'kg', categoria: 'Grãos', preco: 12 }] });
  assert.equal(ok.success && ok.data.itens[0].categoria, 'Outros');
  const ruim = ListaSugeridaSchema.safeParse({ itens: [{ nome: '', quantidade: -1, unidade: null, categoria: 'Mercearia', preco: null }] });
  assert.equal(ruim.success, false);
});
