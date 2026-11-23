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
      { como: 'continuar falando', faz: 'depois da resposta ele segue ouvindo ~8 s sem precisar do "Teko"' },
      { como: '"tchau" · "valeu" · "é isso"', faz: 'encerra a conversa' },
      { como: 'Esc', faz: 'cancela a conversa (para a fala e descarta a resposta)' },
      { como: '"Teko, trabalha no projeto <nome>"', faz: 'muda o projeto da conversa' },
      { como: '"Teko, sai do projeto"', faz: 'volta a conversar sem projeto' },
      { como: '"sim" · "pode" / "não"', faz: 'aprova ou nega quando ele pergunta "Posso…?"' },
    ],
  },
  {
    titulo: 'Gestos (câmera, liga no menu da barra)',
    itens: [
      { como: 'juntar as mãos abertas e afastar', faz: 'abre o mapa' },
      { como: 'juntar as mãos e segurar meio segundo', faz: 'fecha o mapa (afastar e juntar também fecha)' },
      { como: 'pinça (polegar no indicador)', faz: 'confirma quando ele pergunta "Posso…?"' },
      { como: 'minimizar o mapa', faz: 'volta pro Teko' },
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
      { como: '/modelo · /models · /switch', faz: 'lista os modelos e escolhe pelo número' },
      { como: '/perfil · /projeto · /nova · /uso', faz: 'troca perfil, projeto, conversa nova, gasto' },
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
