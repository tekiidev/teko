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
  // Anthropic
  { id: 'anthropic/claude-sonnet-4-5', provider: 'anthropic', model: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', ctx: 200000, priceIn: 3, priceOut: 15, tags: ['code', 'docs', 'review', 'plan'] },
  { id: 'anthropic/claude-opus-4-1', provider: 'anthropic', model: 'claude-opus-4-1', label: 'Claude Opus 4.1', ctx: 200000, priceIn: 15, priceOut: 75, tags: ['plan', 'review'] },
  { id: 'anthropic/claude-haiku-4-5', provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', ctx: 200000, priceIn: 1, priceOut: 5, tags: ['bug', 'docs'] },

  // OpenAI
  { id: 'openai/gpt-5.1-codex', provider: 'openai', model: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', ctx: 400000, priceIn: 1.25, priceOut: 10, tags: ['code', 'review', 'bug'] },
  { id: 'openai/gpt-5.1', provider: 'openai', model: 'gpt-5.1', label: 'GPT-5.1', ctx: 400000, priceIn: 1.25, priceOut: 10, tags: ['plan', 'docs', 'review'] },
  { id: 'openai/gpt-5.1-mini', provider: 'openai', model: 'gpt-5.1-mini', label: 'GPT-5.1 mini', ctx: 400000, priceIn: 0.25, priceOut: 2, tags: ['docs', 'bug'] },

  // Google
  { id: 'google/gemini-3-pro', provider: 'google', model: 'gemini-3-pro', label: 'Gemini 3 Pro', ctx: 1000000, priceIn: 2, priceOut: 12, tags: ['plan', 'docs', 'code'] },
  { id: 'google/gemini-2.5-flash', provider: 'google', model: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', ctx: 1000000, priceIn: 0.3, priceOut: 2.5, tags: ['docs', 'bug'] },

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

export const PROFILES = [
  {
    id: 'code',
    label: 'Código',
    description: 'Implementar, refatorar e depurar código de verdade.',
    systemPrompt: `${BASE_SYSTEM} Modo: implementação. Entregue código completo e pronto pra colar, com o caminho do arquivo quando fizer sentido.`,
    chain: [
      'anthropic/claude-sonnet-4-5',
      'openai/gpt-5.1-codex',
      'qwen/qwen3-coder-plus',
      'deepseek/deepseek-chat',
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
      'anthropic/claude-opus-4-1',
      'google/gemini-3-pro',
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
      'anthropic/claude-sonnet-4-5',
      'google/gemini-3-pro',
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
      'anthropic/claude-opus-4-1',
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
      'anthropic/claude-haiku-4-5',
      'openai/gpt-5.1-mini',
      'qwen/qwen3-coder-plus',
      'ollama/qwen3:8b',
    ],
  },
];
