// 다른 앱의 「공유」로 온 것, the browser side (2026-11-26 — rules: src/shareTarget.js, screens: components/ShareArrival.vue).
// The service worker (public/sw.js, its share block) kept what was shared in Cache Storage and opened <base>/chat?share=<id>.
//   stashShare()  main.js, before the router: the id leaves the address (and is kept in localStorage while the person signs in),
//                 with the place this device had open before the share came — the page it lands on must not count as that place
//   readShare(id) the files (File objects, as a file picker gives them) and the words, then the cache entry goes
// `inbox` is what the composers and the folder take from ShareArrival: Messenger.vue (a room's files and words), FolderDetail.vue
// (files into the folder after 「이 폴더에 넣기」), Composer.vue (words taken back when the person puts them somewhere else).
import { reactive } from 'vue'
import { BASE } from './base.js'
import { ID_RE, LIMITS, PENDING_KEY, composeText, fileName, idTime, readLast } from './shareTarget.js'

export const CACHE = 'pgl-share-v1'

export const inbox = reactive({
  forRoom: null,     // {key, room, files: File[], text} — Messenger.vue takes it once that room is open there
  forFolder: null,   // {key, slug, files: File[]} — FolderDetail.vue puts them in (its own upload, its own permission check)
  takeBack: null,    // {key, text} — the files and the words a place got with this share go away (「다른 곳에 넣기」)
})

const store = (win) => { try { return win.localStorage } catch { return null } }

/**
 * ?share=<id> (or ?share=failed from the service worker) → kept with the place open before, and removed from the address.
 * Returns what was kept, or null. Runs before the router reads the address.
 */
export function stashShare(win = window) {
  let u
  try { u = new URL(win.location.href) } catch { return null }
  const id = u.searchParams.get('share')
  // (/folders/<slug>?share=<who asked> is the folder's own 「권한 요청」 — not ours)
  if (id == null || !/\/chat\/?$/.test(u.pathname)) return null
  u.searchParams.delete('share')
  try { win.history.replaceState(win.history.state, '', u.pathname + u.search + u.hash) } catch { /* the address keeps it: harmless */ }
  const s = store(win)
  const kept = { id: ID_RE.test(id) ? id : 'failed', at: Date.now(), last: readLast(s) }
  try { s?.setItem(PENDING_KEY, JSON.stringify(kept)) } catch { /* private window: taken from memory below */ }
  stashed = kept
  return kept
}
let stashed = null

/** The share waiting to be put somewhere (and no longer waiting after this), or null. One older than an hour is dropped. */
export function takePending(win = window, now = Date.now()) {
  const s = store(win)
  let v = stashed
  try { v = JSON.parse(s?.getItem(PENDING_KEY) || 'null') || v } catch { /* keep the one in memory */ }
  try { s?.removeItem(PENDING_KEY) } catch { /* nothing kept */ }
  stashed = null
  if (!v || typeof v.id !== 'string' || !(now - Number(v.at || 0) < 3600_000)) return null
  return v
}
export const hasPending = (win = window) => { if (stashed) return true; try { return !!store(win)?.getItem(PENDING_KEY) } catch { return false } }

const scopeOf = (win) => `${win.location.origin}${BASE}/`

/**
 * What the service worker kept for this id: { files: File[], text, skipped, title, url } — null when it is not there (it never came,
 * it was taken in another window, a day went by). The entry is deleted either way, and anything a day old with it.
 */
export async function readShare(id, win = window) {
  const caches = win.caches
  if (!caches || !ID_RE.test(String(id || ''))) return null
  let cache
  try { cache = await caches.open(CACHE) } catch { return null }
  const base = `${scopeOf(win)}share-target/${id}/`
  try {
    const res = await cache.match(`${base}meta`)
    if (!res) return null
    const meta = await res.json()
    const files = []
    for (const f of (meta.files || []).slice(0, LIMITS.files)) {
      const r = await cache.match(`${base}${f.n}`)
      if (!r) continue
      const blob = await r.blob()
      files.push(new File([blob], fileName(f.name, f.n, f.type), { type: f.type || blob.type || '' }))
    }
    return { files, text: composeText(meta), title: meta.title || '', url: meta.url || '', skipped: Array.isArray(meta.skipped) ? meta.skipped : [] }
  } catch { return null } finally { await sweep(win, id).catch(() => {}) }
}

/** Deletes this share's entries (id) and every share's older than a day. */
export async function sweep(win = window, id = '') {
  const cache = await win.caches?.open(CACHE)
  if (!cache) return
  const now = Date.now(), prefix = `${scopeOf(win)}share-target/`
  for (const r of await cache.keys()) {
    if (!r.url.startsWith(prefix)) continue
    const rid = r.url.slice(prefix.length).split('/')[0]
    if (rid === id || !(now - idTime(rid) < LIMITS.keepMs)) await cache.delete(r)
  }
}
