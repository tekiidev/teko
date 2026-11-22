# Contexto unificado no Teko

O Teko é a fonte única para preferências globais, cadastro de projetos, decisões, bugs e notas duráveis. Claude Code, Codex e Antigravity conectam-se a ele pelo servidor MCP local `teko-context`.

## Preparar o Teko

Requer Node.js 22.5 ou superior. Execute os comandos a partir da pasta do Teko:

```sh
cd /caminho/para/teko
npm install
npm run typecheck
npm run start
```

Cadastre cada repositório na aba **Projetos**, incluindo seu caminho local. Para importar os repositórios Git de uma pasta raiz de uma vez, rode:

```sh
cd /caminho/para/teko
npm run discover:projects -- "/caminho/para/seus-projetos"
```

O comando só cadastra pastas filhas que já tenham `.git`; ele pula caminhos já cadastrados e não reindexa nem altera os repositórios. Isso permite que o MCP reconheça o projeto pelo diretório atual. Revise stack e descrições na tela **Projetos**. A indexação local é criada na primeira busca (ou pode ser iniciada pela tela Projetos).

## Conectar os agentes

Use o caminho real do Teko e do executável Node 22.5+ instalado no computador. Os três clientes iniciam o mesmo processo local; não é necessário publicar o banco nem expor uma porta na rede.

### Claude Code

```sh
claude mcp add --scope user teko -- /caminho/para/node /caminho/para/teko/node_modules/tsx/dist/cli.mjs /caminho/para/teko/apps/teko/src/mcp.ts
claude mcp list
```

### Codex

```sh
codex mcp add teko -- /caminho/para/node /caminho/para/teko/node_modules/tsx/dist/cli.mjs /caminho/para/teko/apps/teko/src/mcp.ts
codex mcp list
```

Se o comando `codex` não estiver instalado, adicione manualmente a `~/.codex/config.toml`:

```toml
[mcp_servers.teko]
command = "/caminho/para/node"
args = ["/caminho/para/teko/node_modules/tsx/dist/cli.mjs", "/caminho/para/teko/apps/teko/src/mcp.ts"]
startup_timeout_sec = 30
```

Reinicie o Codex para carregar a configuração.

### Antigravity

Adicione ao `mcpServers` em `~/.gemini/config/mcp_config.json` (ou ao arquivo `.agents/mcp_config.json` do workspace):

```json
{
  "mcpServers": {
    "teko": {
      "command": "/caminho/para/node",
      "args": [
        "/caminho/para/teko/node_modules/tsx/dist/cli.mjs",
        "/caminho/para/teko/apps/teko/src/mcp.ts"
      ]
    }
  }
}
```

Reabra/recarregue o cliente e confira a lista de ferramentas MCP.

## Como usar o contexto sem inflar tokens

Inclua uma regra curta nos arquivos de instruções dos projetos. Preserve as instruções existentes e acrescente algo como:

```md
Use o MCP `teko` como fonte para preferências e memória entre agentes.
No início de uma tarefa relevante, consulte `teko_get_project_brief`.
Busque detalhes com `teko_search_knowledge` em vez de carregar conversas inteiras.
Ao descobrir uma decisão durável, salve apenas o resumo com `teko_save_memory`.
Não salve transcrições, código já presente no repositório ou segredos.
```

Codex e Antigravity leem `AGENTS.md`. Claude Code usa `CLAUDE.md`; para reaproveitar o mesmo texto, Claude Code aceita uma inclusão `@AGENTS.md` em `CLAUDE.md`. As memórias internas privadas dos produtos não são sincronizadas pelo Teko automaticamente: migre o que for importante para notas/decisões do Teko ou para os arquivos de instrução do repositório.

## Ferramentas MCP disponíveis

- `teko_list_projects`: IDs, slugs, diretórios e descrição curta.
- `teko_get_global_context`: preferências globais e projetos.
- `teko_get_project_brief`: resumo compacto, decisões recentes e bugs abertos. Infere o projeto pelo diretório quando possível.
- `teko_search_knowledge`: busca FTS5 local por relevância, limitada a poucos trechos.
- `teko_save_memory`: registra uma nota durável em um projeto e atualiza seu índice local.

O servidor não expõe shell nem escrita arbitrária em arquivos. A única escrita MCP é uma nota na memória do projeto.

## Organização da pasta `teki-projects`

Use um diretório por repositório/projeto ativo. Cadastre no Teko apenas os projetos que você quer pesquisar e mantenha decisões de produto no banco; regras de execução e padrões de código ficam versionados no `AGENTS.md`/`CLAUDE.md` de cada repo. Repositórios arquivados podem continuar no Git sem precisar ser carregados automaticamente em todo prompt.

## Custos da API

- Use o perfil **Caveman (econômico)** ou um modelo de baixo custo para triagem, resumo, busca e mudanças simples; reserve modelos mais fortes para arquitetura, revisão difícil e depuração complexa.
- Deixe o histórico grande fora do prompt padrão. O Teko injeta metadados, decisões e bugs em formato curto; conteúdo e resumos antigos entram pela busca textual local quando relevantes.
- Salve notas concisas e reutilizáveis, em vez de enviar transcrições entre agentes.
- Configure preço por modelo, teto mensal/semanal e fallback na aba **Modelos**. Preço de modelo e identificadores mudam; use a tabela de preços oficial antes de atualizar a configuração local.
- O catálogo inicial do Teko inclui `gpt-6-luna` a US$ 0,10 por 1M tokens de entrada e US$ 0,50 por 1M de saída (entrada em cache: US$ 0,01). A API aceita function calling via Chat Completions com `reasoning_effort: "none"`; o adaptador do Teko configura isso para esse modelo. Confira [preços atuais](https://developers.openai.com/api/docs/pricing) antes de usar estimativas.
- O painel de uso do Teko ainda estima todos os tokens de entrada à tarifa normal; se a API descontar tokens em cache, o gasto exibido pode ficar acima do real. Use o painel de uso da API OpenAI como referência de cobrança.
- API é cobrada por uso e separadamente de uma assinatura de chat. Confira o painel da API e use alertas/limites de orçamento no provedor, além dos limites locais do Teko.

O `teko_search_knowledge` usa FTS5 local sem embeddings pagos. A indexação custa tempo de CPU/disco local, não chamadas de modelo.
