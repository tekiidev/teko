# teko

Orquestrador local de IAs por **Felipe Oliveira** (@tekidev). Conversa com várias IAs usando o mesmo contexto: projetos, decisões, bugs, documentos, Drive e Figma. Escolhe o modelo, e se ele falhar ou estourar cota, o próximo da fila assume sozinho.

Zero dependências: Node 24 + `node:sqlite` + `fetch`. Sem build, sem `npm install`.

## Rodar

```bash
cd ~/Documents/teki-projects/teko
cp .env.example .env      # opcional: preencha as chaves que você tem
node src/server.js        # ou: npm start
```

Abre `http://127.0.0.1:4780`.

As chaves também podem ser cadastradas pela aba **Conexões** — ficam no SQLite local (`data/teko.db`, com permissão do seu usuário).

## O que já funciona

- **Chat com roteamento por perfil** — `código`, `projeto/arquitetura`, `documentação`, `revisão`, `bug`.
- **Fallback automático** — 429, cota esgotada, chave inválida, 5xx, timeout: o modelo entra em cooldown e a fila continua.
- **Escolha manual + fallback** — se você escolher um modelo e ele cair, os seguintes do perfil continuam valendo.
- **Uso** — tokens e custo por sessão, hoje, semana, mês e total; série de 14 dias; quebra por modelo e provider.
- **Orçamento por modelo** — limite de tokens por semana/mês; ao estourar, o modelo sai da fila.
- **Projetos** — descrição, stack, caminho do repo (`git ls-files` entra no contexto), decisões (ADR-lite) e memória/documentos.
- **Bugs** — severidade, status, reprodução, esperado/atual, logs, tags; export JSON e Markdown pro projeto separado de bugs.
- **Resumo de sessão** — condensa a conversa e injeta nos próximos contextos do mesmo projeto.
- **Google Drive/Docs** — OAuth, busca e importação de Docs/Sheets como memória do projeto.
- **Figma** — token pessoal, leitura de páginas/frames/textos e importação como memória do projeto.
- **Sync de modelos** — puxa a lista real de cada provider e deixa os novos desativados pra revisão.

## Arquitetura

```
public/                 SPA vanilla (sem build)
src/
  server.js             HTTP + SSE + rotas
  db.js                 schema SQLite + seed
  catalog.js            providers, modelos, perfis e preços iniciais
  router.js             fila, fallback, cooldown, orçamento
  context.js            monta o system prompt do projeto
  usage.js              agregações de tokens/custo
  sync.js               descoberta de modelos por provider
  providers/            anthropic | openai-compatible | google
  connectors/google.js  OAuth + Drive
  connectors/figma.js   token + outline de arquivos
```

### Como o fallback decide

1. Monta a fila do perfil (ou começa pelo modelo escolhido).
2. Remove desativados, sem chave, em cooldown e acima do orçamento.
3. Tenta em ordem. Em falha, grava cooldown conforme o erro:
   - `429` → usa `Retry-After` ou 15 min
   - `401/403` → 30 min
   - `402` / "quota"/"insufficient" → 12–24h
   - `5xx`/rede → 3 min
4. Em sucesso, limpa o cooldown e registra uso.

O cliente recebe eventos SSE (`attempt`, `delta`, `fallback`, `done`, `error`) e mostra a troca de modelo na própria bolha.

## API

| Método | Rota | Uso |
| --- | --- | --- |
| GET | `/api/bootstrap` | estado completo do dashboard |
| POST | `/api/chat` | SSE: conversa com fallback |
| GET | `/api/route?profileId=&modelId=` | prévia da fila e motivos de skip |
| GET | `/api/usage` | agregações de uso |
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

## Próximos passos sugeridos

- Ferramentas no chat (ler/escrever arquivos, rodar comando) com aprovação.
- Busca semântica nos projetos (embeddings locais).
- Regras de roteamento por intenção (detectar review/bug automaticamente).
- Webhooks: bug criado → abre issue no GitHub.
- Criptografia das chaves em repouso (hoje ficam no SQLite local).

## Reset

```bash
npm run reset -- --yes
```
