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

async function onPush(d) {
  try { if (self.navigator.setAppBadge && d.badge != null) d.badge ? await self.navigator.setAppBadge(d.badge) : await self.navigator.clearAppBadge() } catch { /* no badging here */ }
  // (Chrome asks for a notification on every push only while no page of the site is in front)
  if (await shownInFront(d)) return null
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
