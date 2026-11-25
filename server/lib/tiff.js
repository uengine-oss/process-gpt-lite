// A TIFF (a fax) for the agent: its pages as PNG pictures, so a model that reads pictures can read the fax (2026-11-25 운영: KT 스마트메시지
// Plus 「팩스 메시지 도착알림」의 arrive_….tif — 「tif 파일을 웹에서 못 열어보나?」; spec openspec/specs/chat-media-preview). The page draws a
// TIFF itself (src/tiff.js); the agent gets pictures it can open: a mail's attachment through 「이 첨부로 묻기」 (lib/mailAttachments.js
// agentFile) and a file attached in the chat (lib/attachments.js) — kept private like the attachment (the private bucket, signed addresses,
// or the agent's own workspace), never a public address.
// Decoded in a worker thread of its own, with a time limit and a memory limit: the decoder (UTIF.js, MIT, pure JavaScript — the server image
// has no libtiff, ImageMagick or sharp) loops for ever on some damaged files, and the walk in tiffCore.js refuses what it can see beforehand
// (a loop of directories, a page larger than LIMITS.maxPixels). PNG is written here with node:zlib. Without the decoder installed (an older
// node_modules) a TIFF simply goes to the agent as it is, as before.
import { Worker } from 'node:worker_threads'
import zlib from 'node:zlib'
import { isTiffBytes, TiffError, LIMITS } from './tiffCore.js'
export { isTiffBytes, TiffError, LIMITS }

const TIFF_EXT = new Set(['tif', 'tiff'])
const TIFF_TYPES = new Set(['image/tiff', 'image/tiff-fx', 'image/x-tiff'])
const extOf = (n) => { const s = String(n || '').split('?')[0]; return s.includes('.') ? s.split('.').pop().toLowerCase() : '' }
/** a TIFF by its type or its name (the bytes, when there are some, decide: isTiffBytes) */
export const isTiffName = (name, type = '') => TIFF_TYPES.has(String(type || '').toLowerCase().split(';')[0].trim()) || TIFF_EXT.has(extOf(name))
export const isTiff = ({ name, type, buf } = {}) => (buf?.length ? isTiffBytes(buf) : isTiffName(name, type))

// at most this many pages go to the agent as pictures (a fax is a few; the rest are named)
export const AGENT_PAGES = 20
export const TIMEOUT_MS = 20_000
// the pictures' names beside the file: <stem>-page<n>.png
export const pageName = (name, n) => `${String(name || 'fax').replace(/\.tiff?$/i, '') || 'fax'}-page${n}.png`

// ---------- PNG (pure) ----------
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** RGBA pixels (opaque) → a PNG: greyscale when every pixel is grey (a fax), else RGB */
export function encodePng({ width, height, rgba }) {
  let grey = true
  for (let i = 0; i < rgba.length && grey; i += 4) grey = rgba[i] === rgba[i + 1] && rgba[i] === rgba[i + 2]
  const ch = grey ? 1 : 3
  const stride = width * ch + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    let o = y * stride + 1 // filter 0 (none): a fax's long runs deflate well as they are
    for (let x = 0, s = y * width * 4; x < width; x++, s += 4) {
      if (grey) raw[o++] = rgba[s]
      else { raw[o++] = rgba[s]; raw[o++] = rgba[s + 1]; raw[o++] = rgba[s + 2] }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = grey ? 0 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))])
}

// ---------- the pages ----------
/**
 * A TIFF's pages as PNG pictures → {total, pages: [{png: Buffer, width, height}]} (the first maxPages). Throws TiffError: not_tiff · bigtiff ·
 * broken · too_big · too_many_pages · unsupported · timeout · unavailable (no decoder installed).
 */
export function tiffToPngs(buf, { maxPages = AGENT_PAGES, timeoutMs = TIMEOUT_MS, limits = null } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || [])
  if (!isTiffBytes(b)) return Promise.reject(new TiffError('not_tiff', 'not a TIFF'))
  // the worker gets an ArrayBuffer of its own (the decoder reads tag values from absolute offsets of it)
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.length)
  return new Promise((resolve, reject) => {
    let done = false
    const worker = new Worker(new URL('./tiffWorker.js', import.meta.url), {
      workerData: { buffer: ab, maxPages, limits }, transferList: [ab],
      // (the pixels are typed arrays, bounded by LIMITS; this bounds what a damaged file makes the decoder pile up in plain arrays)
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 48, stackSizeMb: 4 },
    })
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); worker.terminate().catch(() => {}); fn(v) }
    const timer = setTimeout(() => finish(reject, new TiffError('timeout', 'decoding took too long')), timeoutMs)
    worker.once('message', (m) => {
      if (m?.error) return finish(reject, new TiffError(m.error.code || 'broken', m.error.message || 'broken'))
      finish(resolve, { total: m.total, pages: m.pages.map((p) => ({ png: Buffer.from(p.png), width: p.width, height: p.height })) })
    })
    worker.once('error', (e) => finish(reject, new TiffError(e?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'too_big' : 'broken', e?.code || 'the decoder stopped')))
    worker.once('exit', () => finish(reject, new TiffError('broken', 'the decoder stopped')))
  })
}

// what the agent is told when a TIFF could not be made into pictures (it still has the file)
export const reasonOf = (e) => ({
  too_big: ['너무 커서', 'it is too large'], too_many_pages: ['쪽이 너무 많아서', 'it has too many pages'], bigtiff: ['BigTIFF 라서', 'it is a BigTIFF'],
  unsupported: ['이 앱이 그리지 못하는 형식이라', 'its kind is not supported'], timeout: ['그리는 데 너무 오래 걸려서', 'decoding took too long'],
  unavailable: ['이 서버에 TIFF 해독기가 없어서', 'this server has no TIFF decoder'],
}[e?.code] || ['파일이 손상되어', 'the file is damaged'])
