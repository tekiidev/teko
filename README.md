# teko 🦾

**Seu JARVIS de código aberto:** várias IAs, uma memória, zero Ultron.

> Sabe o Visão, que carrega o JARVIS, a Sexta-Feira, a E.D.I.T.H. e até o Idiota e o Você dentro do próprio código?
> O Teko é isso, só que pra IA no mundo real: Claude, GPT, Gemini, DeepSeek, Grok, Ollama e companhia morando no mesmo lugar, dividindo a mesma memória e passando a bola quando uma delas cai.
> O Ultron fica de fora. Nenhuma IA escreve um arquivo ou roda um comando sem você dizer "pode".

Feito no Maranhão por **Felipe Oliveira** ([@tekiidev](https://github.com/tekiidev)). Teki Industries.

## Por que "Teko"

- 🗣️ **Pronúncia:** "TÉ-ko", com a força na primeira sílaba, rimando com Teki (não é "te-KÔ")
- Vem de **Teki**, o apelido de quem fez
- Em guarani, *teko* quer dizer algo como "modo de ser, jeito de viver"
- A ideia é essa: um jeito só de trabalhar com todas as IAs, em vez de uma aba pra cada

## O que o Teko faz

- 🧠 **Uma memória pra todas:** projetos, decisões, bugs e documentos entram no contexto do modelo escolhido, e agentes como Claude Code, Codex e Antigravity podem consultar a mesma base via MCP
- 🔁 **Troca de modelo sozinho:** se o modelo cai, estoura a cota ou dá timeout, o Teko tenta o próximo da fila
- 💸 **Ajuda a controlar o gasto:** perfis com fila de modelos (incluindo um modo econômico), orçamento por modelo e registro de tokens e custo de cada conversa
- 🛡️ **Segurança desde o começo:** roda local, as chaves ficam no banco da sua máquina, as ferramentas ficam presas à pasta do projeto e escrita ou execução pedem a sua aprovação
- 🏠 **Local primeiro:** banco SQLite e busca rodam na sua máquina. O que você manda no chat vai para o provedor de IA que você configurou, sob os termos dele

> O Teko está em desenvolvimento e é fornecido **sem garantia**, como diz a [AGPL 3.0](LICENSE) nas seções 15 e 16. Revise o que as IAs propõem antes de aprovar e use por sua conta e risco.

Backend TypeScript executado com `tsx`, sem etapa de build. Requer Node 22.5+ (`node:sqlite`).

## Rodar

```bash
git clone https://github.com/tekiidev/teko.git && cd teko
npm install
cp .env.example .env      # opcional: preencha as chaves que você tem
npm start                 # npm run dev recarrega sozinho
npm run typecheck         # checa todos os pacotes via Turborepo
npm test                  # testes (node:test)
npm run index             # reindexa os projetos com caminho local
```

Abre `http://127.0.0.1:4780`.

As chaves também podem ser cadastradas pela aba **Conexões** — ficam no SQLite local (`data/teko.db`, com permissão do seu usuário).

## O que já funciona

- **Chat com roteamento por perfil** — `código`, `projeto/arquitetura`, `documentação`, `revisão`, `bug`, `caveman (econômico)`.
- **Modo Caveman (Econômico)** — respostas telegráficas e ultra-densas que cortam até ~75% de tokens sem perder substância técnica.
- **Ferramentas no chat** — o modelo lista e lê arquivos, busca com regex, escreve, edita e roda comandos. Escrita e execução pedem **aprovação** na própria bolha.
- **Busca no projeto** — índice local FTS5 (BM25) sobre código, docs, memória, decisões e bugs. Os melhores trechos entram automaticamente no contexto da conversa.
- **Fallback automático** — 429, cota esgotada, chave inválida, 5xx, timeout: o modelo entra em cooldown e a fila continua.
- **Prompt caching**: o system prompt fica estável entre mensagens (data e trechos da busca vão junto da mensagem), com breakpoints de cache na Anthropic e aproveitamento do cache automático de OpenAI, Gemini e DeepSeek. Tokens em cache, latência e economia estimada ficam registrados por chamada.
- **Escolha manual + fallback** — se você escolher um modelo e ele cair, os seguintes do perfil continuam valendo.
- **Uso** — tokens e custo por sessão, hoje, semana, mês e total; série de 14 dias; quebra por modelo e provider.
- **Orçamento por modelo** — limite de tokens por semana/mês; ao estourar, o modelo sai da fila.
- **Projetos** — descrição, stack, caminho do repo (`git ls-files` entra no contexto), decisões (ADR-lite) e memória/documentos.
- **Bugs** — severidade, status, reprodução, esperado/atual, logs, tags; export JSON e Markdown pro projeto separado de bugs.
- **Memória contínua e resumo de sessão** — condensa a conversa e persiste aprendizados na memória do projeto.
- **Google Drive/Docs** — OAuth, busca e importação de Docs/Sheets como memória do projeto.
- **Figma** — token pessoal, leitura de páginas/frames/textos e importação como memória do projeto.
- **Sync de modelos** — puxa a lista real de cada provider e deixa os novos desativados pra revisão.

## Arquitetura

Monorepo com npm workspaces + Turborepo.

```
packages/
  ai/                     @teko/ai: o orquestrador
    src/
      config.ts           .env, data/ e porta (lidos da raiz do repo)
      db.ts               schema SQLite + seed
      catalog.ts          providers, modelos, perfis e preços iniciais
      router.ts           fila, fallback, cooldown, orçamento e loop de ferramentas
      context.ts          monta o system prompt do projeto
      approvals.ts        aprovações pendentes de ferramentas
      search-index.ts     índice FTS5 + busca BM25 + trechos pro prompt
      tools/              fs | search | shell | catálogo de ferramentas
      usage.ts            agregações de tokens/custo
      sync.ts             descoberta de modelos por provider
      providers/          anthropic | openai-compatible | google
      connectors/         google (OAuth + Drive) | figma (token + outline)
    scripts/              index | reset
apps/
  teko/                   @teko/app: painel local e servidor MCP
    src/server.ts         HTTP + SSE + rotas
    src/mcp.ts            contexto compartilhado com agentes via MCP stdio
    src/discover-projects.ts
    public/               SPA vanilla (sem build)
```

Os apps importam o orquestrador por subcaminho, por exemplo `@teko/ai/router`.

Próximos espaços previstos: `packages/career-core`, `packages/finance-core`, `apps/cofu`, `apps/teko-desktop`.

### Como o fallback decide

1. Monta a fila do perfil (ou começa pelo modelo escolhido).
2. Remove desativados, sem chave, em cooldown e acima do orçamento.
3. Tenta em ordem. Em falha, grava cooldown conforme o erro:
   - `429` → usa `Retry-After` ou 15 min
   - `401/403` → 30 min
   - `402` / "quota"/"insufficient" → 12–24h
   - `5xx`/rede → 3 min
4. Em sucesso, limpa o cooldown e registra uso.

O cliente recebe eventos SSE (`attempt`, `delta`, `fallback`, `tool_call`, `tool_decision`, `tool_running`, `tool_result`, `done`, `error`) e mostra a troca de modelo e as ferramentas na própria bolha.

## Ferramentas no chat

Com um projeto que tem caminho local, o modelo ganha seis ferramentas:

| Ferramenta | Aprovação | O que faz |
| --- | --- | --- |
| `list_files` | não | árvore de arquivos (profundidade 1–6) |
| `read_file` | não | lê arquivo com números de linha |
| `grep` | não | regex no conteúdo, com filtro de glob |
| `search_project` | não | busca por relevância no índice do projeto |
| `write_file` | **sim** | cria/sobrescreve arquivo |
| `edit_file` | **sim** | substitui trecho exato |
| `run_command` | **sim** | shell dentro do projeto (timeout 120s) |

É aqui que o Ultron fica preso. Tudo fica restrito ao caminho do projeto: `../` e caminhos externos são bloqueados. Comandos destrutivos óbvios (`rm -rf /`, `sudo`, `mkfs`, `dd if=`) são recusados antes da aprovação. Aprovações expiram em 5 minutos; se você fechar a aba, a execução é cancelada.

## Busca local

O índice usa **FTS5 do próprio SQLite** (`unicode61`, sem acento), com BM25 e trechos destacados. Sem embeddings, sem serviço externo, sem dependência.

- Indexa código e docs do repo + memória, decisões e bugs do projeto.
- `POST /api/search/index` reindexa; o índice também é criado ao salvar o caminho do projeto.
- Na conversa, os 5 trechos mais relevantes da sua mensagem entram no system prompt (RAG local).
- A aba **Projetos** tem busca com `arquivo:linha` e trecho destacado.

## API

| Método | Rota | Uso |
| --- | --- | --- |
| GET | `/api/bootstrap` | estado completo do dashboard |
| POST | `/api/chat` | SSE: conversa com fallback |
| GET | `/api/route?profileId=&modelId=` | prévia da fila e motivos de skip |
| GET | `/api/usage` | agregações de uso |
| GET | `/api/search?q=&projectId=` | busca no índice (BM25) |
| GET | `/api/search/status?projectId=` | estado do índice |
| POST | `/api/search/index` | reindexar projeto |
| GET | `/api/approvals` | aprovações pendentes |
| POST | `/api/approvals/:id` | aprovar/negar (`{ approved }`) |
| GET/POST/PATCH/DELETE | `/api/sessions…` | conversas |
| POST | `/api/sessions/:id/summarize` | resumo da sessão |
| GET/POST/PATCH/DELETE | `/api/projects…` | projetos |
| GET/POST/PATCH/DELETE | `/api/decisions…` | decisões |
| GET/POST/PATCH/DELETE | `/api/bugs…` | bugs |
| GET | `/api/bugs/export?format=json\|md` | export pro app de bugs |
| GET/POST/DELETE | `/api/memory…` | memória/documentos |
| PATCH | `/api/models?id=` | ativar, preço, orçamento |
| POST | `/api/models/sync` | descobrir modelos |
| POST | `/api/keys` | salvar chave por provider |
| GET | `/api/google/auth` | iniciar OAuth |
| GET | `/api/google/search?q=` | buscar no Drive |
| POST | `/api/google/import` | importar doc como memória |
| GET | `/api/figma/status` | estado da conexão |
| GET | `/api/figma/file?url=` | outline do arquivo (sem salvar) |
| POST | `/api/figma/import` | importar arquivo como memória |

## Google Drive

1. Crie um OAuth client **Desktop app** no Google Cloud Console.
2. Ative a Drive API.
3. Coloque `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` no `.env`.
4. Aba **Conexões → Conectar**.

Redirect URI usado: `http://localhost:4780/api/google/callback`.

## Figma

1. Gere um **Personal Access Token** em Figma → Settings → Security (escopo de leitura de arquivo).
2. Cole na aba **Conexões → Figma** ou defina `FIGMA_TOKEN` no `.env`.
3. Cole a URL do arquivo (`https://www.figma.com/design/<key>/...`) e importe para um projeto.

O que entra no contexto: nome das páginas, tipos e nomes dos frames, dimensões e os textos encontrados (até ~1200 nós).

## Integração com o OpenCode

O teko é um serviço local. Pra reaproveitar o roteamento dentro do OpenCode, o caminho mais direto é um plugin/MCP que chame `POST http://127.0.0.1:4780/api/chat` (SSE) — as sessões e o uso continuam sendo registrados aqui.

## Contexto para Claude Code, Codex e Antigravity

O Teko inclui um servidor MCP local (`npm run mcp`) para compartilhar projetos, preferências, decisões, bugs e notas duráveis entre agentes. A busca retorna poucos trechos do índice local; o servidor não envia o histórico completo das conversas. Configure o mesmo servidor em cada cliente e cadastre os caminhos dos repositórios na aba Projetos.

Veja [como conectar os agentes e organizar o contexto](docs/CONTEXTO_UNIFICADO.md).

## Próximos passos sugeridos

- Embeddings locais (Ollama) como segunda perna da busca, mantendo o FTS5 como fallback.
- Regras de roteamento por intenção (detectar review/bug automaticamente).
- Webhooks: bug criado → abre issue no GitHub.
- Criptografia das chaves em repouso (hoje ficam no SQLite local).
- Diff visual antes de aprovar escrita/edição.

## Licença

O Teko é open source sob a **[AGPL 3.0](LICENSE)**. Criado por **Felipe Oliveira** (Teki Industries).

- ✅ Pode usar, estudar, modificar e compartilhar à vontade
- ✅ Pode rodar pra você, pro seu time ou pra sua empresa
- 📌 Toda cópia ou fork mantém o crédito ao autor e o aviso do [NOTICE](NOTICE)
- 🔓 Se modificar e distribuir, ou oferecer como serviço online, o código tem que continuar aberto sob a AGPL
- 🏷️ Os nomes **Teko**, **Teki**, **Teki Industries** e **Cofu** não vêm junto com o código: fork tem que ter outro nome (nada de "Teko Pro"). Veja [TRADEMARKS.md](TRADEMARKS.md)
- 💼 Quer usar num produto fechado ou vender sem abrir o código? Isso pede uma **licença comercial**. Fala com [@tekiidev](https://github.com/tekiidev)

Contribuições são bem-vindas. Ao abrir um PR, você concorda que sua contribuição pode ser distribuída sob a AGPL 3.0 e sob a licença comercial do Teko.

## Reset

```bash
npm run reset -- --yes
```

Apaga o banco local. É o protocolo "Casa Limpa" do Teko: use com consciência.

---

Teko não tem relação com a Marvel. A gente só é fã mesmo. 🦾
