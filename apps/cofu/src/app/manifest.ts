import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cofu · sua feira no cofo',
    short_name: 'Cofu',
    description: 'Fale ou escreva o que vai comprar e o Cofu monta a lista. Funciona sem internet.',
    start_url: '/',
    display: 'standalone',
    background_color: '#fbf6ec',
    theme_color: '#fbf6ec',
    lang: 'pt-BR',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
    ],
  };
}
