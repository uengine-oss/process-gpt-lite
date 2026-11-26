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
// server) and the window goes on to <scope>chat?share=<id> (303). The app (src/shareInbox.js) then asks once — 「넣기」 into the place
// the person last had open, or 「다른 곳에」 — before anything goes in or up: another site can post the same form, and nothing here
// tells the two apart.
// Limits as the composers' (src/shareTarget.js LIMITS, compared by server/test/shareTarget.test.js): 10 files, 50MB a file (the upload
// routes' own limit), 200MB together. A body over the total (and a margin for the form's own lines) is not read at all
// (?share=failed:big); what does not fit is listed (skipped) so the app says why; one never opened is swept after a day.
// Files are kept as application/octet-stream whatever the sharing app called them: the app names their type from the file's extension.
// Where the browser has static routing (Chrome 123+: InstallEvent.addRoutes — the browsers that take shares at all), every request but
// the share's POST goes straight to the network and never wakes this worker; elsewhere (Safari, Firefox) there is no fetch handler.
const PGL_SHARE = { cache: 'pgl-share-v1', files: 10, fileBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, marginBytes: 1024 * 1024, keepMs: 24 * 3600 * 1000 }

if (self.InstallEvent && 'addRoutes' in self.InstallEvent.prototype) {
  self.addEventListener('install', (e) => {
    const pathname = new URL('share-target', self.registration.scope).pathname
    const add = (rules) => Promise.resolve().then(() => e.addRoutes(rules))
    // (a browser without the `not` condition: the GETs at least; the install never fails over a route)
    e.waitUntil(add([{ condition: { not: { requestMethod: 'POST', urlPattern: { pathname } } }, source: 'network' }])
      .catch(() => add([{ condition: { requestMethod: 'GET' }, source: 'network' }])).catch(() => {}))
  })
  self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'POST') return
    const scope = self.registration.scope
    if (e.request.url.split(/[?#]/)[0] !== `${scope}share-target`) return
    e.respondWith(pglTakeShare(e.request, scope))
  })
}

const pglShareId = () => `${Date.now().toString(36)}-${(self.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '').slice(0, 10)}`
const pglShareStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
const pglShareBig = () => new Error('big')

// the form, read only while it stays under the total: a phone's memory is not spent on a body that would be refused anyway
async function pglShareForm(req) {
  const max = PGL_SHARE.totalBytes + PGL_SHARE.marginBytes
  if (Number(req.headers.get('content-length') || 0) > max) throw pglShareBig()
  if (!req.body?.getReader) return req.formData()
  const reader = req.body.getReader(), parts = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) { await reader.cancel().catch(() => {}); throw pglShareBig() }
    parts.push(value)
  }
  return new Response(new Blob(parts), { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData()
}

async function pglTakeShare(req, scope) {
  const id = pglShareId()
  let cache = null
  try {
    const form = await pglShareForm(req)
    cache = await caches.open(PGL_SHARE.cache)
    await pglShareSweep(cache, scope).catch(() => {})
    const meta = { id, at: Date.now(), title: pglShareStr(form.get('title'), 300), text: pglShareStr(form.get('text'), 20000), url: pglShareStr(form.get('url'), 4000), files: [], skipped: [] }
    let total = 0
    for (const f of form.getAll('files')) {
      if (!f || typeof f === 'string') continue
      const name = String(f.name || '').slice(0, 200)
      const why = f.size === 0 ? 'empty' : f.size > PGL_SHARE.fileBytes ? 'big' : meta.files.length >= PGL_SHARE.files ? 'many' : total + f.size > PGL_SHARE.totalBytes ? 'total' : ''
      if (why) { meta.skipped.push({ name, size: f.size, why }); continue }
      const n = meta.files.length
      await cache.put(`${scope}share-target/${id}/${n}`, new Response(f, { headers: { 'Content-Type': 'application/octet-stream' } }))
      meta.files.push({ n, name, size: f.size })
      total += f.size
    }
    await cache.put(`${scope}share-target/${id}/meta`, new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }))
    return Response.redirect(`${scope}chat?share=${id}`, 303)
  } catch (err) {
    // (nothing readable, too big, or the phone's storage is full: what was kept of this one goes now, and the app says it did not come)
    if (cache) await pglShareDrop(cache, scope, id).catch(() => {})
    return Response.redirect(`${scope}chat?share=${err?.message === 'big' ? 'failed:big' : 'failed'}`, 303)
  }
}

// this share's entries
async function pglShareDrop(cache, scope, id) {
  for (const r of await cache.keys()) if (r.url.startsWith(`${scope}share-target/${id}/`)) await cache.delete(r)
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
