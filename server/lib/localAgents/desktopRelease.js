// The newest desktop app (this repository's GitHub releases, tags desktop-vX.Y.Z), so a page inside an older app can offer the new one —
// the page comes from the server, so even an app from before this offer (0.1.x) shows it. Read in the background and kept for hours:
// a look never waits for GitHub, and when GitHub cannot be reached there is simply no offer.
//   PRO_DESKTOP_LATEST         a fixed version (tests, an install with no way out to GitHub)
//   PRO_DESKTOP_RELEASES_REPO  another repository; 'off' (or empty): no offer
const KEEP_MS = 6 * 3600e3
const RETRY_MS = 10 * 60e3
// at: when GitHub was last asked (never: -Infinity)
let kept = { v: null, at: -Infinity, busy: null }

const parts = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim())
  return m ? m.slice(1).map(Number) : null
}
// a is an older version than b (anything that is not x.y.z: not older)
export function older(a, b) {
  const x = parts(a)
  const y = parts(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}
// the highest desktop-vX.Y.Z among published releases (drafts and pre-releases are not offered)
export function pickLatest(releases) {
  let best = null
  for (const r of Array.isArray(releases) ? releases : []) {
    if (!r || r.draft || r.prerelease) continue
    const m = /^desktop-v(\d+\.\d+\.\d+)$/.exec(String(r.tag_name || ''))
    if (m && (!best || older(best, m[1]))) best = m[1]
  }
  return best
}

export function latestDesktop({ fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const fixed = process.env.PRO_DESKTOP_LATEST
  if (fixed) return parts(fixed) ? parts(fixed).join('.') : null
  const repo = process.env.PRO_DESKTOP_RELEASES_REPO ?? 'uengine-oss/process-gpt-lite'
  if (!repo || repo === 'off' || typeof fetchImpl !== 'function') return null
  if (!kept.busy && now - kept.at > (kept.v ? KEEP_MS : RETRY_MS)) {
    kept.at = now
    kept.busy = (async () => {
      try {
        const r = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'process-gpt-lite' }, signal: AbortSignal.timeout(5000),
        })
        if (r.ok) kept.v = pickLatest(await r.json()) || kept.v
      } catch { /* GitHub out of reach: no offer this time */ } finally { kept.busy = null }
    })()
  }
  return kept.v
}
// (tests) the look on its way, and a fresh start
export const pending = () => kept.busy || Promise.resolve()
export const _reset = () => { kept = { v: null, at: -Infinity, busy: null } }
