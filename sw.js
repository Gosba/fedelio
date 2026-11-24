// Service worker : reçoit les notifications des commerçants
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {}; try { d = e.data.json(); } catch { d = { title: 'Nouvelle offre', body: e.data?.text() || '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Nouvelle offre', { body: d.body || '', data: { url: d.url || '/' }, icon: d.url ? d.url + '/icon.svg' : undefined }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    for (const c of list) if (new URL(c.url).pathname === url && 'focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
