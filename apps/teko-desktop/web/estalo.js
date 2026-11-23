// Detector de estalo de dedos no microfone.
//
// Estalo = som agudo e seco: sobe de uma vez (poucos ms), some em ~40 ms e tem bastante
// passagem por zero (energia nos agudos, perto de 2 a 3 kHz). Voz sobe devagar e sustenta;
// batida na mesa ou porta é grave. Nenhum dos dois passa.
// Isolado: nada parecido no 0,6 s antes nem no 0,35 s depois. Digitar faz vários cliques
// seguidos, então não dispara; palmas em sequência (aplauso, música) também não.
// Analisa em blocos de ~5 ms; recebe os quadros do microfone na ordem em que chegam.

const BLOCO = 256;
const MIN_ABSOLUTO = 0.05; // volume mínimo de um estalo (RMS do bloco)
const ACIMA_DO_RUIDO = 12; // e bem acima do ruído de fundo
const ATAQUE = 0.3; // os 2 blocos antes têm que estar abaixo de 30% do pico
const QUEDA_MS = 40; // ~40 ms depois, abaixo de 20% do pico
const QUEDA = 0.2;
const AGUDO = 0.07; // passagens por zero por amostra no pico (~1,7 kHz pra cima)
const REFRATARIO_MS = 80; // ecos do mesmo estalo
const SOZINHO_ANTES = 600;
const SOZINHO_DEPOIS = 350;
// Qualquer pico brusco (mesmo fraco ou grave) conta pra regra de "sozinho": é o que
// separa um estalo de uma sequência de teclas.
const TRANSIENTE_MIN = 0.02;

export function criarDetectorEstalo({ taxa = 48000, aoDetectar = () => {} } = {}) {
  const msPorBloco = (BLOCO / taxa) * 1000;
  const blocosQueda = Math.max(3, Math.round(QUEDA_MS / msPorBloco));
  let resto = new Float32Array(0);
  let amostras = 0; // amostras já vistas (relógio do detector)
  let ruido = 0.003;
  const historico = []; // { rms, zcr } dos últimos blocos
  const candidatos = []; // estalos esperando conferir a queda
  let ultimoTransiente = -Infinity; // último pico brusco de qualquer tipo
  let pendente = null; // estalo confirmado esperando o silêncio depois

  function analisarBloco(bloco, t) {
    let soma = 0;
    let cruzou = 0;
    for (let i = 0; i < bloco.length; i += 1) {
      soma += bloco[i] * bloco[i];
      if (i && (bloco[i] >= 0) !== (bloco[i - 1] >= 0)) cruzou += 1;
    }
    const rms = Math.sqrt(soma / bloco.length);
    const zcr = cruzou / bloco.length;
    historico.push({ rms, zcr });
    if (historico.length > blocosQueda + 4) historico.shift();

    const n = historico.length;
    const antes = n >= 3 ? Math.max(historico[n - 2].rms, historico[n - 3].rms) : Infinity;
    const brusco = antes < rms * ATAQUE;
    const limiar = Math.max(MIN_ABSOLUTO, ruido * ACIMA_DO_RUIDO);

    if (brusco && rms > Math.max(TRANSIENTE_MIN, ruido * 5) && t - ultimoTransiente > REFRATARIO_MS) {
      // Algum pico brusco: se já tinha um estalo esperando, não era um estalo sozinho.
      if (pendente) pendente = null;
      const isolado = t - ultimoTransiente > SOZINHO_ANTES;
      ultimoTransiente = t;
      if (isolado && rms > limiar && zcr > AGUDO) {
        candidatos.push({ rms, t, conferirEm: t + blocosQueda * msPorBloco });
      }
    } else if (rms < limiar) {
      // Ruído de fundo: média lenta só com o que não é pico.
      ruido = ruido * 0.98 + rms * 0.02;
    }

    // Confere a queda dos candidatos que já têm ~40 ms de futuro.
    while (candidatos.length && candidatos[0].conferirEm <= t) {
      const c = candidatos.shift();
      // Só vale se nenhum outro pico apareceu depois dele.
      if (rms < c.rms * QUEDA && ultimoTransiente === c.t) pendente = { em: c.t + SOZINHO_DEPOIS };
    }
  }

  return {
    /** Passa um quadro do microfone (Float32Array). */
    quadro(dados) {
      const junto = new Float32Array(resto.length + dados.length);
      junto.set(resto);
      junto.set(dados, resto.length);
      let i = 0;
      for (; i + BLOCO <= junto.length; i += BLOCO) {
        amostras += BLOCO;
        analisarBloco(junto.subarray(i, i + BLOCO), (amostras / taxa) * 1000);
      }
      resto = junto.slice(i);
      const agora = (amostras / taxa) * 1000;
      if (pendente && agora >= pendente.em) {
        pendente = null;
        aoDetectar();
      }
    },
    /** Esquece tudo (ex.: depois de o Teko falar). */
    reset() {
      resto = new Float32Array(0);
      historico.length = 0;
      candidatos.length = 0;
      pendente = null;
      ultimoTransiente = -Infinity;
    },
  };
}
