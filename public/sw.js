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

// ---- 다른 앱의 「공유」 → Process GPT (Web Share Target, 2026-11-26) — a block of its own: nothing above depends on it ----
// 사용자(휴대폰 녹화): 「우리가 파일을 공유할 때 여기 앱으로 process GPT가 들어가면 좋겠어.」 The manifest's share_target
// (public/manifest.webmanifest) makes Android's share sheet post what was shared — multipart: title, text, url, files — to
// <scope>share-target. It is kept here in Cache Storage (pgl-share-v1: <scope>share-target/<id>/meta and …/<id>/<n>, never on the
// server) and the window goes on to <scope>chat?share=<id> (303), where the app (src/shareInbox.js) puts it in the place the person
// last had open, or asks where. Only a POST to that one address is answered; every other request goes to the network as before.
// Limits as the composers' (src/shareTarget.js LIMITS, compared by server/test/shareTarget.test.js): 10 files, 50MB a file (the upload
// routes' own limit), 200MB together. What does not fit is listed (skipped) so the app says why. One never opened is swept after a day.
const PGL_SHARE = { cache: 'pgl-share-v1', files: 10, fileBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, keepMs: 24 * 3600 * 1000 }

// Only a POST can be a share: every GET (the app's pages, scripts, the API's reads, the event stream) goes straight to the network
// without waking this worker, where the browser can route that (Chrome's static routing, 123+); elsewhere the handler below lets it pass.
self.addEventListener('install', (e) => {
  try { Promise.resolve(e.addRoutes?.([{ condition: { requestMethod: 'GET' }, source: 'network' }])).catch(() => {}) } catch { /* not here */ }
})

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'POST') return
  const scope = self.registration.scope
  if (e.request.url.split(/[?#]/)[0] !== `${scope}share-target`) return
  e.respondWith(pglTakeShare(e.request, scope))
})

const pglShareId = () => `${Date.now().toString(36)}-${(self.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 10)}`
const pglShareStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')

async function pglTakeShare(req, scope) {
  const id = pglShareId()
  try {
    const form = await req.formData()
    const cache = await caches.open(PGL_SHARE.cache)
    await pglShareSweep(cache, scope).catch(() => {})
    const meta = { id, at: Date.now(), title: pglShareStr(form.get('title'), 300), text: pglShareStr(form.get('text'), 20000), url: pglShareStr(form.get('url'), 4000), files: [], skipped: [] }
    let total = 0
    for (const f of form.getAll('files')) {
      if (!f || typeof f === 'string') continue
      const name = String(f.name || '').slice(0, 200)
      const why = f.size === 0 ? 'empty' : f.size > PGL_SHARE.fileBytes ? 'big' : meta.files.length >= PGL_SHARE.files ? 'many' : total + f.size > PGL_SHARE.totalBytes ? 'total' : ''
      if (why) { meta.skipped.push({ name, size: f.size, why }); continue }
      const n = meta.files.length
      await cache.put(`${scope}share-target/${id}/${n}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }))
      meta.files.push({ n, name, type: f.type || '', size: f.size })
      total += f.size
    }
    await cache.put(`${scope}share-target/${id}/meta`, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }))
    return Response.redirect(`${scope}chat?share=${id}`, 303)
  } catch {
    // (nothing readable, or the phone's storage is full: the app says it did not come — what was kept of it is swept with the rest)
    return Response.redirect(`${scope}chat?share=failed`, 303)
  }
}

// a share's entries older than a day (its id begins with the time it came, so a share whose record never got written goes too)
async function pglShareSweep(cache, scope) {
  const now = Date.now()
  for (const r of await cache.keys()) {
    const m = r.url.startsWith(`${scope}share-target/`) ? /share-target\/([0-9a-z]+)-/.exec(r.url) : null
    const t = m ? parseInt(m[1], 36) : 0
    if (!t || now - t > PGL_SHARE.keepMs) await cache.delete(r)
  }
}
