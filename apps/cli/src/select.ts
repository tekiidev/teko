import readline from 'node:readline';
import { c } from './ui.js';

export type Opcao<T> = { label: string; value: T; hint?: string };

/**
 * Lista escolhida com ↑ ↓ e Enter. Números também pulam direto pra opção.
 * Esc, Ctrl+C ou q cancelam (devolve null). Sem terminal interativo, devolve null.
 * Enquanto a lista está aberta, tira os ouvintes de tecla do readline da conversa
 * e devolve no final, pra a digitação não vazar pro prompt.
 */
export async function escolher<T>(titulo: string, opcoes: Opcao<T>[], inicial = 0): Promise<T | null> {
  const input = process.stdin;
  const out = process.stdout;
  if (!input.isTTY || !out.isTTY || !opcoes.length) return null;

  readline.emitKeypressEvents(input);
  const antes = input.listeners('keypress') as ((...a: any[]) => void)[];
  input.removeAllListeners('keypress');
  const eraRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();

  const janela = Math.max(3, Math.min(opcoes.length, (out.rows || 24) - 4));
  let atual = Math.min(Math.max(inicial, 0), opcoes.length - 1);
  let topo = 0;
  let desenhadas = 0;

  const desenhar = () => {
    if (atual < topo) topo = atual;
    if (atual >= topo + janela) topo = atual - janela + 1;
    if (desenhadas) out.write(`\x1b[${desenhadas}A`);
    const linhas = [`  ${c.white(titulo)} ${c.dim('↑↓ escolhe · Enter confirma · Esc cancela')}`];
    for (let i = topo; i < Math.min(opcoes.length, topo + janela); i += 1) {
      const o = opcoes[i];
      const hint = o.hint ? ` ${c.dim(o.hint)}` : '';
      linhas.push(i === atual ? `  ${c.accent('›')} ${c.accent(o.label)}${hint}` : `    ${c.muted(o.label)}${hint}`);
    }
    if (opcoes.length > janela) linhas.push(c.dim(`    ${atual + 1}/${opcoes.length}`));
    for (const l of linhas) out.write(`\x1b[2K${l}\n`);
    desenhadas = linhas.length;
  };

  out.write('\x1b[?25l'); // esconde o cursor
  desenhar();

  return new Promise((resolve) => {
    const fim = (valor: T | null) => {
      input.removeListener('keypress', tecla);
      // Apaga a lista e deixa só a linha com o que foi escolhido.
      out.write(`\x1b[${desenhadas}A\x1b[J`);
      const escolhida = valor === null ? c.dim('cancelado') : c.accent(opcoes[atual].label);
      out.write(`  ${c.white(titulo)} ${escolhida}\n\x1b[?25h`);
      input.setRawMode(eraRaw);
      for (const l of antes) input.on('keypress', l);
      resolve(valor);
    };
    const tecla = (str: string, key: { name?: string; ctrl?: boolean } = {}) => {
      if (key.ctrl && key.name === 'c') return fim(null);
      if (key.name === 'escape' || str === 'q') return fim(null);
      if (key.name === 'return' || key.name === 'enter') return fim(opcoes[atual].value);
      if (key.name === 'up' || str === 'k') atual = (atual - 1 + opcoes.length) % opcoes.length;
      else if (key.name === 'down' || str === 'j') atual = (atual + 1) % opcoes.length;
      else if (key.name === 'home') atual = 0;
      else if (key.name === 'end') atual = opcoes.length - 1;
      else if (/^[0-9]$/.test(str || '')) {
        const n = Number(str);
        if (n < opcoes.length) atual = n;
        else return;
      } else return;
      desenhar();
    };
    input.on('keypress', tecla);
  });
}

/** Sim ou não com setas. O padrão (onde o cursor começa) é "Não", pra Enter sem pensar não fazer nada. */
export async function confirmar(pergunta: string, { sim = 'Sim', nao = 'Não', padraoSim = false } = {}) {
  const r = await escolher(pergunta, [{ label: nao, value: false }, { label: sim, value: true }], padraoSim ? 1 : 0);
  return r === true;
}
