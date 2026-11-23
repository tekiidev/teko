/**
 * Tudo que dá pra fazer no Teko, numa fonte só: o terminal (/help) e o mapa (?) mostram daqui.
 * Ao criar comando, atalho ou gesto novo, adicione aqui.
 */

export type ItemAjuda = { faz: string; como: string };
export type SecaoAjuda = { titulo: string; itens: ItemAjuda[] };

export const AJUDA: SecaoAjuda[] = [
  {
    titulo: 'Voz (app na barra de menu)',
    itens: [
      { como: '"Teko"', faz: 'chama o Teko (bipe), depois é só falar o pedido' },
      { como: '"Teko, <pergunta>"', faz: 'pergunta direto, numa frase só' },
      { como: 'segurar ⌥ Espaço', faz: 'fala enquanto segura e envia ao soltar' },
      { como: 'mouse no notch', faz: 'abre a ilha: Falar, Mapa, Parar e um campo pra pedir digitando' },
      { como: 'continuar falando', faz: 'depois da resposta ele segue ouvindo ~8 s sem precisar do "Teko"' },
      { como: '"tchau" · "valeu" · "é isso"', faz: 'encerra a conversa' },
      { como: 'Esc', faz: 'cancela a conversa (para a fala e descarta a resposta)' },
      { como: '"Teko, trabalha no projeto <nome>"', faz: 'muda o projeto da conversa' },
      { como: '"Teko, abre o <app>"', faz: 'abre um app instalado (Mac, Linux e Windows); funciona no chat também' },
      { como: '"Teko, sai do projeto"', faz: 'volta a conversar sem projeto' },
      { como: '"sim" · "pode" / "não"', faz: 'aprova ou nega quando ele pergunta "Posso…?"' },
    ],
  },
  {
    titulo: 'Gestos (câmera, liga no menu da barra)',
    itens: [
      { como: 'fazer um T com as mãos e descolar', faz: 'abre o mapa (o T não precisa ser perfeito; descolar um pouco já basta)' },
      { como: 'juntar as mãos e segurar meio segundo', faz: 'fecha o mapa (afastar e juntar também fecha)' },
      { como: 'mãos separadas se afastando na diagonal (no mapa)', faz: 'volta pra rede inteira ramificada (tira a seleção e enquadra)' },
      { como: 'pinça (polegar no indicador)', faz: 'confirma quando ele pergunta "Posso…?"' },
      { como: 'minimizar o mapa', faz: 'volta pro Teko' },
      { como: 'apontar com o indicador (no mapa)', faz: 'mostra o cursor' },
      { como: 'parar o cursor num ponto ~1 s (no mapa)', faz: 'seleciona o ponto (o anel do cursor enche)' },
      { como: 'pinça e arrastar (no mapa)', faz: 'move o mapa' },
      { como: 'pinça com as duas mãos e afastar/aproximar', faz: 'amplia/diminui o mapa' },
    ],
  },
  {
    titulo: 'Mapa',
    itens: [
      { como: '? ou o botão ?', faz: 'mostra esta ajuda' },
      { como: 'Esc · botão Fechar mapa', faz: 'fecha o mapa' },
      { como: 'clicar num ponto', faz: 'mostra detalhes, abre a conversa ou o projeto' },
      { como: '+ · − · ⌖ · ⚙', faz: 'aproxima, afasta, enquadra e configura o grafo' },
    ],
  },
  {
    titulo: 'Terminal (teko)',
    itens: [
      { como: 'teko', faz: 'abre a conversa' },
      { como: 'teko "pergunta"', faz: 'responde e sai' },
      { como: 'cat arquivo | teko "explica"', faz: 'junta o arquivo à pergunta' },
      { como: 'teko -c', faz: 'continua a última conversa' },
      { como: 'teko uso · modelos · skills', faz: 'gasto, modelos prontos e skills' },
      { como: '/modelo · /models · /switch', faz: 'escolhe o modelo com ↑ ↓ e Enter' },
      { como: '/perfil · /projeto · /nova · /uso', faz: 'troca perfil, projeto, conversa nova, gasto' },
      { como: '/desfazer [n] · "Teko, desfaz isso"', faz: 'volta o que a IA escreveu nesta conversa (pede aprovação)' },
      { como: 'teko limpar · /limpar', faz: 'apaga conversas (todas, só voz ou só do projeto), pede confirmação' },
      { como: '↑ ↓ · Enter · Esc', faz: 'nas escolhas: move, confirma, cancela' },
      { como: '/semcache · /sair', faz: 'liga/desliga o cache local, sai' },
    ],
  },
  {
    titulo: 'Programar e delegar',
    itens: [
      { como: 'pedir com um projeto ativo', faz: 'lê, busca e edita arquivos do projeto (alterar pede aprovação)' },
      { como: '"implementa…" · "corrige o bug…"', faz: 'delega pro Claude Code (com aprovação); com revisão de outra IA quando ativa' },
    ],
  },
  {
    titulo: 'Skills',
    itens: [{ como: '/<nome> <texto>', faz: 'usa uma skill (ex.: /vagas <texto da vaga>); veja a lista com /skills' }],
  },
];

/** Versão em texto (terminal). */
export function ajudaTexto(cor: { titulo?: (t: string) => string; destaque?: (t: string) => string; dim?: (t: string) => string } = {}) {
  const t = cor.titulo || ((x) => x);
  const d = cor.destaque || ((x) => x);
  const m = cor.dim || ((x) => x);
  const largura = Math.max(...AJUDA.flatMap((s) => s.itens.map((i) => i.como.length)));
  return AJUDA.map((s) => [t(s.titulo), ...s.itens.map((i) => `  ${d(i.como.padEnd(largura))}  ${m(i.faz)}`)].join('\n')).join('\n\n');
}
