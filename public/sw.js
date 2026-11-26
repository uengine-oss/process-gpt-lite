// Lite's service worker (2026-11-18): Web Push from the server (server/lib/webpush.js) shown as system
// notifications — even with the app closed — with the app badge, and a click that opens the card's place.
// Android needs this: a page cannot call new Notification() there, and the launcher's number on an
// installed web app counts the notifications it has shown. No caching: the app always loads fresh.
// 2026-11-26 (사용자: 「퀵하게 대화방에서 온 내용 혹은 ai의 후먼인더루프 등을 모바일에서 보게할 수 있나?」): like a messenger —
//   - one notification per room (the push's tag), replaced as more come: 「<방 이름> · 3」 over the last lines, with 「답장」
//   - the AI waiting on the person: its question with buttons — an option answers it right here (POST api/push/act with the push's
//     single-use token, never the sign-in token), 「열기」 opens where it asks
//   - a room or a chat thread the person has open in front is not notified (the page is asked: src/browserNotify.js); a mention always is
const VIEW_ASK_MS = 400
const DONE_SHOWN_MS = 4000

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

const scope = () => self.registration.scope
const lite = async () => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => c.url.startsWith(scope()))

// Is a page of Lite in front showing this room or this thread? Each page in front is asked (it knows what it shows); no answer in time: no.
async function shownInFront(d) {
  if (d.mention || (!d.room && !d.thread)) return false
  for (const c of await lite()) {
    if (c.visibilityState !== 'visible' || !c.focused) continue
    const seen = await new Promise((ok) => {
      const ch = new MessageChannel()
      const t = setTimeout(() => ok(false), VIEW_ASK_MS)
      ch.port1.onmessage = (e) => { clearTimeout(t); ok(!!e.data?.viewing) }
      try { c.postMessage({ type: 'pgl:viewing?', room: d.room || null, thread: d.thread || null }, [ch.port2]) } catch { clearTimeout(t); ok(false) }
    })
    if (seen) return true
  }
  return false
}

// what a click needs later (never the token in an address: openPlace leaves it out)
const dataOf = (d) => ({ id: d.id || null, type: d.type || null, url: d.url || null, instId: d.instId || null, room: d.room || null, thread: d.thread || null,
  card: d.card || null, place: d.place || null, kind: d.kind || null, token: d.token || null, title: d.title || '',
  actions: (d.actions || []).map((a) => ({ action: a.action, title: a.title })) })

// Safari's Web Push (iPhone · iPad · Mac) counts a push that shows nothing as a silent push and drops the subscription after a few: there
// a push for what is already in front is shown silently and closed at once (review 11-26, PR #89). Chrome · Edge · Firefox allow none
// while a page of the site is in front.
const appleWebKit = (ua) => /iPhone|iPad|iPod/.test(ua) || (/Safari\//.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/.test(ua))
const QUIET = 'pgl-quiet'

// d: the push; ua: this browser (tests give one) → the options shown, 'quiet' (shown and closed), or null (nothing)
async function onPush(d, ua = self.navigator.userAgent) {
  try { if (self.navigator.setAppBadge && d.badge != null) d.badge ? await self.navigator.setAppBadge(d.badge) : await self.navigator.clearAppBadge() } catch { /* no badging here */ }
  if (await shownInFront(d)) {
    if (!appleWebKit(String(ua || ''))) return null
    await self.registration.showNotification(d.title || 'process gpt', { body: d.body || '', tag: QUIET, silent: true, data: {} })
    for (const n of await self.registration.getNotifications({ tag: QUIET })) n.close()
    return 'quiet'
  }
  const tag = d.tag || (d.id ? `pgl-${d.id}` : undefined)
  const max = Math.max(0, Math.min(2, self.Notification?.maxActions ?? 2))
  const opts = {
    body: d.body || '', tag, renotify: !!(tag && d.renotify), requireInteraction: !!d.requireInteraction,
    icon: `${scope()}icons/icon-192.png`, badge: `${scope()}icons/badge-72.png`, data: dataOf(d),
    actions: (d.actions || []).slice(0, max).map((a) => ({ action: a.action, title: a.title })),
  }
  await self.registration.showNotification(d.title || 'process gpt', opts)
  return opts
}

// the app open: it is told (MainView opens the room, the thread, the routine or the card's page); closed: it opens with ?notify=
async function openPlace(d) {
  const { token: _t, actions: _a, ...detail } = d
  const c = (await lite())[0]
  if (c) { await c.focus().catch(() => {}); c.postMessage({ type: 'pgl:open-notification', detail }); return 'told' }
  await self.clients.openWindow(`${scope()}chat?notify=${encodeURIComponent(JSON.stringify(detail))}`)
  return 'opened'
}

// a click on the notification (action '' = its body) → what happened: 'answered' | 'told' | 'opened'
async function onClick(n, action) {
  const d = n.data || {}
  n.close()
  if (/^a\d$/.test(action || '') && d.token) {
    try {
      const r = await fetch(`${scope()}api/push/act`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: d.token, answer: Number(action.slice(1)) }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok) {
        // a moment's word that it went (in the person's language: the server says it), then it goes
        const tag = n.tag || `pgl-${d.id}`
        await self.registration.showNotification(d.title || 'process gpt', { body: j.said || j.answered || '', tag, silent: true, renotify: false,
          icon: `${scope()}icons/icon-192.png`, badge: `${scope()}icons/badge-72.png`, data: { ...dataOf(d), token: null, actions: [] } })
        await new Promise((ok) => setTimeout(ok, DONE_SHOWN_MS))
        for (const x of await self.registration.getNotifications({ tag })) x.close()
        return 'answered'
      }
    } catch { /* offline: opened instead */ }
    // refused (answered already, no longer waiting, too old): the place opens with what is there now
    return openPlace({ ...d, refused: true })
  }
  return openPlace(action === 'reply' ? { ...d, reply: true } : d)
}

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { d = { title: 'process gpt', body: e.data ? e.data.text() : '' } }
  e.waitUntil(onPush(d))
})
self.addEventListener('notificationclick', (e) => e.waitUntil(onClick(e.notification, e.action)))

// the handlers themselves, for the tests (e2e/tests/feature/push-hitl.spec.js calls them in this worker)
self.__pgl = { push: onPush, click: onClick, shownInFront }

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

// the form, read only while it stays under the total: a phone's memory is not spent on a body that would be refused anyway. The body flows
// once through a byte count into the form reader — never gathered first (the pieces, then a Blob of them, then the form: three copies).
async function pglShareForm(req) {
  const max = PGL_SHARE.totalBytes + PGL_SHARE.marginBytes
  if (Number(req.headers.get('content-length') || 0) > max) throw pglShareBig()
  if (!req.body?.pipeThrough || typeof TransformStream !== 'function') return req.formData()
  let n = 0, over = false
  const counter = new TransformStream({
    transform(chunk, c) {
      n += chunk.byteLength
      if (n > max) { over = true; c.error(pglShareBig()) } else c.enqueue(chunk)
    },
  })
  try {
    return await new Response(req.body.pipeThrough(counter), { headers: { 'Content-Type': req.headers.get('content-type') || '' } }).formData()
  } catch (err) { throw over ? pglShareBig() : err }
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
