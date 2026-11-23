// Fluxo de voz do Teko no Mac.
//
// Dois jeitos de chamar:
//   1. Falar "Teko" (escuta ligada no menu da barra): um detector de volume recorta trechos curtos
//      de fala e o servidor confere, com whisper local, se começam com "Teko".
//      "Teko, pergunta..." numa frase só vai direto; "Teko" sozinho abre a escuta do comando.
//      Depois da resposta a conversa continua: ele segue ouvindo sem precisar do "Teko" até
//      ficar VAD.esperaSeguimento sem ninguém falar (ou você dizer "tchau"/"valeu").
//   2. Segurar ⌥ Espaço: grava enquanto segura.
// Depois: transcrever (whisper local) -> Teko responde (perfil Voz) -> falar (say do macOS).
// Tudo passa só pelo servidor local do Teko (npm start) em 127.0.0.1:4780.

import { criarAura } from './aura.js';
import { criarDetectorEstalo } from './estalo.js';
import { comandoLocal, comandoComChamadoParecido } from './comandos.js';

const API = 'http://127.0.0.1:4780/api';
const ROTAS_VOZ = {
  wake: `${API}/voice/wake`,
  transcribe: `${API}/voice/transcribe`,
  chat: `${API}/chat`,
  speak: `${API}/voice/speak`,
};
const auraTela = criarAura(document.getElementById('aura'));
// Tudo que muda na aura (estado e legenda) também vai pra ilha do notch, por evento.
const avisarIlha = (nome, dado) => window.__TAURI__?.event?.emit(nome, dado).catch(() => {});
const aura = {
  get estado() { return auraTela.estado; },
  set estado(valor) {
    // 'gesto' é só visual (aura sendo movida): a ilha não precisa saber.
    if (auraTela.estado !== valor && valor !== 'gesto') avisarIlha('teko-estado', valor);
    auraTela.estado = valor;
  },
  repouso: (v) => auraTela.repouso(v),
  formaT: (v) => {
    // A ilha acende o T junto: dá retorno do gesto mesmo com a aura desligada.
    if (Boolean(v) !== tNaIlha) {
      tNaIlha = Boolean(v);
      avisarIlha('teko-gesto', tNaIlha ? 'T' : '');
    }
    auraTela.formaT(v);
  },
  janelaCamera: (v) => auraTela.janelaCamera(v),
  volume: (v) => {
    auraTela.volume(v);
    // A ilha anima com o volume (LED quando você fala, barras quando ele fala): ~12 por segundo basta.
    const agora = performance.now();
    if (agora - volumeIlha.em > 80 && (v > 0.01 || volumeIlha.v > 0.01)) {
      volumeIlha.em = agora;
      volumeIlha.v = v;
      avisarIlha('teko-volume', Math.min(1, v));
    }
  },
};
const volumeIlha = { em: 0, v: 0 };
let tNaIlha = false;
const legenda = document.getElementById('legenda');

// Detector de fala (VAD) por volume. Um quadro = 4096 amostras (~85 ms a 48 kHz).
const VAD = {
  inicio: 0.015, // volume mínimo pra considerar fala
  fimTrecho: 7, // quadros de silêncio que fecham um trecho na vigia (~0,6 s)
  fimComando: 9, // no comando, ~0,75 s de silêncio já fecha (antes 1,2 s)
  preRoll: 4, // quadros guardados antes da fala começar (não cortar o "T" do Teko)
  maxTrecho: 6000, // ms: trecho de vigia mais longo que isso é descartado
  maxComando: 15000,
  esperaComando: 5000, // se ninguém falar depois do "Teko", desiste
  esperaSeguimento: 8000, // conversa seguida: silêncio que encerra e volta a exigir "Teko"
  respiroSeguimento: 350, // pausa depois da fala dele antes de voltar a ouvir (evita pegar o eco)
};

let ctx = null;
let micAnalisador = null;
let falaAnalisador = null;
let ativo = null; // analisador que a aura está lendo
let mic = null; // { stream, fonte, processador }
let escuta = true; // ouvir "Teko" (menu da barra)
// Interruptor geral do microfone: desligado, nada abre o microfone (nem ⌥ Espaço).
let micLigado = true;
try { micLigado = localStorage.getItem('teko.mic') !== '0'; } catch { /* padrão: ligado */ }
let modo = 'parado'; // parado | vigia | gravando | ocupado
let gravacao = null; // { pedacos, inicio, auto, falou, silencio }
let trecho = null; // trecho da vigia em andamento
let anteriores = []; // pre-roll
let piso = 0.004; // ruído de fundo estimado
let conferindo = false;
let avisouServidor = false;
let pico = 0; // maior volume visto (depuração)
let ouvido = ''; // último trecho conferido (depuração)
let tocando = null;
let sessionId = null;
let ciclo = 0;
let taxa = 48000;
let versaoLegenda = 0;
let gestosSolicitados = false;
let gestosStream = null;
let gestosLandmarker = null;
let gestosFrame = 0;
let gestosBase = null;
let gestosInicio = 0;
let gestosMapaAberto = false;
let gestosEmT = false;
let tDesde = 0; // quando o T começou a aparecer (precisa ficar firme um instante)
let statusGestoAtual = '';

function statusGesto(texto) {
  if (texto === statusGestoAtual) return;
  statusGestoAtual = texto;
  const elemento = document.getElementById('gesto-status');
  if (!elemento) return;
  elemento.textContent = texto;
  elemento.classList.toggle('on', Boolean(texto));
}

function mostrar(quem, texto, apagarEm = 0) {
  const versao = ++versaoLegenda;
  avisarIlha('teko-legenda', { quem, texto: texto || '', apagarEm });
  if (!texto) {
    legenda.classList.remove('on');
    return;
  }
  legenda.innerHTML = '';
  const q = document.createElement('span');
  q.className = 'quem';
  q.textContent = quem;
  const resposta = document.createElement('span');
  resposta.className = 'resposta';
  resposta.textContent = texto;
  legenda.append(q, resposta);
  legenda.classList.add('on');
  if (apagarEm) {
    setTimeout(() => versao === versaoLegenda && modo !== 'gravando' && mostrar(), apagarEm);
  }
}

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    taxa = ctx.sampleRate;
    micAnalisador = ctx.createAnalyser();
    falaAnalisador = ctx.createAnalyser();
    micAnalisador.fftSize = falaAnalisador.fftSize = 512;
    medir();
  }
  return ctx;
}

function medir() {
  const dados = new Float32Array(512);
  const passo = () => {
    if (ativo) {
      ativo.getFloatTimeDomainData(dados);
      let soma = 0;
      for (const v of dados) soma += v * v;
      aura.volume(Math.sqrt(soma / dados.length) * 6);
    } else aura.volume(0);
    requestAnimationFrame(passo);
  };
  passo();
}

function rms(quadro) {
  let soma = 0;
  for (const v of quadro) soma += v * v;
  return Math.sqrt(soma / quadro.length);
}

// No app Tauri, manda as requisições pelo processo Rust para evitar bloqueios de CORS do WebView.
async function requisicaoLocal(acao, conteudo, tipo) {
  const body = conteudo instanceof Blob
    ? new Uint8Array(await conteudo.arrayBuffer())
    : new TextEncoder().encode(JSON.stringify(conteudo));
  const invoke = window.__TAURI__?.core?.invoke;
  if (invoke) {
    const bytes = await invoke('voice_local_request', { action: acao, body: Array.from(body) });
    return new Uint8Array(bytes);
  }

  const res = await fetch(ROTAS_VOZ[acao], {
    method: 'POST',
    headers: { 'content-type': tipo },
    body,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!res.ok) throw new Error(`Teko respondeu HTTP ${res.status}: ${new TextDecoder().decode(bytes)}`);
  return bytes;
}

/** Bipe curto pra avisar que ouviu o "Teko". */
function bipe() {
  const c = audio();
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.setValueAtTime(660, c.currentTime);
  o.frequency.exponentialRampToValueAtTime(990, c.currentTime + 0.09);
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.12, c.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.14);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + 0.15);
}

// ---------- microfone ----------

async function abrirMic() {
  if (!micLigado) {
    mostrar('teko', 'Microfone desligado. Ligue na ilha ou no menu da barra.', 3000);
    return false;
  }
  const c = audio();
  try {
    if (!mic) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const fonte = c.createMediaStreamSource(stream);
      const processador = c.createScriptProcessor(4096, 1, 1);
      processador.onaudioprocess = (e) => aoQuadro(new Float32Array(e.inputBuffer.getChannelData(0)));
      fonte.connect(processador);
      fonte.connect(micAnalisador); // só pra medir; não vai pro alto-falante
      processador.connect(c.destination); // o ScriptProcessor só roda conectado (sai silêncio)
      mic = { stream, fonte, processador };
    }
    if (c.state !== 'running') await c.resume();
    if (c.state !== 'running') throw new Error(`áudio do app está ${c.state}; clique no menu do Teko e ative a escuta`);
    return true;
  } catch (err) {
    mostrar('erro', `Sem acesso ao microfone (${err.message || err}).`, 5000);
    return false;
  }
}

function fecharMic() {
  if (!mic) return;
  mic.processador.disconnect();
  mic.fonte.disconnect();
  mic.stream.getTracks().forEach((t) => t.stop());
  mic = null;
}

/** Decide o que fazer com o microfone conforme o modo (e desliga quando não precisa). */
// Com a escuta ligada o microfone fica aberto (o macOS mostra o ponto laranja), mas o áudio
// só é usado na vigia ou gravando; enquanto o Teko pensa e fala, os quadros são ignorados.
async function ajustarMic() {
  if (micLigado && (modo === 'gravando' || escuta)) {
    if (await abrirMic()) {
      if (modo === 'parado' && escuta) modo = 'vigia';
      if (modo === 'vigia') {
        ativo = micAnalisador;
        aura.estado = 'ouvindo';
        mostrar('teko', 'Ouvindo: diga “Teko”.');
      }
    }
  } else {
    fecharMic();
    if (modo === 'vigia') modo = 'parado';
    if (modo === 'parado') {
      ativo = null;
      aura.estado = 'parado';
    }
  }
}

/** Liga ou desliga o microfone de vez (ilha, menu ou "Teko, desligar microfone"). */
function definirMic(ligado) {
  micLigado = ligado;
  try { localStorage.setItem('teko.mic', ligado ? '1' : '0'); } catch { /* só não lembra */ }
  if (!ligado) {
    if (modo === 'gravando' || modo === 'ocupado') cancelarConversa();
    trecho = null;
    anteriores = [];
    fecharMic(); // fecha de verdade: o ponto laranja do macOS some
  }
  ajustarMic();
  avisarIlha('teko-mic', ligado);
  mostrar('teko', ligado ? 'Microfone ligado.' : 'Microfone desligado. Nada é ouvido até você ligar de novo.', 2500);
}

function aoQuadro(quadro) {
  const v = rms(quadro);
  if (v > pico) pico = v;
  if (modo === 'gravando') return gravarQuadro(quadro, v);
  if (modo === 'vigia') {
    // Estalo de dedos também chama o Teko (só esperando: falando ou gravando, não conta).
    if (estaloLigado) {
      if (!detectorEstalo || detectorEstalo.taxa !== taxa) detectorEstalo = { taxa, ...criarDetectorEstalo({ taxa, aoDetectar: chamadoPorEstalo }) };
      detectorEstalo.quadro(quadro);
    }
    return vigiar(quadro, v);
  }
}

// ---------- estalo de dedos ----------

let estaloLigado = true; // item "Ligar com estalo de dedos" do menu da barra
let detectorEstalo = null;

/** Estalo = mesmo que falar "Teko" sozinho: bipe e ele começa a ouvir. */
// Juntar as mãos (fechar o mapa, desligar a aura) faz barulho parecido com estalo.
// Com o mapa aberto, logo depois de fechar e com as mãos juntas na câmera, estalo não conta.
let estaloSilenciadoAte = 0;
let mapaAbertoAgora = false;

function chamadoPorEstalo() {
  if (modo !== 'vigia') return;
  if (mapaAbertoAgora || performance.now() < estaloSilenciadoAte) return;
  // O estalo liga a aura e ela fica na tela (juntar as mãos desliga).
  if (!auraLigada) window.__TAURI__?.core?.invoke('definir_aura', { visivel: true }).catch(() => {});
  trecho = null; // o som do estalo não vai pro reconhecimento de "Teko"
  anteriores = [];
  ciclo += 1;
  bipe();
  comecarGravacao({ auto: true });
}

// ---------- vigia ("Teko") ----------

function vigiar(quadro, v) {
  const limiar = Math.max(VAD.inicio, piso * 3);
  if (!trecho) {
    piso = Math.max(0.002, piso * 0.95 + v * 0.05);
    anteriores.push(quadro);
    if (anteriores.length > VAD.preRoll) anteriores.shift();
    if (v > limiar) {
      trecho = { pedacos: [...anteriores, quadro], inicio: performance.now(), silencio: 0 };
      anteriores = [];
    }
    return;
  }
  trecho.pedacos.push(quadro);
  trecho.silencio = v < Math.max(VAD.inicio * 0.7, piso * 2) ? trecho.silencio + 1 : 0;
  const dur = performance.now() - trecho.inicio;
  if (dur > VAD.maxTrecho) {
    trecho = null; // conversa longa, não é chamada
    return;
  }
  if (trecho.silencio >= VAD.fimTrecho) {
    const t = trecho;
    trecho = null;
    if (dur < 300 || conferindo) return;
    conferirTeko(paraWav(t.pedacos, taxa));
  }
}

async function conferirTeko(wav) {
  conferindo = true;
  try {
    const bytes = await requisicaoLocal('wake', wav, 'audio/wav');
    avisouServidor = false;
    if (modo !== 'vigia') return;
    const { wake, rest, text } = JSON.parse(new TextDecoder().decode(bytes));
    ouvido = text || '';
    if (!wake) {
      // "Teko" mal ouvido ("Deco, farmar aura"): se o resto é um comando conhecido, vale.
      const comando = comandoComChamadoParecido(text);
      if (comando) {
        ciclo += 1;
        bipe();
        mostrar('você', text);
        await executarComando(comando, ciclo);
        return;
      }
      if (text) mostrar('não reconheci', `“${text}”`, 1800);
      return;
    }
    ciclo += 1;
    bipe();
    // Comando de uma palavra ("Teko, brochar") também vai direto, sem esperar mais fala.
    if (rest && (rest.split(/\s+/).length >= 2 || comandoLocal(rest))) {
      // "Teko, qual a capital do Maranhão?" -> já é a pergunta.
      mostrar('você', rest);
      await responder(rest, ciclo);
    } else {
      comecarGravacao({ auto: true });
    }
  } catch (err) {
    // Avise uma vez, sem repetir a mensagem a cada trecho enquanto o servidor estiver fora.
    if (!avisouServidor) {
      avisouServidor = true;
      mostrar('erro', `Teko não conseguiu conferir o áudio (${err.message || err}). Inicie o servidor com npm start.`, 6000);
    }
  } finally {
    conferindo = false;
  }
}

// ---------- gravação do comando ----------

// ---------- Esc cancela a conversa ----------
// O atalho global de Esc só fica ligado enquanto há conversa (o Rust registra e solta).
let escAtivo = false;
function definirEsc(ligado) {
  if (ligado === escAtivo) return;
  escAtivo = ligado;
  window.__TAURI__?.core?.invoke('definir_esc', { ativo: ligado }).catch((err) => console.warn('[Teko] Esc:', err));
}

/** Esc: para a fala, descarta o que está em andamento e volta a esperar "Teko". */
function cancelarConversa() {
  if (modo !== 'gravando' && modo !== 'ocupado') return definirEsc(false);
  ciclo += 1; // respostas e falas em andamento deste ciclo são ignoradas
  if (aprovacao) aprovacao.responder(false); // nega a ferramenta que esperava resposta
  pararFala();
  gravacao = null;
  trecho = null;
  ativo = null;
  modo = 'parado';
  aura.estado = 'parado';
  definirEsc(false);
  ajustarMic().then(() => mostrar('teko', 'Conversa cancelada. Diga “Teko” quando precisar.', 2500));
}

function comecarGravacao({ auto, seguimento = false, aoTerminar = null }) {
  definirEsc(true);
  pararFala();
  // aoTerminar: em vez de virar pergunta pro Teko, o texto volta pra quem pediu (ex.: "sim/não").
  gravacao = { pedacos: [], inicio: performance.now(), auto, seguimento, aoTerminar, falou: false, silencio: 0 };
  modo = 'gravando';
  ativo = micAnalisador;
  aura.estado = 'ouvindo';
  // Na conversa seguida a resposta continua na legenda; a aura em "ouvindo" mostra que ele espera você.
  if (!seguimento) mostrar('ouvindo', auto ? 'Pode falar.' : '…');
}

function gravarQuadro(quadro, v) {
  const g = gravacao;
  if (!g) return;
  g.pedacos.push(quadro);
  if (!g.auto) return; // ⌥ Espaço: termina quando soltar
  const limiar = Math.max(VAD.inicio, piso * 3);
  if (v > limiar) {
    g.falou = true;
    g.silencio = 0;
  } else if (g.falou) g.silencio += 1;
  const dur = performance.now() - g.inicio;
  if ((g.falou && g.silencio >= VAD.fimComando) || dur > VAD.maxComando) terminarGravacao();
  else if (!g.falou && dur > (g.seguimento ? VAD.esperaSeguimento : VAD.esperaComando)) {
    cancelarGravacao(g.seguimento ? 'Conversa encerrada. Diga “Teko” para chamar de novo.' : '');
  }
}

function cancelarGravacao(aviso = '') {
  if (gravacao?.aoTerminar) {
    const volta = gravacao.aoTerminar;
    gravacao = null;
    ativo = null;
    modo = 'ocupado';
    return volta(null);
  }
  definirEsc(false);
  gravacao = null;
  ativo = null;
  modo = 'parado';
  aura.estado = 'parado';
  mostrar();
  ajustarMic().then(() => aviso && modo === 'vigia' && mostrar('teko', aviso, 3500));
}

/** "Teko, ..." no meio da conversa: tira o chamado e fica só com o pedido. */
function semChamado(texto) {
  return texto.replace(/^\s*(ei,?\s*)?te[ck]o[\s,.!:;-]+/i, '').trim() || texto;
}
const DESPEDIDA = /^(tchau|valeu|obrigad[oa]|é isso|era isso|pode parar|encerrar|encerra|chega)[\s,.!]*(teko)?[.!]*$/i;

async function terminarGravacao() {
  const g = gravacao;
  gravacao = null;
  ativo = null;
  if (g?.aoTerminar) {
    // Resposta curta (sim/não): transcreve e devolve, sem abrir um ciclo novo.
    modo = 'ocupado';
    aura.estado = 'pensando';
    try {
      const bytes = await requisicaoLocal('transcribe', paraWav(g.pedacos, taxa), 'audio/wav');
      const { text } = JSON.parse(new TextDecoder().decode(bytes));
      return g.aoTerminar(text || null);
    } catch {
      return g.aoTerminar(null);
    }
  }
  if (!g || performance.now() - g.inicio < 350) return cancelarGravacao();
  const meu = ++ciclo;
  modo = 'ocupado';
  aura.estado = 'pensando';
  mostrar('ouvi', '…');
  try {
    const bytes = await requisicaoLocal('transcribe', paraWav(g.pedacos, taxa), 'audio/wav');
    const { text, error } = JSON.parse(new TextDecoder().decode(bytes));
    if (error) throw new Error(error);
    if (!text) {
      mostrar('ouvi', 'Não entendi. Fala de novo.', 3000);
      return fim(meu, true);
    }
    const pedido = g.seguimento ? semChamado(text) : text;
    if (g.seguimento && DESPEDIDA.test(pedido)) {
      mostrar('teko', 'Fechado. Diga “Teko” quando precisar.', 3500);
      return fim(meu);
    }
    mostrar('você', pedido);
    await responder(pedido, meu);
  } catch (err) {
    erro(err, meu);
  }
}

// ---------- resposta ----------

/** Comandos curtos (mapa, aura, gestos, autodestruir): o app resolve na hora, sem IA. */
async function executarComando(cmd, meu) {
  modo = 'ocupado';
  mostrar('teko', cmd.fala);
  const invoke = window.__TAURI__?.core?.invoke;
  const dizer = async () => { try { await falar(cmd.fala, meu); } catch { /* sem voz: fica o texto */ } };
  try {
    if (cmd.acao === 'sair') {
      await dizer();
      await invoke?.('sair_teko');
      return;
    }
    if (cmd.acao === 'mapa') await invoke?.('open_context_map');
    else if (cmd.acao === 'aura-ligar') await invoke?.('definir_aura', { visivel: true });
    else if (cmd.acao === 'aura-desligar') await invoke?.('definir_aura', { visivel: false });
    else if (cmd.acao === 'gestos-ligar') await invoke?.('definir_gestos', { ativo: true });
    else if (cmd.acao === 'gestos-desligar') await invoke?.('definir_gestos', { ativo: false });
    else if (cmd.acao === 'mic-desligar') {
      // Fala antes: depois de desligar, nada mais é ouvido.
      await dizer();
      await invoke?.('definir_microfone', { ligado: false });
      return;
    }
    await dizer();
  } catch (err) {
    mostrar('erro', `Não consegui: ${err?.message || err}`, 4000);
  }
  if (meu === ciclo) mostrar('teko', cmd.fala, 2000);
  fim(meu);
}

async function responder(texto, meu) {
  const comando = comandoLocal(texto);
  if (comando) return executarComando(comando, meu);
  definirEsc(true);
  modo = 'ocupado';
  aura.estado = 'pensando';
  // Em modo ocupado os quadros do microfone são ignorados: ele não ouve a si mesmo.
  try {
    const resposta = await perguntar(texto, meu);
    if (resposta == null || meu !== ciclo) return;
    mostrar('teko', resposta);
    try {
      await falar(resposta, meu);
      if (meu === ciclo) mostrar('teko', resposta, 2500);
    } catch (err) {
      // A resposta veio; só a voz falhou. Deixa o texto na tela e explica o porquê.
      const msg = String(err?.message || err);
      const aviso = /voz clonada fora do ar|4781|ECONNREFUSED/.test(msg)
        ? 'Sua voz está desligada. Rode: npm run voz:clone'
        : 'Não consegui falar agora.';
      if (meu === ciclo) mostrar('teko', `${resposta}\n\n(${aviso})`, 9000);
    }
  } catch (err) {
    return erro(err, meu);
  }
  fim(meu, true);
}

/** Fim de um turno. Com `seguir` e a escuta ligada, continua a conversa sem pedir "Teko". */
function fim(meu, seguir = false) {
  if (meu !== ciclo) return;
  if (seguir && escuta && mic) {
    modo = 'ocupado'; // segura os quadros do microfone até a fala dele parar de ecoar
    setTimeout(() => {
      if (meu === ciclo && modo === 'ocupado') comecarGravacao({ auto: true, seguimento: true });
    }, VAD.respiroSeguimento);
    return;
  }
  definirEsc(false);
  modo = 'parado';
  aura.estado = 'parado';
  ajustarMic();
}

function erro(err, meu) {
  const msg = String(err?.message || err);
  mostrar('erro', /Failed to fetch|Load failed|NetworkError/.test(msg) ? 'Teko desligado. Rode npm start.' : msg, 5000);
  fim(meu);
}

// ---------- aprovação por voz ou gesto ----------
// Quando o Teko quer escrever, editar, rodar algo ou delegar pro Claude Code, ele pergunta.
// Responda "sim"/"pode" ou "não", ou faça pinça (polegar + indicador) pra confirmar.
let aprovacao = null; // { id, responder(bool) }

const SIM = /^(sim|pode|pode sim|manda|manda ver|bora|claro|ok|okay|beleza|isso|faz|faça|confirmo|confirma|vai)\b/i;
const NAO = /^(não|nao|nem|cancela|cancelar|para|pare|deixa|espera)\b/i;

function perguntaDe(ev) {
  const a = ev.args || {};
  const curto = (t, n = 90) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
  if (ev.name === 'delegate_agent') return `Posso mandar pro Claude Code: ${curto(a.task)}?`;
  if (ev.name === 'write_file') return `Posso criar o arquivo ${a.path}?`;
  if (ev.name === 'edit_file') return `Posso editar ${a.path}?`;
  if (ev.name === 'run_command') return `Posso rodar o comando ${curto(a.command, 60)}?`;
  return `Posso usar ${ev.name}?`;
}

async function ouvirSimNao(meu) {
  if (meu !== ciclo || !(await abrirMic())) return null;
  return new Promise((resolve) => comecarGravacao({ auto: true, aoTerminar: (texto) => resolve(texto) }));
}

async function pedirAprovacao(ev, meu) {
  const pergunta = perguntaDe(ev);
  return new Promise(async (resolve) => {
    let resolvido = false;
    const responder = (ok) => {
      if (resolvido) return;
      resolvido = true;
      aprovacao = null;
      resolve(ok);
    };
    aprovacao = { id: ev.id, responder };
    mostrar('teko', `${pergunta}\n(diga sim ou não · pinça confirma)`);
    try { await falar(pergunta, meu); } catch { /* sem voz: a pergunta fica escrita */ }
    if (resolvido || meu !== ciclo) return responder(false);
    // Até 2 tentativas de ouvir; sem resposta clara, nega (mais seguro).
    for (let tentativa = 0; tentativa < 2 && !resolvido; tentativa += 1) {
      const texto = await ouvirSimNao(meu);
      if (resolvido) return;
      const t = String(texto || '').trim();
      if (SIM.test(t)) return responder(true);
      if (NAO.test(t)) return responder(false);
      if (tentativa === 0) mostrar('teko', `${pergunta}\n(não entendi: diga sim ou não)`);
    }
    responder(false);
  });
}

/** Chat em streaming (app nativo): vê pedidos de aprovação no meio da resposta. */
async function perguntarStream(texto, meu) {
  const { invoke, Channel } = window.__TAURI__.core;
  let resposta = '';
  let falha = null;
  let fila = Promise.resolve();
  const canal = new Channel();
  const tratar = async (dado) => {
    if (meu !== ciclo) return;
    let ev;
    try { ev = JSON.parse(dado); } catch { return; }
    if (ev.type === 'meta') sessionId = ev.sessionId;
    else if (ev.type === 'delta') resposta += ev.text;
    else if (ev.type === 'done' && typeof ev.text === 'string') resposta = ev.text;
    else if (ev.type === 'error') falha = ev.message;
    else if (ev.type === 'tool_call' && ev.requiresApproval) {
      const ok = await pedirAprovacao(ev, meu);
      await invoke('approve_tool', { id: ev.id, approved: ok }).catch((err) => console.warn('[Teko] aprovação:', err));
      mostrar('teko', ok ? 'Fechado, fazendo.' : 'Beleza, não vou fazer.', 2500);
      if (meu === ciclo) aura.estado = 'pensando';
    } else if (ev.type === 'tool_running' && ev.name === 'delegate_agent') {
      mostrar('teko', 'Mandei pro Claude Code. Te aviso quando terminar.');
    }
  };
  canal.onmessage = (dado) => { fila = fila.then(() => tratar(dado)); };
  const corpo = new TextEncoder().encode(JSON.stringify({ text: texto, sessionId, profileId: 'voice' }));
  await invoke('chat_stream', { body: Array.from(corpo), onEvent: canal });
  await fila;
  if (meu !== ciclo) return null;
  if (!resposta && falha) throw new Error(falha);
  return resposta;
}

async function perguntar(texto, meu) {
  if (window.__TAURI__?.core?.Channel) return perguntarStream(texto, meu);
  const bytes = await requisicaoLocal('chat', { text: texto, sessionId, profileId: 'voice' }, 'application/json');
  const corpo = new TextDecoder().decode(bytes);
  let buffer = corpo;
  let resposta = '';
  let falha = null;
  while (buffer.length) {
    if (meu !== ciclo) return null;
    let i;
    i = buffer.indexOf('\n\n');
    const evento = i === -1 ? buffer : buffer.slice(0, i);
    buffer = i === -1 ? '' : buffer.slice(i + 2);
    const linha = evento.split('\n').find((l) => l.startsWith('data:'));
    if (!linha) continue;
    let ev;
    try { ev = JSON.parse(linha.slice(5)); } catch { continue; }
    if (ev.type === 'meta') sessionId = ev.sessionId;
    if (ev.type === 'delta') resposta += ev.text;
    if (ev.type === 'done' && typeof ev.text === 'string') resposta = ev.text;
    if (ev.type === 'error') falha = ev.message;
  }
  if (!resposta && falha) throw new Error(falha);
  return resposta;
}

/**
 * Quebra em frases pra começar a falar antes de gerar tudo.
 * A primeira fica sozinha e curta (sai rápido); as seguintes juntam as muito curtas.
 */
function frases(texto) {
  const partes = (texto.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) || [texto]).map((x) => x.trim()).filter(Boolean);
  if (!partes.length) return [texto];
  // Primeira frase longa: corta na primeira vírgula, pra voz começar logo.
  const primeira = partes.shift();
  const virgula = primeira.indexOf(', ');
  const out = primeira.length > 60 && virgula > 8 && virgula < 90
    ? [primeira.slice(0, virgula + 1), primeira.slice(virgula + 2)]
    : [primeira];
  for (const p of partes) {
    const ultima = out[out.length - 1];
    if (out.length > 1 && (ultima.length < 25 || p.length < 15) && ultima.length + p.length < 220) {
      out[out.length - 1] += ` ${p}`;
    } else out.push(p);
  }
  return out;
}

async function gerarFala(trecho) {
  const bytes = await requisicaoLocal('speak', { text: trecho }, 'application/json');
  return audio().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

// Efeito metálico de robô por cima da voz. Desligado: o Teki quer a voz clonada idêntica.
// Pra ligar: localStorage.setItem('teko.vozMetalica', '1') no console do app.
const VOZ_METALICA = (() => { try { return localStorage.getItem('teko.vozMetalica') === '1'; } catch { return false; } })();

function tocar(som) {
  const c = audio();
  const fonte = c.createBufferSource();
  const seco = c.createGain();
  const modulador = c.createGain();
  const metal = c.createGain();
  const portadora = c.createOscillator();
  fonte.buffer = som;
  // Ring modulation em paralelo com a voz seca (só se VOZ_METALICA estiver ligada).
  seco.gain.value = VOZ_METALICA ? 0.65 : 1;
  metal.gain.value = VOZ_METALICA ? 0.35 : 0;
  portadora.frequency.value = 42;
  portadora.connect(modulador.gain);
  fonte.connect(seco);
  fonte.connect(modulador);
  modulador.connect(metal);
  seco.connect(falaAnalisador);
  metal.connect(falaAnalisador);
  falaAnalisador.connect(c.destination);
  tocando = fonte;
  ativo = falaAnalisador;
  return new Promise((resolve) => {
    fonte.onended = () => {
      portadora.stop();
      fonte.disconnect();
      seco.disconnect();
      modulador.disconnect();
      metal.disconnect();
      portadora.disconnect();
      resolve();
    };
    portadora.start();
    fonte.start();
  });
}

/** Fala frase por frase: enquanto toca uma, já gera a próxima. */
async function falar(texto, meu) {
  const lista = frases(texto);
  let proxima = gerarFala(lista[0]);
  for (let i = 0; i < lista.length; i += 1) {
    const som = await proxima;
    if (meu !== ciclo) return;
    proxima = i + 1 < lista.length ? gerarFala(lista[i + 1]) : null;
    if (!som) continue;
    aura.estado = 'falando';
    const fonte = tocar(som);
    await fonte;
    if (meu !== ciclo) return;
  }
  pararFala();
}

function pararFala() {
  if (!tocando) return;
  try { tocando.stop(); } catch { /* já parou */ }
  tocando = null;
  try { falaAnalisador.disconnect(); } catch { /* ok */ }
  if (ativo === falaAnalisador) ativo = null;
}

// ---------- WAV ----------

/** Junta os pedaços, reduz pra 16 kHz mono e monta um WAV PCM 16 bits (o que o whisper quer). */
function paraWav(pedacos, taxaOrigem) {
  const total = pedacos.reduce((n, p) => n + p.length, 0);
  const tudo = new Float32Array(total);
  let pos = 0;
  for (const p of pedacos) {
    tudo.set(p, pos);
    pos += p.length;
  }
  const alvo = 16000;
  const razao = taxaOrigem / alvo;
  const n = Math.floor(total / razao);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    const ini = Math.floor(i * razao);
    const fimJ = Math.min(total, Math.floor((i + 1) * razao));
    let soma = 0;
    for (let j = ini; j < fimJ; j += 1) soma += tudo[j];
    const v = Math.max(-1, Math.min(1, soma / Math.max(1, fimJ - ini)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const txt = (o, s) => [...s].forEach((ch, i) => dv.setUint8(o + i, ch.charCodeAt(0)));
  txt(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); txt(8, 'WAVE');
  txt(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, alvo, true); dv.setUint32(28, alvo * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  txt(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------- entradas ----------

async function apertou() {
  if (modo === 'gravando' && !gravacao?.seguimento) return;
  ciclo += 1;
  modo = 'parado';
  if (await abrirMic()) comecarGravacao({ auto: false });
}

function soltou() {
  if (modo === 'gravando' && gravacao && !gravacao.auto) terminarGravacao();
}

function mudarEscuta(ligada) {
  escuta = ligada;
  avisarIlha('teko-escuta', ligada);
  if (!ligada && modo === 'vigia') modo = 'parado';
  trecho = null;
  ajustarMic();
  mostrar('teko', ligada ? 'Iniciando escuta de “Teko”…' : 'Escuta de “Teko” desligada.', 2500);
}

async function desligarGestos(silencioso = false) {
  gestosSolicitados = false;
  cancelAnimationFrame(gestosFrame);
  gestosLandmarker?.close();
  gestosLandmarker = null;
  gestosStream?.getTracks().forEach((track) => track.stop());
  gestosStream = null;
  const video = document.getElementById('gestos-camera');
  const preview = document.getElementById('gestos-preview');
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  preview?.classList.remove('ativa');
  aura.janelaCamera(false);
  gestosBase = null;
  gestosInicio = 0;
  gestosMapaAberto = false;
  gestosEmT = false;
  aura.formaT(false);
  statusGesto('');
  if (!silencioso) mostrar('teko', 'Gesto T desligado; câmera fechada.', 3000);
}

// ---------- mover e redimensionar a aura com pinça ----------
// Uma mão em pinça segura a aura e arrasta; as duas em pinça afastando ou aproximando
// mudam o tamanho. Segurar ~0,25 s antes de pegar evita mexer sem querer.
const AURA_GUARDADA = 'teko.aura.geo';
const GANHO_MOVER = 1.6; // a mão anda pouco na frente da câmera; a aura anda mais na tela
// Três tamanhos fixos: afastar as mãos sobe um, aproximar desce um.
const AURA_BASE = { largura: 460, altura: 520 };
const TAMANHOS_AURA = [
  { nome: 'pequena', escala: 0.7 },
  { nome: 'padrão', escala: 1 },
  { nome: 'grande', escala: 1.35 },
];
const PASSO_AFASTAR = 1.3; // distância entre as pinças precisa crescer 30% pra subir um tamanho
const PASSO_APROXIMAR = 0.77;
/** Índice do tamanho mais próximo da largura atual. */
const tamanhoAtual = (largura) => {
  let melhor = 1;
  TAMANHOS_AURA.forEach((t, i) => {
    if (Math.abs(AURA_BASE.largura * t.escala - largura) < Math.abs(AURA_BASE.largura * TAMANHOS_AURA[melhor].escala - largura)) melhor = i;
  });
  return melhor;
};
let pegada = null; // { tipo, geo, p0, d0, estadoAntes }
let pincaTipo = null;
let pincaDesde = 0;
let posicionando = false;

const emPinca = (m) => Math.hypot(m[4].x - m[8].x, m[4].y - m[8].y) < 0.05;
const pontoPinca = (m) => ({ x: (m[4].x + m[8].x) / 2, y: (m[4].y + m[8].y) / 2 });

async function aplicarGeo(geo) {
  if (posicionando) return; // ainda aplicando o quadro anterior
  posicionando = true;
  try {
    await window.__TAURI__.core.invoke('posicionar_aura', { x: geo.x, y: geo.y, largura: geo.largura, altura: geo.altura });
  } catch (err) {
    console.warn('[Teko] mover aura:', err);
  } finally {
    posicionando = false;
  }
}

async function soltarAura() {
  if (!pegada) return;
  const antes = pegada.estadoAntes;
  pegada = null;
  if (aura.estado === 'gesto') aura.estado = antes || 'parado';
  statusGesto('');
  try {
    const geo = await window.__TAURI__.core.invoke('aura_geometria');
    localStorage.setItem(AURA_GUARDADA, JSON.stringify({ x: geo.x, y: geo.y, largura: geo.largura, altura: geo.altura }));
  } catch { /* sem armazenamento: só não lembra a posição */ }
}

/** Trata a pinça neste quadro. Devolve true quando a pinça é dela (o resto dos gestos espera). */
async function tratarPinca(maos, agora) {
  const pincando = maos.filter(emPinca);
  const tipo = pincando.length >= 2 ? 'tamanho' : pincando.length === 1 ? 'mover' : null;
  if (tipo !== pincaTipo) {
    await soltarAura();
    pincaTipo = tipo;
    pincaDesde = agora;
  }
  if (!tipo) return false;
  if (!pegada) {
    if (agora - pincaDesde < 250) return true;
    let geo;
    try { geo = await window.__TAURI__.core.invoke('aura_geometria'); } catch { return true; }
    const [a, b] = pincando.map(pontoPinca);
    pegada = { tipo, geo, p0: a, d0: b ? Math.hypot(a.x - b.x, a.y - b.y) : 0, estadoAntes: aura.estado };
    if (aura.estado === 'parado') aura.estado = 'gesto'; // mostra a aura enquanto segura
    statusGesto(tipo === 'mover' ? 'Movendo a aura · solte a pinça pra largar' : 'Mudando o tamanho · afaste ou aproxime as mãos');
    return true;
  }
  const { geo } = pegada;
  if (pegada.tipo === 'mover') {
    const p = pontoPinca(pincando[0]);
    // A câmera vê espelhado: mão pra sua direita = x menor na imagem.
    const dx = -(p.x - pegada.p0.x) * geo.tela_largura * GANHO_MOVER;
    const dy = (p.y - pegada.p0.y) * geo.tela_altura * GANHO_MOVER;
    await aplicarGeo({ x: geo.x + dx, y: geo.y + dy, largura: geo.largura, altura: geo.altura });
  } else {
    const [a, b] = pincando.map(pontoPinca);
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const razao = d / Math.max(pegada.d0, 0.01);
    const atual = tamanhoAtual(geo.largura);
    const proximo = razao >= PASSO_AFASTAR ? atual + 1 : razao <= PASSO_APROXIMAR ? atual - 1 : atual;
    if (proximo !== atual && proximo >= 0 && proximo < TAMANHOS_AURA.length) {
      const t = TAMANHOS_AURA[proximo];
      const largura = AURA_BASE.largura * t.escala;
      const altura = AURA_BASE.altura * t.escala;
      // Cresce a partir do centro: o meio da aura fica no lugar.
      const novo = { x: geo.x + (geo.largura - largura) / 2, y: geo.y + (geo.altura - altura) / 2, largura, altura };
      posicionando = false; // troca de tamanho não pode ser pulada
      await aplicarGeo(novo);
      // Nova base: dá pra continuar afastando pra subir mais um.
      pegada.geo = { ...geo, ...novo };
      pegada.d0 = d;
      statusGesto(`Aura ${t.nome}`);
    }
  }
  return true;
}

// Diagonal: mãos já separadas se afastando rápido em diagonais opostas (↖ ↘ ou ↗ ↙)
// centraliza a aura no tamanho padrão. Mesmo gesto que abre a rede inteira no mapa.
let historicoMaos = [];
let diagonalEm = 0;

/** Devolve true quando o gesto diagonal aconteceu neste quadro. */
function gestoDiagonal(maos, agora) {
  if (maos.length < 2) { historicoMaos = []; return false; }
  const [esq, dir] = [maos[0][9], maos[1][9]].sort((p, q) => p.x - q.x);
  const d = Math.hypot(esq.x - dir.x, esq.y - dir.y);
  historicoMaos = historicoMaos.filter((h) => agora - h.t < 500);
  historicoMaos.push({ t: agora, a: { x: esq.x, y: esq.y }, b: { x: dir.x, y: dir.y }, d });
  const antigo = historicoMaos[0];
  if (!antigo || agora - antigo.t < 150 || antigo.d < 0.2 || agora - diagonalEm < 1500) return false;
  const da = { x: esq.x - antigo.a.x, y: esq.y - antigo.a.y };
  const db = { x: dir.x - antigo.b.x, y: dir.y - antigo.b.y };
  const diagonal = (v) => Math.min(Math.abs(v.x), Math.abs(v.y)) / Math.max(Math.abs(v.x), Math.abs(v.y), 1e-6) > 0.35;
  const forte = (v) => Math.hypot(v.x, v.y) > 0.07;
  if (!(forte(da) && forte(db) && diagonal(da) && diagonal(db) && da.x * db.x + da.y * db.y < 0 && d - antigo.d > 0.1)) return false;
  diagonalEm = agora;
  historicoMaos = [];
  window.__TAURI__.core.invoke('aura_centralizar').catch((err) => console.warn('[Teko] centralizar aura:', err));
  statusGesto('Aura no centro, tamanho padrão');
  setTimeout(() => statusGesto(''), 1500);
  return true;
}

/** Volta pra onde você deixou a aura da última vez. */
// ---------- mostrar ou esconder a aura ----------
// Ligada, a aura fica na tela o tempo todo (parada, girando devagar e mais apagada).
// Desligada, não desenha nada (a ilha cuida da conversa), mas a janela continua rodando
// microfone, câmera e gestos. Estalo liga; juntar as mãos desliga.
const AURA_LIGADA = 'teko.aura.visivel';
let auraLigada = true;
try { auraLigada = localStorage.getItem(AURA_LIGADA) !== '0'; } catch { /* padrão: ligada */ }

function aplicarAuraVisivel() {
  document.body.classList.toggle('sem-aura', !auraLigada);
  aura.repouso(auraLigada);
}

// Juntar as mãos desliga a aura, igual fechar o mapa: juntas e paradas ~0,5 s, ou
// afastar e juntar. Mãos cruzadas são o T e não contam.
// Com as palmas encostadas a câmera às vezes perde uma das mãos: se uma some logo depois
// de estarem juntas, continua valendo.
let juntasDesde = 0;
let desligouEm = 0;
let ultimoPar = null; // { d, t } da última vez que as duas mãos apareceram
let afastadasEm = 0;

const anguloMao = (m) => Math.atan2(m[9].y - m[0].y, m[9].x - m[0].x);

/** Distância entre as mãos agora (ou logo antes de a câmera perder uma), ou null. */
function distanciaMaos(maos, agora) {
  if (maos.length >= 2) return Math.hypot(maos[0][9].x - maos[1][9].x, maos[0][9].y - maos[1][9].y);
  if (maos.length === 1 && ultimoPar && agora - ultimoPar.t < 400) return ultimoPar.d;
  return null;
}

/** Mãos perto uma da outra: aí não é pinça (o polegar encosta no indicador com as palmas juntas). */
function maosPerto(maos, agora) {
  const d = distanciaMaos(maos, agora);
  const perto = d != null && d < 0.2;
  // Juntar as mãos faz barulho; não pode virar "estalo".
  if (perto) estaloSilenciadoAte = Math.max(estaloSilenciadoAte, agora + 1500);
  return perto;
}

function gestoJuntar(maos, agora) {
  if (maos.length >= 2) {
    const d = Math.hypot(maos[0][9].x - maos[1][9].x, maos[0][9].y - maos[1][9].y);
    ultimoPar = { d, t: agora };
    if (d > 0.3) afastadasEm = agora;
    // Cruzadas = T, não é juntar.
    if (Math.abs(Math.cos(anguloMao(maos[0]) - anguloMao(maos[1]))) < 0.6) { juntasDesde = 0; return false; }
  }
  if (!auraLigada || gestosEmT || agora - desligouEm < 1500) { juntasDesde = 0; return false; }
  const d = distanciaMaos(maos, agora);
  if (d == null) { juntasDesde = 0; return false; }
  const desligar = () => {
    juntasDesde = 0;
    afastadasEm = 0;
    desligouEm = agora;
    window.__TAURI__.core.invoke('definir_aura', { visivel: false }).catch(() => {});
    mostrar('teko', 'Aura desligada. Estale os dedos pra chamar de novo.', 2500);
    return true;
  };
  if (d < 0.12 && agora - afastadasEm < 2500) return desligar(); // afastar e juntar
  if (d < 0.16) {
    juntasDesde = juntasDesde || agora;
    if (agora - juntasDesde >= 500) return desligar();
  } else {
    juntasDesde = 0;
  }
  return false;
}

async function restaurarAura() {
  try {
    const salvo = JSON.parse(localStorage.getItem(AURA_GUARDADA) || 'null');
    if (salvo && Number.isFinite(salvo.x)) await aplicarGeo(salvo);
  } catch { /* nada salvo */ }
}

// Um pedido de câmera por vez: dois juntos (abertura do app + "religar" ao fechar o mapa)
// fazem o WebView cancelar um deles com AbortError.
let ligandoGestos = null;
function ligarGestos() {
  if (gestosStream) return Promise.resolve();
  if (!ligandoGestos) ligandoGestos = ligarGestosAgora().finally(() => { ligandoGestos = null; });
  return ligandoGestos;
}

/**
 * Pede a câmera tentando de novo quando ela está ocupada ou o pedido foi cancelado:
 * ao fechar o mapa, a janela dele ainda está soltando a câmera por um instante.
 */
async function pedirCamera() {
  const esperas = [0, 500, 1000, 2000, 3500];
  let ultimoErro = null;
  for (const ms of esperas) {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    if (!gestosSolicitados) return null;
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      ultimoErro = err;
      // Permissão negada ou sem câmera: tentar de novo não adianta.
      if (!['AbortError', 'NotReadableError', 'TrackStartError'].includes(err?.name)) throw err;
      console.warn(`[Teko] câmera ocupada (${err.name}), tentando de novo…`);
    }
  }
  throw ultimoErro;
}

async function ligarGestosAgora() {
  if (gestosStream) return;
  gestosSolicitados = true;
  const video = document.getElementById('gestos-camera');
  const preview = document.getElementById('gestos-preview');
  const previewCtx = preview?.getContext('2d');
  let ultimoQuadroPrevia = 0;
  const dpr = window.devicePixelRatio || 1;
  // Resolução do maior tamanho da aura, pra prévia ficar nítida em qualquer um dos três.
  if (preview) { preview.width = Math.round(272 * TAMANHOS_AURA.at(-1).escala * dpr); preview.height = Math.round(204 * TAMANHOS_AURA.at(-1).escala * dpr); }
  let etapa = 'pedir permissão para a câmera';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('câmera indisponível neste app');
    mostrar('teko', 'Ativando gesto T automaticamente enquanto o Teko estiver aberto…');
    gestosStream = await pedirCamera();
    if (!gestosStream || !gestosSolicitados) return desligarGestos(true);
    // Se a câmera cair no meio (outro app pegou, Mac dormiu), religa sozinho.
    gestosStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (!gestosSolicitados) return;
      desligarGestos(true).then(() => setTimeout(() => ligarGestos(), 1000));
    });
    etapa = 'iniciar a câmera';
    video.srcObject = gestosStream;
    await video.play();
    etapa = 'carregar o detector local';
    const visionUrl = new URL('./vendor/mediapipe/vision_bundle.mjs', window.location.href).href;
    const vision = await import(visionUrl);
    const wasmUrl = new URL('./vendor/mediapipe/wasm/', window.location.href).href;
    etapa = 'preparar o runtime visual';
    const files = await vision.FilesetResolver.forVisionTasks(wasmUrl);
    etapa = 'carregar o modelo de mãos';
    // GPU deixa o detector fluido e alivia a CPU; se o WebGL falhar, volta pra CPU.
    const opcoes = (delegate) => ({
      baseOptions: { modelAssetPath: new URL('./models/hand_landmarker.task', window.location.href).href, delegate },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: .48, minHandPresenceConfidence: .45, minTrackingConfidence: .45,
    });
    try {
      gestosLandmarker = await vision.HandLandmarker.createFromOptions(files, opcoes('GPU'));
    } catch (err) {
      console.warn('[Teko] detector na GPU falhou, usando CPU:', err);
      gestosLandmarker = await vision.HandLandmarker.createFromOptions(files, opcoes('CPU'));
    }
    if (!gestosSolicitados) return desligarGestos(true);
    mostrar('teko', 'Gestos prontos. Forme um T com as mãos e descole para abrir o mapa.');
    statusGesto('Gestos ligados · mostre as duas mãos');

    // ~8 quadros por segundo bastam pra gesto (a 60 quadros/s ele usava ~80% da GPU e
    // atrasava a fala); durante a conversa cai pra ~4 quadros/s.
    let ultimaDeteccao = 0;
    const animate = async () => {
      const agora = performance.now();
      // Na conversa os gestos continuam, só mais devagar (~4 quadros/s) pra não disputar a GPU com a voz.
      const emConversa = modo === 'ocupado' || modo === 'gravando';
      // Segurando a aura, mais quadros por segundo pra ela seguir a mão sem tranco.
      const pausado = agora - ultimaDeteccao < (pegada ? 45 : emConversa ? 250 : 120);
      if (!gestosSolicitados || !gestosLandmarker || video.readyState < 2 || pausado) {
        if (gestosSolicitados) gestosFrame = requestAnimationFrame(animate);
        return;
      }
      ultimaDeteccao = agora;
      try {
        const timestamp = performance.now();
        if (previewCtx && preview && video.readyState >= 2 && timestamp - ultimoQuadroPrevia > 50) {
          ultimoQuadroPrevia = timestamp;
          previewCtx.drawImage(video, 0, 0, preview.width, preview.height);
        }
        const result = gestosLandmarker.detectForVideo(video, timestamp);
        const detectedHands = result.landmarks || [];
        // A janelinha da câmera aparece com as duas mãos na imagem (ou segurando a aura na pinça).
        const janelaAberta = detectedHands.length >= 2 || Boolean(pegada);
        preview?.classList.toggle('ativa', janelaAberta);
        aura.janelaCamera(janelaAberta);
        // Pinça (polegar encostando no indicador) confirma uma aprovação pendente.
        if (aprovacao && detectedHands.some((m) => Math.hypot(m[4].x - m[8].x, m[4].y - m[8].y) < 0.045)) {
          aprovacao.responder(true);
        }
        const agoraGesto = performance.now();
        // Logo depois do T, afastar as mãos é abrir o mapa: diagonal e juntar ficam de fora.
        const depoisDoT = gestosEmT || (gestosBase != null && agoraGesto - gestosInicio < 2500);
        // Juntar as mãos (desliga a aura) vem antes da pinça: com as palmas juntas o polegar
        // encosta no indicador e virava "pinça de duas mãos".
        if (!depoisDoT && !gestosMapaAberto && gestoJuntar(detectedHands, agoraGesto)) {
          if (gestosSolicitados) gestosFrame = requestAnimationFrame(animate);
          return;
        }
        // Pinça sem aprovação pendente = mover ou redimensionar a aura (só com as mãos longe).
        if (!aprovacao && !gestosMapaAberto && !maosPerto(detectedHands, agoraGesto) && (await tratarPinca(detectedHands, agoraGesto))) {
          if (gestosSolicitados) gestosFrame = requestAnimationFrame(animate);
          return;
        }
        // Diagonal centraliza a aura.
        if (!depoisDoT && !gestosMapaAberto && gestoDiagonal(detectedHands, agoraGesto)) {
          if (gestosSolicitados) gestosFrame = requestAnimationFrame(animate);
          return;
        }
        const hands = detectedHands.filter((landmarks) => {
          const wrist = landmarks[0];
          const extended = [8, 12, 16, 20].filter((tip, index) => {
            const pip = [6, 10, 14, 18][index];
            return Math.hypot(landmarks[tip].x - wrist.x, landmarks[tip].y - wrist.y) >
              Math.hypot(landmarks[pip].x - wrist.x, landmarks[pip].y - wrist.y) * 1.05;
          }).length;
          return extended >= 2; // mão aberta (tolera dedos meio dobrados)
        });
        const now = performance.now();
        // Depois do T, a janela pra descolar fica aberta 2,5 s desde a última vez que o T foi visto.
        const emJanela = gestosBase != null && now - gestosInicio < 2500;
        const abrirMapa = async () => {
          aura.formaT(false);
          gestosEmT = false;
          gestosMapaAberto = true;
          try {
            await desligarGestos(true);
            await window.__TAURI__.core.invoke('open_context_map');
            mostrar('teko', 'Mapa neural aberto. Junte as mãos para fechar.', 3500);
          } catch (err) {
            gestosMapaAberto = false;
            mostrar('erro', `Não consegui abrir o mapa: ${err.message || err}`, 5000);
            await ligarGestos();
          }
        };
        // Descolar o T já abre: basta as mãos se afastarem um pouco, mesmo que os dedos
        // fechem ou que o detector perca uma mão por um instante.
        if (emJanela && !gestosMapaAberto && detectedHands.length >= 2) {
          const d = Math.hypot(detectedHands[0][9].x - detectedHands[1][9].x, detectedHands[0][9].y - detectedHands[1][9].y);
          // Afastar ~6% da imagem: mais que um tremor das mãos, sem precisar abrir os braços.
          if (d > gestosBase + .06) await abrirMapa();
        }
        if (gestosMapaAberto) {
          // já abriu neste quadro
        } else if (detectedHands.length >= 2 && hands.length >= 1) {
          // T tolerante: basta uma mão aberta (a outra pode estar meio fechada).
          const [m1, m2] = detectedHands;
          const a = m1[9], b = m2[9];
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          const angleA = Math.atan2(m1[9].y - m1[0].y, m1[9].x - m1[0].x);
          const angleB = Math.atan2(m2[9].y - m2[0].y, m2[9].x - m2[0].x);
          // Cruzadas: a partir de ~30° entre as mãos já conta (um T perfeito é 90°);
          // lado a lado (paralelas) não.
          const cruzadas = Math.abs(Math.cos(angleA - angleB)) < .87;
          // Encostando: ponta de algum dedo de uma mão perto da palma da outra.
          const encosta = (p, q) => Math.min(...[4, 8, 12, 16, 20].flatMap((t) => [0, 5, 9, 13, 17].map((k) => Math.hypot(p[t].x - q[k].x, p[t].y - q[k].y))));
          const juntas = distance < .33 || Math.min(encosta(m1, m2), encosta(m2, m1)) < .1;
          // Mão passando na frente da câmera não arma o T.
          if (cruzadas && juntas) tDesde = tDesde || now; else tDesde = 0;
          // Firme por 0,35 s: o mapa só abre de propósito.
          const formsT = cruzadas && juntas && now - tDesde >= 350;
          if (formsT) {
            aura.formaT(true);
            statusGesto('T reconhecido · agora descole as mãos');
            if (!gestosEmT) mostrar('teko', 'T reconhecido. Descole as mãos para abrir o mapa.', 1800);
            gestosEmT = true;
            // Base = o T mais junto visto; a janela renova enquanto o T continua.
            gestosBase = gestosBase == null || !emJanela ? distance : Math.min(gestosBase, distance);
            gestosInicio = now;
          } else if (!emJanela) {
            gestosBase = null;
            aura.formaT(false);
            gestosEmT = false;
            statusGesto('Forme um T com as mãos e depois descole');
          }
        } else if (!emJanela) {
          gestosBase = null;
          gestosInicio = 0;
          aura.formaT(false);
          gestosEmT = false;
          tDesde = 0;
          statusGesto(detectedHands.length < 2
            ? 'Mostre as duas mãos para a câmera'
            : 'Abra os dedos de uma das mãos');
        }
      } catch (err) {
        console.error('[Teko] erro no detector de gestos:', err);
      }
      if (gestosSolicitados) gestosFrame = requestAnimationFrame(animate);
    };
    gestosFrame = requestAnimationFrame(animate);
  } catch (err) {
    await desligarGestos(true);
    const detalhe = [err.name, err.message].filter(Boolean).join(': ');
    statusGesto(`Câmera indisponível: ${detalhe || err}`);
    mostrar('erro', `Falha ao ${etapa}: ${detalhe || err}`);
  }
}

if (window.__TAURI__) {
  const { listen } = window.__TAURI__.event;
  listen('falar', ({ payload }) => (payload ? apertou() : soltou()));
  listen('escuta', ({ payload }) => mudarEscuta(Boolean(payload)));
  listen('microfone', ({ payload }) => definirMic(Boolean(payload)));
  // Sincroniza o menu da barra com o que ficou salvo da última vez.
  window.__TAURI__.core.invoke('definir_microfone', { ligado: micLigado }).catch(() => {});
  listen('estalo', ({ payload }) => {
    estaloLigado = Boolean(payload);
    detectorEstalo?.reset();
    mostrar('teko', estaloLigado ? 'Um estalo de dedos chama o Teko.' : 'Estalo desligado.', 2200);
  });
  listen('gestos', ({ payload }) => {
    // Os gestos voltam quando o mapa fecha: o barulho de juntar as mãos ainda está no ar.
    if (payload && mapaAbertoAgora) {
      mapaAbertoAgora = false;
      estaloSilenciadoAte = performance.now() + 2500;
    }
    return payload ? ligarGestos() : desligarGestos();
  });
  listen('cancelar', () => cancelarConversa());
  listen('mapa-aberto', () => {
    mapaAbertoAgora = true;
    desligarGestos(true);
  });
  // "Centralizar aura" no menu da barra: esquece a posição guardada.
  listen('aura-centralizada', () => { try { localStorage.removeItem(AURA_GUARDADA); } catch { /* ok */ } });
  restaurarAura();
  // Ligar/desligar a aura (menu da barra ou botão da ilha).
  listen('aura-visivel', ({ payload }) => {
    auraLigada = Boolean(payload);
    try { localStorage.setItem(AURA_LIGADA, auraLigada ? '1' : '0'); } catch { /* só não lembra */ }
    aplicarAuraVisivel();
  });
  aplicarAuraVisivel();
  // Sincroniza o menu da barra com o que ficou salvo da última vez.
  window.__TAURI__.core.invoke('definir_aura', { visivel: auraLigada }).catch(() => {});
  // A ilha abre depois da aura: quando ela avisa que está pronta, manda o estado atual.
  listen('ilha-pronta', () => {
    avisarIlha('teko-escuta', escuta);
    avisarIlha('teko-estado', aura.estado);
    avisarIlha('aura-visivel', auraLigada);
    avisarIlha('teko-mic', micLigado);
  });
  // Ilha do notch: botão Falar (ouve até você parar) e pedido digitado (mesmo fluxo da voz).
  listen('ilha-falar', async () => {
    if (modo === 'gravando') return terminarGravacao();
    ciclo += 1;
    modo = 'parado';
    if (await abrirMic()) comecarGravacao({ auto: true });
  });
  listen('ilha-pedido', ({ payload }) => {
    const texto = String(payload || '').trim();
    if (!texto) return;
    if (modo === 'gravando' || modo === 'ocupado') cancelarConversa();
    const meu = ++ciclo;
    mostrar('você', texto);
    responder(texto, meu);
  });
} else {
  // Fora do Tauri (navegador, pra testar): barra de espaço faz o papel do atalho.
  window.addEventListener('keydown', (e) => e.code === 'Space' && !e.repeat && apertou());
  window.addEventListener('keyup', (e) => e.code === 'Space' && soltou());
}

// Estado pra depurar no console do webview: __teko()
window.__teko = () => ({ modo, escuta, mic: Boolean(mic), audio: ctx?.state, piso: Number(piso.toFixed(4)), pico: Number(pico.toFixed(4)), ouvido, conferindo });

mostrar('teko', 'Iniciando escuta do microfone…');
ajustarMic();
// O gesto T é parte do modo normal do Teko: a câmera fica ativa só enquanto o app estiver aberto.
// O item no menu da barra permite desligar temporariamente a detecção.
ligarGestos();
