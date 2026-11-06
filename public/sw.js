// Service worker: guarda a tela do app para abrir rápido; dados (/api) sempre buscados na hora.
const CACHE = 'investimentos-v15';
const SHELL = ['/', '/manifest.json', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE && k !== 'compartilhado').map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  // Conversa compartilhada pelo WhatsApp (Android): guarda o arquivo e abre a aba Grupo D2, que envia com o PIN.
  if (e.request.method === 'POST' && u.origin === location.origin && u.pathname === '/compartilhar') {
    e.respondWith((async () => {
      try {
        const fd = await e.request.formData();
        const f = fd.getAll('arquivo').find((x) => x && typeof x !== 'string');
        if (!f) return Response.redirect('/?compartilhado=falhou', 303);
        const c = await caches.open('compartilhado');
        await c.put('/compartilhado', new Response(f, { headers: { 'x-nome': encodeURIComponent(f.name || '') } }));
        return Response.redirect('/?compartilhado=1', 303);
      } catch (err) { return Response.redirect('/?compartilhado=falhou', 303); }
    })());
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api')) return;
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});

// Notificações de alerta
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { corpo: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Investimentos', { body: d.corpo || '', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'alerta-' + Date.now(), data: { url: d.url || '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('focus' in c) { if (url !== '/' && 'navigate' in c) c.navigate(url).catch(() => {}); return c.focus(); } }
    return self.clients.openWindow(url);
  }));
});
