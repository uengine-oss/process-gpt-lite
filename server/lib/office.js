// Documents an agent produced (한글·Word·PowerPoint·Excel·PDF) open in the IeumOffice editor
// (process-gpt office-host, proxied at /office) instead of being downloaded. The editor loads a
// document by URL from Supabase storage and saves the edited copy next to it, so every card needs
// a public storage URL: office-mcp results already carry one; files the agent wrote in its sandbox
// are published to the `files` bucket first.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { admin } from './supa.js'
import { workspaceHostPath } from './missions.js'
import { fetchRoomFile } from './roomStore.js'

// same table as process-gpt's src/utils/officeEditor.js EDITOR_BY_EXT
export const EDITOR_BY_EXT = {
  docx: 'docs', odt: 'docs', xlsx: 'sheets', xlsm: 'sheets', xls: 'sheets', csv: 'sheets', pptx: 'slides',
  pdf: 'pdf', hwp: 'hwp', hwpx: 'hwp', md: 'markdown', markdown: 'markdown', txt: 'markdown',
  html: 'html', htm: 'html', xmind: 'mindmap',
  // ArtCraft web apps (src/craftEditor.js)
  dxf: 'cadcraft', dwg: 'cadcraft',
  svg: 'vectorcraft', vectorcraft: 'vectorcraft',
  psd: 'photocraft', psb: 'photocraft', pcraft: 'photocraft', png: 'photocraft', jpg: 'photocraft', jpeg: 'photocraft', webp: 'photocraft',
  wav: 'soundcraft', mp3: 'soundcraft', flac: 'soundcraft', soundcraft: 'soundcraft', scraftz: 'soundcraft',
  mp4: 'filmcraft', mov: 'filmcraft', webm: 'filmcraft', fcproj: 'filmcraft',
}
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf', hwpx: 'application/hwp+zip', hwp: 'application/x-hwp', csv: 'text/csv',
  md: 'text/markdown; charset=utf-8', markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', xmind: 'application/vnd.xmind.workbook',
  odt: 'application/vnd.oasis.opendocument.text', xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12', xls: 'application/vnd.ms-excel',
  dxf: 'image/vnd.dxf', dwg: 'image/vnd.dwg', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  psd: 'image/vnd.adobe.photoshop', wav: 'audio/wav', mp3: 'audio/mpeg', flac: 'audio/flac', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
}
export const extOf = (name) => String(name || '').split('?')[0].split('.').pop().toLowerCase()
export const editable = (name) => !!EDITOR_BY_EXT[extOf(name)]

// A tool result in any of the shapes deepagents streams it (object, JSON, `content='{…}'`,
// `content=[{'type':'text','text':'{…}'}]`) → the object inside, like process-gpt's parseMcpToolOutput.
export function parseToolOutput(raw) {
  if (raw && typeof raw === 'object') return Array.isArray(raw) ? parseToolOutput(raw[0]?.text ?? raw[0]) : raw
  const s = String(raw || '')
  const tries = [s, s.match(/'text':\s*'(\{.*\})'/s)?.[1], s.match(/"text":\s*"(\{.*\})"/s)?.[1]?.replace(/\\"/g, '"'), s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]
  for (const t of tries) {
    if (!t) continue
    try { const v = JSON.parse(t); if (v && typeof v === 'object') return v } catch { /* next shape */ }
    try { const v = JSON.parse(t.replace(/'/g, '"')); if (v && typeof v === 'object') return v } catch { /* next shape */ }
  }
  return null
}

// office-mcp (generate_hwpx / generate_docx / store_and_render_hwpx) and the IeumOffice MCP both
// answer with {file_url, file_name}.
export function documentFrom(output) {
  const o = parseToolOutput(output)
  const url = o?.file_url || o?.fileUrl
  const name = o?.file_name || o?.fileName || (url ? decodeURIComponent(url.split('?')[0].split('/').pop()) : '')
  return url && editable(name) ? { name: name.replace(/^[0-9a-f-]{36}_/, ''), url, ext: extOf(name) } : null
}

// A sandbox file → a public URL the editor can load. Where the sandbox is not on this machine (the
// agent's pods), the copy deepagents stored for the turn (src, a signed url) or the room folder's.
async function sandboxBytes(sandboxPath, src) {
  const host = await workspaceHostPath(sandboxPath).catch(() => null)
  if (host) return fs.readFile(host)
  if (src) {
    const r = await fetch(src, { signal: AbortSignal.timeout(60_000) }).catch(() => null)
    if (r?.ok) return Buffer.from(await r.arrayBuffer())
  }
  const stored = await fetchRoomFile(sandboxPath)
  if (stored) return stored.buf
  throw new Error(`workspace folder not found: ${sandboxPath}`)
}
export async function publish(userId, sandboxPath, src) {
  const buf = await sandboxBytes(sandboxPath, src)
  const name = path.basename(sandboxPath)
  // storage keys must be ASCII; the name the user sees travels with the card
  const key = `pgpt-pro/${userId}/${crypto.randomUUID()}.${extOf(name)}`
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: MIME[extOf(name)] || 'application/octet-stream', upsert: false })
  if (error) throw error
  return { name, url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, ext: extOf(name) }
}

// Documents the agent wrote with its own scripts (docx/pptx/xlsx skills) never show up as
// file_artifact events: look for them in the paths the answer names and in the run's folder.
const EXT = '(?:docx|odt|pptx|xlsx|xlsm|xls|csv|pdf|hwpx|hwp|markdown|md|txt|html?|xmind|dxf|dwg|svg|vectorcraft|psd|psb|pcraft|png|jpe?g|webp|wav|mp3|flac|soundcraft|scraftz|mp4|mov|webm|fcproj)'
// a quoted path may hold spaces ("/workspace/11월 고객 세미나 예산표.xlsx"); a bare one may not
const QUOTED_RE = new RegExp(`[\`*"'](\\/workspace\\/[^\`*"'\\n]+?\\.${EXT})[\`*"']`, 'g')
const BARE_RE = new RegExp(`\\/workspace\\/[^\\s"'\`)\\]]+?\\.${EXT}\\b`, 'g')
export async function documentsOfRun({ text, dirs, since }) {
  const t = String(text || '')
  // a markdown link carries the path URL-encoded ("견적서%20초안.xlsx"); the file on disk is not
  const decode = (p) => { try { return decodeURIComponent(p) } catch { return p } }
  const found = new Set([...[...t.matchAll(QUOTED_RE)].map((m) => m[1]), ...(t.match(BARE_RE) || [])].map(decode))
  // the top of the tenant workspace, where an agent sometimes saves without a run folder. Every
  // user's runs share it, so a new file there counts only when this answer names it (by file
  // name); otherwise another person's document saved meanwhile would turn up in this chat.
  for (const dir of ['/workspace', ...dirs]) {
    const host = await workspaceHostPath(dir).catch(() => null)
    if (!host) continue
    const walk = async (d, depth) => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name)
        if (e.isDirectory() && dir !== '/workspace' && depth < 2 && !e.name.startsWith('.') && e.name !== 'node_modules') await walk(p, depth + 1)
        else if (e.isFile() && editable(e.name) && (dir !== '/workspace' || t.includes(e.name)) && (await fs.stat(p)).mtimeMs >= since) found.add(path.join(dir, path.relative(host, p)))
      }
    }
    await walk(host, 0)
  }
  // a path the answer only mentions is not a document unless it is on disk
  const real = []
  for (const p of found) if (await workspaceHostPath(p).then((h) => fs.stat(h)).catch(() => null)) real.push(p)
  return real
}

// office-mcp republishes a sandbox document under an ASCII-only name ("edited--_-2026-10-30_…");
// the name the agent gave it is in its answer.
export function displayName(doc, answer) {
  if (!/^edited-|--_|^[0-9a-f]{32}_/.test(doc.name)) return doc.name
  const t = String(answer || '')
  // a quoted name may hold spaces ("**11월 고객 세미나 안내문.hwpx**"); a bare one may not
  const quoted = [...t.matchAll(new RegExp(`[\`*"'](?:[^\`*"'\\n]*\\/)?([^\`*"'\\n/]+\\.${doc.ext})[\`*"']`, 'g'))].map((m) => m[1].trim())
  const bare = [...t.matchAll(new RegExp(`([^\\s*\`/'"()\\[\\]]+\\.${doc.ext})\\b`, 'g'))].map((m) => m[1])
  return [...quoted, ...bare].find((n) => !/^edited-/.test(n)) || doc.name
}
