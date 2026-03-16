// sw-habits.js — Service Worker para notificaciones de hábitos
// Ubicación: /public/sw-habits.js
//
// Recibe mensajes de habits.js con { type: 'SCHEDULE_HABIT_NOTIF', hour, minute, msUntil }
// y programa un setTimeout que dispara la notificación.
// Al cerrar el browser el SW puede suspenderse — el reschedule ocurre en cada visita a la app.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

let notifTimer = null;

self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'SCHEDULE_HABIT_NOTIF') {
    const { hour, minute, msUntil } = data;

    // Cancelar timer anterior si existía
    if (notifTimer) clearTimeout(notifTimer);

    if (msUntil <= 0 || msUntil > 24 * 60 * 60 * 1000) return;

    notifTimer = setTimeout(() => {
      const hh = String(hour).padStart(2, '0');
      const mm = String(minute).padStart(2, '0');

      self.registration.showNotification('Personal Hub — Hábitos', {
        body: `Son las ${hh}:${mm}. ¿Completaste tus hábitos de hoy?`,
        icon: '/logos/icon-192.png',
        badge: '/logos/icon-192.png',
        tag: 'habits-daily',          // reemplaza notif anterior si no fue cerrada
        renotify: false,
        requireInteraction: false,
        data: { url: '/' },
      });

      // Re-schedule para mañana a la misma hora
      notifTimer = setTimeout(() => {
        self.registration.showNotification('Personal Hub — Hábitos', {
          body: `Son las ${hh}:${mm}. ¿Completaste tus hábitos de hoy?`,
          icon: '/logos/icon-192.png',
          badge: '/logos/icon-192.png',
          tag: 'habits-daily',
          data: { url: '/' },
        });
      }, 24 * 60 * 60 * 1000);

    }, msUntil);

    console.log(`[sw-habits] notif programada en ${Math.round(msUntil / 60000)} min`);
  }
});

// Al tocar la notificación, abrir/enfocar la app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});
