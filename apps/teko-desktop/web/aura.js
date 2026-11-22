// Aura cyber tribal de pixels.
// Cada pixel tem um ângulo e um raio base; o estado decide como eles se mexem:
//   parado   -> some devagar
//   ouvindo  -> puxa pra dentro e pulsa com o volume da sua voz (gelo/ciano)
//   pensando -> gira em órbita, com as pontas tribais girando (azul)
//   falando  -> ondas saindo do centro no ritmo da fala do Teko (azul/branco)

const PIXEL = 3; // tamanho do "mini pixel" (em px de tela)
const CORES = {
  ouvindo: [[207, 234, 255], [95, 212, 255]],
  pensando: [[46, 155, 255], [95, 212, 255]],
  falando: [[46, 155, 255], [242, 247, 255]],
};

export function criarAura(canvas) {
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, dpr = 1;
  let estado = 'parado';
  let nivel = 0; // volume suavizado, 0..1
  let alpha = 0; // visibilidade geral
  let t = 0;

  // Pontos: 4 anéis + pontas curvas como as da logo (seno elevado gera "garras").
  const pontos = [];
  const ANEIS = [0.42, 0.55, 0.68, 0.8];
  ANEIS.forEach((r, anel) => {
    const n = 90 + anel * 30;
    for (let i = 0; i < n; i += 1) {
      const a = (i / n) * Math.PI * 2;
      pontos.push({ a, r, anel, fase: Math.random() * Math.PI * 2, brilho: 0.55 + Math.random() * 0.45 });
    }
  });
  for (let garra = 0; garra < 6; garra += 1) {
    const base = (garra / 6) * Math.PI * 2;
    for (let k = 0; k < 26; k += 1) {
      const p = k / 26;
      pontos.push({ a: base + p * 0.55, r: 0.8 + p * 0.32, anel: 4, fase: p * 6, brilho: 1 - p * 0.6, garra: true });
    }
  }

  function redimensionar() {
    dpr = window.devicePixelRatio || 1;
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', redimensionar);
  redimensionar();

  function cor(par, mistura, a) {
    const [c1, c2] = par;
    const r = c1[0] + (c2[0] - c1[0]) * mistura;
    const g = c1[1] + (c2[1] - c1[1]) * mistura;
    const b = c1[2] + (c2[2] - c1[2]) * mistura;
    return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
  }

  function quadro(agora) {
    t = agora / 1000;
    const alvo = estado === 'parado' ? 0 : 1;
    alpha += (alvo - alpha) * (alvo ? 0.18 : 0.06);
    ctx.clearRect(0, 0, w, h);
    if (alpha < 0.01) return requestAnimationFrame(quadro);

    const cx = w / 2;
    const cy = h * 0.44;
    const R = Math.min(w, h) * 0.36;
    const par = CORES[estado] || CORES.pensando;

    // Brilho de fundo bem fraco.
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.3);
    g.addColorStop(0, `rgba(46,155,255,${0.12 * alpha * (0.6 + nivel)})`);
    g.addColorStop(1, 'rgba(46,155,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    for (const p of pontos) {
      let a = p.a;
      let r = p.r;
      if (estado === 'ouvindo') {
        // Puxa pra dentro e treme com a voz.
        r = p.r * (0.82 - nivel * 0.18) + Math.sin(t * 9 + p.fase) * 0.012 * (1 + nivel * 4);
        a += Math.sin(t * 2 + p.anel) * 0.02;
      } else if (estado === 'pensando') {
        // Órbita: cada anel gira num sentido, as garras giram mais rápido.
        const sentido = p.anel % 2 ? -1 : 1;
        a += t * (p.garra ? 1.6 : 0.5 + p.anel * 0.15) * sentido;
        r = p.r + Math.sin(t * 3 + p.fase) * 0.015;
      } else if (estado === 'falando') {
        // Ondas saindo do centro, mais fortes quanto mais alto ele fala.
        const onda = Math.sin(p.r * 18 - t * 7);
        r = p.r * (1 + nivel * 0.12) + onda * nivel * 0.06;
        a += t * 0.12;
      }
      const x = cx + Math.cos(a) * r * R;
      const y = cy + Math.sin(a) * r * R;
      // Encaixa na grade pra parecer pixel.
      const px = Math.round(x / PIXEL) * PIXEL;
      const py = Math.round(y / PIXEL) * PIXEL;
      const tremor = 0.5 + 0.5 * Math.sin(t * 4 + p.fase);
      ctx.fillStyle = cor(par, tremor, alpha * p.brilho * (0.55 + nivel * 0.45));
      const tam = p.garra ? PIXEL : PIXEL - (p.anel === 0 ? 1 : 0);
      ctx.fillRect(px, py, tam, tam);
    }

    // Núcleo: um quadrado tribal pulsando.
    const n = 6 + nivel * 10;
    ctx.fillStyle = cor(par, 1, alpha * 0.9);
    ctx.fillRect(Math.round((cx - n / 2) / PIXEL) * PIXEL, Math.round((cy - n / 2) / PIXEL) * PIXEL, n, n);

    requestAnimationFrame(quadro);
  }
  requestAnimationFrame(quadro);

  return {
    set estado(valor) { estado = valor; },
    get estado() { return estado; },
    /** Volume bruto 0..1; suaviza subindo rápido e descendo devagar. */
    volume(v) { nivel += (Math.min(1, v) - nivel) * (v > nivel ? 0.5 : 0.12); },
  };
}
