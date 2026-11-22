import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PORT, HOST, APP_VERSION } from '@teko/ai/config';
import {
  db,
  getSetting,
  setSetting,
  newId,
  nowIso,
  listModels,
  listProfiles,
  getModel,
  getProvider,
  safeJson,
} from '@teko/ai/db';
import { usageSummary, recordUsage } from '@teko/ai/usage';
import { runChat, planRoute, modelHealth, budgetStatus, resolveKey } from '@teko/ai/router';
import { cacheSettings, cacheStats, clearCache, pruneCache } from '@teko/ai/response-cache';
import { compactHistory, compressionSettings, loadSessionHistory, withSummary } from '@teko/ai/compress';
import { buildSystemPrompt, buildTurnContext, withTurnContext } from '@teko/ai/context';
import { deleteSkill, findImportable, getSkill, importSkills, listSkills, parseSkillCommand } from '@teko/ai/skills';
import { syncModels } from '@teko/ai/sync';
import * as google from '@teko/ai/connectors/google';
import * as figma from '@teko/ai/connectors/figma';
import { toolDefs } from '@teko/ai/tools/index';
import { listApprovals, resolveApproval } from '@teko/ai/approvals';
import { indexProject, indexStatus, search, searchForPrompt, ensureIndex } from '@teko/ai/search-index';

const PUBLIC_DIR = fileURLToPath(new URL('../public', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('corpo da requisição muito grande');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('não encontrado');
  }
}

function maskKey(key) {
  if (!key) return null;
  return key.length <= 8 ? '••••' : `••••${key.slice(-4)}`;
}

function publicBootstrap() {
  const providers = db
    .prepare('SELECT * FROM providers ORDER BY id')
    .all()
    .map((p) => ({
      ...p,
      keyEnv: p.key_env,
      hasKey: Boolean(resolveKey(p)) || p.id === 'ollama',
      keyHint: maskKey(resolveKey(p)),
    }));

  const models = listModels().map((m) => ({
    ...m,
    health: modelHealth(m.id),
    budget: budgetStatus(m.id),
    providerHasKey: providers.find((p) => p.id === m.provider_id)?.hasKey ?? false,
  }));

  const projects = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM decisions d WHERE d.project_id = p.id) AS decision_count,
              (SELECT COUNT(*) FROM bugs b WHERE b.project_id = p.id AND b.status != 'resolvido') AS open_bugs
         FROM projects p ORDER BY p.created_at ASC`,
    )
    .all()
    .map((p) => ({ ...p, stack: safeJson(p.stack, []) }));

  const budgets = getSetting('budgets', {});
  const keys = getSetting('keys', {});
  const keyHints = {};
  for (const [id, value] of Object.entries(keys)) keyHints[id] = maskKey(value);

  return {
    version: APP_VERSION,
    now: nowIso(),
    providers,
    models,
    profiles: listProfiles(),
    projects,
    usage: usageSummary(),
    settings: {
      router: getSetting('router', {}),
      responseCache: { ...cacheSettings(), ...cacheStats() },
      compression: compressionSettings(),
      budgets,
      globalNotes: getSetting('globalNotes', ''),
      keyHints,
    },
    google: google.status(),
    figma: figma.status(),
    route: planRoute({ profileId: 'code' }),
  };
}

/** Uma chamada simples (sem ferramentas) que devolve o texto e o uso do evento done. */
async function summarizeOnce(system, prompt, profileId, signal) {
  let done = null;
  for await (const event of runChat({ profileId, system, messages: [{ role: 'user', content: prompt }], signal, noCache: true })) {
    if (event.type === 'done') done = event;
  }
  if (!done) throw new Error('resumo indisponível');
  return done;
}

async function handleChat(req, res) {
  const body = await readJson(req);
  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { error: 'mensagem vazia' });

  let session = body.sessionId
    ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(body.sessionId)
    : null;

  if (!session) {
    const id = newId('ses');
    session = {
      id,
      project_id: body.projectId || null,
      profile_id: body.profileId || 'code',
      title: text.slice(0, 70),
      summary: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    db.prepare(
      'INSERT INTO sessions (id, project_id, title, profile_id, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(session.id, session.project_id, session.title, session.profile_id, null, session.created_at, session.updated_at);
  }

  const profileId = body.profileId || session.profile_id || 'code';
  const stored = loadSessionHistory(session.id);
  stored.messages.push({ role: 'user', content: text });

  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(newId('msg'), session.id, 'user', text, nowIso());

  db.prepare('UPDATE sessions SET updated_at = ?, profile_id = ? WHERE id = ?').run(
    nowIso(),
    profileId,
    session.id,
  );

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (type, payload = {}) => {
    if (res.writableEnded) return;
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  send('meta', { sessionId: session.id, projectId: session.project_id, profileId });

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  const project = session.project_id
    ? db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id)
    : null;
  const projectPath = project?.path && fs.existsSync(project.path) ? project.path : null;
  const tools = projectPath ? toolDefs() : null;

  let retrieved = '';
  if (project?.id) {
    try {
      ensureIndex(project.id);
      retrieved = searchForPrompt(project.id, text, { limit: 4, maxChars: 3500 });
    } catch (err) {
      console.error('[busca]', err.message);
    }
  }

  // Conversa longa: as mensagens antigas viram resumo (modelo barato) e ficam salvas na sessão.
  const compressCfg = compressionSettings();
  const compacted = await compactHistory({
    sessionId: session.id,
    summary: stored.summary,
    messages: stored.messages,
    settings: compressCfg,
    summarize: (summarySystem, prompt) => summarizeOnce(summarySystem, prompt, compressCfg.profileId, controller.signal),
  });
  if (compacted.compressed) {
    const r = compacted.compressed.result;
    recordUsage({
      sessionId: session.id,
      projectId: session.project_id,
      modelId: r.modelId,
      providerId: r.providerId,
      inputTokens: r.usage?.inputTokens || 0,
      outputTokens: r.usage?.outputTokens || 0,
      cachedInputTokens: r.usage?.cachedInputTokens || 0,
      cacheWriteTokens: r.usage?.cacheWriteTokens || 0,
      latencyMs: r.usage?.latencyMs ?? null,
      cost: r.cost || 0,
      saved: r.saved || 0,
      kind: 'compression',
    });
    send('compressed', { messages: compacted.compressed.messages, savedTokens: compacted.compressed.savedTokens, modelId: r.modelId });
  }
  const history = withSummary(compacted.summary, compacted.messages);

  const system = buildSystemPrompt({ projectId: session.project_id, profileId });
  // Contexto volátil entra só na última mensagem: o system fica idêntico entre mensagens
  // e o prefixo (ferramentas + system) é reaproveitado do cache do provider.
  // `/nome` no começo ativa a skill só nesta mensagem (sem chamada extra ao modelo).
  const command = parseSkillCommand(text);
  const turnContext = buildTurnContext({ retrieved, skill: command?.skill || null });
  const modelHistory = history.map((message, index) =>
    index === history.length - 1 ? { ...message, content: withTurnContext(message.content, turnContext) } : message,
  );

  let acc = '';
  let final = null;
  let lastModel = null;

  try {
    for await (const event of runChat({
      profileId,
      modelId: body.modelId || null,
      system,
      messages: modelHistory,
      signal: controller.signal,
      tools,
      projectPath,
      sessionId: session.id,
      noCache: Boolean(body.noCache),
    })) {
      if (event.type === 'delta') acc += event.text;
      if (event.type === 'attempt') lastModel = event.modelId;
      if (event.type === 'done') {
        final = event;
        if (typeof event.text === 'string') acc = event.text;
      }
      send(event.type, event);
    }
  } catch (err) {
    send('error', { message: String(err.message || err) });
  }

  if (final) {
    const cost = final.cost || 0;
    db.prepare(
      `INSERT INTO messages
         (id, session_id, role, content, model_id, provider_id, input_tokens, output_tokens, cost, meta, created_at)
       VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      newId('msg'),
      session.id,
      acc,
      final.modelId,
      final.providerId,
      final.usage?.inputTokens || 0,
      final.usage?.outputTokens || 0,
      cost,
      JSON.stringify({ label: final.label, tools: final.tools || [], cacheHit: Boolean(final.cacheHit) }),
      nowIso(),
    );

    recordUsage({
      sessionId: session.id,
      projectId: session.project_id,
      modelId: final.modelId,
      providerId: final.providerId,
      inputTokens: final.usage?.inputTokens || 0,
      outputTokens: final.usage?.outputTokens || 0,
      cachedInputTokens: final.usage?.cachedInputTokens || 0,
      cacheWriteTokens: final.usage?.cacheWriteTokens || 0,
      latencyMs: final.usage?.latencyMs ?? null,
      cost,
      saved: final.saved || 0,
      kind: final.cacheHit ? 'cache_hit' : 'chat',
    });

    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowIso(), session.id);
    send('end', { ok: true, usage: final.usage, cost, modelId: final.modelId, cacheHit: Boolean(final.cacheHit) });
  } else {
    if (acc) {
      db.prepare(
        `INSERT INTO messages
           (id, session_id, role, content, model_id, provider_id, meta, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
      ).run(newId('msg'), session.id, acc, lastModel, null, JSON.stringify({ partial: true }), nowIso());
    }
    send('end', { ok: false });
  }

  res.end();
}

function sessionList(url) {
  const projectId = url.searchParams.get('projectId');
  const rows = db
    .prepare(
      `SELECT s.*,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
              (SELECT COALESCE(SUM(cost),0) FROM usage_events u WHERE u.session_id = s.id) AS cost
         FROM sessions s
         ${projectId ? 'WHERE s.project_id = ?' : ''}
         ORDER BY s.updated_at DESC
         LIMIT 100`,
    )
    .all(...(projectId ? [projectId] : []));
  return rows;
}

function bugsExport(url) {
  const projectId = url.searchParams.get('projectId');
  const rows = db
    .prepare(
      `SELECT b.*, p.name AS project_name FROM bugs b
        LEFT JOIN projects p ON p.id = b.project_id
        ${projectId ? 'WHERE b.project_id = ?' : ''}
        ORDER BY b.created_at DESC`,
    )
    .all(...(projectId ? [projectId] : []));

  const format = url.searchParams.get('format') || 'json';
  if (format === 'md') {
    const lines = ['# Bugs', ''];
    for (const b of rows) {
      lines.push(`## [${b.severity}] ${b.title}`);
      lines.push(`- id: \`${b.id}\``);
      lines.push(`- status: ${b.status}`);
      if (b.project_name) lines.push(`- projeto: ${b.project_name}`);
      if (b.area) lines.push(`- área: ${b.area}`);
      if (b.repro) lines.push(`- reproduzir: ${b.repro}`);
      if (b.expected) lines.push(`- esperado: ${b.expected}`);
      if (b.actual) lines.push(`- atual: ${b.actual}`);
      if (b.logs) lines.push(`- logs:\n\n\`\`\`\n${b.logs}\n\`\`\``);
      lines.push('');
    }
    return { body: lines.join('\n'), type: 'text/markdown; charset=utf-8' };
  }

  const payload = rows.map((b) => ({ ...b, tags: safeJson(b.tags, []) }));
  return { body: JSON.stringify({ exportedAt: nowIso(), count: payload.length, bugs: payload }, null, 2), type: 'application/json; charset=utf-8' };
}

function buildCopyContext(url) {
  const sessionId = url.searchParams.get('sessionId');
  const projectId = url.searchParams.get('projectId');
  const session = sessionId ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) : null;
  if (sessionId && !session) return { error: 'conversa não encontrada', status: 404 };

  const resolvedProjectId = projectId || session?.project_id || null;
  const project = resolvedProjectId
    ? db.prepare('SELECT * FROM projects WHERE id = ?').get(resolvedProjectId)
    : null;
  if (resolvedProjectId && !project) return { error: 'projeto não encontrado', status: 404 };

  const sections = ['# Contexto para outra IA', `Gerado em: ${nowIso()}`];
  if (project) {
    sections.push(
      `## Projeto: ${project.name}`,
      project.description ? `Descrição: ${project.description}` : '',
      project.path ? `Caminho local: ${project.path}` : '',
      `Stack: ${safeJson(project.stack, []).join(', ') || 'não informada'}`,
    );

    const decisions = db.prepare(
      'SELECT title, status, context, decision, consequences, created_at FROM decisions WHERE project_id = ? ORDER BY created_at DESC LIMIT 12',
    ).all(project.id);
    if (decisions.length) sections.push('## Decisões registradas', ...decisions.map((d) =>
      `- [${d.status}] ${d.title}${d.decision ? `: ${d.decision}` : ''}${d.consequences ? ` (consequências: ${d.consequences})` : ''}`,
    ));

    const bugs = db.prepare(
      "SELECT title, severity, status, area, repro, expected, actual FROM bugs WHERE project_id = ? AND status != 'resolvido' ORDER BY updated_at DESC LIMIT 10",
    ).all(project.id);
    if (bugs.length) sections.push('## Bugs em aberto', ...bugs.map((b) =>
      `- [${b.severity}/${b.status}] ${b.title}${b.area ? ` (${b.area})` : ''}${b.actual ? ` — atual: ${b.actual}` : ''}${b.expected ? `; esperado: ${b.expected}` : ''}${b.repro ? `; reproduzir: ${b.repro}` : ''}`,
    ));

    const memories = db.prepare(
      'SELECT kind, title, content, created_at FROM memory WHERE project_id = ? ORDER BY created_at DESC LIMIT 6',
    ).all(project.id);
    if (memories.length) sections.push('## Memória e notas recentes', ...memories.map((m) =>
      `### ${m.title || m.kind}\n${String(m.content).slice(0, 800)}`,
    ));

    if (project.path && fs.existsSync(project.path)) {
      try {
        const git = (args: string[]) => execFileSync('git', args, {
          cwd: project.path, encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        const head = git(['log', '-1', '--format=%h %s (%cI)']);
        const changed = git(['status', '--short']);
        if (head) sections.push('## Último commit', head);
        if (changed) sections.push('## Arquivos modificados no repositório', changed.slice(0, 5000));
      } catch { /* projeto sem Git ou Git indisponível */ }
    }

    const sessions = db.prepare(
      'SELECT id, title, summary, updated_at FROM sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 5',
    ).all(project.id);
    if (sessions.length) sections.push('## Conversas recentes', ...sessions.map((s) =>
      `- ${s.title} (${s.updated_at})${s.summary ? `\n  Resumo: ${s.summary}` : ''}`,
    ));
    const recentMessages = db.prepare(
      `SELECT s.title AS session_title, m.role, m.content, m.meta, m.created_at
         FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE s.project_id = ? ORDER BY m.created_at DESC LIMIT 8`,
    ).all(project.id).reverse();
    if (recentMessages.length) sections.push('## Mudanças e confirmações recentes nas conversas', ...recentMessages.map((m) => {
      const role = m.role === 'user' ? 'Usuário' : 'Assistente';
      const meta = safeJson(m.meta, null);
      const tools = (meta?.tools || []).map((t) => `${t.name}: ${t.status}${t.preview ? ` — ${t.preview}` : ''}`).join('; ');
      return `**${m.session_title} · ${role}** (${m.created_at})\n${String(m.content || '').slice(-900)}${tools ? `\nAções: ${tools}` : ''}`;
    }));
  }

  if (session) {
    sections.push(`## Conversa: ${session.title}`, `Perfil: ${session.profile_id}`, `Atualizada em: ${session.updated_at}`);
    if (session.summary) sections.push('### Resumo salvo', session.summary);
    const messages = db.prepare(
      'SELECT role, content, meta, created_at FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 10',
    ).all(session.id).reverse();
    if (messages.length) {
      sections.push('### Trecho recente da conversa', ...messages.map((m) => {
        const role = m.role === 'user' ? 'Usuário' : 'Assistente';
        const content = String(m.content || '').slice(-1200);
        const meta = safeJson(m.meta, null);
        const tools = (meta?.tools || []).map((t) => `${t.name}: ${t.status}${t.preview ? ` — ${t.preview}` : ''}`).join('; ');
        return `**${role}** (${m.created_at})\n${content}${tools ? `\nAções: ${tools}` : ''}`;
      }));
    }
  }

  if (!project && !session) sections.push('Sem conversa ou projeto selecionado.');
  return { context: sections.filter(Boolean).join('\n\n').slice(0, 24000), generatedAt: nowIso() };
}

async function dispatch(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method || 'GET';

  if (!segments[0]?.startsWith('api')) {
    if (method !== 'GET') return json(res, 405, { error: 'método não permitido' });
    return serveStatic(res, url.pathname);
  }

  const [, resource, id, sub] = segments;

  if (resource === 'bootstrap' && method === 'GET') return json(res, 200, publicBootstrap());
  if (resource === 'usage' && method === 'GET') return json(res, 200, usageSummary());
  if (resource === 'route' && method === 'GET') {
    return json(
      res,
      200,
      planRoute({
        profileId: url.searchParams.get('profileId') || 'code',
        modelId: url.searchParams.get('modelId') || null,
      }),
    );
  }
  if (resource === 'health' && method === 'GET') {
    return json(res, 200, { ok: true, version: APP_VERSION, now: nowIso() });
  }
  if (resource === 'context' && method === 'GET') {
    const result = buildCopyContext(url);
    if (result.error) return json(res, result.status, { error: result.error });
    return json(res, 200, result);
  }

  if (resource === 'chat' && method === 'POST') return handleChat(req, res);

  if (resource === 'search') {
    if (method === 'GET' && !id) {
      const q = url.searchParams.get('q') || '';
      const projectId = url.searchParams.get('projectId') || null;
      const kind = url.searchParams.get('kind') || null;
      const limit = Number(url.searchParams.get('limit') || 10);
      if (!q.trim()) return json(res, 200, { query: q, results: [], total: 0 });
      return json(res, 200, search(q, { projectId, kind, limit }));
    }

    if (method === 'GET' && id === 'status') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return json(res, 400, { error: 'projectId obrigatório' });
      return json(res, 200, indexStatus(projectId));
    }

    if (method === 'POST' && id === 'index') {
      const body = await readJson(req);
      const projectId = body.projectId || url.searchParams.get('projectId');
      if (!projectId) return json(res, 400, { error: 'projectId obrigatório' });
      try {
        return json(res, 200, indexProject(projectId));
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    if (method === 'DELETE' && id === 'index') {
      const projectId = url.searchParams.get('projectId');
      if (!projectId) return json(res, 400, { error: 'projectId obrigatório' });
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'approvals') {
    if (method === 'GET') return json(res, 200, { pending: listApprovals() });
    if (method === 'POST' && id) {
      const body = await readJson(req);
      const ok = resolveApproval(id, body.approved !== false);
      return json(res, ok ? 200 : 404, { ok });
    }
  }

  if (resource === 'sessions') {
    if (method === 'POST' && id && sub === 'summarize') {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) return json(res, 404, { error: 'sessão não encontrada' });
      const messages = db
        .prepare("SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC")
        .all(id);
      if (messages.length < 2) return json(res, 400, { error: 'conversa curta demais pra resumir' });

      const transcript = messages
        .map((m) => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${String(m.content).slice(0, 4000)}`)
        .join('\n\n')
        .slice(-24000);

      let summary = '';
      let usedModel = null;
      for await (const event of runChat({
        profileId: 'docs',
        system:
          'Resuma a conversa abaixo em até 12 linhas. Formato: objetivo, o que foi decidido, pendências e bugs citados. Sem introdução.',
        messages: [{ role: 'user', content: transcript }],
      })) {
        if (event.type === 'delta') summary += event.text;
        if (event.type === 'done') usedModel = event.label;
      }
      if (!summary.trim()) return json(res, 502, { error: 'não foi possível resumir agora' });

      db.prepare('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?').run(
        summary.trim(),
        nowIso(),
        id,
      );

      if (session.project_id) {
        const memId = newId('mem');
        db.prepare(
          'INSERT INTO memory (id, project_id, kind, title, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          memId,
          session.project_id,
          'aprendizado',
          `Sessão: ${session.title}`,
          summary.trim(),
          `session:${id}`,
          nowIso(),
        );
      }

      return json(res, 200, { summary: summary.trim(), model: usedModel });
    }

    if (method === 'GET' && !id) return json(res, 200, sessionList(url));
    if (method === 'POST' && !id) {
      const body = await readJson(req);
      const sessionId = newId('ses');
      const row = {
        id: sessionId,
        project_id: body.projectId || null,
        title: body.title || 'Nova conversa',
        profile_id: body.profileId || 'code',
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.prepare(
        'INSERT INTO sessions (id, project_id, title, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(row.id, row.project_id, row.title, row.profile_id, row.created_at, row.updated_at);
      return json(res, 201, row);
    }
    if (method === 'GET' && id) {
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
      if (!session) return json(res, 404, { error: 'sessão não encontrada' });
      const messages = db
        .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
        .all(id)
        .map((m) => ({ ...m, meta: safeJson(m.meta, null) }));
      return json(res, 200, { session, messages });
    }
    if (method === 'PATCH' && id) {
      const body = await readJson(req);
      const fields = [];
      const params = [];
      for (const key of ['title', 'summary', 'profile_id', 'project_id']) {
        if (key in body) {
          fields.push(`${key} = ?`);
          params.push(body[key]);
        }
      }
      if (!fields.length) return json(res, 400, { error: 'nada pra atualizar' });
      fields.push('updated_at = ?');
      params.push(nowIso(), id);
      db.prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return json(res, 200, db.prepare('SELECT * FROM sessions WHERE id = ?').get(id));
    }
    if (method === 'DELETE' && id) {
      db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'projects') {
    if (method === 'GET' && !id) {
      const rows = db
        .prepare(
          `SELECT p.*,
                  (SELECT COUNT(*) FROM decisions d WHERE d.project_id = p.id) AS decision_count,
                  (SELECT COUNT(*) FROM bugs b WHERE b.project_id = p.id AND b.status != 'resolvido') AS open_bugs
             FROM projects p ORDER BY p.created_at ASC`,
        )
        .all()
        .map((p) => ({ ...p, stack: safeJson(p.stack, []) }));
      return json(res, 200, rows);
    }
    if (method === 'POST' && !id) {
      const body = await readJson(req);
      if (!body.name) return json(res, 400, { error: 'nome obrigatório' });
      const projectId = newId('prj');
      const slug =
        body.slug ||
        String(body.name)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
      db.prepare(
        'INSERT INTO projects (id, name, slug, path, description, stack, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        projectId,
        body.name,
        slug,
        body.path || null,
        body.description || null,
        JSON.stringify(body.stack || []),
        nowIso(),
      );
      if (body.path) {
        setImmediate(() => {
          try {
            indexProject(projectId);
          } catch (err) {
            console.error('[índice]', err.message);
          }
        });
      }
      return json(res, 201, db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId));
    }
    if (method === 'PATCH' && id) {
      const body = await readJson(req);
      const fields = [];
      const params = [];
      for (const key of ['name', 'path', 'description']) {
        if (key in body) {
          fields.push(`${key} = ?`);
          params.push(body[key] || null);
        }
      }
      if ('stack' in body) {
        fields.push('stack = ?');
        params.push(JSON.stringify(body.stack || []));
      }
      if (!fields.length) return json(res, 400, { error: 'nada pra atualizar' });
      params.push(id);
      db.prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      if ('path' in body && body.path) {
        setImmediate(() => {
          try {
            indexProject(id);
          } catch (err) {
            console.error('[índice]', err.message);
          }
        });
      }
      return json(res, 200, db.prepare('SELECT * FROM projects WHERE id = ?').get(id));
    }
    if (method === 'DELETE' && id) {
      db.prepare('DELETE FROM decisions WHERE project_id = ?').run(id);
      db.prepare('UPDATE bugs SET project_id = NULL WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM memory WHERE project_id = ?').run(id);
      db.prepare('UPDATE sessions SET project_id = NULL WHERE project_id = ?').run(id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'decisions') {
    if (method === 'GET' && !id) {
      const projectId = url.searchParams.get('projectId');
      const rows = db
        .prepare(
          `SELECT * FROM decisions ${projectId ? 'WHERE project_id = ?' : ''} ORDER BY created_at DESC`,
        )
        .all(...(projectId ? [projectId] : []));
      return json(res, 200, rows);
    }
    if (method === 'POST' && !id) {
      const body = await readJson(req);
      if (!body.projectId || !body.title) return json(res, 400, { error: 'projectId e title obrigatórios' });
      const decisionId = newId('dec');
      db.prepare(
        `INSERT INTO decisions (id, project_id, title, status, context, decision, consequences, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        decisionId,
        body.projectId,
        body.title,
        body.status || 'aceita',
        body.context || null,
        body.decision || null,
        body.consequences || null,
        nowIso(),
      );
      return json(res, 201, db.prepare('SELECT * FROM decisions WHERE id = ?').get(decisionId));
    }
    if (method === 'PATCH' && id) {
      const body = await readJson(req);
      const fields = [];
      const params = [];
      for (const key of ['title', 'status', 'context', 'decision', 'consequences']) {
        if (key in body) {
          fields.push(`${key} = ?`);
          params.push(body[key]);
        }
      }
      if (!fields.length) return json(res, 400, { error: 'nada pra atualizar' });
      params.push(id);
      db.prepare(`UPDATE decisions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return json(res, 200, db.prepare('SELECT * FROM decisions WHERE id = ?').get(id));
    }
    if (method === 'DELETE' && id) {
      db.prepare('DELETE FROM decisions WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'bugs') {
    if (method === 'GET' && id === 'export') {
      const out = bugsExport(url);
      res.writeHead(200, { 'content-type': out.type, 'content-disposition': 'attachment; filename="bugs-export"' });
      return res.end(out.body);
    }
    if (method === 'GET' && !id) {
      const projectId = url.searchParams.get('projectId');
      const status = url.searchParams.get('status');
      const where = [];
      const params = [];
      if (projectId) {
        where.push('b.project_id = ?');
        params.push(projectId);
      }
      if (status) {
        where.push('b.status = ?');
        params.push(status);
      }
      const rows = db
        .prepare(
          `SELECT b.*, p.name AS project_name FROM bugs b
             LEFT JOIN projects p ON p.id = b.project_id
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY CASE b.severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
                      b.created_at DESC`,
        )
        .all(...params)
        .map((b) => ({ ...b, tags: safeJson(b.tags, []) }));
      return json(res, 200, rows);
    }
    if (method === 'POST' && !id) {
      const body = await readJson(req);
      if (!body.title) return json(res, 400, { error: 'título obrigatório' });
      const bugId = newId('bug');
      const ts = nowIso();
      db.prepare(
        `INSERT INTO bugs (id, project_id, title, severity, status, area, repro, expected, actual, logs, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        bugId,
        body.projectId || null,
        body.title,
        body.severity || 'media',
        body.status || 'aberto',
        body.area || null,
        body.repro || null,
        body.expected || null,
        body.actual || null,
        body.logs || null,
        JSON.stringify(body.tags || []),
        ts,
        ts,
      );
      return json(res, 201, db.prepare('SELECT * FROM bugs WHERE id = ?').get(bugId));
    }
    if (method === 'PATCH' && id) {
      const body = await readJson(req);
      const fields = [];
      const params = [];
      for (const key of ['project_id', 'title', 'severity', 'status', 'area', 'repro', 'expected', 'actual', 'logs']) {
        if (key in body) {
          fields.push(`${key} = ?`);
          params.push(body[key]);
        }
      }
      if ('tags' in body) {
        fields.push('tags = ?');
        params.push(JSON.stringify(body.tags || []));
      }
      if (!fields.length) return json(res, 400, { error: 'nada pra atualizar' });
      fields.push('updated_at = ?');
      params.push(nowIso(), id);
      db.prepare(`UPDATE bugs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      return json(res, 200, db.prepare('SELECT * FROM bugs WHERE id = ?').get(id));
    }
    if (method === 'DELETE' && id) {
      db.prepare('DELETE FROM bugs WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'skills') {
    const summary = (skill) => ({ name: skill.name, description: skill.description, chars: skill.chars });
    if (method === 'GET' && id === 'importable') {
      const installed = new Set(listSkills().map((skill) => skill.name));
      return json(res, 200, findImportable().map(({ name, description }) => ({ name, description, installed: installed.has(name) })));
    }
    if (method === 'GET' && id) {
      const skill = getSkill(id);
      return skill ? json(res, 200, skill) : json(res, 404, { error: 'skill não encontrada' });
    }
    if (method === 'GET') return json(res, 200, listSkills().map(summary));
    // Só importa da pasta padrão (~/.claude/skills), por nome: a API não lê caminhos arbitrários.
    if (method === 'POST' && id === 'import') {
      const body = await readJson(req);
      const names = Array.isArray(body.names) ? body.names.map(String) : [];
      return json(res, 200, { imported: importSkills(names) });
    }
    if (method === 'DELETE' && id) {
      return deleteSkill(id) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'skill não encontrada' });
    }
  }

  if (resource === 'memory') {
    if (method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      const rows = db
        .prepare(`SELECT * FROM memory ${projectId ? 'WHERE project_id = ?' : ''} ORDER BY created_at DESC`)
        .all(...(projectId ? [projectId] : []));
      return json(res, 200, rows);
    }
    if (method === 'POST') {
      const body = await readJson(req);
      if (!body.content) return json(res, 400, { error: 'conteúdo obrigatório' });
      const memoryId = newId('mem');
      db.prepare(
        'INSERT INTO memory (id, project_id, kind, title, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        memoryId,
        body.projectId || null,
        body.kind || 'nota',
        body.title || null,
        body.content,
        body.source || null,
        nowIso(),
      );
      return json(res, 201, db.prepare('SELECT * FROM memory WHERE id = ?').get(memoryId));
    }
    if (method === 'DELETE' && id) {
      db.prepare('DELETE FROM memory WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'models') {
    if (method === 'POST' && id === 'sync') return json(res, 200, { report: await syncModels() });
    if (method === 'PATCH') {
      const modelId = url.searchParams.get('id');
      if (!modelId) return json(res, 400, { error: 'id obrigatório' });
      const body = await readJson(req);
      const fields = [];
      const params = [];
      for (const key of ['enabled', 'price_in', 'price_out', 'ctx', 'label', 'notes']) {
        if (key in body) {
          fields.push(`${key} = ?`);
          params.push(body[key]);
        }
      }
      if (fields.length) {
        params.push(modelId);
        db.prepare(`UPDATE models SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      }
      if ('budgetWeek' in body || 'budgetMonth' in body) {
        const budgets = getSetting('budgets', {});
        budgets[modelId] = {
          ...(budgets[modelId] || {}),
          week: Number(body.budgetWeek || 0),
          month: Number(body.budgetMonth || 0),
        };
        setSetting('budgets', budgets);
      }
      return json(res, 200, getModel(modelId));
    }
    if (method === 'GET' && id) {
      return json(res, 200, getModel(id));
    }
  }

  if (resource === 'profiles' && method === 'PATCH' && id) {
    const body = await readJson(req);
    if (Array.isArray(body.chain)) {
      db.prepare('UPDATE profiles SET chain = ? WHERE id = ?').run(JSON.stringify(body.chain), id);
    }
    if (typeof body.system_prompt === 'string') {
      db.prepare('UPDATE profiles SET system_prompt = ? WHERE id = ?').run(body.system_prompt, id);
    }
    return json(res, 200, db.prepare('SELECT * FROM profiles WHERE id = ?').get(id));
  }

  if (resource === 'keys') {
    if (method === 'POST') {
      const body = await readJson(req);
      if (!body.providerId) return json(res, 400, { error: 'providerId obrigatório' });
      const keys = getSetting('keys', {});
      if (body.apiKey) keys[body.providerId] = String(body.apiKey).trim();
      else delete keys[body.providerId];
      setSetting('keys', keys);
      return json(res, 200, { ok: true, hasKey: Boolean(keys[body.providerId]) });
    }
    if (method === 'DELETE') {
      const providerId = url.searchParams.get('providerId');
      const keys = getSetting('keys', {});
      delete keys[providerId];
      setSetting('keys', keys);
      return json(res, 200, { ok: true });
    }
  }

  if (resource === 'health' && method === 'POST' && id === 'reset') {
    const body = await readJson(req);
    if (body.modelId) db.prepare('DELETE FROM model_health WHERE model_id = ?').run(body.modelId);
    else db.prepare('DELETE FROM model_health').run();
    return json(res, 200, { ok: true });
  }

  if (resource === 'settings' && method === 'PUT') {
    const body = await readJson(req);
    if ('globalNotes' in body) setSetting('globalNotes', String(body.globalNotes || ''));
    if ('router' in body) setSetting('router', body.router || {});
    if ('budgets' in body) setSetting('budgets', body.budgets || {});
    if ('compression' in body) {
      const cfg = body.compression || {};
      const out: Record<string, any> = { enabled: cfg.enabled !== false };
      if (Number(cfg.thresholdTokens) >= 1000) out.thresholdTokens = Math.min(Number(cfg.thresholdTokens), 500000);
      if (Number(cfg.keepRecent) >= 2) out.keepRecent = Math.min(Math.floor(Number(cfg.keepRecent)), 50);
      if (typeof cfg.profileId === 'string' && cfg.profileId) out.profileId = cfg.profileId;
      setSetting('compression', out);
    }
    if ('responseCache' in body) {
      const cfg = body.responseCache || {};
      const ttlHours = Number(cfg.ttlHours);
      setSetting('responseCache', {
        enabled: cfg.enabled !== false,
        ...(Number.isFinite(ttlHours) && ttlHours > 0 ? { ttlHours: Math.min(ttlHours, 24 * 30) } : {}),
      });
    }
    return json(res, 200, { ok: true });
  }

  if (resource === 'cache' && method === 'GET') return json(res, 200, { ...cacheSettings(), ...cacheStats() });
  if (resource === 'cache' && method === 'DELETE') return json(res, 200, { removed: clearCache() });

  if (resource === 'figma') {
    if (id === 'status' && method === 'GET') return json(res, 200, figma.status());

    if (id === 'token' && method === 'POST') {
      const body = await readJson(req);
      setSetting('figma', { token: String(body.token || '').trim() || null });
      return json(res, 200, figma.status());
    }

    if (id === 'file' && method === 'GET') {
      try {
        const key = figma.parseKey(url.searchParams.get('url') || url.searchParams.get('key'));
        const file = await figma.getFile(key);
        return json(res, 200, { key, name: file.name, outline: figma.outline(file) });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }

    if (id === 'import' && method === 'POST') {
      try {
        const body = await readJson(req);
        const file = await figma.importFile({ url: body.url, projectId: body.projectId });
        const memoryId = newId('mem');
        db.prepare(
          'INSERT INTO memory (id, project_id, kind, title, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          memoryId,
          body.projectId || null,
          'figma',
          `Figma · ${file.name}`,
          file.content,
          `figma:${file.key}`,
          nowIso(),
        );
        return json(res, 201, {
          ok: true,
          memoryId,
          key: file.key,
          name: file.name,
          chars: file.content.length,
        });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }
  }

  if (resource === 'google') {
    if (id === 'status' && method === 'GET') return json(res, 200, google.status());
    if (id === 'auth' && method === 'GET') {
      try {
        return json(res, 200, { url: google.authUrl() });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }
    if (id === 'callback' && method === 'GET') {
      try {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code) throw new Error('código ausente');
        await google.exchangeCode(code, state);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(
          '<body style="background:#08090c;color:#e8e8e8;font-family:system-ui;padding:40px">' +
            '<h2>Google Drive conectado ✅</h2><p>Pode fechar esta aba e voltar ao teko.</p>' +
            '<script>setTimeout(()=>window.close(),1500)</script></body>',
        );
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }
    if (id === 'search' && method === 'GET') {
      try {
        return json(res, 200, await google.search(url.searchParams.get('q') || ''));
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }
    if (id === 'import' && method === 'POST') {
      try {
        const body = await readJson(req);
        if (!body.fileId) return json(res, 400, { error: 'fileId obrigatório' });
        const file = await google.importFile(body.fileId);
        const memoryId = newId('mem');
        db.prepare(
          'INSERT INTO memory (id, project_id, kind, title, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(
          memoryId,
          body.projectId || null,
          'doc',
          file.title,
          file.content,
          `gdrive:${file.id}`,
          nowIso(),
        );
        return json(res, 201, { ok: true, memoryId, title: file.title, chars: file.content.length });
      } catch (err) {
        return json(res, 400, { error: String(err.message || err) });
      }
    }
  }

  return json(res, 404, { error: `rota não encontrada: ${method} ${url.pathname}` });
}

const server = http.createServer((req, res) => {
  dispatch(req, res).catch((err) => {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    json(res, 500, { error: String(err.message || err) });
  });
});

try {
  pruneCache({ ttlHours: cacheSettings().ttlHours });
} catch (err) {
  console.error('[cache]', err.message);
}

server.listen(PORT, HOST, () => {
  console.log(`\n  teko v${APP_VERSION}`);
  console.log(`  http://${HOST}:${PORT}\n`);
});
