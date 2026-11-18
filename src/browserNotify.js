// Browser notifications while Lite is in a background tab or another window is in front (2026-11-18:
// "채팅을 걸면 웹브라우저 노티가 들어오는지, 단톡일 때도"). What arrives on the Home cards arrives here too —
// a teammate's message in a 1:1 or group room (process-gpt's chat trigger writes a 'chat' row for every
// participant, whoever sent it from Lite or the ProcessGPT portal), a share or mention, a step waiting for
// me, a meeting's action item, a process started or done. Nothing when the tab is in front: the Home card
// and the messenger's own toast are there. Browsers ask for the permission only from a click (HomeDock).
import { BASE } from './base.js'

const seen = new Set()
let primed = false

export const supported = () => typeof window !== 'undefined' && 'Notification' in window
export const permission = () => (supported() ? Notification.permission : 'unsupported')
export async function ask() {
  if (!supported()) return 'unsupported'
  if (Notification.permission === 'default') { try { return await Notification.requestPermission() } catch { return Notification.permission } }
  return Notification.permission
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

// list: the Home's notifications as just loaded; open(n): what clicking does (MainView routes it)
export function announce(list, open) {
  const fresh = (list || []).filter((n) => n?.id && !seen.has(n.id))
  for (const n of fresh) seen.add(n.id)
  // the first load after opening the app is what was already waiting, not news
  if (!primed) { primed = true; return [] }
  if (permission() !== 'granted' || front()) return []
  const shown = fresh.slice(0, 3)
  for (const n of shown) {
    try {
      const x = new Notification(titleOf(n), { body: bodyOf(n), tag: `pgl-${n.id}`, icon: `${BASE}/favicon.svg` })
      x.onclick = () => { try { x.close() } catch { /* closed */ } window.focus(); open(n) }
    } catch { /* a browser that only allows them from a service worker (Android Chrome): the Home card stays */ }
  }
  return shown
}
