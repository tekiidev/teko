// Ilha do Teko no notch do MacBook.
// Parada, é uma pílula preta do tamanho do notch (some nele). Em conversa cresce e anima:
//   você falando -> LED azul contornando, mais forte quanto mais alto
//   pensando     -> brilho correndo na borda e três pontos
//   Teko falando -> barras seguindo a voz dele
// Com o mouse em cima abre o painel: falar, mapa, parar e um campo pra pedir digitando.
// Quem conversa de verdade é a aura (voz.js); a ilha só espelha o estado e manda pedidos.

const { invoke } = window.__TAURI__.core;
const { listen, emit } = window.__TAURI__.event;

const ilha = document.getElementById('ilha');
const legenda = document.getElementById('legenda');
const pedido = document.getElementById('pedido');
const barras = [...document.querySelectorAll('.barras i')];

const LARGURA_ATIVA = 300; // em conversa
const LARGURA_PAINEL = 340; // com o mouse em cima

let notch = { tem: false, largura: 160, altura: 24 };
let estado = 'parado';
let temLegenda = false;
let aberta = false;
let apagarLegenda = 0;
let fecharPainel = 0;
let volume = 0;
let zerarVolume = 0;

function tamanho() {
  const base = notch.tem ? notch.largura : 160;
  if (aberta) return { w: Math.max(LARGURA_PAINEL, base + 40), h: notch.altura + 142 };
  if (estado !== 'parado' || temLegenda) {
    const extra = temLegenda ? Math.min(110, legenda.scrollHeight + 2) : 0;
    return { w: Math.max(base + 100, LARGURA_ATIVA), h: notch.altura + extra };
  }
  // Parada: um pouco menor que o notch, escondida inteira atrás dele. Em tela LCD o preto
  // da tela é mais claro que o notch físico; assim nenhuma borda aparece em volta.
  // Sem notch, uma faixa fina pra achar com o mouse.
  return notch.tem ? { w: base - 8, h: notch.altura - 3 } : { w: base, h: 8 };
}

function redesenhar() {
  ilha.dataset.estado = estado;
  ilha.classList.toggle('ativa', estado !== 'parado');
  ilha.classList.toggle('com-legenda', temLegenda && !aberta);
  ilha.classList.toggle('aberta', aberta);
  const { w, h } = tamanho();
  ilha.style.width = `${w}px`;
  ilha.style.height = `${h}px`;
  // O Rust usa essa área pra decidir onde o mouse para na ilha e onde passa direto.
  invoke('ilha_area', { largura: w, altura: h }).catch(() => {});
}

/** Volume 0..1: acende o LED (você falando) e mexe as barras (Teko falando). */
function aplicarVolume(v) {
  volume = v;
  ilha.style.setProperty('--vol', v.toFixed(3));
  const falando = estado === 'falando';
  barras.forEach((b, i) => {
    // Cada barra com um peso diferente, pra parecer onda e não um bloco subindo junto.
    const peso = [0.55, 0.85, 1, 0.8, 0.5][i];
    const ruido = 0.75 + Math.random() * 0.5;
    b.style.height = `${falando ? Math.max(3, Math.min(16, 3 + v * 15 * peso * ruido)) : 3}px`;
  });
  // Sem novos volumes por um tempo, volta ao repouso.
  clearTimeout(zerarVolume);
  if (v > 0) zerarVolume = setTimeout(() => aplicarVolume(0), 300);
}

async function gastoHoje() {
  try {
    const u = JSON.parse(await invoke('ilha_uso'));
    const custo = Number(u?.today?.cost || 0);
    const poupado = Number(u?.today?.saved || 0);
    const fmt = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
    document.getElementById('gasto').textContent = poupado > 0 ? `${fmt(custo)} · poupou ${fmt(poupado)}` : fmt(custo);
  } catch {
    document.getElementById('gasto').textContent = 'servidor fora do ar (npm start)';
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

function enviar() {
  const texto = pedido.value.trim();
  if (!texto) return;
  pedido.value = '';
  emit('ilha-pedido', texto);
  aberta = false;
  pedido.blur();
  redesenhar();
}

listen('ilha-mouse', ({ payload }) => {
  clearTimeout(fecharPainel);
  if (payload) abrir(true);
  else fecharPainel = setTimeout(() => abrir(false), 450);
});

listen('teko-estado', ({ payload }) => {
  estado = payload || 'parado';
  if (estado !== 'falando') aplicarVolume(estado === 'ouvindo' ? volume : 0);
  redesenhar();
});

listen('teko-volume', ({ payload }) => aplicarVolume(Number(payload) || 0));

listen('teko-legenda', ({ payload }) => {
  clearTimeout(apagarLegenda);
  const { quem, texto, apagarEm } = payload || {};
  temLegenda = Boolean(texto) && texto !== '…';
  // Sem rótulo: o que você disse aparece mais apagado, a resposta do Teko em branco.
  legenda.classList.toggle('sua', quem === 'você' || quem === 'ouvi' || quem === 'ouvindo');
  legenda.textContent = temLegenda ? texto : '';
  if (temLegenda && apagarEm) apagarLegenda = setTimeout(() => { temLegenda = false; redesenhar(); }, apagarEm);
  redesenhar();
});

listen('teko-escuta', ({ payload }) => ilha.classList.toggle('escutando', Boolean(payload)));

// Retorno na hora: a ilha já mostra o estado enquanto a aura liga o microfone.
document.getElementById('falar').onclick = () => {
  estado = 'ouvindo';
  aberta = false;
  redesenhar();
  emit('ilha-falar');
};
document.getElementById('cancelar').onclick = () => {
  aberta = false;
  redesenhar();
  emit('cancelar');
};
document.getElementById('mapa').onclick = () => invoke('open_context_map').catch(() => {});
document.getElementById('enviar').onclick = enviar;
pedido.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { pedido.value = ''; abrir(false); return; }
  if (e.key === 'Enter') enviar();
});

const info = await invoke('ilha_info').catch(() => null);
if (info) notch = { tem: Boolean(info.tem_notch), largura: Math.round(info.largura), altura: Math.round(info.altura) };
document.documentElement.style.setProperty('--notch-h', `${notch.altura}px`);
redesenhar();
emit('ilha-pronta');
