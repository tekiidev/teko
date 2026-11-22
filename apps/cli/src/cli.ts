import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { APP_VERSION } from '@teko/ai/config';
import { db, listProfiles } from '@teko/ai/db';
import { runTurn } from '@teko/ai/chat';
import { planRoute } from '@teko/ai/router';
import { usageSummary } from '@teko/ai/usage';
import { listSkills, getSkill } from '@teko/ai/skills';
import { resolveApproval } from '@teko/ai/approvals';
import { banner, c, fmtCost, fmtTokens } from './ui.js';

const HELP = `
${c.white(c.bold('teko'))} ${c.dim('· seu JARVIS no terminal')}

${c.accent('Uso')}
  teko                      abre a conversa
  teko "pergunta"           responde e sai
  cat erro.log | teko "explica"   junta o que vier pela entrada
  teko uso | modelos | skills | ajuda

${c.accent('Opções')}
  -p, --perfil <id>         perfil (code, docs, terse...)
  -m, --modelo <id>         força um modelo (ex: anthropic/claude-sonnet-5-5)
      --projeto <slug>      usa um projeto (padrão: o da pasta atual)
      --sem-projeto         não usa projeto
  -c, --continuar           continua a última conversa
      --sem-cache           não usa respostas guardadas
  -v, --version

${c.accent('Na conversa')}
  /ajuda /sair /nova /perfil <id> /modelo <id|auto> /projeto <slug|nenhum>
  /uso /skills /semcache e qualquer skill: /vagas <texto>
  Linha terminando em \\ continua na próxima.
`;

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
  const ready = planRoute({ profileId: state.profileId, modelId: state.modelId }).filter((m) => m.status === 'ready');
  const first = ready[0]?.label || c.red('nenhum modelo pronto');
  const project = state.projectName ? c.ice(state.projectName) : c.dim('sem projeto');
  return `${c.dim('perfil')} ${c.accent(state.profileId)}  ${c.dim('modelo')} ${state.modelId ? c.accent(state.modelId) : first}  ${c.dim('projeto')} ${project}${state.noCache ? `  ${c.amber('sem cache')}` : ''}`;
}

function printUsage() {
  const u = usageSummary();
  const row = (name, t) =>
    `  ${c.muted(name.padEnd(7))} ${c.white(fmtTokens(t.tokens).padStart(7))} tok  ${c.accent(fmtCost(t.cost).padStart(8))}  ${c.dim('cache')} ${fmtTokens(t.cached)}  ${c.dim('poupado')} ${c.green(fmtCost(t.saved))}  ${c.dim(`${t.requests} chamadas`)}`;
  console.log(['', row('hoje', u.today), row('semana', u.week), row('mês', u.month), row('total', u.total), ''].join('\n'));
}

function printModels(state: State) {
  console.log('');
  for (const m of planRoute({ profileId: state.profileId, modelId: state.modelId })) {
    const mark = m.status === 'ready' ? c.green('●') : c.dim('○');
    const why = m.status === 'ready' ? '' : c.dim(` ${m.reason || ''}`);
    console.log(`  ${mark} ${c.white(m.label)} ${c.dim(m.modelId)}${why}`);
  }
  console.log('');
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
          const ok = await ask(`${c.amber('  permitir?')} ${c.dim('[s/N]')} `);
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

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let controller: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (controller) controller.abort();
    else {
      rl.close();
      process.exit(0);
    }
  });
  const ask = async (q: string) => /^s(im)?$/i.test((await rl.question(q)).trim());
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
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
      if (cmd === 'sair' || cmd === 'exit' || cmd === 'q') break;
      if (cmd === 'ajuda' || cmd === 'help') { console.log(HELP); continue; }
      if (cmd === 'nova') { state.sessionId = null; console.log(c.dim('  conversa nova\n')); continue; }
      if (cmd === 'uso') { printUsage(); continue; }
      if (cmd === 'skills') { printSkills(); continue; }
      if (cmd === 'modelos') { printModels(state); continue; }
      if (cmd === 'semcache') {
        state.noCache = !state.noCache;
        console.log(c.dim(`  cache local ${state.noCache ? 'desligado' : 'ligado'}\n`));
        continue;
      }
      if (cmd === 'perfil') {
        const ids = listProfiles().map((p) => p.id);
        if (!ids.includes(arg)) { console.log(c.dim(`  perfis: ${ids.join(', ')}\n`)); continue; }
        state.profileId = arg;
        console.log(`  ${routeLine(state)}\n`);
        continue;
      }
      if (cmd === 'modelo') {
        if (!arg) { printModels(state); continue; }
        state.modelId = arg === 'auto' ? null : arg;
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
  if (opts.help || opts.words[0] === 'ajuda') return console.log(HELP);

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
    modelId: opts.model || null,
    noCache: Boolean(opts.noCache),
  };
  if (opts.resume) state.sessionId = lastSession(state.projectId);

  const [first] = opts.words;
  if (opts.words.length === 1 && first === 'uso') return printUsage();
  if (opts.words.length === 1 && first === 'modelos') return printModels(state);
  if (opts.words.length === 1 && first === 'skills') return printSkills();

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
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(q);
    rl.close();
    return /^s(im)?$/i.test(answer.trim());
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
