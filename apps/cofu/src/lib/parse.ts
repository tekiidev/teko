import type { Categoria, ItemSugerido } from './items.ts';

/**
 * Leitor simples, sem IA: funciona offline e quando a IA falha.
 * Entende coisas como "2 kg de arroz, 1 dúzia de ovos e café".
 * Não estima preço (isso fica pra IA ou pra pessoa digitar).
 */

const NUMEROS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7,
  oito: 8, nove: 9, dez: 10, meio: 0.5, meia: 0.5,
};

const UNIDADES: Record<string, string> = {
  kg: 'kg', kilo: 'kg', kilos: 'kg', quilo: 'kg', quilos: 'kg',
  g: 'g', gr: 'g', grama: 'g', gramas: 'g',
  l: 'L', litro: 'L', litros: 'L',
  ml: 'ml',
  un: 'un', und: 'un', unidade: 'un', unidades: 'un',
  pacote: 'pct', pacotes: 'pct', pct: 'pct',
  caixa: 'cx', caixas: 'cx', cx: 'cx',
  duzia: 'dz', duzias: 'dz', dz: 'dz',
  lata: 'lata', latas: 'lata',
  garrafa: 'garrafa', garrafas: 'garrafa',
  maco: 'maço', macos: 'maço',
  bandeja: 'bandeja', bandejas: 'bandeja',
  vidro: 'vidro', vidros: 'vidro',
  saco: 'saco', sacos: 'saco',
};

const PALAVRAS_CATEGORIA: [Categoria, string[]][] = [
  ['Hortifrúti', ['banana', 'maca', 'laranja', 'limao', 'tomate', 'cebola', 'alho', 'batata', 'cenoura', 'alface', 'cheiro verde', 'coentro', 'cebolinha', 'macaxeira', 'mandioca', 'abobora', 'pimentao', 'manga', 'mamao', 'abacaxi', 'melancia', 'acerola', 'cupuacu', 'bacuri', 'juçara', 'jucara', 'quiabo', 'maxixe', 'vinagreira', 'repolho', 'pepino', 'uva', 'goiaba', 'fruta', 'verdura', 'legume']],
  ['Carnes e peixes', ['carne', 'frango', 'peixe', 'camarao', 'linguica', 'calabresa', 'bacon', 'presunto', 'mortadela', 'salsicha', 'file', 'patinho', 'acem', 'costela', 'figado', 'sururu', 'caranguejo', 'pescada', 'tilapia', 'sardinha', 'charque', 'bisteca', 'peito', 'coxa', 'moida']],
  ['Laticínios e ovos', ['leite', 'queijo', 'iogurte', 'manteiga', 'margarina', 'requeijao', 'creme de leite', 'ovo', 'ovos', 'nata', 'coalhada']],
  ['Padaria', ['pao', 'paes', 'bolo', 'biscoito', 'bolacha', 'torrada', 'cuscuz', 'tapioca', 'rosca']],
  ['Bebidas', ['refrigerante', 'refri', 'suco', 'agua', 'cerveja', 'guarana', 'jesus', 'cafe', 'cha', 'vinho', 'achocolatado']],
  ['Limpeza', ['sabao', 'detergente', 'agua sanitaria', 'desinfetante', 'amaciante', 'esponja', 'vassoura', 'saco de lixo', 'multiuso', 'alcool', 'cloro']],
  ['Higiene', ['papel higienico', 'sabonete', 'shampoo', 'xampu', 'condicionador', 'pasta de dente', 'creme dental', 'escova', 'desodorante', 'absorvente', 'fralda', 'cotonete']],
  ['Mercearia', ['arroz', 'feijao', 'farinha', 'acucar', 'sal', 'oleo', 'azeite', 'macarrao', 'massa', 'milho', 'flocao', 'molho', 'extrato', 'vinagre', 'tempero', 'colorau', 'leite em po', 'aveia', 'granola', 'enlatado', 'sardinha em lata', 'atum', 'goma', 'polvilho', 'fuba', 'trigo']],
];

/** Tira acento e deixa minúsculo, pra comparar palavras. */
export function normalizar(texto: string) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

export function categorizar(nome: string): Categoria {
  const n = ` ${normalizar(nome)} `;
  // Frases mais longas primeiro: "leite em po" é mercearia, "leite" é laticínio.
  const pares = PALAVRAS_CATEGORIA.flatMap(([cat, palavras]) => palavras.map((p) => [cat, p] as const)).sort(
    (a, b) => b[1].length - a[1].length,
  );
  for (const [cat, palavra] of pares) {
    if (n.includes(` ${palavra} `) || n.includes(` ${palavra}s `)) return cat;
  }
  return 'Outros';
}

function lerQuantidade(token: string): number | null {
  const t = normalizar(token).replace(',', '.');
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t in NUMEROS) return NUMEROS[t];
  return null;
}

function capitalizar(texto: string) {
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}

export function lerItem(trecho: string): ItemSugerido | null {
  let palavras = trecho.trim().replace(/[.!?]+$/, '').split(/\s+/).filter(Boolean);
  if (!palavras.length) return null;

  let quantidade: number | null = null;
  let unidade: string | null = null;

  // "2kg" grudado vira "2" + "kg".
  const grudado = /^(\d+(?:[.,]\d+)?)([a-zA-Z]+)$/.exec(palavras[0]);
  if (grudado && UNIDADES[normalizar(grudado[2])]) palavras = [grudado[1], grudado[2], ...palavras.slice(1)];

  const q = lerQuantidade(palavras[0]);
  if (q != null) {
    quantidade = q;
    palavras = palavras.slice(1);
  }
  if (palavras.length > 1 && UNIDADES[normalizar(palavras[0])]) {
    unidade = UNIDADES[normalizar(palavras[0])];
    palavras = palavras.slice(1);
  }
  if (palavras.length > 1 && ['de', 'do', 'da'].includes(normalizar(palavras[0]))) palavras = palavras.slice(1);

  const nome = palavras.join(' ').trim();
  if (!nome) return null;
  return {
    nome: capitalizar(nome).slice(0, 60),
    quantidade,
    unidade: quantidade != null && !unidade ? null : unidade,
    categoria: categorizar(nome),
    preco: null,
  };
}

/** Quebra o texto em itens: vírgula, ponto e vírgula, quebra de linha e " e " entre itens. */
export function lerLista(texto: string): ItemSugerido[] {
  return texto
    .split(/[\n,;]+|\s+e\s+(?=\d|um\b|uma\b|dois\b|duas\b|meio\b|meia\b|[a-zà-ú])/i)
    .map((t) => t.trim())
    .filter(Boolean)
    .map(lerItem)
    .filter((i): i is ItemSugerido => i != null)
    .slice(0, 60);
}
