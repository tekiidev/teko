// Ilha do Teko no notch do MacBook.
// Parada, é uma pílula preta do tamanho do notch (some nele). Em conversa cresce e mostra
// o estado e a legenda. Com o mouse em cima abre o painel: falar, mapa, parar e um campo
// pra pedir digitando. Quem conversa de verdade é a aura (voz.js); a ilha só espelha o
// estado dela e manda pedidos por evento.

const API = 'http://127.0.0.1:4780/api';
const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

const ilha = document.getElementById('ilha');
const legenda = document.getElementById('legenda');
const estadoTxt = document.getElementById('estado');
const pedido = document.getElementById('pedido');

const NOMES = { ouvindo: 'ouvindo', pensando: 'pensando', falando: 'falando' };
const LARGURA_ATIVA = 360; // em conversa
const LARGURA_PAINEL = 380; // com o mouse em cima

let notch = { tem: false, largura: 160, altura: 24 };
let estado = 'parado';
let temLegenda = false;
let aberta = false;
let apagarLegenda = 0;
let fecharPainel = 0;

function tamanho() {
  const base = notch.tem ? notch.largura : 160;
  if (aberta) return { w: LARGURA_PAINEL, h: notch.altura + 128 };
  if (estado !== 'parado' || temLegenda) {
    const extra = temLegenda ? Math.min(110, legenda.scrollHeight + 4) : 0;
    return { w: Math.max(base + 120, LARGURA_ATIVA), h: notch.altura + extra };
  }
  // Parada: no notch, do tamanho dele; sem notch, uma faixa fina pra achar com o mouse.
  return notch.tem ? { w: base, h: notch.altura } : { w: base, h: 8 };
}

function redesenhar() {
  ilha.dataset.estado = estado;
  ilha.classList.toggle('ativa', estado !== 'parado');
  ilha.classList.toggle('com-legenda', temLegenda && !aberta);
  ilha.classList.toggle('aberta', aberta);
  estadoTxt.textContent = NOMES[estado] || '';
  const { w, h } = tamanho();
  ilha.style.width = `${w}px`;
  ilha.style.height = `${h}px`;
  // O Rust usa essa área pra decidir onde o mouse para na ilha e onde passa direto.
  invoke('ilha_area', { largura: w, altura: h }).catch(() => {});
}

async function gastoHoje() {
  try {
    const r = await fetch(`${API}/usage`);
    const u = await r.json();
    const custo = Number(u?.today?.cost || 0);
    const poupado = Number(u?.today?.saved || 0);
    const fmt = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
    document.getElementById('gasto').textContent = `${fmt(custo)} · poupou ${fmt(poupado)}`;
  } catch {
    document.getElementById('gasto').textContent = 'Teko fora do ar (npm start)';
  }
}

function abrir(sim) {
  clearTimeout(fecharPainel);
  if (sim) {
    if (aberta) return;
    aberta = true;
    gastoHoje();
  } else {
    // Não fecha com algo digitado no campo: o mouse pode ter escapado sem querer.
    if (!aberta || pedido.value.trim()) return;
    aberta = false;
    pedido.blur();
  }
  redesenhar();
}

listen('ilha-mouse', ({ payload }) => {
  clearTimeout(fecharPainel);
  if (payload) abrir(true);
  else fecharPainel = setTimeout(() => abrir(false), 450);
});

listen('teko-estado', ({ payload }) => {
  estado = payload || 'parado';
  redesenhar();
});

listen('teko-legenda', ({ payload }) => {
  clearTimeout(apagarLegenda);
  const { quem, texto, apagarEm } = payload || {};
  temLegenda = Boolean(texto);
  legenda.innerHTML = '';
  if (texto) {
    const q = document.createElement('span');
    q.className = 'quem';
    q.textContent = quem || 'teko';
    legenda.append(q, document.createTextNode(texto));
    if (apagarEm) apagarLegenda = setTimeout(() => { temLegenda = false; redesenhar(); }, apagarEm);
  }
  redesenhar();
});

listen('teko-escuta', ({ payload }) => document.body.classList.toggle('escutando', Boolean(payload)));

document.getElementById('falar').onclick = () => emit('ilha-falar');
document.getElementById('cancelar').onclick = () => emit('cancelar');
document.getElementById('mapa').onclick = () => invoke('open_context_map').catch(() => {});
pedido.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { pedido.value = ''; abrir(false); return; }
  if (e.key !== 'Enter') return;
  const texto = pedido.value.trim();
  if (!texto) return;
  pedido.value = '';
  emit('ilha-pedido', texto);
  aberta = false;
  pedido.blur();
  redesenhar();
});

const info = await invoke('ilha_info').catch(() => null);
if (info) notch = { tem: Boolean(info.tem_notch), largura: Math.round(info.largura), altura: Math.round(info.altura) };
document.body.classList.toggle('sem-notch', !notch.tem);
document.documentElement.style.setProperty('--notch-h', `${notch.altura}px`);
redesenhar();
emit('ilha-pronta');
