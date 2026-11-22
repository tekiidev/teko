// Fluxo de voz: segurar atalho -> gravar -> transcrever (whisper local) -> Teko responde -> falar.
// Fala com o servidor do Teko (npm start) em 127.0.0.1:4780.

import { criarAura } from './aura.js';

const API = 'http://127.0.0.1:4780/api';
const aura = criarAura(document.getElementById('aura'));
const legenda = document.getElementById('legenda');

let ctx = null; // AudioContext
let analisador = null;
let gravando = null; // { stream, fonte, processador, pedacos, taxa, inicio }
let tocando = null; // AudioBufferSourceNode
let sessionId = null;
let ciclo = 0; // invalida respostas antigas quando você fala de novo

function mostrar(quem, texto) {
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
}

function audio() {
  if (!ctx) {
    ctx = new AudioContext();
    analisador = ctx.createAnalyser();
    analisador.fftSize = 512;
    medir();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Lê o volume (RMS) do que está passando pelo analisador e manda pra aura.
function medir() {
  const dados = new Float32Array(analisador.fftSize);
  const passo = () => {
    analisador.getFloatTimeDomainData(dados);
    let soma = 0;
    for (const v of dados) soma += v * v;
    aura.volume(Math.sqrt(soma / dados.length) * 6);
    requestAnimationFrame(passo);
  };
  passo();
}

async function comecar() {
  ciclo += 1;
  pararFala();
  const c = audio();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
    const fonte = c.createMediaStreamSource(stream);
    // ScriptProcessor captura o PCM cru (sem codec), mais simples de virar WAV.
    const processador = c.createScriptProcessor(4096, 1, 1);
    const pedacos = [];
    processador.onaudioprocess = (e) => pedacos.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    fonte.connect(analisador);
    fonte.connect(processador);
    processador.connect(c.destination);
    gravando = { stream, fonte, processador, pedacos, taxa: c.sampleRate, inicio: performance.now() };
    aura.estado = 'ouvindo';
    mostrar('ouvindo', '…');
  } catch (err) {
    aura.estado = 'parado';
    mostrar('erro', `Sem acesso ao microfone (${err.message || err}).`);
    setTimeout(() => mostrar(), 4000);
  }
}

function parar() {
  if (!gravando) return null;
  const g = gravando;
  gravando = null;
  g.processador.disconnect();
  g.fonte.disconnect();
  g.stream.getTracks().forEach((t) => t.stop());
  const duracao = performance.now() - g.inicio;
  return duracao < 350 ? null : paraWav(g.pedacos, g.taxa);
}

/** Junta os pedaços, reduz pra 16 kHz mono e monta um WAV PCM 16 bits (o que o whisper quer). */
function paraWav(pedacos, taxa) {
  const total = pedacos.reduce((n, p) => n + p.length, 0);
  const tudo = new Float32Array(total);
  let pos = 0;
  for (const p of pedacos) {
    tudo.set(p, pos);
    pos += p.length;
  }
  const alvo = 16000;
  const razao = taxa / alvo;
  const n = Math.floor(total / razao);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    // Média simples da janela: reduz a taxa sem chiado.
    const ini = Math.floor(i * razao);
    const fim = Math.min(total, Math.floor((i + 1) * razao));
    let soma = 0;
    for (let j = ini; j < fim; j += 1) soma += tudo[j];
    const v = Math.max(-1, Math.min(1, soma / Math.max(1, fim - ini)));
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

async function perguntar(texto, meuCiclo) {
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
  let erro = null;
  while (true) {
    const { done, value } = await leitor.read();
    if (done) break;
    if (meuCiclo !== ciclo) {
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
      if (ev.type === 'error') erro = ev.message;
    }
  }
  if (!resposta && erro) throw new Error(erro);
  return resposta;
}

async function falar(texto, meuCiclo) {
  const res = await fetch(`${API}/voice/speak`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: texto }),
  });
  if (!res.ok || meuCiclo !== ciclo) return;
  const c = audio();
  const som = await c.decodeAudioData(await res.arrayBuffer());
  if (meuCiclo !== ciclo) return;
  const fonte = c.createBufferSource();
  fonte.buffer = som;
  fonte.connect(analisador);
  analisador.connect(c.destination);
  tocando = fonte;
  aura.estado = 'falando';
  await new Promise((resolve) => {
    fonte.onended = resolve;
    fonte.start();
  });
  if (tocando === fonte) {
    tocando = null;
    analisador.disconnect();
  }
}

function pararFala() {
  if (tocando) {
    try { tocando.stop(); } catch { /* já parou */ }
    tocando = null;
    try { analisador.disconnect(); } catch { /* ok */ }
  }
}

async function soltar() {
  const wav = parar();
  const meuCiclo = ciclo;
  if (!wav) {
    aura.estado = 'parado';
    mostrar();
    return;
  }
  aura.estado = 'pensando';
  mostrar('ouvi', '…');
  try {
    const t = await fetch(`${API}/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: wav });
    const { text, error } = await t.json();
    if (!t.ok) throw new Error(error || `transcrição falhou (${t.status})`);
    if (!text) {
      mostrar('ouvi', 'Não entendi. Segure ⌥ Espaço e fale de novo.');
      aura.estado = 'parado';
      setTimeout(() => meuCiclo === ciclo && mostrar(), 3000);
      return;
    }
    mostrar('você', text);
    const resposta = await perguntar(text, meuCiclo);
    if (resposta == null || meuCiclo !== ciclo) return;
    mostrar('teko', resposta);
    await falar(resposta, meuCiclo);
    if (meuCiclo === ciclo) {
      aura.estado = 'parado';
      setTimeout(() => meuCiclo === ciclo && mostrar(), 2500);
    }
  } catch (err) {
    const msg = String(err.message || err);
    mostrar('erro', msg.includes('Failed to fetch') || msg.includes('Load failed') ? 'Teko desligado. Rode npm start.' : msg);
    aura.estado = 'parado';
    setTimeout(() => meuCiclo === ciclo && mostrar(), 5000);
  }
}

// Atalho global vindo do Rust: true = apertou, false = soltou.
if (window.__TAURI__) {
  window.__TAURI__.event.listen('falar', ({ payload }) => {
    if (payload && !gravando) comecar();
    else if (!payload && gravando) soltar();
  });
} else {
  // Fora do Tauri (abrindo no navegador pra testar a aura): barra de espaço faz o papel do atalho.
  window.addEventListener('keydown', (e) => e.code === 'Space' && !e.repeat && !gravando && comecar());
  window.addEventListener('keyup', (e) => e.code === 'Space' && gravando && soltar());
}
