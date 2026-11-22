// Service worker do Cofu: guarda o app no aparelho pra abrir sem internet.
// - Páginas: tenta a rede primeiro; sem rede, usa a última cópia guardada.
// - Arquivos do app (JS, CSS, fontes, ícones): usa a cópia guardada e atualiza por trás.
// - /api/*: nunca guarda (a IA só funciona online).

const VERSAO = 'cofu-v1';
const INICIAIS = ['/', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSAO).then((cache) => cache.addAll(INICIAIS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((chaves) => Promise.all(chaves.filter((c) => c !== VERSAO).map((c) => caches.delete(c))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copia = res.clone();
          caches.open(VERSAO).then((cache) => cache.put(req, copia));
          return res;
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/'))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((guardado) => {
      const rede = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copia = res.clone();
            caches.open(VERSAO).then((cache) => cache.put(req, copia));
          }
          return res;
        })
        .catch(() => guardado);
      return guardado || rede;
    }),
  );
});
