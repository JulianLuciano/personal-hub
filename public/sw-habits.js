// sw-habits.js — Service Worker para Web Push real
// Ubicación: /public/sw-habits.js
//
// Este SW maneja notificaciones push reales enviadas desde el servidor
// via protocolo VAPID/Web Push. Ya NO usa setTimeout — notification-worker.js
// en Railway es quien decide cuándo mandar cada push.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Recibir push del servidor ─────────────────────────────────────────────────
self.addEventListener('push', event => {
  if (!event.data) return;

  let payload;
  try { payload = event.data.json(); }
  catch (_) { payload = { title: 'Personal Hub', body: event.data.text(), type: 'GENERIC' }; }

  const { title, body, tag, actions, data, type } = payload;

  const options = {
    body:    body || '',
    icon:    '/logos/icon-192.png',
    badge:   '/logos/icon-192.png',
    tag:     tag || 'hub-notif',
    renotify: true,
    requireInteraction: type === 'WATER_CHECK',
    data:    { ...data, type, url: '/' },
    actions: actions || [],
  };

  event.waitUntil(
    self.registration.showNotification(title || 'Personal Hub', options)
  );
});

// ── Action buttons ────────────────────────────────────────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const action    = event.action;
  const notifData = event.notification.data || {};
  const type      = notifData.type;

  if (type === 'WATER_CHECK') {
    if (action === 'water_yes') {
      event.waitUntil(
        fetch('/api/water/log', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ amount_ml: 500, source: 'notification', response: 'yes' }),
        }).then(() => focusOrOpenApp('/'))
      );
      return;
    }
    if (action === 'water_no') {
      event.waitUntil(
        fetch('/api/water/respond', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ response: 'no', water_ml_at_time: notifData.waterMl || 0 }),
        })
      );
      return;
    }
  }

  event.waitUntil(focusOrOpenApp('/'));
});

function focusOrOpenApp(url) {
  return self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    });
}
