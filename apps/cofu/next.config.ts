import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { NextConfig } from 'next';

// Rodando local, usa o mesmo .env da raiz do monorepo (GOOGLE_API_KEY etc.).
// Só preenche o que ainda não existe; na hospedagem (Vercel) as variáveis vêm do painel dela.
const rootEnv = path.resolve(process.cwd(), '../../.env');
if (!process.env.VERCEL && fs.existsSync(rootEnv)) {
  for (const [chave, valor] of Object.entries(parseEnv(fs.readFileSync(rootEnv, 'utf8')))) {
    if (process.env[chave] === undefined && valor !== undefined) process.env[chave] = valor;
  }
}

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [
      {
        // Cabeçalhos básicos de segurança em todas as páginas.
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
        ],
      },
      {
        // O service worker nunca fica velho no cache do navegador.
        source: '/sw.js',
        headers: [{ key: 'Cache-Control', value: 'no-cache' }],
      },
    ];
  },
};

export default config;
