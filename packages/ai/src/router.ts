import { db, getModel, getProvider, getSetting, safeJson } from './db.js';
import { ADAPTERS } from './providers/index.js';
import { env } from './config.js';
import { previaDesfazer } from './undo.js';
import { tokensSince, windowStart } from './usage.js';
import { createApproval, resolveApproval } from './approvals.js';
import { getTool, executeTool, previewFor, toolsForModel } from './tools/index.js';
import { addUsage, computeCost, type Usage } from './pricing.js';
import { cacheKey, cacheSettings, getCached, putCached } from './response-cache.js';

const modelTags = (model): string[] => safeJson(model?.tags, []) || [];
/** Ferramentas já chamadas nesta conversa (pelos resultados com role tool). */
const toolsUsed = (conversation) => new Set<string>(conversation.filter((m) => m.role === 'tool' && m.name).map((m) => m.name));

export function resolveKey(provider) {
  if (!provider) return null;
  const keys = getSetting('keys', {});
  const stored = keys[provider.id];
  if (stored) return stored;
  return provider.key_env ? env(provider.key_env) : null;
}

export function modelHealth(modelId) {
  const row = db.prepare('SELECT * FROM model_health WHERE model_id = ?').get(modelId);
  const until = row?.cooldown_until ? new Date(row.cooldown_until) : null;
  const active = until && until.getTime() > Date.now();
  return {
    cooldownUntil: active ? until.toISOString() : null,
    lastError: row?.last_error ?? null,
    reason: active ? row?.reason ?? null : null,
    failures: row?.failures ?? 0,
  };
}

export function budgetStatus(modelId) {
  const budgets = getSetting('budgets', {});
  const cfg = budgets[modelId] || budgets['*'];
  if (!cfg) return null;
  const labels = { week: 'semana', month: 'mês' };
  for (const w of ['week', 'month']) {
    const cap = Number(cfg[w] || 0);
    if (!cap) continue;
    const used = tokensSince(windowStart(w), modelId);
    if (used >= cap) return { window: w, label: labels[w], used, cap };
  }
  return null;
}

export function buildChain({ profileId = 'code', modelId = null }) {
  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(profileId);
  let chain = profile ? safeJson(profile.chain, []) : [];
  if (modelId) chain = [modelId, ...chain.filter((id) => id !== modelId)];
  const seen = new Set();
  return chain.filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function planRoute({ profileId = 'code', modelId = null } = {}) {
  return buildChain({ profileId, modelId }).map((id, index) => {
    const model = getModel(id);
    if (!model) {
      return { order: index + 1, modelId: id, label: id, status: 'skip', reason: 'modelo não cadastrado' };
    }
    const provider = getProvider(model.provider_id);
    const base = {
      order: index + 1,
      modelId: model.id,
      label: model.label,
      providerId: model.provider_id,
      providerLabel: provider?.label ?? model.provider_id,
      tags: model.tags,
      ctx: model.ctx,
      priceIn: model.price_in,
      priceOut: model.price_out,
    };
    if (!provider) return { ...base, status: 'skip', reason: 'provider não cadastrado' };
    if (!provider.enabled || !model.enabled) return { ...base, status: 'skip', reason: 'desativado' };
    const key = resolveKey(provider);
    if (!key && provider.id !== 'ollama') return { ...base, status: 'skip', reason: 'sem chave de API' };
    const health = modelHealth(model.id);
    if (health.cooldownUntil) {
      return {
        ...base,
        status: 'skip',
        reason: `cooldown (${health.reason || 'erro'}) até ${new Date(health.cooldownUntil).toLocaleTimeString('pt-BR')}`,
      };
    }
    const budget = budgetStatus(model.id);
    if (budget) {
      return {
        ...base,
        status: 'skip',
        reason: `orçamento da ${budget.label} esgotado (${fmtTokens(budget.used)}/${fmtTokens(budget.cap)})`,
      };
    }
    return { ...base, status: 'ready' };
  });
}

function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function describeError(err) {
  if (!err) return 'erro desconhecido';
  if (err.code === 'refusal') return 'recusa do modelo';
  if (err.name === 'AbortError' || /aborted|timeout/i.test(err.message || '')) return 'timeout';
  if (err.status === 401 || err.status === 403) return 'chave inválida';
  if (err.status === 429) return 'limite de uso (429)';
  if (err.status === 402) return 'crédito esgotado';
  if (/requires .*GiB|out of memory|not enough memory|failed to load model/i.test(err.message || '')) {
    return 'sem memória local';
  }
  if (/quota|insufficient|credit|exceeded|limit/i.test(err.message || '')) return 'cota esgotada';
  if (err.status >= 500) return `instabilidade do provider (${err.status})`;
  return err.message ? String(err.message).slice(0, 140) : 'falha no provider';
}

function markFailure(modelId, err) {
  const now = Date.now();
  let minutes = 2;
  let reason = 'erro';
  const msg = String(err?.message || '');

  if (err?.status === 401 || err?.status === 403) {
    minutes = 30;
    reason = 'chave inválida';
  } else if (err?.status === 429) {
    minutes = Math.max(1, Math.ceil((err.retryAfter ?? 900) / 60));
    reason = 'limite de uso';
  } else if (err?.status === 402) {
    minutes = 60 * 24;
    reason = 'crédito esgotado';
  } else if (/quota|insufficient|credit|exceeded/i.test(msg)) {
    minutes = 60 * 12;
    reason = 'cota esgotada';
  } else if (/requires .*GiB|out of memory|not enough memory|failed to load model/i.test(msg)) {
    minutes = 60 * 12;
    reason = 'sem memória local';
  } else if (err?.status >= 500) {
    minutes = 3;
    reason = 'instabilidade';
  }

  const until = new Date(now + minutes * 60_000).toISOString();
  db.prepare(
    `INSERT INTO model_health (model_id, cooldown_until, last_error, reason, failures)
     VALUES (?, ?, ?, ?, 1)
     ON CONFLICT(model_id) DO UPDATE SET
       cooldown_until = excluded.cooldown_until,
       last_error = excluded.last_error,
       reason = excluded.reason,
       failures = model_health.failures + 1`,
  ).run(modelId, until, msg.slice(0, 500), reason);
}

function clearHealth(modelId) {
  db.prepare('DELETE FROM model_health WHERE model_id = ?').run(modelId);
}

function makeQueue() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(item) {
      items.push(item);
      wake?.();
      wake = null;
    },
    close() {
      closed = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) {
          yield items.shift();
          continue;
        }
        if (closed) return;
        await new Promise((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

async function waitApproval(approval, signal) {
  if (!signal) return approval.promise;
  return new Promise((resolve) => {
    const onAbort = () => {
      resolveApproval(approval.id, false);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    approval.promise.then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
  });
}

async function* attemptModel({
  model,
  provider,
  adapter,
  conversation,
  system,
  tools,
  signal,
  timeoutMs,
  maxTokens,
}) {
  const queue = makeQueue();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('timeout do provider')), timeoutMs);

  let text = '';
  const promise = adapter({
    model: model.model,
    system,
    messages: conversation,
    maxTokens,
    apiKey: resolveKey(provider),
    baseUrl: provider.base_url,
    signal: controller.signal,
    tools,
    onDelta: (delta) => {
      text += delta;
      queue.push({ type: 'delta', text: delta });
    },
  })
    .then((result) => ({ ok: true, ...result }))
    .catch((error) => ({ ok: false, error }))
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      queue.close();
    });

  for await (const event of queue) yield event;
  const result = await promise;
  return result.ok ? { ...result, text } : result;
}

/**
 * Executa a conversa com fallback automático e loop de ferramentas.
 * Eventos: attempt | delta | fallback | tool_call | tool_decision | tool_running |
 *          tool_result | done | error | aborted
 */
export async function* runChat({
  profileId = 'code',
  modelId = null,
  system = '',
  messages,
  signal = null,
  maxTokens = 4096,
  tools = null,
  projectPath = null,
  projectId = null,
  sessionId = null,
  noCache = false,
}) {
  const cfg = getSetting('router', {});
  const activeTools = tools?.length ? tools : null;

  // Cache local: só sem ferramentas, porque aí a resposta depende só do que foi enviado.
  const cacheCfg = cacheSettings();
  const useCache = cacheCfg.enabled && !activeTools;
  const key = useCache ? cacheKey({ profileId, modelId, system, messages }) : null;
  if (key && !noCache) {
    const hit = getCached(key, { ttlHours: cacheCfg.ttlHours });
    if (hit) {
      yield { type: 'delta', text: hit.text };
      yield {
        type: 'done',
        cacheHit: true,
        modelId: hit.model_id,
        providerId: hit.provider_id,
        label: hit.label,
        usage: { inputTokens: 0, outputTokens: 0, latencyMs: 0, savedTokens: hit.input_tokens + hit.output_tokens },
        cost: 0,
        saved: hit.cost,
        text: hit.text,
        tools: [],
      };
      return;
    }
  }

  const maxAttempts = Number(cfg.maxAttempts || 6);
  const timeoutMs = Number(cfg.requestTimeoutMs || 180000);
  const maxRounds = Math.max(1, Math.min(Number(cfg.maxToolRounds || 8), 20));

  const plan = planRoute({ profileId, modelId });
  const usable = plan.filter((c) => c.status === 'ready').slice(0, maxAttempts);

  if (!usable.length) {
    yield {
      type: 'error',
      message:
        'Nenhum modelo disponível na fila. Cadastre uma chave, aguarde o cooldown ou aumente o orçamento.',
      candidates: plan,
    };
    return;
  }

  const conversation = messages.map((message) => ({ ...message }));
  const toolLog = [];

  let modelIndex = 0;
  let rounds = 0;
  let totalUsage: Usage = {};
  let totalCost = 0;
  let totalSaved = 0;
  let totalLatencyMs = 0;
  let fullText = '';
  let last = null;

  while (rounds <= maxRounds) {
    if (signal?.aborted) {
      yield { type: 'aborted' };
      return;
    }

    const candidate = usable[modelIndex];
    if (!candidate) {
      yield {
        type: 'error',
        message: 'Todos os modelos da fila falharam. Veja o cooldown na aba Modelos.',
        candidates: plan,
      };
      return;
    }

    const model = getModel(candidate.modelId);
    const provider = getProvider(model.provider_id);
    const adapter = ADAPTERS[provider.kind];

    if (!adapter) {
      markFailure(model.id, new Error(`adapter "${provider.kind}" não implementado`));
      yield {
        type: 'fallback',
        from: model.id,
        fromLabel: model.label,
        reason: 'adapter não implementado',
        truncate: fullText.length,
      };
      modelIndex += 1;
      continue;
    }

    yield {
      type: 'attempt',
      modelId: model.id,
      label: model.label,
      providerId: provider.id,
      providerLabel: provider.label,
      order: candidate.order,
      round: rounds + 1,
      tools: Boolean(activeTools),
    };

    const startedAt = Date.now();
    const outcome = yield* attemptModel({
      model,
      provider,
      adapter,
      conversation,
      system,
      tools: toolsForModel(activeTools, modelTags(model), toolsUsed(conversation)),
      signal,
      timeoutMs,
      maxTokens,
    });

    if (!outcome.ok) {
      if (signal?.aborted) {
        yield { type: 'aborted' };
        return;
      }
      // Recusa depende do conteúdo, não da saúde do modelo: tenta o próximo sem cooldown.
      if (outcome.error?.code !== 'refusal') markFailure(model.id, outcome.error);
      yield {
        type: 'fallback',
        from: model.id,
        fromLabel: model.label,
        reason: describeError(outcome.error),
        detail: String(outcome.error?.message || outcome.error).slice(0, 300),
        truncate: fullText.length,
      };
      modelIndex += 1;
      continue;
    }

    clearHealth(model.id);
    totalLatencyMs += Date.now() - startedAt;
    totalUsage = addUsage(totalUsage, outcome);
    const price = computeCost(model, provider.id, outcome);
    totalCost += price.cost;
    totalSaved += price.saved;
    if (outcome.text) fullText += (fullText ? '\n\n' : '') + outcome.text;
    last = { model, provider };

    const calls = outcome.toolCalls || [];
    if (!calls.length) {
      if (key && !toolLog.length) {
        putCached(key, {
          modelId: model.id,
          providerId: provider.id,
          label: model.label,
          text: fullText,
          inputTokens: totalUsage.inputTokens || 0,
          outputTokens: totalUsage.outputTokens || 0,
          cost: totalCost,
        });
      }
      yield {
        type: 'done',
        modelId: model.id,
        providerId: provider.id,
        label: model.label,
        usage: { ...totalUsage, latencyMs: totalLatencyMs },
        cost: totalCost,
        saved: totalSaved,
        text: fullText,
        tools: toolLog,
      };
      return;
    }

    conversation.push({
      role: 'assistant',
      content: outcome.text || '',
      toolCalls: calls,
      providerContent: outcome.providerContent,
    });

    for (const call of calls) {
      if (signal?.aborted) {
        yield { type: 'aborted' };
        return;
      }

      const tool = getTool(call.name);
      if (!tool) {
        conversation.push({
          role: 'tool',
          toolCallId: call.id,
          name: call.name,
          content: `ferramenta desconhecida: ${call.name}`,
        });
        continue;
      }

      const args = call.args && typeof call.args === 'object' ? call.args : {};
      // Desfazer mostra os arquivos de verdade que vão voltar, não só a quantidade.
      const desfazendo = call.name === 'undo_changes' ? previaDesfazer({ sessionId, root: projectPath, n: args?.n || 1 }) : null;
      const preview = desfazendo?.length ? `desfazer:\n${desfazendo.join('\n')}` : previewFor(call.name, args);
      const approval = tool.requiresApproval
        ? createApproval({ sessionId, tool: call.name, args, preview })
        : null;
      const eventId = approval?.id || call.id;

      yield {
        type: 'tool_call',
        id: eventId,
        callId: call.id,
        name: call.name,
        args,
        preview,
        requiresApproval: Boolean(approval),
      };

      if (approval) {
        const approved = await waitApproval(approval, signal);
        yield { type: 'tool_decision', id: approval.id, callId: call.id, approved };
        if (!approved) {
          const denied = 'Ação negada pelo usuário.';
          conversation.push({ role: 'tool', toolCallId: call.id, name: call.name, content: denied });
          toolLog.push({ id: eventId, name: call.name, status: 'denied', preview });
          continue;
        }
      }

      yield { type: 'tool_running', id: eventId, callId: call.id, name: call.name };
      const result: any = await executeTool(call.name, args, { root: projectPath, projectId, sessionId });
      const output = String(result.output || '');
      const forModel = output.slice(0, 12000);

      yield {
        type: 'tool_result',
        id: eventId,
        callId: call.id,
        name: call.name,
        ok: Boolean(result.ok),
        output: output.slice(0, 4000),
      };

      toolLog.push({
        id: eventId,
        name: call.name,
        status: result.ok ? 'ok' : 'error',
        preview,
        output: output.slice(0, 4000),
      });

      conversation.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: forModel,
      });
    }

    rounds += 1;
  }

  yield {
    type: 'error',
    message: `Limite de ${maxRounds} rodadas de ferramentas atingido. Peça pra continuar de onde parou.`,
    text: fullText,
  };
}
