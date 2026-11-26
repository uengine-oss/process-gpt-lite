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

// src: {url, name, type?} → {how: 'saved' | 'opened' | 'link', name, href?} — 'link': the browser blocked the new tab, the caller shows href
// to press. Throws (with .status) when the server refused the file — its words, or why in a person's words (src/downloadPlan.js refusal).
export async function saveFile(src, { win = window } = {}) {
  const name = downloadName(src?.name, src?.url, src?.type)
  const plan = downloadPlan(src?.url, { origin: win.location.origin, name })
  if (plan.how === 'none') throw new Error('내려받을 주소가 없어요.')
  const instead = (href) => (openTab(href, win) ? { how: 'opened', name } : { how: 'link', name, href })
  let res
  try { res = await fetch(plan.url, { credentials: plan.credentials, cache: 'no-store' }) } catch { return instead(plan.fallback) }
  if (!res.ok) {
    let words = ''
    try { words = (await res.clone().json())?.error || '' } catch { /* not JSON */ }
    throw Object.assign(new Error(refusal(res.status, typeof words === 'string' ? words : '')), { status: res.status })
  }
  // too large to hold: this server's route saves itself (<a download>, same origin), anything else opens in a tab
  if (Number(res.headers.get('content-length')) > BLOB_MAX) {
    res.body?.cancel?.().catch(() => {})
    if (plan.same) { press(plan.url, name, win.document); return { how: 'saved', name } }
    return instead(plan.fallback)
  }
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  press(href, name, win.document)
  // (Safari reads the blob after the click returns)
  setTimeout(() => URL.revokeObjectURL(href), 60_000)?.unref?.()
  return { how: 'saved', name, size: blob.size }
}
