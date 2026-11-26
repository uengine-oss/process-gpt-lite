// 「내려받기」 — what a download saves and under which name, decided without a browser (tested in server/test/download.test.js).
// src/download.js carries it out and components/DownloadButton.vue is the one button every place a file opens has in its header
// (2026-11-26 사용자: 「파일을 열면 바로 열리는 건 좋은데 다운로드 받을 방법이 없네 …」 — spec openspec/specs/file-download).
//   name     — the name the place shows (Korean as it is, NFC), with the extension of the bytes: added when the name has none (from the
//              address, else the stored type), replaced when the address is another known kind (a 한글 card whose saved copy is .hwpx)
//   address  — every file is fetched by the page and saved from memory (a blob behind <a download>): storage (another origin, open to
//              CORS) ignores <a download> and a phone would open a PDF in place of the app; this server's own routes (folder · workroom ·
//              signed mail and share links) are fetched as they are. Never a public address made for it: the address the place already
//              has, or the one it asks for at the press (a signed one).
//   fallback — when the page cannot fetch it (a network or CORS refusal) or it is too large to hold, the file opens in a new tab
//              instead (storage: with ?download=<name>, so the browser saves it under that name; a phone's share sheet saves it there)

// a file the server says is larger than this is not held in memory (a phone has little to spare): see src/download.js
export const BLOB_MAX = 300 * 1024 * 1024

// file kinds an address may tell (its last path part, or a route's ?path=) — not a storage key's generic 'bin'
const KNOWN = new Set(['docx', 'doc', 'odt', 'rtf', 'xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'pptx', 'ppt', 'pdf', 'hwp', 'hwpx', 'md', 'markdown', 'txt',
  'html', 'htm', 'xmind', 'json', 'xml', 'yaml', 'yml', 'log', 'zip', '7z', 'gz', 'tar', 'eml',
  'png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'psd', 'psb',
  'mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba', 'mp4', 'm4v', 'mov', 'webm', 'ogv',
  'dxf', 'dwg', 'pcraft', 'photocraft', 'vectorcraft', 'soundcraft', 'scraftz', 'filmcraft', 'fcproj'])
// one kind, two spellings: a name's own spelling stays
const SAME = [['jpg', 'jpeg', 'jfif'], ['tif', 'tiff'], ['htm', 'html'], ['md', 'markdown'], ['yml', 'yaml']]
const same = (a, b) => a === b || SAME.some((g) => g.includes(a) && g.includes(b))
// a stored type → the extension a name without one gets
const TYPE_EXT = {
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/json': 'json', 'text/plain': 'txt', 'text/markdown': 'md', 'text/csv': 'csv', 'text/html': 'html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx', 'application/msword': 'doc', 'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt', 'application/x-hwp': 'hwp', 'application/haansofthwp': 'hwp', 'application/vnd.hancom.hwp': 'hwp',
  'application/vnd.hancom.hwpx': 'hwpx', 'application/hwp+zip': 'hwpx',
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/tiff': 'tif',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/webm': 'weba',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/ogg': 'ogv',
}

// a %-escape that is not one (「50%.pdf」 in an address) leaves the text as it is
const safeDecode = (s) => { try { return decodeURIComponent(s) } catch { return s } }
// a name's own extension, when it looks like one ("v1.2 보고서" has none)
export function nameExt(name) {
  const s = String(name || '')
  const dot = s.lastIndexOf('.')
  if (dot <= 0) return ''
  const e = s.slice(dot + 1).toLowerCase()
  return /^[a-z0-9]{1,10}$/.test(e) && /[a-z]/.test(e) ? e : ''
}
// the kind an address tells: its last path part ("…/att/<uuid>.docx", "…/edited-attachment_20261126.xlsx"), else a route's ?path=
// ("/api/folders/x/raw?path=보고서/견적서.hwp"); '' when it tells nothing known
export function addressExt(url) {
  let u
  try { u = new URL(String(url || ''), 'http://x.invalid') } catch { return '' }
  if (u.protocol === 'blob:' || u.protocol === 'data:') return ''
  const last = safeDecode(u.pathname.split('/').pop() || '')
  const e = nameExt(last)
  if (KNOWN.has(e)) return e
  const p = u.searchParams.get('path')
  const pe = p ? nameExt(p.split('/').pop()) : ''
  return KNOWN.has(pe) ? pe : ''
}
// the last part of an address, as a name (when the place shows none)
const addressBase = (url) => {
  try {
    const u = new URL(String(url || ''), 'http://x.invalid')
    const p = u.searchParams.get('path')
    return p ? p.split('/').pop() : safeDecode(u.pathname.split('/').pop() || '')
  } catch { return '' }
}
const typeExt = (type) => TYPE_EXT[String(type || '').toLowerCase().split(';')[0].trim()] || ''

// a long name is cut by its UTF-8 bytes (ext4 and most file systems stop at 255 — a 한글 syllable is 3), whole characters only: never half
// of a surrogate pair or of a grapheme cluster (an emoji with its modifier, a letter with its mark)
export const NAME_MAX_BYTES = 240
const utf8 = new TextEncoder()
const byteLen = (s) => utf8.encode(s).length
const graphemes = (() => {
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  return (s) => (seg ? Array.from(seg.segment(s), (x) => x.segment) : Array.from(s))
})()
function capBytes(s, max) {
  if (byteLen(s) <= max) return s
  let out = ''
  let n = 0
  for (const g of graphemes(s)) { const b = byteLen(g); if (n + b > max) break; out += g; n += b }
  return out
}

// The name the file is saved under: the one the place shows, cleaned only of what no file system takes (/ \ : * ? " < > | → _, control
// and invisible format characters — a right-to-left override, a zero-width space — dropped), Korean kept (NFC: a Mac's decomposed 한글 is
// joined), with the extension of what is saved: a known file kind of the name is replaced when the bytes are another kind; anything else
// after a dot is part of the name (「Q3.final」 + a .docx → 「Q3.final.docx」).
export function downloadName(name, url = '', type = '') {
  let n = String(name || '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\p{Cf}/gu, '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim()
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!n) { const base = addressBase(url); n = (base && downloadName(base, '', '')) || 'download' }
  const own = nameExt(n)
  const known = KNOWN.has(own)
  const real = addressExt(url)
  if (known && real && !same(own, real)) n = `${n.slice(0, n.length - own.length - 1)}.${real}`
  else if (!known) { const e = real || typeExt(type); if (e) n = `${n}.${e}` }
  const e = nameExt(n)
  const tail = KNOWN.has(e) ? `.${e}` : ''
  if (byteLen(n) > NAME_MAX_BYTES) n = `${capBytes(n.slice(0, n.length - tail.length), NAME_MAX_BYTES - byteLen(tail)).trim()}${tail}`
  return n
}

// a storage address (Supabase Storage: public or signed) — it saves under a name of our choosing with ?download=<name>
export const isStorage = (url) => /\/storage\/v1\/object\/(public|sign|authenticated)\//.test(String(url || ''))
export function storageDownloadUrl(url, name) {
  try {
    const u = new URL(url)
    u.searchParams.set('download', name)
    return u.toString()
  } catch { return url }
}

// How a press saves the file at url, from a page at origin:
//   {how: 'fetch', url, credentials, same, fallback} — fetched by the page (blob → <a download>); fallback: what opens in a new tab instead
//   {how: 'none'} — nothing to save from (no address, another scheme)
// A route of this server keeps its own address (its signature, its ?token=); a folder's raw route is asked for an attachment (download=1).
export function downloadPlan(url, { origin = '', name = '' } = {}) {
  const s = String(url || '').trim()
  if (!s) return { how: 'none' }
  let u
  try { u = new URL(s, origin || undefined) } catch { return { how: 'none' } }
  if (u.protocol === 'blob:' || u.protocol === 'data:') return { how: 'fetch', url: s, credentials: 'same-origin', same: true, fallback: s }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { how: 'none' }
  const same = !!origin && u.origin === origin
  if (same && /\/api\/folders\/[^/]+\/raw$/.test(u.pathname) && !u.searchParams.has('download')) u.searchParams.set('download', '1')
  const href = same ? `${u.pathname}${u.search}` : u.toString()
  return { how: 'fetch', url: href, credentials: same ? 'same-origin' : 'omit', same, fallback: isStorage(href) && name ? storageDownloadUrl(href, name) : href }
}

// what the button says after a download (version: which one was saved — the place saved the edits first, or could not)
export function doneNote({ version = 'current', name = '' } = {}) {
  if (version === 'saved') return `방금 저장한 판을 내려받았어요 · ${name}`
  if (version === 'last') return `마지막으로 저장된 판을 내려받았어요 — 방금 고친 내용은 들어 있지 않아요 · ${name}`
  return `내려받았어요 · ${name}`
}
// why a fetch was refused, said for a person (the server's own words when it gave them)
export function refusal(status, serverWords = '') {
  if (serverWords) return serverWords
  if (status === 401) return '주소가 만료됐어요. 다시 열어 주세요.'
  if (status === 403) return '이 파일을 내려받을 권한이 없어요.'
  if (status === 404) return '파일을 찾지 못했어요.'
  return `서버가 파일을 주지 않았어요 (${status}).`
}
