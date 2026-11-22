// Cores e desenho do terminal: preto, azul elétrico e branco, igual ao painel.

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const rgb = (r: number, g: number, b: number) => (text: string) =>
  enabled ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m` : text;
const wrap = (code: string) => (text: string) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);

export const c = {
  accent: rgb(46, 155, 255),
  ice: rgb(207, 234, 255),
  cyan: rgb(95, 212, 255),
  white: rgb(242, 247, 255),
  muted: rgb(143, 163, 189),
  dim: rgb(90, 109, 134),
  red: rgb(255, 95, 109),
  amber: rgb(255, 176, 32),
  green: rgb(74, 222, 128),
  bold: wrap('1'),
};

// Gerado a partir de apps/teko/public/brand/teko.svg (meio-blocos, 58 colunas).
const LOGO = [
  '  ▄                                    ▄               ▄',
  '  █▄              ▄▄          ▄       ▄█              ▄█',
  '   █████▄▄▄▄▄▄█████▄▄▄▄▄▄▄▄█▀██    ▄▄██   ▄▄  ▄▄▄▄▄████',
  '    ▀█▀▀▀█████▀██████▀▀▀▀▀▀ ████▀████▀▄▄██▀████████▀▀▀',
  '         ▀███  ▀ ▀████▄▄▄▄▀ ▄███▄██▄███▀▀▄██▀    ▀██▄',
  '         ▄███    ▄██   █▀ ▄██ ███████▄▄ ▄███▄     ████',
  '        ▄████▄ ▄████▄▄▄▄████▀▄███▄▄ ▀████▄▀███▄▄▄███▀',
  '       ▄███▀▀▄█████▀▀▀▀▀▀██▄█▀▀▀    ▀▀█████▄█▀▀▀▀████▄',
  '    ▄█▀▀▀   ▄█▀           ▄▀              ▀▀▀█▄▄   ▀▀██▄',
  '  ▀▀                                                    ▀',
];

// Degradê de cima pra baixo: branco gelo até o azul, imitando o cromado da logo.
const STEPS: [number, number, number][] = [
  [242, 247, 255], [207, 234, 255], [160, 214, 255], [110, 190, 255], [70, 170, 255],
  [46, 155, 255], [40, 135, 230], [34, 118, 205], [28, 100, 180], [24, 86, 160],
];

export function banner(version: string) {
  const lines = LOGO.map((line, i) => rgb(...STEPS[Math.min(i, STEPS.length - 1)])(line));
  return [
    '',
    ...lines,
    '',
    `  ${c.white(c.bold('teko'))} ${c.dim(`v${version}`)}  ${c.muted('fala-se TÉ-ko')}  ${c.dim('feito por')} ${c.accent('tekidev')}`,
    '',
  ].join('\n');
}

export function fmtTokens(n = 0) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function fmtCost(n = 0) {
  if (!n) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
