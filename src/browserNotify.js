// System notifications for Lite (2026-11-18): "채팅을 걸면 웹브라우저 노티가 들어오는지, 단톡일 때도" and
// "웹앱으로 설치했을 때도 노티가 들어오면 아이콘에 숫자가 나오면 좋겠다". What arrives on the Home cards arrives
// as a system notification too — a teammate's message in a 1:1 or group room (process-gpt's chat trigger
// writes a 'chat' row for every participant, whoever sent it), a share or mention, a step waiting for me,
// a meeting's action item, a routine started or done.
//   - Web Push (server/lib/webpush.js → public/sw.js): also with Lite closed; on Android the launcher shows
//     the number on the installed app's icon. Turned on by the Home's 「브라우저 알림 켜기」 (a click — browsers
//     ask for the permission only then); later visits renew the subscription quietly.
//   - without push (no service worker, push refused): the open tab shows them while it is in the background,
//     through the service worker when there is one (Android allows no other way), else new Notification().
// The app badge (installed app, where the browser has it; the desktop app's Dock, taskbar and tray) is the number of Home cards waiting.
// 2026-11-26 (「퀵하게 대화방에서 온 내용 혹은 ai의 후먼인더루프 등을 모바일에서 보게할 수 있나?」): one notification per room, the AI's
// questions with buttons that answer them (public/sw.js), a room or thread shown in front is not notified (setViewing), 「시험 알림
// 보내기」 (sendTest), and on an iPhone outside a Home Screen web app a word on how it works there (iosNeedsHomeScreen).
import { BASE } from './base.js'
import { api } from './api.js'
import { showBadge } from './appBadge.js'
import { currentEnv } from './install.js'

const seen = new Set()
let primed = false
let pushOn = false

export const supported = () => typeof window !== 'undefined' && 'Notification' in window
export const permission = () => (supported() ? Notification.permission : 'unsupported')
const swOk = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext
// the desktop app (desktop/, Electron) has no push service and does not show a service worker's notifications:
// there the page shows them itself (new Notification) while its window is in the background
const desktopApp = () => typeof document !== 'undefined' && document.documentElement.classList.contains('pgl-desktop')
const pushOk = () => swOk() && 'PushManager' in window && !desktopApp()

// What this page shows in front, for the service worker's question (public/sw.js shownInFront): a push of a room or a chat thread the
// person is looking at right now is not shown. MainView sets it (the open messenger room, the thread in the middle).
let viewing = () => false
export function setViewing(fn) { viewing = typeof fn === 'function' ? fn : () => false }
export const viewingNow = (d) => front() && !!viewing({ room: d?.room || null, thread: d?.thread || null })

// the service worker (scope: the app's own address, /lite/ behind the gateway); a click on a notification
// it showed comes back here as a message (MainView opens it)
export function registerWorker() {
  if (!swOk()) return
  navigator.serviceWorker.register(`${BASE}/sw.js`, { scope: `${BASE}/` }).catch((e) => console.warn('[sw]', e.message))
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'pgl:open-notification') window.dispatchEvent(new CustomEvent('pgl:open-notification', { detail: e.data.detail }))
    if (e.data?.type === 'pgl:viewing?') e.ports?.[0]?.postMessage({ viewing: viewingNow(e.data) })
  })
  // permission given before (another visit): keep the subscription current
  if (permission() === 'granted') subscribePush().catch(() => {})
}

const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
export async function subscribePush() {
  if (!pushOk() || permission() !== 'granted') return false
  const reg = await navigator.serviceWorker.ready
  const { publicKey } = await api('/push/key')
  let sub = await reg.pushManager.getSubscription()
  // a subscription made for another server key (a reinstalled server) cannot be used: made again
  const same = sub && sub.options?.applicationServerKey && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') === publicKey
  if (sub && !same) { await sub.unsubscribe().catch(() => {}); sub = null }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
  await api('/push/subscriptions', { method: 'POST', body: { subscription: sub.toJSON() } })
  pushOn = true
  return true
}

export async function ask() {
  if (!supported()) return 'unsupported'
  let p = Notification.permission
  if (p === 'default') { try { p = await Notification.requestPermission() } catch { p = Notification.permission } }
  if (p === 'granted') await subscribePush().catch((e) => console.warn('[push]', e.message))
  return p
}

const front = () => document.visibilityState === 'visible' && document.hasFocus()

export function titleOf(n) {
  if (n.type === 'chat') return n.from || '새 메시지'
  if (n.type === 'workitem') return `입력이 필요해요 · ${n.title}`
  return n.title || 'process gpt'
}
export function bodyOf(n) {
  if (n.type === 'chat') return String(n.title || n.text || '').slice(0, 160)
  if (n.type === 'workitem') return [n.context, n.process].filter(Boolean).join(' · ').slice(0, 160)
  return String(n.text || n.process || '').slice(0, 160)
}
// a room's notifications share one tag (server lib/pushActions.js roomTag): new messages replace it, and reading the room here clears it
const roomOfUrl = (url) => /^\/chats\?id=([\w.:-]+)/.exec(String(url || ''))?.[1] || null
export const roomTag = (room) => `pgl-room-${room}`
export async function clearRoom(room) {
  if (!room || !swOk()) return
  try {
    const reg = await navigator.serviceWorker.getRegistration(`${BASE}/`)
    for (const n of (await reg?.getNotifications({ tag: roomTag(room) })) || []) n.close()
  } catch { /* nothing shown */ }
}

// 「시험 알림 보내기」: the server pushes one to each of my devices now (POST /api/push/test); this browser not subscribed (no push
// service here — the desktop app, a refusal): the page shows one itself, so the person still sees what a notification looks like.
// → { devices, local }
export async function sendTest() {
  if (pushOk() && permission() === 'granted' && !pushOn) await subscribePush().catch(() => {})
  const r = await api('/push/test', { method: 'POST' }).catch(() => ({ devices: 0 }))
  if (r.devices > 0 && pushOn) return { devices: r.devices, local: false }
  if (permission() !== 'granted') return { devices: r.devices || 0, local: false }
  // (English mode: the page's translator — a system notification is not on the page)
  const tr = (t) => (typeof window !== 'undefined' && window.osI18n?.tr?.(t)) || t
  const opts = { body: tr('이 알림이 보이면 알림이 켜진 거예요'), tag: 'pgl-test', icon: `${BASE}/icons/icon-192.png`, badge: `${BASE}/icons/badge-72.png` }
  try {
    if (swOk() && !desktopApp()) await (await navigator.serviceWorker.ready).showNotification(tr('시험 알림이에요'), opts)
    else new Notification(tr('시험 알림이에요'), opts)
  } catch { /* not allowed here */ }
  return { devices: r.devices || 0, local: true }
}
export const pushReady = () => pushOn

// iPhone · iPad: Web Push only reaches a web app added to the Home Screen, on iOS 16.4 or later — in a Safari tab there is no
// notification at all (the browser has no Notification there). The Home and Settings say so instead of offering a switch.
export function iosNeedsHomeScreen(env = currentEnv()) {
  return env.os === 'ios' && !env.appMode
}

// the installed app's badge: how many Home cards wait — the desktop app's Dock, taskbar and tray (over its bridge), or an installed
// web app's icon (src/appBadge.js)
export function setBadge(n) {
  showBadge(n)
}

// list: the Home's notifications as just loaded; open(n): what clicking does (MainView routes it)
export function announce(list, open) {
  setBadge((list || []).length)
  const fresh = (list || []).filter((n) => n?.id && !seen.has(n.id))
  for (const n of fresh) seen.add(n.id)
  // the first load after opening the app is what was already waiting, not news; with push on, the server
  // sends them (to this device too — showing them here as well would show each twice)
  if (!primed) { primed = true; return [] }
  if (pushOn || permission() !== 'granted' || front()) return []
  const shown = fresh.slice(0, 3)
  for (const n of shown) {
    const room = n.type === 'chat' ? roomOfUrl(n.url) : null
    const opts = { body: bodyOf(n), tag: room ? roomTag(room) : `pgl-${n.id}`, icon: `${BASE}/icons/icon-192.png`, badge: `${BASE}/icons/badge-72.png`,
      data: { id: n.id, type: n.type, url: n.url || null, instId: n.instId || null, place: n.place || null, room } }
    if (swOk() && !desktopApp()) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification(titleOf(n), opts)).catch(() => {})
      continue
    }
    try {
      const x = new Notification(titleOf(n), opts)
      x.onclick = () => { try { x.close() } catch { /* closed */ } window.focus(); open(n) }
    } catch { /* the Home card stays */ }
  }
  return shown
}
