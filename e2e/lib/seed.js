// Seeding and cleanup helpers that know where pgpt-pro keeps things.
import fs from 'node:fs/promises'
import path from 'node:path'
import * as db from './db.js'

// a shared folder: its row (cascades members/variations/files), its git repository, checkouts and
// integration worktrees (only paths under a pgpt-folders root are removed)
export async function removeFolder(_db, slug) {
  if (!slug || !(await db.available())) return
  const [f] = await db.q('select id, repo_path from pro_folders where slug=$1', [slug])
  if (!f) return
  const trees = await db.q('select worktree_path from pro_folder_variations where folder_id=$1 and worktree_path is not null', [f.id])
  const ints = await db.q('select worktree_path from pro_folder_integrations where folder_id=$1 and worktree_path is not null', [f.id]).catch(() => [])
  for (const v of [...trees, ...ints]) await fs.rm(v.worktree_path, { recursive: true, force: true }).catch(() => {})
  await db.q('delete from pro_panel_apps where folder_id=$1', [f.id]).catch(() => {})
  await db.q('delete from pro_folders where id=$1', [f.id])
  if (f.repo_path && /pgpt-folders/.test(f.repo_path)) {
    await fs.rm(f.repo_path, { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(path.dirname(f.repo_path), '.integrate', path.basename(f.repo_path)), { recursive: true, force: true }).catch(() => {})
  }
}

// small real images/sounds/drawings — enough for each editor to open a document
import zlib from 'node:zlib'
function crc32(buf) {
  let c, crc = 0xffffffff
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c }
  return (crc ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]) }
export function PNG(w = 160, h = 90, [r, g, b] = [31, 111, 209]) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = (g + y) & 255; raw[o + 2] = b }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
export const PNG_1PX = PNG()
export const SVG = (label) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120"><rect width="320" height="120" fill="#1f6fd1"/><text x="20" y="70" font-size="32" fill="#fff">${label}</text></svg>`)
export const DXF = Buffer.from(['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1000', '21', '0', '31', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\n'))
export function WAV(seconds = 0.5, hz = 880) {
  const rate = 16000, n = Math.floor(rate * seconds)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34)
  b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), 44 + i * 2)
  return b
}
export async function XLSX(rows = [['이름', '값'], ['가', 1], ['나', 2]]) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Sheet1')
  for (const r of rows) ws.addRow(r)
  return Buffer.from(await wb.xlsx.writeBuffer())
}
export const MIME = { mp4: 'video/mp4', png: 'image/png', svg: 'image/svg+xml', dxf: 'image/vnd.dxf', wav: 'audio/wav', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', md: 'text/markdown' }

// a short H.264 clip (ffmpeg on PATH), or null
export async function MP4(seconds = 2) {
  const { execFileSync } = await import('node:child_process')
  const os = await import('node:os')
  const out = path.join(os.tmpdir(), `rt-${process.pid}-${Date.now()}.mp4`)
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=15:duration=${seconds}`, '-pix_fmt', 'yuv420p', '-c:v', 'libx264', out])
    const b = await fs.readFile(out); await fs.rm(out, { force: true }); return b
  } catch { return null }
}

// a process instance a test started: hidden, its open work items cancelled and their cards checked,
// so nobody's Home keeps a card from a test run
export async function retireInstance(instId) {
  if (!instId || !(await db.available())) return
  await db.q(`update notifications set is_checked=true where url in (select '/todolist/'||id::text from todolist where proc_inst_id=$1)`, [instId])
  await db.q(`update todolist set status='CANCELLED' where proc_inst_id=$1 and status in ('NEW','TODO','IN_PROGRESS','PENDING')`, [instId])
  await db.q('update bpm_proc_inst set is_deleted=true where proc_inst_id=$1', [instId])
}
