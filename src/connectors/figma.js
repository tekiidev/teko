import { env } from '../config.js';
import { getSetting } from '../db.js';

// Figma REST API com Personal Access Token (figd_...).
// Escopo necessário: File content (read).

export function figmaToken() {
  const saved = getSetting('figma', {});
  return saved.token || env('FIGMA_TOKEN');
}

export function status() {
  return {
    connected: Boolean(figmaToken()),
    env: 'FIGMA_TOKEN',
    docs: 'https://www.figma.com/developers/api#access-tokens',
  };
}

export function parseKey(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Informe a URL ou a key do arquivo do Figma.');
  const match = raw.match(/figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{10,}$/.test(raw)) return raw;
  throw new Error('URL do Figma inválida. Use algo como https://www.figma.com/design/<key>/...');
}

export async function getFile(key, { depth = 4 } = {}) {
  const token = figmaToken();
  if (!token) throw new Error('Figma não conectado. Salve um Personal Access Token na aba Conexões.');

  const res = await fetch(`https://api.figma.com/v1/files/${encodeURIComponent(key)}?depth=${depth}`, {
    headers: { 'X-Figma-Token': token },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 403 || res.status === 401) {
      throw new Error('Token do Figma inválido ou sem permissão de leitura de arquivo.');
    }
    throw new Error(`Figma ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

const MAX_NODES = 1200;

/** Transforma a árvore do Figma num outline em Markdown, bom pra contexto de IA. */
export function outline(file) {
  const lines = [];
  lines.push(`# ${file.name || 'Arquivo Figma'}`);
  if (file.lastModified) lines.push(`Última modificação: ${file.lastModified}`);
  if (file.version) lines.push(`Versão: ${file.version}`);
  lines.push('');

  let count = 0;
  const walk = (node, depth) => {
    if (!node || count >= MAX_NODES || depth > 5) return;
    count += 1;
    const pad = '  '.repeat(depth);

    if (node.type === 'TEXT' && node.characters) {
      const text = String(node.characters).replace(/\s+/g, ' ').trim().slice(0, 120);
      if (text) lines.push(`${pad}- texto: "${text}"`);
      return;
    }

    const box = node.absoluteBoundingBox;
    const size = box ? ` (${Math.round(box.width)}×${Math.round(box.height)})` : '';
    lines.push(`${pad}- ${node.type}: ${node.name || 'sem nome'}${size}`);

    for (const child of node.children || []) walk(child, depth + 1);
  };

  walk(file.document, 0);
  if (count >= MAX_NODES) lines.push('\n[outline truncado]');
  return lines.join('\n');
}

export async function importFile({ url, projectId, depth = 4 }) {
  const key = parseKey(url);
  const file = await getFile(key, { depth });
  return {
    key,
    name: file.name || key,
    content: outline(file),
    url: `https://www.figma.com/design/${key}`,
  };
}
