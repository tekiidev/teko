// Catálogo inicial de providers, modelos e perfis de tarefa.
// Tudo aqui é editável no dashboard (preços, ordem, ativar/desativar).
// Os IDs de modelo mudam com o tempo: use "Sincronizar modelos" na aba Modelos
// para puxar a lista real de cada provider.

export const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'google',
    label: 'Google (Gemini)',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    keyEnv: 'GOOGLE_API_KEY',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'qwen',
    label: 'Qwen (DashScope)',
    kind: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    keyEnv: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'zhipu',
    label: 'Zhipu (GLM)',
    kind: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyEnv: 'ZHIPU_API_KEY',
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    kind: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    keyEnv: 'MOONSHOT_API_KEY',
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    kind: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: 'XAI_API_KEY',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai',
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
    keyEnv: null,
  },
];

// priceIn / priceOut em USD por 1M tokens (aproximado, edite conforme seu plano).
export const MODELS = [
  // Anthropic (thinking adaptativo sempre ligado; Haiku 5.5 passa a US$ 0,50/2,50 acima de 100K tokens de prompt)
  { id: 'anthropic/claude-opus-5-5', provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', ctx: 1000000, priceIn: 4, priceOut: 20, tags: ['plan', 'review', 'code'] },
  { id: 'anthropic/claude-sonnet-5-5', provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', ctx: 1000000, priceIn: 2, priceOut: 10, tags: ['code', 'docs', 'review', 'plan'] },
  { id: 'anthropic/claude-haiku-5-5', provider: 'anthropic', model: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', ctx: 1000000, priceIn: 0.1, priceOut: 0.5, tags: ['bug', 'docs', 'economic'] },
  { id: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', ctx: 200000, priceIn: 3, priceOut: 15, tags: ['code', 'docs', 'review', 'plan'] },
  { id: 'anthropic/claude-opus-4-1', provider: 'anthropic', model: 'claude-opus-4-1', label: 'Claude Opus 4.1', ctx: 200000, priceIn: 15, priceOut: 75, tags: ['plan', 'review'] },
  { id: 'anthropic/claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', ctx: 200000, priceIn: 1, priceOut: 5, tags: ['bug', 'docs'] },

  // OpenAI
  { id: 'openai/gpt-6-luna', provider: 'openai', model: 'gpt-6-luna', label: 'GPT-6 Luna', ctx: 1050000, priceIn: 0.1, priceOut: 0.5, tags: ['code', 'docs', 'bug', 'economic'] },
  { id: 'openai/gpt-5.1-codex', provider: 'openai', model: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', ctx: 400000, priceIn: 1.25, priceOut: 10, tags: ['code', 'review', 'bug'] },
  { id: 'openai/gpt-5.1', provider: 'openai', model: 'gpt-5.1', label: 'GPT-5.1', ctx: 400000, priceIn: 1.25, priceOut: 10, tags: ['plan', 'docs', 'review'] },
  { id: 'openai/gpt-5.1-mini', provider: 'openai', model: 'gpt-5.1-mini', label: 'GPT-5.1 mini', ctx: 400000, priceIn: 0.25, priceOut: 2, tags: ['docs', 'bug'] },

  // Google: aliases "latest" sempre apontam pra versão atual (o Google aposenta versões fixas rápido).
  // Preços estimados; ajuste na aba Modelos se mudar.
  { id: 'google/gemini-flash-lite-latest', provider: 'google', model: 'gemini-flash-lite-latest', label: 'Gemini Flash Lite (latest)', ctx: 1000000, priceIn: 0.1, priceOut: 0.4, tags: ['code', 'docs', 'bug', 'economic'] },
  { id: 'google/gemini-flash-latest', provider: 'google', model: 'gemini-flash-latest', label: 'Gemini Flash (latest)', ctx: 1000000, priceIn: 0.3, priceOut: 2.5, tags: ['code', 'docs', 'bug', 'economic'] },
  { id: 'google/gemini-pro-latest', provider: 'google', model: 'gemini-pro-latest', label: 'Gemini Pro (latest)', ctx: 1000000, priceIn: 2, priceOut: 12, tags: ['plan', 'docs', 'code'] },

  // DeepSeek
  { id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', label: 'DeepSeek V3', ctx: 128000, priceIn: 0.28, priceOut: 0.42, tags: ['code', 'bug'] },
  { id: 'deepseek/deepseek-reasoner', provider: 'deepseek', model: 'deepseek-reasoner', label: 'DeepSeek Reasoner', ctx: 128000, priceIn: 0.28, priceOut: 0.42, tags: ['bug', 'plan', 'review'] },

  // Qwen
  { id: 'qwen/qwen3-coder-plus', provider: 'qwen', model: 'qwen3-coder-plus', label: 'Qwen3 Coder Plus', ctx: 256000, priceIn: 0.3, priceOut: 1.2, tags: ['code', 'bug'] },
  { id: 'qwen/qwen3-max', provider: 'qwen', model: 'qwen3-max', label: 'Qwen3 Max', ctx: 256000, priceIn: 1.2, priceOut: 6, tags: ['plan', 'docs'] },

  // Outros
  { id: 'zhipu/glm-4.6', provider: 'zhipu', model: 'glm-4.6', label: 'GLM 4.6', ctx: 200000, priceIn: 0.6, priceOut: 2.2, tags: ['code', 'docs'] },
  { id: 'moonshot/kimi-k2', provider: 'moonshot', model: 'kimi-k2', label: 'Kimi K2', ctx: 256000, priceIn: 0.6, priceOut: 2.5, tags: ['code', 'plan'] },
  { id: 'xai/grok-code-fast-1', provider: 'xai', model: 'grok-code-fast-1', label: 'Grok Code Fast', ctx: 256000, priceIn: 0.2, priceOut: 1.5, tags: ['code', 'review'] },

  // Ollama (local, custo zero)
  { id: 'ollama/qwen3.8:27b', provider: 'ollama', model: 'qwen3.8:27b', label: 'Qwen3.8 27B (local)', ctx: 128000, priceIn: 0, priceOut: 0, tags: ['code', 'offline'] },
  { id: 'ollama/qwen3:8b', provider: 'ollama', model: 'qwen3:8b', label: 'Qwen3 8B (local)', ctx: 128000, priceIn: 0, priceOut: 0, tags: ['code', 'offline'] },
];

const BASE_SYSTEM = [
  'Você é o motor do teko, um orquestrador pessoal de desenvolvimento.',
  'Responda em português do Brasil, direto ao ponto, sem encher linguiça.',
  'Quando o assunto for código, prefira exemplos concretos, diffs e nomes reais de arquivos.',
  'Se faltar informação essencial, faça no máximo 2 perguntas curtas antes de assumir.',
].join(' ');

// Modelos substituídos: em bancos existentes, o substituto entra na fila logo antes do antigo.
export const MODEL_UPGRADES: Record<string, string> = {
  'anthropic/claude-sonnet-4-5': 'anthropic/claude-sonnet-5-5',
  'anthropic/claude-opus-4-1': 'anthropic/claude-opus-5-5',
  'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-5-5',
  'google/gemini-3-pro': 'google/gemini-pro-latest',
  'google/gemini-2.5-flash': 'google/gemini-flash-latest',
};

/**
 * Modelos novos que entram em filas existentes uma única vez (antes do primeiro `before`
 * encontrado, ou no fim). Se o usuário tirar depois, não volta.
 */
export const CHAIN_ADDITIONS: { id: string; profile: string; model: string; before: string[] }[] = [
  // Flash Lite antes do Flash: responde rápido e o Flash vive sobrecarregado no plano grátis.
  { id: 'code-gemini-flash-lite', profile: 'code', model: 'google/gemini-flash-lite-latest', before: ['google/gemini-flash-latest', 'ollama/qwen3.8:27b', 'ollama/qwen3:8b'] },
  { id: 'bug-gemini-flash-lite', profile: 'bug', model: 'google/gemini-flash-lite-latest', before: ['google/gemini-flash-latest', 'ollama/qwen3.8:27b', 'ollama/qwen3:8b'] },
  { id: 'terse-gemini-flash-lite', profile: 'terse', model: 'google/gemini-flash-lite-latest', before: ['google/gemini-flash-latest'] },
  { id: 'code-gemini-flash', profile: 'code', model: 'google/gemini-flash-latest', before: ['ollama/qwen3.8:27b', 'ollama/qwen3:8b'] },
  { id: 'bug-gemini-flash', profile: 'bug', model: 'google/gemini-flash-latest', before: ['ollama/qwen3.8:27b', 'ollama/qwen3:8b'] },
];

export const PROFILES = [
  {
    id: 'code',
    label: 'Código',
    description: 'Implementar, refatorar e depurar código de verdade.',
    systemPrompt: `${BASE_SYSTEM} Modo: implementação. Entregue código completo e pronto pra colar, com o caminho do arquivo quando fizer sentido.`,
    chain: [
      'anthropic/claude-sonnet-5-5',
      'openai/gpt-5.1-codex',
      'qwen/qwen3-coder-plus',
      'deepseek/deepseek-chat',
      'google/gemini-flash-lite-latest',
      'google/gemini-flash-latest',
      'ollama/qwen3.8:27b',
      'ollama/qwen3:8b',
    ],
  },
  {
    id: 'plan',
    label: 'Projeto / Arquitetura',
    description: 'Decidir escopo, arquitetura, trade-offs e próximos passos.',
    systemPrompt: `${BASE_SYSTEM} Modo: arquitetura e produto. Sempre explicite trade-offs, riscos e o menor próximo passo executável.`,
    chain: [
      'anthropic/claude-opus-5-5',
      'google/gemini-pro-latest',
      'openai/gpt-5.1',
      'moonshot/kimi-k2',
      'ollama/qwen3.8:27b',
      'ollama/qwen3:8b',
    ],
  },
  {
    id: 'docs',
    label: 'Documentação',
    description: 'README, ADRs, docs de API, textos de projeto.',
    systemPrompt: `${BASE_SYSTEM} Modo: documentação. Escreva em Markdown limpo, com títulos curtos, exemplos e nada de redundância.`,
    chain: [
      'anthropic/claude-sonnet-5-5',
      'google/gemini-pro-latest',
      'openai/gpt-5.1-mini',
      'zhipu/glm-4.6',
      'ollama/qwen3.8:27b',
      'ollama/qwen3:8b',
    ],
  },
  {
    id: 'review',
    label: 'Revisão',
    description: 'Code review, segurança, bugs escondidos.',
    systemPrompt: `${BASE_SYSTEM} Modo: revisão crítica. Aponte problema, impacto e correção. Ordene por severidade. Não elogie de graça.`,
    chain: [
      'openai/gpt-5.1-codex',
      'anthropic/claude-opus-5-5',
      'xai/grok-code-fast-1',
      'deepseek/deepseek-reasoner',
      'ollama/qwen3.8:27b',
      'ollama/qwen3:8b',
    ],
  },
  {
    id: 'bug',
    label: 'Bug / Triagem',
    description: 'Transformar sintoma em causa raiz e correção.',
    systemPrompt: `${BASE_SYSTEM} Modo: caça-bug. Formato: sintoma → hipóteses → teste mais barato pra confirmar → correção → como evitar recorrência.`,
    chain: [
      'deepseek/deepseek-reasoner',
      'anthropic/claude-haiku-5-5',
      'openai/gpt-5.1-mini',
      'qwen/qwen3-coder-plus',
      'google/gemini-flash-lite-latest',
      'google/gemini-flash-latest',
      'ollama/qwen3:8b',
    ],
  },
  {
    id: 'voice',
    label: 'Voz',
    description: 'Conversa falada: respostas curtas, faladas, sem formatação.',
    systemPrompt: `${BASE_SYSTEM} Modo: voz. A resposta vai ser lida em voz alta. Fale como numa conversa: 1 a 3 frases curtas, em português do Brasil, sem markdown, sem listas, sem emoji e sem código. Se precisar de código ou de muitos detalhes, diga em uma frase e sugira abrir o painel ou o terminal.`,
    chain: [
      'google/gemini-flash-lite-latest',
      'anthropic/claude-haiku-5-5',
      'openai/gpt-6-luna',
      'deepseek/deepseek-chat',
      'google/gemini-flash-latest',
      'ollama/qwen3:8b',
    ],
  },
  {
    id: 'terse',
    label: 'Caveman (Econômico)',
    description: 'Respostas telegráficas e diretas para economizar ~75% de tokens.',
    systemPrompt: `${BASE_SYSTEM} Modo: caveman ultra-terse. Responda de forma direta e telegráfica, sem enrolação ou formalidades. Corte artigos e preâmbulos desnecessários. Código técnico preciso e cirúrgico. Máxima densidade de informação por token.`,
    chain: [
      'openai/gpt-6-luna',
      'anthropic/claude-haiku-5-5',
      'deepseek/deepseek-chat',
      'google/gemini-flash-lite-latest',
      'google/gemini-flash-latest',
      'openai/gpt-5.1-mini',
      'ollama/qwen3:8b',
    ],
  },
];
