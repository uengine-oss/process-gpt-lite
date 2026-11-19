// Lite's service worker (2026-11-18): Web Push from the server (server/lib/webpush.js) shown as system
// notifications — even with the app closed — with the app badge, and a click that opens the card's place.
// Android needs this: a page cannot call new Notification() there, and the launcher's number on an
// installed web app counts the notifications it has shown. No caching: the app always loads fresh.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { title: 'process gpt', body: e.data ? e.data.text() : '' } }
  const scope = self.registration.scope
  e.waitUntil((async () => {
    try { if (self.navigator.setAppBadge && d.badge != null) d.badge ? await self.navigator.setAppBadge(d.badge) : await self.navigator.clearAppBadge() } catch { /* no badging here */ }
    await self.registration.showNotification(d.title || 'process gpt', {
      body: d.body || '', tag: d.id ? `pgl-${d.id}` : undefined, renotify: false,
      icon: `${scope}icons/icon-192.png`, badge: `${scope}icons/badge-72.png`,
      data: { id: d.id || null, type: d.type || null, url: d.url || null, instId: d.instId || null },
    })
  })())
})

// the app open: it is told (MainView opens the room, the routine or the card's page); closed: it opens with ?notify=
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const d = e.notification.data || {}
  e.waitUntil((async () => {
    const scope = self.registration.scope
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const c = open.find((x) => x.url.startsWith(scope))
    if (c) { await c.focus().catch(() => {}); c.postMessage({ type: 'pgl:open-notification', detail: d }); return }
    await self.clients.openWindow(`${scope}chat?notify=${encodeURIComponent(JSON.stringify(d))}`)
  })())
})
