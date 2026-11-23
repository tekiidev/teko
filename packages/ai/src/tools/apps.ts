import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

/**
 * Abre aplicativos instalados pelo nome, no Mac, Linux e Windows.
 * Só abre o que achou instalado (nada de caminho, URL ou argumento vindo do modelo),
 * e diz o que observou: "aberto" quando viu o processo, "não confirmei" quando não deu pra checar.
 */
export type App = { name: string; target: string; process?: string };

const ALIASES: Record<string, string> = {
  vscode: 'visual studio code', code: 'visual studio code', 'vs code': 'visual studio code',
  chrome: 'google chrome', navegador: 'safari', zap: 'whatsapp', wpp: 'whatsapp',
  terminal: 'terminal', config: 'system settings', configuracoes: 'system settings', ajustes: 'system settings',
  calculadora: 'calculator', calendario: 'calendar', notas: 'notes', musica: 'music', fotos: 'photos',
  mensagens: 'messages', lembretes: 'reminders', mapas: 'maps', email: 'mail',
};

export const normalizar = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\.(app|desktop|lnk)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();

function lerPasta(dir: string) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function appsMac(): App[] {
  const pastas = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
  const apps: App[] = [];
  for (const dir of pastas) {
    for (const e of lerPasta(dir)) {
      if (e.name.endsWith('.app')) apps.push({ name: e.name.slice(0, -4), target: path.join(dir, e.name), process: path.join(dir, e.name) });
      // Apps dentro de uma pasta (ex.: /Applications/Adobe Photoshop/Photoshop.app).
      else if (e.isDirectory() && !e.name.startsWith('.') && dir === '/Applications') {
        for (const sub of lerPasta(path.join(dir, e.name))) {
          if (sub.name.endsWith('.app')) apps.push({ name: sub.name.slice(0, -4), target: path.join(dir, e.name, sub.name), process: path.join(dir, e.name, sub.name) });
        }
      }
    }
  }
  return apps;
}

function appsLinux(): App[] {
  const pastas = [
    '/usr/share/applications', '/usr/local/share/applications', path.join(os.homedir(), '.local/share/applications'),
    '/var/lib/flatpak/exports/share/applications', path.join(os.homedir(), '.local/share/flatpak/exports/share/applications'),
    '/var/lib/snapd/desktop/applications',
  ];
  const apps: App[] = [];
  for (const dir of pastas) {
    for (const e of lerPasta(dir)) {
      if (!e.name.endsWith('.desktop')) continue;
      let texto = '';
      try { texto = fs.readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
      if (/^NoDisplay=true/m.test(texto) || /^Type=(?!Application)/m.test(texto)) continue;
      const nome = texto.match(/^Name=(.+)$/m)?.[1]?.trim() || e.name.slice(0, -8);
      const exec = texto.match(/^Exec=(\S+)/m)?.[1];
      apps.push({ name: nome, target: e.name.slice(0, -8), process: exec ? path.basename(exec) : undefined });
    }
  }
  return apps;
}

function appsWindows(): App[] {
  const pastas = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs'),
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData\\Roaming'), 'Microsoft\\Windows\\Start Menu\\Programs'),
  ];
  const apps: App[] = [];
  const andar = (dir: string, nivel: number) => {
    for (const e of lerPasta(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && nivel < 3) andar(p, nivel + 1);
      else if (e.name.toLowerCase().endsWith('.lnk')) apps.push({ name: e.name.slice(0, -4), target: p });
    }
  };
  pastas.forEach((d) => andar(d, 0));
  return apps;
}

export function listarApps(platform = process.platform): App[] {
  const apps = platform === 'darwin' ? appsMac() : platform === 'win32' ? appsWindows() : appsLinux();
  const vistos = new Set<string>();
  return apps.filter((a) => (vistos.has(normalizar(a.name)) ? false : (vistos.add(normalizar(a.name)), true)));
}

/** Melhor app pro nome pedido: igual, depois começa com, depois contém. */
export function acharApp(pedido: string, apps: App[]) {
  let alvo = normalizar(pedido);
  alvo = ALIASES[alvo] || alvo;
  const nomes = apps.map((a) => ({ app: a, n: normalizar(a.name) }));
  const hit =
    nomes.find((x) => x.n === alvo) ||
    nomes.find((x) => x.n.startsWith(alvo + ' ') || x.n.startsWith(alvo)) ||
    nomes.find((x) => x.n.split(' ').includes(alvo)) ||
    (alvo.length >= 3 ? nomes.find((x) => x.n.includes(alvo)) : undefined);
  if (hit) return { app: hit.app, sugestoes: [] as string[] };
  const palavras = alvo.split(' ').filter((p) => p.length >= 3);
  const sugestoes = nomes.filter((x) => palavras.some((p) => x.n.includes(p.slice(0, 3)))).slice(0, 5).map((x) => x.app.name);
  return { app: null, sugestoes };
}

const rodando = (processo: string) =>
  new Promise<boolean>((resolve) => {
    execFile('pgrep', ['-f', processo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')], (err, out) => resolve(!err && Boolean(String(out).trim())));
  });

async function confirmarAberto(app: App) {
  if (process.platform === 'win32' || !app.process) return false;
  for (let i = 0; i < 6; i += 1) {
    if (await rodando(app.process)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function lancar(app: App) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [app.target]]
      : process.platform === 'win32' ? ['explorer.exe', [app.target]]
        : ['gtk-launch', [app.target]];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

export async function openApp(args: any = {}) {
  const pedido = String(args.name || '').trim();
  if (!pedido) return { ok: false, output: 'informe o nome do aplicativo' };
  const { app, sugestoes } = acharApp(pedido, listarApps());
  if (!app) {
    return { ok: false, output: `não achei "${pedido}" instalado.${sugestoes.length ? ` Parecidos: ${sugestoes.join(', ')}` : ''}` };
  }
  try {
    await lancar(app);
  } catch (err) {
    return { ok: false, output: `não consegui abrir ${app.name}: ${err.message || err}` };
  }
  const aberto = await confirmarAberto(app);
  return { ok: true, output: aberto ? `${app.name} aberto` : `pedi pra abrir ${app.name}, mas não confirmei se abriu` };
}
