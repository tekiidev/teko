import { test } from 'node:test';
import assert from 'node:assert/strict';
import { db, nowIso } from '../src/db.ts';
import { contarConversas, limparConversas } from '../src/cleanup.ts';

function sessao(id: string, profile: string, project: string | null) {
  const t = nowIso();
  db.prepare('INSERT INTO sessions (id, project_id, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, project, profile, t, t);
  db.prepare("INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, 'user', 'oi', ?)").run(`${id}-m`, id, t);
}

test('limpa só voz, só projeto e depois tudo', () => {
  db.exec('DELETE FROM messages; DELETE FROM sessions;');
  sessao('a', 'voice', null);
  sessao('b', 'code', 'p1');
  sessao('c', 'code', null);
  assert.deepEqual(contarConversas({ tipo: 'todas' }), { sessoes: 3, mensagens: 3 });

  assert.equal(limparConversas({ tipo: 'voz' }).sessoes, 1);
  assert.equal(contarConversas({ tipo: 'todas' }).sessoes, 2);

  assert.equal(limparConversas({ tipo: 'projeto', projectId: 'p1' }).sessoes, 1);
  assert.deepEqual(contarConversas({ tipo: 'todas' }), { sessoes: 1, mensagens: 1 });

  limparConversas({ tipo: 'todas' });
  assert.deepEqual(contarConversas({ tipo: 'todas' }), { sessoes: 0, mensagens: 0 });
});
