// Fluxo de voz do Teko no Mac.
//
// Dois jeitos de chamar:
//   1. Falar "Teko" (escuta ligada no menu da barra): um detector de volume recorta trechos curtos
//      de fala e o servidor confere, com whisper local, se começam com "Teko".
//      "Teko, pergunta..." numa frase só vai direto; "Teko" sozinho abre a escuta do comando.
//   2. Segurar ⌥ Espaço: grava enquanto segura.
// Depois: transcrever (whisper local) -> Teko responde (perfil Voz) -> falar (say do macOS).
// Tudo passa só pelo servidor local do Teko (npm start) em 127.0.0.1:4780.

import { criarAura } from './aura.js';

const API = 'http://127.0.0.1:4780/api';
const aura = criarAura(document.getElementById('aura'));
const legenda = document.getElementById('legenda');

// Detector de fala (VAD) por volume. Um quadro = 4096 amostras (~85 ms a 48 kHz).
const VAD = {
  inicio: 0.015, // volume mínimo pra considerar fala
  fimTrecho: 7, // quadros de silêncio que fecham um trecho na vigia (~0,6 s)
  fimComando: 14, // no comando, espera mais (~1,2 s) pra você terminar de falar
  preRoll: 4, // quadros guardados antes da fala começar (não cortar o "T" do Teko)
  maxTrecho: 6000, // ms: trecho de vigia mais longo que isso é descartado
  maxComando: 15000,
  esperaComando: 5000, // se ninguém falar depois do "Teko", desiste
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
let pico = 0; // maior volume visto (depuração)
let ouvido = ''; // último trecho conferido (depuração)
let tocando = null;
let sessionId = null;
let ciclo = 0;
let taxa = 48000;

function mostrar(quem, texto, apagarEm = 0) {
  if (!texto) {
    legenda.classList.remove('on');
    return;
  }
  legenda.innerHTML = '';
  const q = document.createElement('span');
  q.className = 'quem';
  q.textContent = quem;
  legenda.append(q, document.createTextNode(texto));
  legenda.classList.add('on');
  if (apagarEm) {
    const meu = ciclo;
    setTimeout(() => meu === ciclo && modo !== 'gravando' && mostrar(), apagarEm);
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
  if (ctx.state === 'suspended') ctx.resume();
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
  if (mic) return true;
  const c = audio();
  try {
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
    if ((await abrirMic()) && modo === 'parado' && escuta) modo = 'vigia';
  } else {
    fecharMic();
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
    const res = await fetch(`${API}/voice/wake`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
    if (!res.ok || modo !== 'vigia') return;
    const { wake, rest, text } = await res.json();
    ouvido = text || '';
    if (!wake) return;
    ciclo += 1;
    bipe();
    if (rest && rest.split(/\s+/).length >= 2) {
      // "Teko, qual a capital do Maranhão?" -> já é a pergunta.
      mostrar('você', rest);
      await responder(rest, ciclo);
    } else {
      comecarGravacao({ auto: true });
    }
  } catch {
    // servidor fora do ar: a vigia continua tentando nos próximos trechos
  } finally {
    conferindo = false;
  }
}

// ---------- gravação do comando ----------

function comecarGravacao({ auto }) {
  pararFala();
  gravacao = { pedacos: [], inicio: performance.now(), auto, falou: false, silencio: 0 };
  modo = 'gravando';
  ativo = micAnalisador;
  aura.estado = 'ouvindo';
  mostrar('ouvindo', auto ? 'Pode falar.' : '…');
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
  else if (!g.falou && dur > VAD.esperaComando) cancelarGravacao();
}

function cancelarGravacao() {
  gravacao = null;
  ativo = null;
  modo = 'parado';
  aura.estado = 'parado';
  mostrar();
  ajustarMic();
}

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
    const t = await fetch(`${API}/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: paraWav(g.pedacos, taxa),
    });
    const { text, error } = await t.json();
    if (!t.ok) throw new Error(error || `transcrição falhou (${t.status})`);
    if (!text) {
      mostrar('ouvi', 'Não entendi. Fala de novo.', 3000);
      return fim(meu);
    }
    mostrar('você', text);
    await responder(text, meu);
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
    await falar(resposta, meu);
    if (meu === ciclo) mostrar('teko', resposta, 2500);
  } catch (err) {
    return erro(err, meu);
  }
  fim(meu);
}

function fim(meu) {
  if (meu !== ciclo) return;
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
  const res = await fetch(`${API}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: texto, sessionId, profileId: 'voice' }),
  });
  if (!res.ok || !res.body) throw new Error(`Teko respondeu ${res.status}`);
  const leitor = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  let resposta = '';
  let falha = null;
  while (true) {
    const { done, value } = await leitor.read();
    if (done) break;
    if (meu !== ciclo) {
      leitor.cancel();
      return null;
    }
    buffer += dec.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) !== -1) {
      const linha = buffer.slice(0, i).split('\n').find((l) => l.startsWith('data:'));
      buffer = buffer.slice(i + 2);
      if (!linha) continue;
      let ev;
      try { ev = JSON.parse(linha.slice(5)); } catch { continue; }
      if (ev.type === 'meta') sessionId = ev.sessionId;
      if (ev.type === 'delta') resposta += ev.text;
      if (ev.type === 'done' && typeof ev.text === 'string') resposta = ev.text;
      if (ev.type === 'error') falha = ev.message;
    }
  }
  if (!resposta && falha) throw new Error(falha);
  return resposta;
}

async function falar(texto, meu) {
  const res = await fetch(`${API}/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: texto }),
  });
  if (!res.ok || meu !== ciclo) return;
  const c = audio();
  const som = await c.decodeAudioData(await res.arrayBuffer());
  if (meu !== ciclo) return;
  const fonte = c.createBufferSource();
  fonte.buffer = som;
  fonte.connect(falaAnalisador);
  falaAnalisador.connect(c.destination);
  tocando = fonte;
  ativo = falaAnalisador;
  aura.estado = 'falando';
  await new Promise((resolve) => {
    fonte.onended = resolve;
    fonte.start();
  });
  if (tocando === fonte) pararFala();
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
  if (modo === 'gravando') return;
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
  mostrar('teko', ligada ? 'Pode me chamar: "Teko".' : 'Não estou mais ouvindo o "Teko".', 2500);
}

if (window.__TAURI__) {
  const { listen } = window.__TAURI__.event;
  listen('falar', ({ payload }) => (payload ? apertou() : soltou()));
  listen('escuta', ({ payload }) => mudarEscuta(Boolean(payload)));
} else {
  // Fora do Tauri (navegador, pra testar): barra de espaço faz o papel do atalho.
  window.addEventListener('keydown', (e) => e.code === 'Space' && !e.repeat && apertou());
  window.addEventListener('keyup', (e) => e.code === 'Space' && soltou());
}

// Estado pra depurar no console do webview: __teko()
window.__teko = () => ({ modo, escuta, mic: Boolean(mic), audio: ctx?.state, piso: Number(piso.toFixed(4)), pico: Number(pico.toFixed(4)), ouvido, conferindo });

ajustarMic();
