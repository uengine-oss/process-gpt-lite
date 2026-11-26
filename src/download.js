// 「내려받기」 carried out in the browser (the decisions: src/downloadPlan.js; the button: components/DownloadButton.vue; spec file-download).
// The page fetches the file from the address it already has (or the signed one asked for at the press) and saves it from memory under the
// name the place shows: <a download> works for a blob on every browser — desktop, Android Chrome, iOS Safari 13+ (Files › 다운로드), and the
// desktop app (its will-download puts it in Downloads, desktop/src/main.js). Storage on another origin answers with CORS; a route of this
// server keeps its signature or ?token= in the address. When the page cannot fetch it (a network or CORS refusal) or it is too large to
// hold, it opens in a new tab instead — storage with ?download=<name> (saved under that name), elsewhere the share sheet saves it.
import { downloadName, downloadPlan, refusal, BLOB_MAX } from './downloadPlan.js'

// a link pressed for the person (no new tab: <a download> saves where it is)
function press(href, name, doc = document) {
  const a = doc.createElement('a')
  a.href = href
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  doc.body.appendChild(a)
  a.click()
  setTimeout(() => a.remove(), 0)
}
// a new tab with the file; null when the browser blocked it (after a wait a window may be refused without a word)
function openTab(href, win = window) {
  const w = win.open('', '_blank')
  if (!w) return false
  try { w.opener = null } catch { /* closed */ }
  w.location.href = href
  return true
}

// the body, counted as it comes: null when it passes the limit (a chunked or compressed answer says no size up front)
async function readCapped(res, max) {
  const reader = res.body?.getReader?.()
  if (!reader) { const b = await res.blob(); return b.size > max ? null : b }
  const parts = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.byteLength
    if (n > max) { reader.cancel().catch(() => {}); return null }
    parts.push(value)
  }
  return new Blob(parts, { type: res.headers.get('content-type') || '' })
}

// src: {url, name, type?} → {how: 'saved' | 'opened' | 'link', name, href?} — 'link': the browser blocked the new tab, the caller shows href
// to press. Throws (with .status) when the server refused the file — this server's own words, or why in a person's words (another
// origin's — storage's 「InvalidJWT」 — are not shown: src/downloadPlan.js refusal). max: how much is held in memory (BLOB_MAX).
export async function saveFile(src, { win = window, max = BLOB_MAX } = {}) {
  const name = downloadName(src?.name, src?.url, src?.type)
  const plan = downloadPlan(src?.url, { origin: win.location.origin, name })
  if (plan.how === 'none') throw new Error('내려받을 주소가 없어요.')
  const instead = (href) => (openTab(href, win) ? { how: 'opened', name } : { how: 'link', name, href })
  let res
  try { res = await fetch(plan.url, { credentials: plan.credentials, cache: 'no-store' }) } catch { return instead(plan.fallback) }
  if (!res.ok) {
    let words = ''
    if (plan.same) try { words = (await res.clone().json())?.error || '' } catch { /* not JSON */ }
    throw Object.assign(new Error(refusal(res.status, typeof words === 'string' ? words : '')), { status: res.status })
  }
  // too large to hold: this server's route saves itself (<a download>, same origin), anything else opens in a tab
  const tooLarge = () => {
    if (plan.same) { press(plan.url, name, win.document); return { how: 'saved', name } }
    return instead(plan.fallback)
  }
  if (Number(res.headers.get('content-length')) > max) { res.body?.cancel?.().catch(() => {}); return tooLarge() }
  let blob
  try { blob = await readCapped(res, max) } catch { return instead(plan.fallback) }
  if (!blob) return tooLarge()
  const href = URL.createObjectURL(blob)
  press(href, name, win.document)
  // (Safari reads the blob after the click returns)
  setTimeout(() => URL.revokeObjectURL(href), 60_000)?.unref?.()
  return { how: 'saved', name, size: blob.size }
}
