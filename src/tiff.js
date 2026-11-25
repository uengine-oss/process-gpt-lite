// TIFF pictures in the page — a fax above all (2026-11-25 운영: 메일 「[KT 스마트메시지 Plus] 팩스 메시지 도착알림」의 arrive_….tif 칩이 FILE ·
// 「앱 안에서 열지 않는 형식이에요 · 내려받기」뿐이었다 — 「tif 파일을 웹에서 못 열어보나?」). Browsers other than Safari do not draw TIFF, so the
// app decodes it itself: in a worker (src/tiffWorker.js — UTIF.js, MIT, with CCITT G3/G4 · LZW · PackBits · Deflate · uncompressed) that is
// only loaded the first time a TIFF is shown, one page at a time, drawn on a canvas (components/TiffView.vue: the viewer, a chat or
// messenger thumbnail, a folder's preview). Nothing runs as code from the file; a page larger than LIMITS.maxPixels is refused before it
// is decoded, and a page that takes longer than PAGE_MS stops the worker (TiffError code 'timeout').
import { TiffError } from './tiffCore.js'

export const PAGE_MS = 15_000
export const MAX_BYTES = 60 * 1024 * 1024
const KEEP = 6

let worker = null
let gen = 0
let seq = 0
const waiting = new Map() // id → {resolve, reject, timer}
function stopAll(code) {
  worker?.terminate(); worker = null; gen++
  for (const [id, w] of waiting) { clearTimeout(w.timer); w.reject(new TiffError(code)); waiting.delete(id) }
  docs.clear()
}
function theWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./tiffWorker.js', import.meta.url), { type: 'module' })
  worker.onmessage = (e) => {
    const w = waiting.get(e.data?.id)
    if (!w) return
    waiting.delete(e.data.id); clearTimeout(w.timer)
    if (e.data.error) w.reject(new TiffError(e.data.error.code || 'broken', e.data.error.message))
    else w.resolve(e.data)
  }
  worker.onerror = () => stopAll('broken')
  return worker
}
function call(msg, transfer = []) {
  const w = theWorker()
  const id = ++seq
  return new Promise((resolve, reject) => {
    // (the decoder cannot be interrupted: the worker goes, with every file it had open)
    const timer = setTimeout(() => { if (waiting.has(id)) stopAll('timeout') }, PAGE_MS)
    waiting.set(id, { resolve, reject, timer })
    w.postMessage({ id, ...msg }, transfer)
  })
}

// opened files by address: a thumbnail and the viewer of the same file share one (the newest few are kept)
const docs = new Map() // url → Promise<doc>
async function fetchBytes(url) {
  const r = await fetch(url, { credentials: 'same-origin' })
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, fetch: true })
  if (Number(r.headers.get('content-length')) > MAX_BYTES) throw new TiffError('too_big', 'file too large')
  const buf = await r.arrayBuffer()
  if (buf.byteLength > MAX_BYTES) throw new TiffError('too_big', 'file too large')
  return buf
}
/**
 * The TIFF at `url` → {pages: [{width, height}], page(i, {maxWidth}) → Promise<{width, height, rgba}>}. Rejects with a TiffError (the file
 * is not one the app can show: its code says why) or an Error with `fetch: true` (the address did not answer — an expired signed address).
 */
export function openTiff(url) {
  const key = String(url || '')
  if (docs.has(key)) { const d = docs.get(key); docs.delete(key); docs.set(key, d); return d }
  const job = (async () => {
    const buffer = await fetchBytes(key)
    const id = `d${++seq}`
    const g = gen
    const { pages } = await call({ op: 'open', doc: id, buffer }, [buffer])
    return {
      pages,
      page: (i, { maxWidth = 0 } = {}) => (g !== gen ? Promise.reject(new TiffError('timeout')) : call({ op: 'page', doc: id, page: i, maxWidth }).then(({ width, height, rgba }) => ({ width, height, rgba }))),
      close: () => (g === gen ? call({ op: 'close', doc: id }).catch(() => {}) : null),
    }
  })()
  docs.set(key, job)
  // a file that could not be opened is not kept (a new address, or the same one later, tries again)
  job.catch(() => { if (docs.get(key) === job) docs.delete(key) })
  while (docs.size > KEEP) {
    const [old, d] = docs.entries().next().value
    docs.delete(old)
    d.then((x) => x.close()).catch(() => {})
  }
  return job
}

/** a decoded page drawn on a canvas at its own size (CSS decides how large it shows) */
export function draw(canvas, { width, height, rgba }) {
  canvas.width = width; canvas.height = height
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0)
}
