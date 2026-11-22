'use client';

import { useEffect } from 'react';

/** Registra o service worker (offline) só em produção, pra não atrapalhar o dev. */
export function RegistrarServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}
