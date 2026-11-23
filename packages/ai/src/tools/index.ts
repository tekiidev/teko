import { listFiles, readFile, writeFile, editFile } from './fs.js';
import { grep } from './search.js';
import { runCommand } from './shell.js';
import { delegateAgent } from './agent.js';
import { search } from '../search-index.js';
import { getSkill, renderSkill } from '../skills.js';

const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });

export const TOOLS = [
  {
    name: 'list_files',
    description: 'Lista arquivos e pastas dentro do projeto. Use pra descobrir a estrutura antes de ler.',
    parameters: {
      type: 'object',
      properties: {
        path: str('subpasta relativa ao projeto (padrão: raiz)'),
        depth: int('profundidade da árvore (1-6, padrão 3)'),
      },
      required: [],
    },
    requiresApproval: false,
    run: listFiles,
    preview: (args) => `listar ${args.path || '.'} (profundidade ${args.depth || 3})`,
  },
  {
    name: 'read_file',
    description: 'Lê um arquivo de texto do projeto com números de linha. Aceita intervalo de linhas.',
    parameters: {
      type: 'object',
      properties: {
        path: str('caminho relativo do arquivo'),
        start: int('linha inicial (1-based)'),
        end: int('linha final'),
      },
      required: ['path'],
    },
    requiresApproval: false,
    run: readFile,
    preview: (args) => `ler ${args.path}${args.start ? ` (linhas ${args.start}-${args.end || '…'})` : ''}`,
  },
  {
    name: 'grep',
    description: 'Busca por regex no conteúdo dos arquivos do projeto. Retorna arquivo:linha: trecho.',
    parameters: {
      type: 'object',
      properties: {
        pattern: str('expressão regular'),
        path: str('subpasta onde buscar (padrão: raiz)'),
        glob: str('filtro de arquivo, ex: *.ts ou src/**/*.js'),
        ignoreCase: { type: 'boolean', description: 'ignorar maiúsculas (padrão true)' },
      },
      required: ['pattern'],
    },
    requiresApproval: false,
    run: grep,
    preview: (args) => `buscar /${args.pattern}/${args.glob ? ` em ${args.glob}` : ''}`,
  },
  {
    name: 'search_project',
    description:
      'Busca por relevância no índice do projeto (código, docs, memória, decisões e bugs). Use quando não souber em qual arquivo está algo. Retorna arquivo:linha e trecho.',
    parameters: {
      type: 'object',
      properties: {
        query: str('o que procurar, em linguagem natural ou termos'),
        limit: int('quantidade de trechos (padrão 8)'),
      },
      required: ['query'],
    },
    requiresApproval: false,
    run: async ({ query, limit }, ctx) => {
      const out = search(query, { projectId: ctx.projectId, limit: limit || 8 });
      if (!out.results.length) return { ok: true, output: `nenhum trecho encontrado para "${query}"` };
      const lines = out.results.map((hit) => {
        const loc = hit.path
          ? `${hit.path}${hit.startLine ? `:${hit.startLine}-${hit.endLine}` : ''}`
          : hit.kind;
        const snippet = String(hit.snippet || '').replace(/<</g, '').replace(/>>/g, '').trim();
        return `— ${loc} (${hit.title || hit.kind})\n${snippet}`;
      });
      return { ok: true, output: lines.join('\n\n') };
    },
    preview: (args) => `buscar no índice: ${args.query}`,
  },
  {
    name: 'write_file',
    description: 'Cria ou sobrescreve um arquivo do projeto com o conteúdo informado. Cria pastas se precisar.',
    parameters: {
      type: 'object',
      properties: {
        path: str('caminho relativo do arquivo'),
        content: str('conteúdo completo do arquivo'),
      },
      required: ['path', 'content'],
    },
    requiresApproval: true,
    run: writeFile,
    preview: (args) => `escrever ${args.path}\n${String(args.content || '').slice(0, 700)}`,
  },
  {
    name: 'edit_file',
    description: 'Edita um arquivo substituindo um trecho exato por outro. Prefira isso a reescrever o arquivo inteiro.',
    parameters: {
      type: 'object',
      properties: {
        path: str('caminho relativo do arquivo'),
        old: str('trecho exato que existe hoje'),
        new: str('trecho que entra no lugar'),
        all: { type: 'boolean', description: 'substituir todas as ocorrências' },
      },
      required: ['path', 'old', 'new'],
    },
    requiresApproval: true,
    run: editFile,
    preview: (args) =>
      `editar ${args.path}\n- ${String(args.old || '').slice(0, 300)}\n+ ${String(args.new || '').slice(0, 300)}`,
  },
  {
    name: 'run_command',
    description: 'Executa um comando shell dentro do projeto (testes, build, git, ls). Retorna stdout/stderr e o exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: str('comando shell a executar'),
        cwd: str('diretório de trabalho relativo ao projeto (padrão: raiz)'),
        timeoutMs: int('timeout em ms (padrão 120000, máx 300000)'),
      },
      required: ['command'],
    },
    requiresApproval: true,
    run: runCommand,
    preview: (args) => `$ ${args.command}${args.cwd ? `\n(em ${args.cwd})` : ''}`,
  },
  {
    name: 'delegate_agent',
    description:
      'Delega uma tarefa de código grande (implementar, corrigir bug, refatorar vários arquivos) pro Claude Code, que edita o projeto ativo e devolve um resumo. Use para mudanças que exigem várias edições; para ajustes pequenos, prefira edit_file.',
    parameters: {
      type: 'object',
      properties: { task: str('tarefa completa, com contexto suficiente pra ser feita sem perguntas') },
      required: ['task'],
    },
    requiresApproval: true,
    run: delegateAgent,
    preview: (args) => `delegar pro Claude Code:\n${String(args.task || '').slice(0, 700)}`,
  },
  {
    name: 'use_skill',
    description:
      'Carrega as instruções completas de uma skill listada em "Skills disponíveis". Use antes de responder quando o pedido combinar com a descrição de uma skill.',
    parameters: {
      type: 'object',
      properties: { name: str('nome exato da skill') },
      required: ['name'],
    },
    requiresApproval: false,
    run: async ({ name }) => {
      const skill = getSkill(String(name || ''));
      if (!skill) return { ok: false, output: `skill não encontrada: ${name}` };
      return { ok: true, output: renderSkill(skill) };
    },
    preview: (args) => `carregar skill ${args.name}`,
  },
];

/** Definições das ferramentas pro modelo. `readOnly` deixa só as que não pedem aprovação. */
export function toolDefs({ readOnly = false } = {}) {
  return TOOLS.filter((tool) => !readOnly || !tool.requiresApproval).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function getTool(name) {
  return TOOLS.find((tool) => tool.name === name) ?? null;
}

export function previewFor(name, args) {
  const tool = getTool(name);
  if (!tool) return `${name} ${JSON.stringify(args || {})}`.slice(0, 800);
  try {
    return tool.preview(args || {});
  } catch {
    return JSON.stringify(args || {}).slice(0, 800);
  }
}

export async function executeTool(name, args, ctx) {
  const tool = getTool(name);
  if (!tool) return { ok: false, output: `ferramenta desconhecida: ${name}` };
  try {
    return await tool.run(args || {}, ctx);
  } catch (err) {
    return { ok: false, output: String(err.message || err) };
  }
}
