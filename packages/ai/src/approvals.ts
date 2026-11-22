import { newId } from './db.js';

// Aprovações pendentes de ferramentas que escrevem ou executam algo.
const pending = new Map();
const DEFAULT_TIMEOUT = 5 * 60 * 1000;

export function createApproval({ sessionId = null, tool, args = {}, preview = '' }) {
  const id = newId('apv');
  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  const timer = setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      resolveFn(false);
    }
  }, DEFAULT_TIMEOUT);

  pending.set(id, {
    id,
    sessionId,
    tool,
    args,
    preview,
    createdAt: new Date().toISOString(),
    resolve: (approved) => {
      clearTimeout(timer);
      pending.delete(id);
      resolveFn(Boolean(approved));
    },
  });

  return { id, promise };
}

export function resolveApproval(id, approved) {
  const entry = pending.get(id);
  if (!entry) return false;
  entry.resolve(approved);
  return true;
}

export function listApprovals() {
  return [...pending.values()].map(({ resolve, ...rest }) => rest);
}
