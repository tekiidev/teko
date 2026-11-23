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

const API = 'http://127.0.0.1:4780/api';
const ROTAS_VOZ = {
  wake: `${API}/voice/wake`,
  transcribe: `${API}/voice/transcribe`,
  chat: `${API}/chat`,
  speak: `${API}/voice/speak`,
};
const aura = criarAura(document.getElementById('aura'));
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
  if (modo === 'gravando' || escuta) {
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
    if (modo === 'parado') {
      ativo = null;
      aura.estado = 'parado';
    }
  }
}

function aoQuadro(quadro) {
  const v = rms(quadro);
  if (v > pico) pico = v;
  if (modo === 'gravando') return gravarQuadro(quadro, v);
  if (modo === 'vigia') return vigiar(quadro, v);
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
      if (text) mostrar('não reconheci', `“${text}”`, 1800);
      return;
    }
    ciclo += 1;
    bipe();
    if (rest && rest.split(/\s+/).length >= 2) {
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

function comecarGravacao({ auto, seguimento = false }) {
  pararFala();
  gravacao = { pedacos: [], inicio: performance.now(), auto, seguimento, falou: false, silencio: 0 };
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

async function responder(texto, meu) {
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
  modo = 'parado';
  aura.estado = 'parado';
  ajustarMic();
}

function erro(err, meu) {
  const msg = String(err?.message || err);
  mostrar('erro', /Failed to fetch|Load failed|NetworkError/.test(msg) ? 'Teko desligado. Rode npm start.' : msg, 5000);
  fim(meu);
}

async function perguntar(texto, meu) {
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

async function ligarGestos() {
  if (gestosStream) return;
  gestosSolicitados = true;
  const video = document.getElementById('gestos-camera');
  const preview = document.getElementById('gestos-preview');
  const previewCtx = preview?.getContext('2d');
  let ultimoQuadroPrevia = 0;
  const dpr = window.devicePixelRatio || 1;
  if (preview) { preview.width = Math.round(272 * dpr); preview.height = Math.round(204 * dpr); }
  let etapa = 'pedir permissão para a câmera';
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('câmera indisponível neste app');
    mostrar('teko', 'Ativando gesto T automaticamente enquanto o Teko estiver aberto…');
    gestosStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    if (!gestosSolicitados) return desligarGestos(true);
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
    mostrar('teko', 'Gestos prontos. Junte as mãos abertas e afaste para abrir o mapa.');
    statusGesto('Gestos ligados · mostre as duas mãos');

    // ~8 quadros por segundo bastam pra gesto, e o detector pausa enquanto o Teko ouve,
    // pensa ou fala: a GPU fica livre pra transcrição e pra voz (a 60 quadros/s ele usava
    // ~80% da GPU e atrasava a fala).
    let ultimaDeteccao = 0;
    const animate = async () => {
      const agora = performance.now();
      const pausado = modo === 'ocupado' || modo === 'gravando' || agora - ultimaDeteccao < 120;
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
        const janelaAberta = detectedHands.length >= 2;
        preview?.classList.toggle('ativa', janelaAberta);
        aura.janelaCamera(janelaAberta);
        const hands = detectedHands.filter((landmarks) => {
          const wrist = landmarks[0];
          const extended = [8, 12, 16, 20].filter((tip, index) => {
            const pip = [6, 10, 14, 18][index];
            return Math.hypot(landmarks[tip].x - wrist.x, landmarks[tip].y - wrist.y) >
              Math.hypot(landmarks[pip].x - wrist.x, landmarks[pip].y - wrist.y) * 1.05;
          }).length;
          return extended >= 2; // mão aberta (tolera dedos meio dobrados)
        });
        if (hands.length >= 2 && !gestosMapaAberto) {
          const a = hands[0][9], b = hands[1][9];
          const distance = Math.hypot(a.x - b.x, a.y - b.y);
          const angleA = Math.atan2(hands[0][9].y - hands[0][0].y, hands[0][9].x - hands[0][0].x);
          const angleB = Math.atan2(hands[1][9].y - hands[1][0].y, hands[1][9].x - hands[1][0].x);
          // Começo do gesto: mãos abertas próximas (em T ou lado a lado). Depois é só afastar.
          const emT = distance < .28 && Math.abs(Math.cos(angleA - angleB)) < .62;
          const formsT = emT || distance < .3;
          const now = performance.now();
          if (gestosBase != null && now - gestosInicio < 4500 && distance > gestosBase + .12) {
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
          } else if (formsT) {
            aura.formaT(true);
            statusGesto('Mãos juntas · agora afaste para abrir o mapa');
            if (!gestosEmT) mostrar('teko', 'Agora afaste as mãos para abrir o mapa.', 1800);
            gestosEmT = true;
            if (gestosBase == null || now - gestosInicio >= 4500) {
              gestosBase = distance;
              gestosInicio = now;
            }
          } else if (now - gestosInicio >= 4500) {
            gestosBase = null;
            aura.formaT(false);
            gestosEmT = false;
            statusGesto('Junte as mãos abertas e depois afaste');
          } else {
            aura.formaT(false);
            gestosEmT = false;
            statusGesto('Junte as mãos abertas e depois afaste');
          }
        } else if (hands.length < 2) {
          gestosBase = null;
          gestosInicio = 0;
          aura.formaT(false);
          gestosEmT = false;
          statusGesto(detectedHands.length < 2
            ? 'Mostre as duas mãos para a câmera'
            : 'Abra os dedos das duas mãos');
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
  listen('gestos', ({ payload }) => (payload ? ligarGestos() : desligarGestos()));
  listen('mapa-aberto', () => desligarGestos(true));
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
