import { db } from './db.js';
import { resolveKey } from './router.js';

// Puxa a lista real de modelos de cada provider que tenha chave.
// Novos modelos entram desativados, com preço 0, pra você revisar.
export async function syncModels() {
  const providers = db.prepare('SELECT * FROM providers WHERE enabled = 1').all();
  const report = [];

  for (const provider of providers) {
    const key = resolveKey(provider);
    if (!key && provider.id !== 'ollama') {
      report.push({ provider: provider.id, ok: false, reason: 'sem chave' });
      continue;
    }
    try {
      const ids = await listProviderModels(provider, key);
      let added = 0;
      const insert = db.prepare(
        `INSERT INTO models (id, provider_id, model, label, ctx, price_in, price_out, tags, enabled, sort)
         VALUES (?, ?, ?, ?, ?, 0, 0, '[]', 0, 999)
         ON CONFLICT(id) DO NOTHING`,
      );
      for (const modelId of ids) {
        const fullId = `${provider.id}/${modelId}`;
        const result = insert.run(fullId, provider.id, modelId, modelId, 128000);
        if (result.changes > 0) added += 1;
      }
      report.push({ provider: provider.id, ok: true, found: ids.length, added });
    } catch (err) {
      report.push({ provider: provider.id, ok: false, reason: String(err.message || err).slice(0, 200) });
    }
  }
  return report;
}

async function listProviderModels(provider, key) {
  const base = provider.base_url.replace(/\/$/, '');

  if (provider.kind === 'anthropic') {
    const res = await fetch(`${base}/v1/models?limit=100`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.data || []).map((m) => m.id);
  }

  if (provider.kind === 'google') {
    const res = await fetch(`${base}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return (json.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''));
  }

  const headers = key ? { authorization: `Bearer ${key}` } : {};
  const res = await fetch(`${base}/models`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : [];
  return list.map((m) => m.id || m.name).filter(Boolean);
}
