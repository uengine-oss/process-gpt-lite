// A page left open across a deploy keeps running the code it loaded (2026-11-19: a meeting opened before
// the fix showed a found folder PDF the old way, as a folder card, while the server was already new).
// The built page names its entry script (assets/index-<hash>.js); every few minutes and whenever the tab
// comes back, the page reads index.html again and, if the entry changed, says so (App.vue's banner).
// Not in the Vite dev server (no hashed entry; it reloads by itself).
import { ref } from 'vue'
import { BASE } from './base.js'

export const newVersion = ref(false)
const entryOf = (text) => (String(text || '').match(/assets\/index-[A-Za-z0-9_-]+\.js/) || [])[0] || ''

export function watchVersion({ everyMs = 5 * 60_000 } = {}) {
  if (import.meta.env.DEV || typeof document === 'undefined') return
  const mine = entryOf([...document.scripts].map((s) => s.src).join(' '))
  if (!mine) return
  let last = 0
  const check = async () => {
    if (newVersion.value || Date.now() - last < 30_000) return
    last = Date.now()
    try {
      const r = await fetch(`${BASE}/`, { cache: 'no-store', credentials: 'same-origin' })
      const now = r.ok ? entryOf(await r.text()) : ''
      if (now && now !== mine) newVersion.value = true
    } catch { /* offline or the server restarting: next time */ }
  }
  setInterval(check, everyMs)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
}
