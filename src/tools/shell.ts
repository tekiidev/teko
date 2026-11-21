import { execFile } from 'node:child_process';
import { resolveInside } from './fs.js';

const BLOCKED = [
  /\brm\s+-rf\s+\/(\s|$)/,
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/,
  /\breboot\b/,
  /:\(\)\s*\{/,
  /\bchmod\s+-R\s+777\s+\//,
];

const MAX_OUTPUT = 20_000;

export async function runCommand({ command, cwd = '.', timeoutMs = 120000 } = {}, ctx) {
  if (!command) throw new Error('informe o comando');
  if (BLOCKED.some((re) => re.test(command))) {
    return { ok: false, output: 'comando bloqueado por segurança (destrutivo ou privilegiado)' };
  }

  const dir = resolveInside(ctx.root, cwd);
  const timeout = Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 300000);

  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-lc', command],
      { cwd: dir, timeout, maxBuffer: 4 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const merged = [stdout, stderr].filter(Boolean).join('\n').trim();
        const clipped = merged.length > MAX_OUTPUT ? `${merged.slice(0, MAX_OUTPUT)}\n[saída truncada]` : merged;
        const exitCode = err?.code ?? 0;
        const timedOut = err?.killed || err?.signal === 'SIGTERM';
        resolve({
          ok: !err,
          output: `${clipped || '(sem saída)'}\n[exit ${exitCode}${timedOut ? ' · timeout' : ''}]`,
        });
      },
    );
  });
}
