import type { Metadata, Viewport } from 'next';
import { Atkinson_Hyperlegible, Fraunces } from 'next/font/google';
import { RegistrarServiceWorker } from '@/components/RegistrarServiceWorker.tsx';
import './globals.css';

const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap' });
const atkinson = Atkinson_Hyperlegible({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-atkinson',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Cofu · sua feira no cofo',
  description: 'Fale ou escreva o que vai comprar e o Cofu monta a lista. Funciona sem internet.',
  applicationName: 'Cofu',
  appleWebApp: { capable: true, title: 'Cofu', statusBarStyle: 'default' },
  icons: { icon: '/icon.svg', apple: '/icon.svg' },
};

export const viewport: Viewport = {
  themeColor: '#fbf6ec',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${fraunces.variable} ${atkinson.variable}`}>
      <body>
        {children}
        <RegistrarServiceWorker />
      </body>
    </html>
  );
}
