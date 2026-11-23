import path from 'node:path';

/**
 * Privacidade: o que nunca deve sair do computador.
 * - Segredos (chaves, tokens, chaves privadas) são trocados por um marcador antes de
 *   qualquer chamada a modelo fora do computador.
 * - Arquivos de segredo (.env, .pem, id_rsa...) não são lidos pelas ferramentas.
 * É uma camada a mais, não uma garantia: um formato de segredo desconhecido pode passar.
 */

export const MARCADOR = '[segredo escondido pelo Teko]';

const PADROES: RegExp[] = [
  // Chaves privadas inteiras (PEM).
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, // OpenAI e compatíveis
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\bxai-[A-Za-z0-9]{20,}/g, // xAI
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g, // Stripe
  /\bfigd_[A-Za-z0-9_-]{20,}/g, // Figma
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

// Linha de configuração com nome de segredo: API_KEY=..., "password": "...", token: ...
const LINHA_SEGREDO = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;

/** Troca segredos por um marcador. Devolve o texto limpo e quantos trechos foram escondidos. */
export function esconderSegredos(texto: string): { texto: string; n: number } {
  if (!texto) return { texto, n: 0 };
  let n = 0;
  let saida = texto;
  for (const re of PADROES) {
    saida = saida.replace(re, () => {
      n += 1;
      return MARCADOR;
    });
  }
  saida = saida.replace(LINHA_SEGREDO, (todo, nome, sep, valor) => {
    // Só valor com cara de segredo: 16+ caracteres de chave, com letra e número.
    // Código como `token = getToken()` ou `key: process.env.X` passa intacto.
    if (!/^[A-Za-z0-9_\-+/=]{16,}$/.test(valor) || !/[0-9]/.test(valor) || !/[A-Za-z]/.test(valor)) return todo;
    n += 1;
    return `${nome}${sep}${MARCADOR}`;
  });
  return { texto: saida, n };
}

/** Esconde segredos em system + mensagens (texto e partes de texto). */
export function esconderNaConversa(system: string, mensagens: any[]) {
  let total = 0;
  const limpar = (t: string) => {
    const r = esconderSegredos(t);
    total += r.n;
    return r.texto;
  };
  const sys = limpar(system || '');
  const msgs = mensagens.map((m) => {
    const c = m.content;
    if (typeof c === 'string') return { ...m, content: limpar(c) };
    if (Array.isArray(c)) return { ...m, content: c.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? { ...p, text: limpar(p.text) } : p)) };
    return m;
  });
  return { system: sys, mensagens: msgs, n: total };
}

/** Provedor que roda no próprio computador (Ollama ou qualquer URL de loopback). */
export function provedorLocal(provider: { id?: string; base_url?: string | null } | null) {
  if (!provider) return false;
  if (provider.id === 'ollama') return true;
  try {
    const host = new URL(String(provider.base_url || '')).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

const EXEMPLOS = /\.(example|sample|template|dist)$/i;

/** Arquivos que guardam segredos: as ferramentas não leem, pra não irem parar no modelo. */
export function arquivoSecreto(caminho: string) {
  const nome = path.basename(String(caminho || '')).toLowerCase();
  if (EXEMPLOS.test(nome)) return false;
  return (
    /^\.env(\..+)?$/.test(nome) ||
    /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/.test(nome) ||
    /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(nome) ||
    /^(credentials|service-account|serviceaccount|secrets?)([._-].*)?\.(json|ya?ml|toml)$/.test(nome) ||
    nome === '.npmrc' || nome === '.netrc' || nome === '.pgpass'
  );
}
