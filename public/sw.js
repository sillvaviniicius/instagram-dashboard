// Service worker mínimo — só existe para o navegador considerar o app
// "instalável". Não guarda cache de dados (o dashboard sempre busca
// métricas atualizadas), só dá uma resposta simples se a pessoa estiver
// offline.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() =>
      new Response(
        'Você está offline. Conecte-se à internet para ver os dados mais recentes do dashboard.',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' }, status: 503 }
      )
    )
  );
});
