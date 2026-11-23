// Comandos curtos que o próprio app resolve, sem IA (na hora e sem gastar nada).
//   "Teko, abrir mapa neural"  -> abre o mapa
//   "Teko, farmar aura"        -> liga a aura
//   "Teko, brochar"            -> desliga a aura
//   "Teko, ativar gestos"      -> liga a câmera dos gestos (desativar desliga)
//   "Teko, autodestruir"       -> "Foi um prazer, senhor." e fecha o Teko
// Só frase curta: "como eu abro o mapa neural no código?" continua indo pra IA.
// As regras aceitam as variações que o reconhecimento de voz costuma ouvir.

const MAX_PALAVRAS = 6;

const COMANDOS = [
  {
    acao: 'sair',
    fala: 'Foi um prazer, senhor.',
    // autodestruir, auto destruir, autodestruição, se autodestrua
    regra: /\bauto ?destru/,
  },
  {
    acao: 'aura-ligar',
    fala: 'Aura farmada.',
    // farmar aura, farma a aura, formar aura (erro comum), ligar/ativar/mostrar a aura
    regra: /\b(farm|form)\w* (a |de )?(aura|aurea|aureo)\b|\b(liga|ativa|mostra)\w* (a )?(aura|aurea)\b/,
  },
  {
    acao: 'aura-desligar',
    fala: 'Aura desligada.',
    // brochar, broxar, brocha, broxou; desligar/esconder a aura
    regra: /\bbro(ch|x)\w*|\b(deslig|escond|desativ|tira)\w* (a )?(aura|aurea)\b/,
  },
  {
    acao: 'gestos-desligar',
    fala: 'Gestos desligados.',
    // desativar/desligar/parar os gestos
    regra: /\b(deslig|desativ|par)\w* (os )?gestos?\b/,
  },
  {
    acao: 'gestos-ligar',
    fala: 'Gestos ligados.',
    // ativar/ligar os gestos
    regra: /\b(lig|ativ)\w* (os )?gestos?\b/,
  },
  {
    acao: 'mapa',
    fala: 'Abrindo o mapa.',
    // abrir mapa neural, abre o mapa, mostra o mapa, mapa neural
    regra: /\b(abr|mostr)\w* (o )?mapa\b|^mapa neural$/,
  },
];

/** Texto sem acento, minúsculo, sem pontuação e sem o "Teko" do começo. */
export function normalizar(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(ei |oi )?te(k|c|qu)o /, '')
    .trim();
}

/** Quantas letras trocar, tirar ou pôr pra ir de `a` a `b` (distância de edição). */
function distancia(a, b) {
  const linha = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const guardado = linha[j];
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return linha[b.length];
}

/** Palavra que soa como "Teko" (Teco, Deco, Tecu, Tico...): até 2 letras de diferença. */
export function pareceTeko(palavra) {
  const p = normalizar(palavra).replace(/ /g, '');
  return p.length >= 3 && p.length <= 6 && distancia(p, 'teko') <= 2;
}

/**
 * "Teko" mal ouvido + comando conhecido: "Deco, farmar aura" vale como "Teko, farmar aura".
 * Só pra comando local; pergunta comum continua exigindo o Teko certo (pra não disparar
 * quando você fala com outra pessoa).
 */
export function comandoComChamadoParecido(texto) {
  const palavras = String(texto || '').trim().replace(/^(ei|oi)[\s,]+/i, '').split(/[\s,.!?:;-]+/).filter(Boolean);
  if (palavras.length < 2 || !pareceTeko(palavras[0])) return null;
  return comandoLocal(palavras.slice(1).join(' '));
}

/** Devolve { acao, fala } se o texto for um comando local, ou null. */
export function comandoLocal(texto) {
  const t = normalizar(texto);
  if (!t || t.split(' ').length > MAX_PALAVRAS) return null;
  const achado = COMANDOS.find((c) => c.regra.test(t));
  return achado ? { acao: achado.acao, fala: achado.fala } : null;
}
