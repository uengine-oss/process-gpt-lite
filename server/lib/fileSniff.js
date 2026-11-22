// What a downloaded file is, from its first bytes. A site that names nothing — NotebookLM's audio overview
// arrives as "download" (2026-11-22 phone recording) — left a card with no type, so it had no player and no
// editor. The signatures here are the formats a file card plays or opens in place; anything else keeps the
// name it came with.
import JSZip from 'jszip'

const bytes = (s) => [...s].map((c) => c.charCodeAt(0))
const at = (b, off, sig) => b.length >= off + sig.length && sig.every((x, i) => b[off + i] === x)
const ascii = (b, from, to) => String.fromCharCode(...b.subarray(from, to))

// an Office or HWPX document is a zip: which one, by the part every such file has
const ZIP_PARTS = [['ppt/presentation.xml', 'pptx'], ['word/document.xml', 'docx'], ['xl/workbook.xml', 'xlsx'], ['Contents/content.hpf', 'hwpx']]

/** the extension a file's bytes show, or null when they match none of the formats here */
export async function sniffExt(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || [])
  if (at(b, 0, bytes('%PDF-'))) return 'pdf'
  // ISO media (MP4 family): the brand says audio-only (M4A, M4B) or QuickTime
  if (at(b, 4, bytes('ftyp'))) {
    const brand = ascii(b, 8, 12)
    return brand.startsWith('M4A') || brand.startsWith('M4B') ? 'm4a' : brand.startsWith('qt') ? 'mov' : 'mp4'
  }
  if (at(b, 0, bytes('RIFF')) && at(b, 8, bytes('WAVE'))) return 'wav'
  if (at(b, 0, bytes('RIFF')) && at(b, 8, bytes('WEBP'))) return 'webp'
  if (at(b, 0, bytes('OggS'))) return 'ogg'
  if (at(b, 0, bytes('fLaC'))) return 'flac'
  if (at(b, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm'
  if (at(b, 0, [0x89, 0x50, 0x4e, 0x47])) return 'png'
  if (at(b, 0, [0xff, 0xd8, 0xff])) return 'jpg'
  if (at(b, 0, bytes('GIF8'))) return 'gif'
  // MPEG audio: an ID3 tag, or a Layer III frame header; AAC in ADTS frames
  if (at(b, 0, bytes('ID3')) || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return 'mp3'
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return 'aac'
  if (at(b, 0, [0x50, 0x4b, 0x03, 0x04])) {
    const zip = await JSZip.loadAsync(b).catch(() => null)
    return ZIP_PARTS.find(([part]) => zip?.file(part))?.[1] || 'zip'
  }
  return null
}

/**
 * The name a download is kept under: the site's own, with the extension its bytes show when that name says
 * nothing this app knows (no extension, or one `known` does not take). A known extension stays as the site
 * gave it; the result only ever adds to the name.
 */
export async function nameByContent(name, buf, known) {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext && known(ext)) return name
  const found = await sniffExt(buf)
  return found && found !== ext ? `${name}.${found}` : name
}
