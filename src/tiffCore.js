// TIFF, faxes included (2026-11-25 운영: KT 스마트메시지 Plus 「팩스 메시지 도착알림」의 첨부 arrive_….tif 가 「앱 안에서 열지 않는 형식이에요 ·
// 내려받기」뿐이었다 — 「tif 파일을 웹에서 못 열어보나?」). Safari 밖의 브라우저는 TIFF 를 그리지 않고, 팩스는 여러 쪽에 CCITT G3/G4 흑백이다.
// The part the page (src/tiffWorker.js) and the server (server/lib/tiffWorker.js) share, without a browser or a file system:
//   · what a file's first bytes say (isTiffBytes),
//   · a walk through its directories (scanTiff) that refuses what would make the decoder (UTIF.js, MIT — passed in, never imported here)
//     loop or run out of memory before a single pixel is decoded: a directory pointing back at itself, a tag of a billion values, a page
//     larger than LIMITS.maxPixels (refused with code 'too_big' — the page says it calmly, nothing is decoded),
//   · one page as RGBA pixels (decodePage), its resolution evened out — a standard fax is 204 × 98 dpi, so drawn pixel for pixel it is
//     squashed to half its height — and, for a thumbnail, made small with area averaging (thin black strokes stay readable).
// Both run in a worker with a time limit (a damaged LZW strip makes the decoder loop for ever): this file only decides.
// The same file is kept at server/lib/tiffCore.js (the server's image has no src/): server/test/tiff.test.js checks they stay identical.

export const LIMITS = Object.freeze({
  maxPixels: 4096 * 4096,         // one page as shown (after evening out its resolution): what every browser's canvas still draws
  maxSampleBytes: 64 * 1024 * 1024, // one page's decoded samples before they become RGBA
  maxPages: 200,
  maxValues: 1 << 20,             // numbers in one tag (the strip offsets of a tall page are a few thousand)
  maxTotalValues: 1 << 22,        // numbers in all tags of the file
  maxDepth: 4,                    // directories inside directories (EXIF, SubIFDs, a maker's note)
})

export class TiffError extends Error {
  // code: not_tiff · bigtiff · broken · too_big · too_many_pages · unsupported · timeout
  constructor(code, message) { super(message || code); this.name = 'TiffError'; this.code = code }
}

const at = (b, sig) => b.length >= sig.length && sig.every((x, i) => b[i] === x)
/** the first bytes of a classic TIFF: II*\0 (Intel) or MM\0* (Motorola) */
export const isTiffBytes = (b) => !!b && (at(b, [0x49, 0x49, 0x2a, 0x00]) || at(b, [0x4d, 0x4d, 0x00, 0x2a]))
// BigTIFF (64-bit offsets) is not read by the decoder: said, not guessed at
const isBigTiff = (b) => at(b, [0x49, 0x49, 0x2b, 0x00]) || at(b, [0x4d, 0x4d, 0x00, 0x2b])

// the field types the decoder reads, with the size of one value; others it skips
const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }
// how many values the decoder still takes from the entry itself (no offset): its own rule, not the standard's
const INLINE = { 1: 5, 2: 5, 7: 5, 3: 3, 8: 3, 4: 2, 9: 2 }
const NESTED = new Set([330, 34665]) // SubIFDs, EXIF: directories the decoder follows
const PHOTOMETRIC = new Set([0, 1, 2, 3, 5, 6])

// (past the end of the file a read is 0, as the decoder's own reads are)
function reader(b, le) {
  const u16 = (p) => (p + 2 <= b.length ? (le ? b[p] | (b[p + 1] << 8) : (b[p] << 8) | b[p + 1]) : 0)
  const u32 = (p) => (p + 4 <= b.length ? (le ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16)) + b[p + 3] * 2 ** 24 : b[p] * 2 ** 24 + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3])) : 0)
  return { u16, u32, le }
}
const scanLe = (r) => r.le

/**
 * The pages of a TIFF and what each is, read without decoding anything → {le, pages: [{offset, width, height, shownWidth, shownHeight,
 * compression, photometric, bits, samples}]}. Throws TiffError: not_tiff · bigtiff · broken · too_big · too_many_pages · unsupported.
 */
export function scanTiff(bytes, limits = LIMITS) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (isBigTiff(b)) throw new TiffError('bigtiff', 'BigTIFF is not supported')
  if (!isTiffBytes(b) || b.length < 8) throw new TiffError('not_tiff', 'not a TIFF')
  const pages = []
  const budget = { values: 0 }
  const seen = new Set()
  const le = b[0] === 0x49
  const r = reader(b, le)
  // the chain of top-level directories: each one a page (unless it is a reduced copy of another), a loop refused
  let off = r.u32(4)
  for (let n = 0; off !== 0; n++) {
    // (reduced copies count too: a chain twice as long as the pages allowed is refused)
    if (n >= limits.maxPages * 2) throw new TiffError('too_many_pages', `more than ${limits.maxPages} pages`)
    if (seen.has(off)) throw new TiffError('broken', 'a directory points back at an earlier one')
    if (off < 8 || off + 2 > b.length) {
      if (n === 0) throw new TiffError('broken', 'the first directory is outside the file')
      break // a chain that runs past the end of the file ends there
    }
    const ifd = readDir(b, r, off, 0, seen, budget, limits)
    if (ifd.tags[256] && ifd.tags[257] && !(ifd.tags[254] & 1)) pages.push(pageOf(ifd, off, limits))
    if (pages.length > limits.maxPages) throw new TiffError('too_many_pages', `more than ${limits.maxPages} pages`)
    off = ifd.next
  }
  if (!pages.length) throw new TiffError('broken', 'no page in it')
  return { le, pages }
}

// one directory, checked the way the decoder will read it (UTIF._readIFD) → {tags: {tag: first value}, values: {tag: [...]}, next}
function readDir(b, r, off, depth, seen, budget, limits) {
  if (depth > limits.maxDepth) throw new TiffError('broken', 'directories nested too deep')
  seen.add(off)
  const cnt = r.u16(off)
  const end = off + 2 + cnt * 12
  if (end > b.length) throw new TiffError('broken', 'a directory runs past the end of the file')
  const tags = {}, values = {}
  for (let i = 0; i < cnt; i++) {
    const e = off + 2 + i * 12
    const tag = r.u16(e), type = r.u16(e + 2), num = r.u32(e + 4), voff = r.u32(e + 8)
    const size = SIZE[type]
    if (!size) continue
    if (num > limits.maxValues) throw new TiffError('broken', `tag ${tag} has too many values`)
    budget.values += num
    if (budget.values > limits.maxTotalValues) throw new TiffError('broken', 'too many values')
    const inline = num < (INLINE[type] || 0)
    const start = inline ? e + 8 : voff
    // (a single float is inline by the standard, yet read from its offset by the decoder: harmless, so not refused)
    if (!inline && !(type === 11 && num === 1) && start + num * size > b.length) throw new TiffError('broken', `tag ${tag} points outside the file`)
    // the numbers this file's pages are made of (sizes, compression, strips' offsets for nested directories)
    if ([3, 4, 8, 9].includes(type) && (num <= 4 || NESTED.has(tag))) {
      const v = []
      for (let j = 0; j < num; j++) v.push(type === 3 || type === 8 ? r.u16(start + 2 * j) : r.u32(start + 4 * j))
      values[tag] = v
      tags[tag] = v[0]
    } else if (type === 5) {
      const d = r.u32(start + 4)
      tags[tag] = d ? r.u32(start) / d : 0
    } else if (num === 0) tags[tag] = undefined
    else tags[tag] = tags[tag] ?? true
    // directories the decoder opens from here: checked the same way (and never one already seen)
    if (NESTED.has(tag) && (type === 1 || type === 7)) throw new TiffError('unsupported', `tag ${tag} of an unexpected type`)
    if (NESTED.has(tag) && values[tag]) {
      for (const p of values[tag]) {
        if (seen.has(p)) throw new TiffError('broken', 'a directory points back at an earlier one')
        if (p >= 8 && p + 2 <= b.length) readDir(b, r, p, depth + 1, seen, budget, limits)
      }
    }
    if (tag === 50740) {
      // DNG private data: the decoder follows its first four bytes as a directory when what is there looks like one
      if (type !== 1 && type !== 7) throw new TiffError('unsupported', 'DNG private data of an unexpected type')
      const q = [0, 1, 2, 3].map((k) => (k < num ? b[start + k] : 0))
      const p = scanLe(r) ? q[0] + q[1] * 256 + q[2] * 65536 + q[3] * 2 ** 24 : q[3] + q[2] * 256 + q[1] * 65536 + q[0] * 2 ** 24
      if (r.u16(p) < 300) {
        if (seen.has(p)) throw new TiffError('broken', 'a directory points back at an earlier one')
        if (p >= 8 && p + 2 <= b.length) readDir(b, r, p, depth + 1, seen, budget, limits)
      }
    }
    if (tag === 37500) {
      // a camera maker's note: Nikon's is a whole TIFF of its own (the decoder reads it from its 11th byte), others a directory
      const nikon = (type === 1 || type === 7) && num >= 5 && b[start] === 0x4e && b[start + 1] === 0x69 && b[start + 2] === 0x6b && b[start + 3] === 0x6f && b[start + 4] === 0x6e
      if (nikon) {
        if (num > 10) nestedTiff(b.subarray(start + 10, start + num), depth + 1, budget, limits)
      } else if (r.u16(voff) < 300) {
        if (seen.has(voff)) throw new TiffError('broken', 'a directory points back at an earlier one')
        if (voff >= 8 && voff + 2 <= b.length) readDir(b, r, voff, depth + 1, seen, budget, limits)
      }
    }
  }
  return { tags, values, next: end + 4 <= b.length ? r.u32(end) : 0 }
}
// a TIFF inside a maker's note, read the way the decoder reads a whole file (UTIF.decode): its own chain, no loop
function nestedTiff(b, depth, budget, limits) {
  if (depth > limits.maxDepth) throw new TiffError('broken', 'directories nested too deep')
  const r = reader(b, b[0] === 0x49 && b[1] === 0x49)
  const seen = new Set()
  let off = r.u32(4)
  for (let n = 0; off !== 0 && n < limits.maxPages; n++) {
    if (seen.has(off)) throw new TiffError('broken', 'a directory points back at an earlier one')
    if (off + 2 > b.length) return
    off = readDir(b, r, off, depth, seen, budget, limits).next
  }
  if (off !== 0) throw new TiffError('broken', 'too many directories')
}

// a page's size as shown: a resolution that differs across and down (a standard fax: 204 × 98 dpi) is evened out
export function shownSize(width, height, xres, yres) {
  const ratio = xres > 0 && yres > 0 && Number.isFinite(xres / yres) ? xres / yres : 1
  if (ratio > 1.05 && ratio < 8) return { width, height: Math.round(height * ratio) }
  if (ratio < 1 / 1.05 && ratio > 1 / 8) return { width: Math.round(width / ratio), height }
  return { width, height }
}
function pageOf(ifd, offset, limits) {
  const t = ifd.tags
  const width = Number(t[256]) || 0, height = Number(t[257]) || 0
  const bitsList = ifd.values[258] || [Number(t[258]) || 1]
  const samples = Number(t[277]) || bitsList.length || 1
  const bits = Math.min(32, Number(bitsList[0]) || 1) * Math.max(samples, bitsList.length)
  const photometric = t[262] == null ? 2 : Number(t[262])
  if (!width || !height) throw new TiffError('broken', 'a page without a size')
  const shown = shownSize(width, height, Number(t[282]) || 0, Number(t[283]) || 0)
  if (width * height > limits.maxPixels || shown.width * shown.height > limits.maxPixels) throw new TiffError('too_big', `a page of ${width} × ${height} pixels`)
  if (Math.ceil((width * bits) / 8) * height > limits.maxSampleBytes) throw new TiffError('too_big', 'a page too large to decode')
  if (!PHOTOMETRIC.has(photometric)) throw new TiffError('unsupported', `photometric ${photometric}`)
  return { offset, width, height, shownWidth: shown.width, shownHeight: shown.height, compression: Number(t[259]) || 1, photometric, bits, samples }
}

/**
 * Page `page` of the scan, decoded with UTIF (passed in) → {width, height, rgba: Uint8ClampedArray} as shown: its resolution evened out,
 * transparent parts on white paper, and no wider than maxWidth when one is given (a thumbnail). buffer: the whole file as an ArrayBuffer
 * of its own (the decoder reads tag values from absolute offsets of it).
 */
export function decodePage(UTIF, buffer, scan, page, { maxWidth = 0 } = {}) {
  const p = scan.pages[page]
  if (!p) throw new TiffError('broken', 'no such page')
  const data = new Uint8Array(buffer)
  // one directory only (the walk above already checked every one the decoder will open from it)
  UTIF.decode._decodeG3.allow2D = null
  const ifds = []
  UTIF._readIFD(scan.le ? UTIF._binLE : UTIF._binBE, data, p.offset, ifds, 0, false)
  const ifd = ifds[0]
  UTIF.decodeImage(buffer, ifd, ifds)
  if (!ifd.data || ifd.width !== p.width || ifd.height !== p.height) throw new TiffError('broken', 'the page could not be decoded')
  const rgba = UTIF.toRGBA8(ifd)
  if (!rgba || rgba.length !== p.width * p.height * 4) throw new TiffError('broken', 'the page could not be decoded')
  onWhite(rgba)
  let w = p.width, h = p.height, px = rgba
  const sw = p.shownWidth, sh = p.shownHeight
  if (maxWidth > 0 && sw > maxWidth) {
    const tw = Math.max(1, Math.round(maxWidth)), th = Math.max(1, Math.round((sh * tw) / sw))
    px = shrink(px, w, h, tw, th); w = tw; h = th
  } else if (sw !== w || sh !== h) {
    px = stretch(px, w, h, sw, sh); w = sw; h = sh
  }
  return { width: w, height: h, rgba: px instanceof Uint8ClampedArray ? px : new Uint8ClampedArray(px.buffer, px.byteOffset, px.length) }
}

// transparent parts (an extra alpha sample, an unknown colour model) shown on white paper, as the page would print
function onWhite(px) {
  for (let i = 3; i < px.length; i += 4) {
    const a = px[i]
    if (a === 255) continue
    const k = a / 255
    px[i - 3] = Math.round(px[i - 3] * k + 255 * (1 - k)); px[i - 2] = Math.round(px[i - 2] * k + 255 * (1 - k)); px[i - 1] = Math.round(px[i - 1] * k + 255 * (1 - k))
    px[i] = 255
  }
}
// to a larger size, each pixel repeated (evening out a fax's resolution: every row twice)
function stretch(src, w, h, tw, th) {
  const out = new Uint8ClampedArray(tw * th * 4)
  const s32 = new Uint32Array(src.buffer, src.byteOffset, w * h), o32 = new Uint32Array(out.buffer)
  const xs = new Uint32Array(tw)
  for (let x = 0; x < tw; x++) xs[x] = Math.min(w - 1, Math.floor((x * w) / tw))
  for (let y = 0; y < th; y++) {
    const row = Math.min(h - 1, Math.floor((y * h) / th)) * w, o = y * tw
    for (let x = 0; x < tw; x++) o32[o + x] = s32[row + xs[x]]
  }
  return out
}
// to a smaller size by area averaging, across first (a tall page shrinks to a few hundred columns before its rows are combined)
function weights(n, tn) {
  const scale = n / tn, list = []
  for (let i = 0; i < tn; i++) {
    const a = i * scale, z = a + scale, ws = []
    for (let s = Math.floor(a); s < Math.min(n, Math.ceil(z)); s++) {
      const wgt = Math.min(z, s + 1) - Math.max(a, s)
      if (wgt > 0) ws.push(s, wgt / scale)
    }
    list.push(ws)
  }
  return list
}
function shrink(src, w, h, tw, th) {
  const wx = weights(w, tw), wy = weights(h, th)
  const mid = new Float32Array(tw * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < tw; x++) {
      const ws = wx[x], o = (y * tw + x) * 4
      for (let k = 0; k < ws.length; k += 2) {
        const s = (y * w + ws[k]) * 4, f = ws[k + 1]
        mid[o] += src[s] * f; mid[o + 1] += src[s + 1] * f; mid[o + 2] += src[s + 2] * f; mid[o + 3] += src[s + 3] * f
      }
    }
  }
  const out = new Uint8ClampedArray(tw * th * 4)
  for (let y = 0; y < th; y++) {
    const ws = wy[y]
    for (let x = 0; x < tw; x++) {
      const o = (y * tw + x) * 4
      let r = 0, g = 0, bl = 0, a = 0
      for (let k = 0; k < ws.length; k += 2) {
        const s = (ws[k] * tw + x) * 4, f = ws[k + 1]
        r += mid[s] * f; g += mid[s + 1] * f; bl += mid[s + 2] * f; a += mid[s + 3] * f
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a
    }
  }
  return out
}

// what the page says when a TIFF cannot be shown (TiffError.code); the person can still download it
export const TIFF_REASON = {
  too_big: '너무 큰 TIFF 예요',
  too_many_pages: '쪽이 너무 많은 TIFF 예요',
  bigtiff: 'BigTIFF 형식이에요',
  unsupported: '이 앱이 그리지 못하는 TIFF 예요',
  timeout: '그리는 데 너무 오래 걸려요',
}
