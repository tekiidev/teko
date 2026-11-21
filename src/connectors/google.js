import crypto from 'node:crypto';
import { env, PORT } from '../config.js';
import { getSetting, setSetting } from '../db.js';

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

export function googleConfig() {
  const saved = getSetting('google', {});
  return {
    clientId: saved.clientId || env('GOOGLE_CLIENT_ID'),
    clientSecret: saved.clientSecret || env('GOOGLE_CLIENT_SECRET'),
  };
}

export function redirectUri() {
  return `http://localhost:${PORT}/api/google/callback`;
}

export function status() {
  const cfg = googleConfig();
  const tokens = getSetting('googleTokens', null);
  return {
    configured: Boolean(cfg.clientId && cfg.clientSecret),
    connected: Boolean(tokens?.refresh_token || tokens?.access_token),
    redirectUri: redirectUri(),
    scope: SCOPES.join(' '),
  };
}

export function authUrl() {
  const cfg = googleConfig();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error('Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (ou salve na aba Conexões).');
  }
  const state = crypto.randomUUID();
  setSetting('googleOauthState', state);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function exchangeCode(code, state) {
  const expected = getSetting('googleOauthState', null);
  if (!expected || state !== expected) throw new Error('state inválido ou expirado. Tente conectar de novo.');
  const cfg = googleConfig();

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`Falha ao trocar código: ${await res.text()}`);
  const tok = await res.json();

  setSetting('googleTokens', {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expiry: Date.now() + (tok.expires_in || 3600) * 1000,
    scope: tok.scope,
  });
  setSetting('googleOauthState', null);
}

export async function accessToken() {
  const tokens = getSetting('googleTokens', null);
  if (!tokens) throw new Error('Google Drive não conectado.');
  if (tokens.access_token && tokens.expiry && tokens.expiry > Date.now() + 60_000) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new Error('Token expirado e sem refresh_token. Reconecte.');

  const cfg = googleConfig();
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Falha ao renovar token: ${await res.text()}`);
  const json = await res.json();
  setSetting('googleTokens', {
    ...tokens,
    access_token: json.access_token,
    expiry: Date.now() + (json.expires_in || 3600) * 1000,
  });
  return json.access_token;
}

export async function search(query, { limit = 25 } = {}) {
  const token = await accessToken();
  const safe = String(query || '').replace(/'/g, "\\'");
  const q = safe ? `name contains '${safe}' and trashed = false` : 'trashed = false';
  const params = new URLSearchParams({
    q,
    pageSize: String(Math.min(limit, 50)),
    orderBy: 'modifiedTime desc',
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Drive: ${await res.text()}`);
  const json = await res.json();
  return json.files || [];
}

const EXPORTS = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

export async function importFile(fileId) {
  const token = await accessToken();

  const metaRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!metaRes.ok) throw new Error(`Drive: ${await metaRes.text()}`);
  const meta = await metaRes.json();

  const exportMime = EXPORTS[meta.mimeType];
  const url = exportMime
    ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;

  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Drive: ${await res.text()}`);
  const text = await res.text();

  return {
    id: meta.id,
    title: meta.name,
    mimeType: meta.mimeType,
    content: text.slice(0, 200_000),
    truncated: text.length > 200_000,
  };
}
