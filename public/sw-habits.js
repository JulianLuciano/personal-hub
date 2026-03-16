// sw-habits.js — Service Worker para notificaciones de hábitos
// Ubicación: /public/sw-habits.js
//
// Recibe mensajes de habits.js con { type: 'SCHEDULE_HABIT_NOTIF', hour, minute, msUntil }
// y programa un setTimeout que dispara la notificación.
// Al cerrar el browser el SW puede suspenderse — el reschedule ocurre en cada visita a la app.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

let notifTimer = null;


// Fire notification only if user hasn't logged any habit today
function fireNotif(hour, minute, lastActivity) {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (lastActivity === todayStr) {
    console.log('[sw-habits] actividad detectada hoy, notif omitida');
    return;
  }
  self.registration.showNotification('Personal Hub', {
    body: 'Hora de completar tus hábitos diarios.',
    icon: '/logos/icon-192.png',
    badge: '/logos/icon-192.png',
    tag: 'habits-daily',
    renotify: false,
    requireInteraction: false,
    data: { url: '/' },
  });
}

self.addEventListener('message', event => {
  const data = event.data || {};

  if (data.type === 'SCHEDULE_HABIT_NOTIF') {
    const { hour, minute, msUntil, lastActivity } = data;

    // Cancelar timer anterior si existía
    if (notifTimer) clearTimeout(notifTimer);

    if (msUntil <= 0 || msUntil > 24 * 60 * 60 * 1000) return;

    notifTimer = setTimeout(() => {
      const hh = String(hour).padStart(2, '0');
      const mm = String(minute).padStart(2, '0');

      fireNotif(hour, minute, lastActivity);

      // Re-schedule para mañana a la misma hora
      notifTimer = setTimeout(() => fireNotif(hour, minute, lastActivity), 24 * 60 * 60 * 1000);

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
