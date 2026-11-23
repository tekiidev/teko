import fs from 'node:fs';
import { db, newId, nowIso } from './db.js';
import { recordUsage } from './usage.js';
import { runChat } from './router.js';
import { compactHistory, compressionSettings, loadSessionHistory, withSummary } from './compress.js';
import { buildSystemPrompt, buildTurnContext, withTurnContext } from './context.js';
import { parseSkillCommand } from './skills.js';
import { toolDefs } from './tools/index.js';
import { ensureIndex, searchForPrompt } from './search-index.js';

/**
 * Uma mensagem completa de chat, igual pra qualquer porta de entrada (painel, terminal):
 * sessão, histórico com compressão, contexto do turno, skills, roteamento, gravação e uso.
 * Gera os mesmos eventos do roteador, mais `meta`, `compressed` e `end`.
 */

/** Uma chamada simples (sem ferramentas) que devolve o evento done. */
export async function summarizeOnce(system, prompt, profileId, signal = null) {
  let done = null;
  for await (const event of runChat({ profileId, system, messages: [{ role: 'user', content: prompt }], signal, noCache: true })) {
    if (event.type === 'done') done = event;
  }
  if (!done) throw new Error('resumo indisponível');
  return done;
}

function usageRow(sessionId, projectId, r, kind) {
  recordUsage({
    sessionId,
    projectId,
    modelId: r.modelId,
    providerId: r.providerId,
    inputTokens: r.usage?.inputTokens || 0,
    outputTokens: r.usage?.outputTokens || 0,
    cachedInputTokens: r.usage?.cachedInputTokens || 0,
    cacheWriteTokens: r.usage?.cacheWriteTokens || 0,
    latencyMs: r.usage?.latencyMs ?? null,
    cost: r.cost || 0,
    saved: r.saved || 0,
    kind,
  });
}

const plain = (t: string) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

/**
 * "Teko, trabalha no projeto Cofu" / "muda pro teko" / "sai do projeto".
 * Só vale se o nome bater com um projeto cadastrado (senão segue pra IA normalmente).
 * Devolve { projectId } (null = sair do projeto) ou undefined se não for comando.
 */
export function parseProjectCommand(text: string, projects: { id: string; name: string; slug?: string | null }[]) {
  const t = plain(text).replace(/^(ei,?\s*)?teko[,.!]?\s*/, '').replace(/[.!?]+$/, '');
  if (/^(sai|sair|fecha|fechar) (do|o) projeto$|^sem projeto$/.test(t)) return { projectId: null, name: null };
  const m = /^(?:(?:vamos |bora )?trabalhar|trabalha|mexe|mexer|muda|mudar|troca|trocar|abre|abrir|usa|usar|entra|entrar)\s+(?:(?:no|na|pro|pra|para o|para a|o|a|em)\s+)?(?:projeto\s+)?(.+)$/.exec(t);
  if (!m) return undefined;
  const nome = m[1].trim();
  const achado = projects.find((p) => plain(p.name) === nome || plain(p.slug || '') === nome);
  return achado ? { projectId: achado.id, name: achado.name } : undefined;
}

export function getOrCreateSession({ sessionId = null, projectId = null, profileId = null, title = '' }) {
  const existing = sessionId ? db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) : null;
  if (existing) return existing;
  const session = {
    id: newId('ses'),
    project_id: projectId || null,
    profile_id: profileId || 'code',
    title: title.slice(0, 70) || 'Nova conversa',
    summary: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  db.prepare(
    'INSERT INTO sessions (id, project_id, title, profile_id, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(session.id, session.project_id, session.title, session.profile_id, null, session.created_at, session.updated_at);
  return session;
}

export async function* runTurn({
  text,
  sessionId = null,
  projectId = null,
  profileId: requestedProfile = null,
  modelId = null,
  noCache = false,
  signal = null,
  onWarn = (scope, message) => console.error(`[${scope}]`, message),
}) {
  const session = getOrCreateSession({ sessionId, projectId, profileId: requestedProfile, title: text });
  const profileId = requestedProfile || session.profile_id || 'code';

  const stored = loadSessionHistory(session.id);
  stored.messages.push({ role: 'user', content: text });
  db.prepare('INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
    newId('msg'),
    session.id,
    'user',
    text,
    nowIso(),
  );
  db.prepare('UPDATE sessions SET updated_at = ?, profile_id = ? WHERE id = ?').run(nowIso(), profileId, session.id);

  yield { type: 'meta', sessionId: session.id, projectId: session.project_id, profileId };

  // Troca de projeto falada/escrita: resolve aqui, sem gastar IA.
  const troca = parseProjectCommand(text, db.prepare('SELECT id, name, slug FROM projects').all());
  if (troca !== undefined) {
    db.prepare('UPDATE sessions SET project_id = ?, updated_at = ? WHERE id = ?').run(troca.projectId, nowIso(), session.id);
    const resposta = troca.projectId ? `Beleza, agora estou no projeto ${troca.name}.` : 'Beleza, saí do projeto.';
    db.prepare("INSERT INTO messages (id, session_id, role, content, model_id, meta, created_at) VALUES (?, ?, 'assistant', ?, 'teko/local', ?, ?)").run(
      newId('msg'), session.id, resposta, JSON.stringify({ label: 'Teko', local: true }), nowIso(),
    );
    yield { type: 'meta', sessionId: session.id, projectId: troca.projectId, profileId };
    yield { type: 'delta', text: resposta };
    const usage = { inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    yield { type: 'done', modelId: 'teko/local', providerId: 'teko', label: 'Teko', usage, cost: 0, saved: 0, text: resposta, tools: [] };
    yield { type: 'end', ok: true, usage, cost: 0, modelId: 'teko/local', cacheHit: false };
    return;
  }

  const project = session.project_id ? db.prepare('SELECT * FROM projects WHERE id = ?').get(session.project_id) : null;
  const projectPath = project?.path && fs.existsSync(project.path) ? project.path : null;
  // Na voz ainda não dá pra aprovar no meio da conversa (issue #62): só ferramentas de leitura.
  const tools = projectPath ? toolDefs({ readOnly: profileId === 'voice' }) : null;

  let retrieved = '';
  if (project?.id) {
    try {
      ensureIndex(project.id);
      retrieved = searchForPrompt(project.id, text, { limit: 4, maxChars: 3500 });
    } catch (err) {
      onWarn('busca', err.message);
    }
  }

  // Conversa longa: as mensagens antigas viram resumo (modelo barato) e ficam salvas na sessão.
  const compressCfg = compressionSettings();
  const compacted = await compactHistory({
    sessionId: session.id,
    summary: stored.summary,
    messages: stored.messages,
    settings: compressCfg,
    summarize: (summarySystem, prompt) => summarizeOnce(summarySystem, prompt, compressCfg.profileId, signal),
  });
  if (compacted.compressed) {
    const r = compacted.compressed.result;
    usageRow(session.id, session.project_id, r, 'compression');
    yield { type: 'compressed', messages: compacted.compressed.messages, savedTokens: compacted.compressed.savedTokens, modelId: r.modelId };
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
      modelId,
      system,
      messages: modelHistory,
      signal,
      tools,
      projectPath,
      sessionId: session.id,
      noCache,
    })) {
      if (event.type === 'delta') acc += event.text;
      if (event.type === 'attempt') lastModel = event.modelId;
      if (event.type === 'done') {
        final = event;
        if (typeof event.text === 'string') acc = event.text;
      }
      yield event;
    }
  } catch (err) {
    yield { type: 'error', message: String(err.message || err) };
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
    usageRow(session.id, session.project_id, { ...final, cost }, final.cacheHit ? 'cache_hit' : 'chat');
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowIso(), session.id);
    yield { type: 'end', ok: true, usage: final.usage, cost, modelId: final.modelId, cacheHit: Boolean(final.cacheHit) };
  } else {
    if (acc) {
      db.prepare(
        `INSERT INTO messages
           (id, session_id, role, content, model_id, provider_id, meta, created_at)
         VALUES (?, ?, 'assistant', ?, ?, ?, ?, ?)`,
      ).run(newId('msg'), session.id, acc, lastModel, null, JSON.stringify({ partial: true }), nowIso());
    }
    yield { type: 'end', ok: false };
  }
}
