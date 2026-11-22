import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { db, newId, nowIso, safeJson, getSetting } from './db.js';
import { clearIndex, ensureIndex, indexProject, search } from './search-index.js';

const server = new Server(
  { name: 'teko-context', version: '0.3.0' },
  { capabilities: { tools: {} } },
);

function resolveProject(value?: string) {
  if (value) {
    const exact = db.prepare('SELECT * FROM projects WHERE id = ? OR slug = ? COLLATE NOCASE').get(value, value);
    if (exact) return exact;
    const byName = db.prepare('SELECT * FROM projects WHERE name = ? COLLATE NOCASE').get(value);
    if (byName) return byName;
    throw new Error(`Projeto não encontrado: ${value}. Use teko_list_projects para ver os slugs.`);
  }

  const cwd = path.resolve(process.cwd());
  const projects = db.prepare('SELECT * FROM projects WHERE path IS NOT NULL').all();
  return projects
    .filter((project) => {
      const root = path.resolve(project.path);
      return cwd === root || cwd.startsWith(`${root}${path.sep}`);
    })
    .sort((a, b) => String(b.path).length - String(a.path).length)[0] || null;
}

function textResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

const tools: any[] = [
  {
    name: 'teko_list_projects',
    description: 'Lista projetos cadastrados no Teko. Chame quando precisar descobrir o slug antes de buscar contexto.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'teko_get_global_context',
    description: 'Retorna preferências globais curtas do Felipe e a lista resumida de projetos. Use no início de uma tarefa ampla; não carrega conversas antigas.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'teko_get_project_brief',
    description: 'Retorna um resumo compacto de um projeto, suas decisões recentes e bugs abertos. Informe project quando o diretório atual não identificar o projeto.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string', description: 'Slug, ID ou nome do projeto; opcional quando o cwd estiver dentro do repositório cadastrado.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'teko_search_knowledge',
    description: 'Busca trechos relevantes no índice local do Teko (código, notas, decisões e bugs). Prefira esta busca a pedir ou carregar o histórico inteiro. Use project para limitar ao repositório atual.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Pergunta ou termos relevantes para busca.' },
        project: { type: 'string', description: 'Slug, ID ou nome do projeto; opcional para busca em todos os índices.' },
        limit: { type: 'integer', minimum: 1, maximum: 8, description: 'Quantidade máxima de trechos; padrão 5.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'teko_save_memory',
    description: 'Salva uma decisão, restrição ou aprendizado que deve continuar disponível para Claude, Antigravity, Codex e Teko. Salve apenas fatos duráveis, não transcrições completas.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Slug, ID ou nome do projeto; opcional quando o cwd identificar o repositório.' },
        title: { type: 'string', description: 'Título curto e pesquisável.' },
        content: { type: 'string', description: 'Fato durável ou decisão, em até 10.000 caracteres.' },
        source: { type: 'string', description: 'Agente/origem, por exemplo claude, codex ou antigravity.' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = (request.params.arguments || {}) as Record<string, any>;

  try {
    switch (request.params.name) {
      case 'teko_list_projects': {
        const projects = db.prepare(
          'SELECT id, name, slug, path, description, stack FROM projects ORDER BY name COLLATE NOCASE',
        ).all().map((project) => ({ ...project, stack: safeJson(project.stack, []) }));
        return textResult({ projects });
      }
      case 'teko_get_global_context': {
        const projects = db.prepare('SELECT name, slug, description FROM projects ORDER BY name COLLATE NOCASE').all();
        return textResult({ preferences: getSetting('globalNotes', ''), projects });
      }
      case 'teko_get_project_brief': {
        const project = resolveProject(args.project);
        if (!project) throw new Error('Não consegui inferir o projeto pelo diretório. Informe o slug retornado por teko_list_projects.');
        const decisions = db.prepare(
          `SELECT title, status, decision FROM decisions
            WHERE project_id = ? AND status != 'descartada'
            ORDER BY created_at DESC LIMIT 4`,
        ).all(project.id).map((item) => ({ ...item, decision: String(item.decision || '').slice(0, 500) }));
        const bugs = db.prepare(
          `SELECT title, severity, status, area, actual FROM bugs
            WHERE project_id = ? AND status != 'resolvido'
            ORDER BY CASE severity WHEN 'critica' THEN 0 WHEN 'alta' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
                     updated_at DESC LIMIT 4`,
        ).all(project.id).map((item) => ({ ...item, actual: String(item.actual || '').slice(0, 300) }));
        const notes = db.prepare(
          `SELECT title, kind, content FROM memory WHERE project_id = ?
            ORDER BY created_at DESC LIMIT 3`,
        ).all(project.id).map((item) => ({ ...item, content: String(item.content || '').slice(0, 450) }));
        return textResult({
          project: { id: project.id, name: project.name, slug: project.slug, path: project.path, description: project.description, stack: safeJson(project.stack, []) },
          decisions,
          openBugs: bugs,
          recentNotes: notes,
          hint: 'Use teko_search_knowledge para buscar detalhes específicos; o histórico de chats não é incluído.',
        });
      }
      case 'teko_search_knowledge': {
        if (!String(args.query || '').trim()) throw new Error('query é obrigatório.');
        const project = resolveProject(args.project);
        if (project) ensureIndex(project.id);
        const requestedLimit = Number(args.limit) || 5;
        const result = search(String(args.query), {
          projectId: project?.id || null,
          limit: Math.min(Math.max(requestedLimit, 1), 8),
        });
        return textResult({ project: project?.slug || null, ...result });
      }
      case 'teko_save_memory': {
        const title = String(args.title || '').trim();
        const content = String(args.content || '').trim();
        if (!title || !content) throw new Error('title e content são obrigatórios.');
        if (title.length > 200 || content.length > 10000) throw new Error('title aceita até 200 caracteres e content até 10.000.');
        const project = resolveProject(args.project);
        if (!project) throw new Error('Informe project ou configure o caminho do repositório no Teko antes de salvar memória.');
        const id = newId('mem');
        db.prepare(
          'INSERT INTO memory (id, project_id, kind, title, content, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(id, project.id, 'nota', title, content, `mcp:${String(args.source || 'agent').slice(0, 80)}`, nowIso());
        let indexed = false;
        try {
          indexProject(project.id);
          indexed = true;
        } catch (error) {
          clearIndex(project.id);
          console.error('[teko-mcp] memória salva, mas o índice será atualizado depois:', error);
        }
        return textResult({ saved: true, id, project: project.slug, indexed });
      }
      default:
        throw new Error(`Ferramenta desconhecida: ${request.params.name}`);
    }
  } catch (error) {
    return { ...textResult({ error: String((error as Error)?.message || error) }), isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
