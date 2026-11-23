import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { APP_VERSION } from '@teko/ai/config';
import { db, listModels, listProfiles } from '@teko/ai/db';
import { runTurn } from '@teko/ai/chat';
import { planRoute } from '@teko/ai/router';
import { usageSummary } from '@teko/ai/usage';
import { listSkills, getSkill } from '@teko/ai/skills';
import { resolveApproval } from '@teko/ai/approvals';
import { ajudaTexto } from '@teko/ai/help';
import { contarConversas, limparConversas, type Alvo } from '@teko/ai/cleanup';
import { escolher, confirmar } from './select.js';
import { banner, c, fmtCost, fmtTokens } from './ui.js';

const HELP = `
${c.white(c.bold('teko'))} ${c.dim('· seu JARVIS no terminal')}

${c.accent('Uso')}
  teko                      abre a conversa
  teko "pergunta"           responde e sai
  cat erro.log | teko "explica"   junta o que vier pela entrada
  teko uso | modelos | skills | ajuda
  teko limpar [voz|projeto|todas]   apaga conversas (pede confirmação)

${c.accent('Opções')}
  -p, --perfil <id>         perfil (code, docs, terse...)
  -m, --modelo <id>         força um modelo (ex: anthropic/claude-sonnet-5-5)
      --projeto <slug>      usa um projeto (padrão: o da pasta atual)
      --sem-projeto         não usa projeto
  -c, --continuar           continua a última conversa
      --sem-cache           não usa respostas guardadas
  -v, --version

${c.accent('Na conversa')}
  /modelo             ${c.dim('/model /models /switch')}     escolhe com ↑ ↓ e Enter
  /modelo <id|auto>                              troca direto (aceita nome curto)
  /perfil [id]        ${c.dim('/profile')}                   troca a fila (sem id: escolhe com setas)
  /projeto <slug>     ${c.dim('/project')}                   usa um projeto (nenhum = sem projeto)
  /nova               ${c.dim('/new /clear')}                conversa nova
  /limpar             ${c.dim('/apagar')}                    apaga conversas salvas (pede confirmação)
  /uso                ${c.dim('/usage /cost')}               tokens, custo e economia
  /skills                                        lista as skills
  /semcache           ${c.dim('/nocache')}                   liga/desliga o cache local
  /ajuda              ${c.dim('/help')}                      esta ajuda
  /sair               ${c.dim('/exit /quit /q')}             sai
  Qualquer skill: /vagas <texto>. Tab completa os comandos, ↑ volta mensagens.
  Nas escolhas: ↑ ↓ move, Enter confirma, Esc cancela.
  Linha terminando em \\ continua na próxima.
`;

// Comandos em português com aliases em inglês (os mais comuns em outros CLIs).
const ALIASES: Record<string, string> = {
  ajuda: 'ajuda', help: 'ajuda', '?': 'ajuda',
  sair: 'sair', exit: 'sair', quit: 'sair', q: 'sair',
  nova: 'nova', new: 'nova', clear: 'nova', reset: 'nova',
  uso: 'uso', usage: 'uso', cost: 'uso', custo: 'uso',
  skills: 'skills',
  modelos: 'modelos', models: 'modelos',
  modelo: 'modelo', model: 'modelo', switch: 'modelo',
  perfil: 'perfil', profile: 'perfil', perfis: 'perfil', profiles: 'perfil',
  projeto: 'projeto', project: 'projeto', projetos: 'projeto', projects: 'projeto',
  semcache: 'semcache', nocache: 'semcache',
  limpar: 'limpar', apagar: 'limpar',
};

/** Ajuda do terminal + tudo que dá pra fazer no Teko (voz, gestos, mapa), da mesma fonte do mapa. */
function ajudaCompleta() {
  return `${HELP}\n${c.white(c.bold('Tudo que dá pra fazer no Teko'))}\n\n${ajudaTexto({ titulo: (t) => c.accent(t), destaque: (t) => c.ice(t), dim: (t) => c.muted(t) })}\n`;
}

type State = {
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  profileId: string;
  modelId: string | null;
  noCache: boolean;
};

function parseArgs(argv: string[]) {
  const opts: Record<string, any> = { words: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '-p' || a === '--perfil') opts.profile = next();
    else if (a === '-m' || a === '--modelo') opts.model = next();
    else if (a === '--projeto') opts.project = next();
    else if (a === '--sem-projeto') opts.noProject = true;
    else if (a === '-c' || a === '--continuar') opts.resume = true;
    else if (a === '--sem-cache') opts.noCache = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '-h' || a === '--help') opts.help = true;
    else opts.words.push(a);
  }
  return opts;
}

function findProject(ref: string | null) {
  const projects = db.prepare('SELECT id, name, slug, path FROM projects').all();
  if (ref) return projects.find((p) => p.slug === ref || p.id === ref || p.name === ref) || null;
  // Projeto da pasta atual: o caminho cadastrado mais específico que contém o cwd.
  const cwd = process.cwd();
  return (
    projects
      .filter((p) => p.path && (cwd === p.path || cwd.startsWith(p.path + path.sep)))
      .sort((a, b) => b.path.length - a.path.length)[0] || null
  );
}

function lastSession(projectId: string | null) {
  const row = projectId
    ? db.prepare('SELECT id FROM sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1').get(projectId)
    : db.prepare('SELECT id FROM sessions WHERE project_id IS NULL ORDER BY updated_at DESC LIMIT 1').get();
  return row?.id || null;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  // Só lê quando tem algo vindo de pipe ou arquivo; um stdin aberto e vazio travaria aqui.
  let stat;
  try {
    stat = fs.fstatSync(0);
  } catch {
    return '';
  }
  if (!stat.isFIFO() && !stat.isFile()) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function routeLine(state: State) {
  const plan = planRoute({ profileId: state.profileId, modelId: state.modelId });
  const ready = plan.filter((m) => m.status === 'ready');
  const first = ready[0]?.label || c.red('nenhum modelo pronto');
  const fixed = state.modelId ? plan.find((m) => m.modelId === state.modelId) : null;
  const fixedNote = fixed && fixed.status !== 'ready' ? c.amber(` (${fixed.reason}; usa o próximo da fila)`) : '';
  const project = state.projectName ? c.ice(state.projectName) : c.dim('sem projeto');
  return `${c.dim('perfil')} ${c.accent(state.profileId)}  ${c.dim('modelo')} ${state.modelId ? c.accent(state.modelId) + fixedNote : first}  ${c.dim('projeto')} ${project}${state.noCache ? `  ${c.amber('sem cache')}` : ''}`;
}

function printUsage() {
  const u = usageSummary();
  const row = (name, t) =>
    `  ${c.muted(name.padEnd(7))} ${c.white(fmtTokens(t.tokens).padStart(7))} tok  ${c.accent(fmtCost(t.cost).padStart(8))}  ${c.dim('cache')} ${fmtTokens(t.cached)}  ${c.dim('poupado')} ${c.green(fmtCost(t.saved))}  ${c.dim(`${t.requests} chamadas`)}`;
  console.log(['', row('hoje', u.today), row('semana', u.week), row('mês', u.month), row('total', u.total), ''].join('\n'));
}

/** Todos os modelos (não só a fila do perfil), prontos primeiro, numerados pra escolher. */
function modelChoices(state: State, all = false) {
  const queue = new Set(planRoute({ profileId: state.profileId }).map((m) => m.modelId));
  const rows = listModels()
    .filter((m) => m.enabled)
    .map((m) => ({ ...planRoute({ profileId: state.profileId, modelId: m.id })[0], inQueue: queue.has(m.id) }));
  const ready = rows.filter((m) => m.status === 'ready');
  const rest = rows.filter((m) => m.status !== 'ready');
  return { list: all ? [...ready, ...rest] : ready, hidden: all ? 0 : rest.length };
}

function printModels(state: State, all = false) {
  const { list, hidden } = modelChoices(state, all);
  const width = String(list.length).length;
  console.log('');
  console.log(`  ${state.modelId ? '  ' : c.accent('▸ ')}${c.dim('0'.padStart(width))}  ${c.white('auto')} ${c.dim(`(fila do perfil ${state.profileId})`)}`);
  list.forEach((m, i) => {
    const current = m.modelId === state.modelId;
    const mark = m.status === 'ready' ? c.green('●') : c.dim('○');
    const why = m.status === 'ready' ? '' : c.dim(` ${m.reason || ''}`);
    const queue = m.inQueue ? c.dim(' · na fila') : '';
    console.log(`  ${current ? c.accent('▸ ') : '  '}${c.dim(String(i + 1).padStart(width))}  ${mark} ${current ? c.accent(m.label) : c.white(m.label)} ${c.dim(m.modelId)}${queue}${why}`);
  });
  if (!list.length) console.log(c.amber('  nenhum modelo pronto: coloque uma chave no .env ou na aba Conexões do painel'));
  if (hidden) console.log(c.dim(`\n  ${hidden} sem chave ou desativados escondidos · /models todos mostra tudo`));
  console.log('');
  return list;
}

function printSkills() {
  const skills = listSkills();
  if (!skills.length) {
    console.log(c.dim('\n  Nenhuma skill. Importe com: npm run skills:import -- <nome>\n'));
    return;
  }
  console.log('');
  for (const s of skills) console.log(`  ${c.accent(`/${s.name}`)} ${c.muted(s.description || '')}`);
  console.log('');
}

const plural = (n: number, um: string, varios = `${um}s`) => `${n} ${n === 1 ? um : varios}`;

/** Apaga conversas do banco local, sempre perguntando antes. Devolve true se apagou algo. */
async function limpar(state: State, arg = '') {
  if (!process.stdin.isTTY) {
    console.log(c.dim('  sem terminal interativo: nada foi apagado'));
    return false;
  }
  const porNome: Record<string, Alvo | null> = {
    todas: { tipo: 'todas' }, tudo: { tipo: 'todas' }, all: { tipo: 'todas' },
    voz: { tipo: 'voz' }, voice: { tipo: 'voz' },
    projeto: state.projectId ? { tipo: 'projeto', projectId: state.projectId } : null,
  };
  let alvo: Alvo | null = null;
  if (arg) {
    alvo = porNome[arg.toLowerCase()] ?? null;
    if (!alvo) {
      console.log(c.red(arg === 'projeto' ? '  sem projeto ativo' : `  opção desconhecida: ${arg}`) + c.dim(' (use voz, projeto ou todas)\n'));
      return false;
    }
  } else {
    const n = (a: Alvo) => plural(contarConversas(a).sessoes, 'conversa');
    const opcoes: { label: string; value: Alvo | null; hint?: string }[] = [
      { label: 'Cancelar', value: null },
      { label: 'Só as de voz', value: { tipo: 'voz' }, hint: n({ tipo: 'voz' }) },
    ];
    if (state.projectId) {
      const a: Alvo = { tipo: 'projeto', projectId: state.projectId };
      opcoes.push({ label: `Só do projeto ${state.projectName}`, value: a, hint: n(a) });
    }
    opcoes.push({ label: 'Todas', value: { tipo: 'todas' }, hint: n({ tipo: 'todas' }) });
    alvo = await escolher('O que apagar?', opcoes);
    if (!alvo) { console.log(''); return false; }
  }
  const { sessoes, mensagens } = contarConversas(alvo);
  if (!sessoes) {
    console.log(c.dim('  nada pra apagar\n'));
    return false;
  }
  console.log(c.dim('  apaga só do seu Mac (data/teko.db); o histórico de custo do /uso fica'));
  const ok = await confirmar(`Apagar ${plural(sessoes, 'conversa')} (${plural(mensagens, 'mensagem', 'mensagens')})? Não dá pra desfazer.`, {
    sim: 'Sim, apagar',
    nao: 'Não, cancelar',
  });
  if (!ok) { console.log(''); return false; }
  limparConversas(alvo);
  state.sessionId = null;
  console.log(c.green(`  ✓ ${sessoes} conversa${sessoes > 1 ? 's' : ''} apagada${sessoes > 1 ? 's' : ''}\n`));
  return true;
}

/** Roda uma mensagem e imprime em streaming. `ask` decide aprovações de ferramentas. */
async function turn(text: string, state: State, ask: (q: string) => Promise<boolean>, signal: AbortSignal) {
  let printed = false;
  let lineOpen = false;
  let ok = false;
  const note = (msg: string) => {
    if (lineOpen) process.stdout.write('\n');
    lineOpen = false;
    console.log(msg);
  };

  for await (const ev of runTurn({
    text,
    sessionId: state.sessionId,
    projectId: state.projectId,
    profileId: state.profileId,
    modelId: state.modelId,
    noCache: state.noCache,
    signal,
    onWarn: (scope, message) => note(c.dim(`  [${scope}] ${message}`)),
  })) {
    switch (ev.type) {
      case 'meta':
        state.sessionId = ev.sessionId;
        break;
      case 'compressed':
        note(c.dim(`  resumo: ${ev.messages} msgs antigas, ~${fmtTokens(ev.savedTokens)} tok a menos`));
        break;
      case 'delta':
        if (!printed) process.stdout.write('\n');
        printed = true;
        lineOpen = !ev.text.endsWith('\n');
        process.stdout.write(c.white(ev.text));
        break;
      case 'fallback':
        note(c.amber(`  ↯ ${ev.fromLabel}: ${ev.reason}${ev.toLabel ? ` → ${ev.toLabel}` : ''}`));
        break;
      case 'tool_call': {
        note(c.cyan(`  ⚙ ${ev.name}`) + c.dim(` ${String(ev.preview || '').split('\n')[0].slice(0, 120)}`));
        if (ev.requiresApproval) {
          const ok = await ask('Permitir?');
          resolveApproval(ev.id, ok);
        }
        break;
      }
      case 'tool_decision':
        if (!ev.approved) note(c.dim('  negado'));
        break;
      case 'tool_result':
        note(ev.ok ? c.dim('  ✓ ok') : c.red(`  ✕ ${String(ev.output || '').split('\n')[0].slice(0, 160)}`));
        break;
      case 'error':
        note(c.red(`  ${ev.message}`));
        break;
      case 'aborted':
        note(c.dim('  interrompido'));
        break;
      case 'done': {
        ok = true;
        if (lineOpen) process.stdout.write('\n');
        lineOpen = false;
        const u = ev.usage || {};
        const parts = [c.accent(ev.label || ev.modelId)];
        if (ev.cacheHit) parts.push(c.green('cache local'), c.dim(`${fmtTokens(u.savedTokens)} tok poupados`));
        else {
          parts.push(c.dim(`${fmtTokens((u.inputTokens || 0) + (u.outputTokens || 0))} tok`), c.dim(fmtCost(ev.cost)));
          if (u.cachedInputTokens) parts.push(c.dim(`cache ${Math.round((u.cachedInputTokens / (u.inputTokens || 1)) * 100)}%`));
        }
        console.log(`\n  ${parts.join(c.dim(' · '))}\n`);
        break;
      }
      default:
        break;
    }
  }
  return ok;
}

async function chat(state: State) {
  console.log(banner(APP_VERSION));
  console.log(`  ${routeLine(state)}`);
  console.log(c.dim('  /ajuda mostra os comandos · Ctrl+C interrompe\n'));

  // Tab completa comandos, skills e, depois do comando, modelos, perfis e projetos.
  const completer = (line: string): [string[], string] => {
    if (!line.startsWith('/')) return [[], line];
    const [head, ...rest] = line.slice(1).split(' ');
    if (!rest.length) {
      const names = [...Object.keys(ALIASES), ...listSkills().map((s) => s.name)].map((n) => `/${n}`);
      const hits = names.filter((n) => n.startsWith(line));
      return [hits.length ? hits : names, line];
    }
    const arg = rest.join(' ');
    const cmd = ALIASES[head];
    let options: string[] = [];
    if (cmd === 'modelo') options = ['auto', ...listModels().map((m) => m.id)];
    if (cmd === 'perfil') options = listProfiles().map((p) => p.id);
    if (cmd === 'projeto') options = ['nenhum', ...db.prepare('SELECT slug FROM projects').all().map((p) => p.slug).filter(Boolean)];
    const hits = options.filter((o) => o.startsWith(arg));
    return [hits.map((h) => `/${head} ${h}`), line];
  };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, completer, historySize: 200 });
  let controller: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (controller) controller.abort();
    else {
      rl.close();
      process.exit(0);
    }
  });
  const ask = (q: string) => confirmar(q, { sim: 'Permitir', nao: 'Negar' });
  const prompt = c.accent('› ');

  while (true) {
    let text = '';
    try {
      let line = await rl.question(prompt);
      while (line.endsWith('\\')) {
        text += line.slice(0, -1) + '\n';
        line = await rl.question(c.dim('· '));
      }
      text = (text + line).trim();
    } catch {
      break; // entrada fechada (Ctrl+D)
    }
    if (!text) continue;

    if (text.startsWith('/')) {
      const [typed, ...rest] = text.slice(1).split(/\s+/);
      const cmd = ALIASES[typed.toLowerCase()] || typed;
      const arg = rest.join(' ').trim();
      if (cmd === 'sair') break;
      if (cmd === 'ajuda') { console.log(ajudaCompleta()); continue; }
      if (cmd === 'nova') { state.sessionId = null; console.log(c.dim('  conversa nova\n')); continue; }
      if (cmd === 'uso') { printUsage(); continue; }
      if (cmd === 'limpar') { await limpar(state, arg); continue; }
      if (cmd === 'skills') { printSkills(); continue; }
      if (cmd === 'semcache') {
        state.noCache = !state.noCache;
        console.log(c.dim(`  cache local ${state.noCache ? 'desligado' : 'ligado'}\n`));
        continue;
      }
      if (cmd === 'perfil') {
        const perfis = listProfiles();
        const ids = perfis.map((p) => p.id);
        let id: string | null = arg;
        if (!arg) {
          id = await escolher('Perfil', perfis.map((p) => ({ label: p.id, value: p.id, hint: p.label || '' })), Math.max(0, ids.indexOf(state.profileId)));
          if (!id) { console.log(''); continue; }
        } else if (!ids.includes(arg)) { console.log(c.dim(`  perfis: ${ids.join(', ')}\n`)); continue; }
        state.profileId = id;
        console.log(`  ${routeLine(state)}\n`);
        continue;
      }
      if (cmd === 'modelo' || cmd === 'modelos') {
        // Sem argumento: escolhe com as setas.
        if (!arg || arg === 'todos' || arg === 'all') {
          const { list, hidden } = modelChoices(state, Boolean(arg));
          if (!list.length) { console.log(c.amber('  nenhum modelo pronto: coloque uma chave no .env ou na aba Conexões do painel\n')); continue; }
          const opcoes = [
            { label: 'auto', value: 'auto', hint: `fila do perfil ${state.profileId}` },
            ...list.map((m) => ({
              label: `${m.status === 'ready' ? '●' : '○'} ${m.label}`,
              value: m.modelId as string,
              hint: `${m.modelId}${m.inQueue ? ' · na fila' : ''}${m.status === 'ready' ? '' : ` · ${m.reason || ''}`}`,
            })),
          ];
          const atual = state.modelId ? opcoes.findIndex((o) => o.value === state.modelId) : 0;
          if (hidden) console.log(c.dim(`  ${hidden} sem chave escondidos · /models todos mostra tudo`));
          const escolhido = await escolher<string>('Modelo', opcoes, Math.max(0, atual));
          if (!escolhido) { console.log(''); continue; }
          state.modelId = escolhido === 'auto' ? null : escolhido;
          console.log(`  ${routeLine(state)}\n`);
          continue;
        }
        // Aceita o id completo ou só o final (ex: gemini-2.5-flash).
        const found = arg === 'auto' ? null : listModels().find((m) => m.id === arg || m.id.endsWith(`/${arg}`) || m.model === arg);
        if (arg !== 'auto' && !found) {
          console.log(c.red(`  modelo não encontrado: ${arg}`) + c.dim(' (Tab mostra os disponíveis)\n'));
          continue;
        }
        state.modelId = found ? found.id : null;
        console.log(`  ${routeLine(state)}\n`);
        continue;
      }
      if (cmd === 'projeto') {
        if (arg === 'nenhum') {
          state.projectId = null;
          state.projectName = null;
        } else {
          const p = findProject(arg);
          if (!p) { console.log(c.red(`  projeto não encontrado: ${arg}\n`)); continue; }
          state.projectId = p.id;
          state.projectName = p.name;
        }
        state.sessionId = null;
        console.log(`  ${routeLine(state)}\n`);
        continue;
      }
      if (!getSkill(cmd)) { console.log(c.dim(`  comando desconhecido: /${cmd} (veja /ajuda)\n`)); continue; }
      // Skill: segue pro modelo, o runTurn injeta o conteúdo dela.
    }

    controller = new AbortController();
    try {
      await turn(text, state, ask, controller.signal);
    } catch (err) {
      console.log(c.red(`  ${err.message || err}\n`));
    } finally {
      controller = null;
    }
  }
  rl.close();
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.version) return console.log(APP_VERSION);
  if (opts.help || ['ajuda', 'help'].includes(opts.words[0])) return console.log(ajudaCompleta());

  const project = opts.noProject ? null : findProject(opts.project || null);
  if (opts.project && !project) {
    console.error(c.red(`projeto não encontrado: ${opts.project}`));
    process.exit(1);
  }
  const state: State = {
    sessionId: null,
    projectId: project?.id || null,
    projectName: project?.name || null,
    profileId: opts.profile || 'code',
    modelId: opts.model ? listModels().find((m) => m.id === opts.model || m.id.endsWith(`/${opts.model}`))?.id || opts.model : null,
    noCache: Boolean(opts.noCache),
  };
  if (opts.resume) state.sessionId = lastSession(state.projectId);

  const [first] = opts.words;
  if (opts.words.length === 1 && first === 'uso') return printUsage();
  if (opts.words.length === 1 && first === 'modelos') return printModels(state);
  if (opts.words.length === 1 && first === 'skills') return printSkills();
  if (['limpar', 'apagar'].includes(first) && opts.words.length <= 2) {
    await limpar(state, opts.words[1] || '');
    return;
  }

  const piped = await readStdin();
  const words = first === 'chat' ? opts.words.slice(1) : opts.words;
  let text = words.join(' ').trim();
  if (piped) text = text ? `${text}\n\n<entrada>\n${piped}\n</entrada>` : piped;

  if (!text) {
    if (!process.stdin.isTTY) {
      console.error(c.red('nada pra perguntar'));
      process.exit(1);
    }
    return chat(state);
  }

  // Uma pergunta só: sem terminal interativo, ferramentas que pedem aprovação são negadas.
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  const ask = async (q: string) => {
    if (!process.stdin.isTTY || piped) {
      console.log(c.dim('  (sem terminal interativo: negado)'));
      return false;
    }
    return confirmar(q, { sim: 'Permitir', nao: 'Negar' });
  };
  if (!(await turn(text, state, ask, controller.signal))) process.exitCode = 1;
}

// Sai explicitamente: conexões keep-alive e o stdin podem segurar o processo aberto.
main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(c.red(String(err?.message || err)));
    process.exit(1);
  });
