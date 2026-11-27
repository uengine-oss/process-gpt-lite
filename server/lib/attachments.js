// Files a person attaches in chat, passed on the way ProcessGPT's own chat does: kept in the `files`
// storage bucket (a URL for the card and the document editor), and when the message is sent
// handed to memento's /save-to-storage for that conversation (room_id), whose file_path goes in the
// chat request's `files` — deepagents reads them as the room's knowledge documents. The agent
// runs on other machines than this server (several pods), so nothing relies on a shared disk;
// where the workspace is on this machine (local, Docker bundle) the file is also put there.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { admin } from './supa.js'
import { workspaceHostPath } from './missions.js'
import { PGPT_ROOT } from './paths.js'
import { L } from './lang.js'
import * as P from './privateStore.js'
import { isTiffBytes, tiffToPngs, pageName, reasonOf, AGENT_PAGES } from './tiff.js'

const MAX = 50 * 1024 * 1024
// memento's chat attachment policy (ingest.py save_to_storage, room_id set): other types are kept
// in storage and passed by address only
const INDEXED = new Set(['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'pptx', 'txt', 'xlsx'])

// "../../x.pdf", "a/b.txt" → a plain file name; nothing outside the upload folder
function safeName(raw) {
  const n = path.basename(String(raw || 'file')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim()
  return n && n !== '.' && n !== '..' ? n.slice(0, 160) : 'file'
}

// pages: a TIFF's pages as pictures for the agent (the AI chat's attachments — POST /api/attachments; a file sent in the messenger is not
// given to an agent from here)
export async function saveAttachment(user, rawName, type, buf, { pages = false } = {}) {
  if (!buf?.length) throw Object.assign(new Error('empty'), { status: 400 })
  if (buf.length > MAX) throw Object.assign(new Error('too large'), { status: 413 })
  const name = safeName(rawName)
  const id = crypto.randomUUID()
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'bin'
  // storage keys must be ASCII; the name the user sees travels with the card
  const key = `pgpt-pro/${user.id}/att/${id}.${ext.replace(/[^a-z0-9]/g, '') || 'bin'}`
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: type || 'application/octet-stream', upsert: false })
  if (error) throw error
  const out = { name, size: buf.length, type: type || '', key, url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}` }
  const rel = `/workspace/uploads/${user.id}/${id}/${name}`
  const root = await workspaceHostPath('/workspace').catch(() => null)
  let host = null
  if (root) {
    // deepagents keeps one workspace per tenant (its /workspace is <root>/<tenant>): a tenant whose first run has not made it yet
    // would get the file in the shared root, where its sandbox never looks
    const shared = path.join(PGPT_ROOT, 'services', 'deepagents', 'workspace')
    if (await fs.stat(shared).then((x) => x.isDirectory(), () => false)) await fs.mkdir(path.join(shared, config.tenantId), { recursive: true }).catch(() => {})
    host = path.join(root, rel.slice('/workspace'.length))
    await fs.mkdir(path.dirname(host), { recursive: true })
    await fs.writeFile(host, buf)
    out.path = rel
  }
  if (pages && isTiffBytes(buf)) Object.assign(out, await tiffPages(user, id, name, buf, host ? { host: path.dirname(host), rel: path.posix.dirname(rel) } : null))
  return out
}

// A TIFF (a fax — 2026-11-25 「tif 파일을 웹에서 못 열어보나?」): its pages as PNG pictures, so a model that reads pictures can read the fax
// (lib/tiff.js) — kept private (chat/<tenant>/<person>/<upload>/page-<n>.png in the private bucket, never the public `files` one), handed
// over by a signed address for PAGES_TTL_S, and beside the file in the agent's workspace when that is on this machine.
// → {pages: [{name, url, path?}], pageTotal} or {pagesError: code}; a failure never stops the upload itself.
export const PAGES_TTL_S = 60 * 60
async function tiffPages(user, upload, name, buf, dir) {
  try {
    const pics = await tiffToPngs(buf)
    const pages = []
    for (const [n, p] of pics.pages.entries()) {
      const k = P.chatPageKey({ tenant: config.tenantId, userId: user.id, upload, n: n + 1 })
      await P.put(k, p.png, 'image/png')
      const pg = { name: pageName(name, n + 1), url: await P.signedUrl(k, PAGES_TTL_S) }
      if (dir) {
        const file = safeName(pg.name)
        await fs.writeFile(path.join(dir.host, file), p.png)
        pg.path = `${dir.rel}/${file}`
      }
      pages.push(pg)
    }
    return { pages, pageTotal: pics.total }
  } catch (e) {
    if (!e?.code) console.warn('[attachments] tiff pages', e?.message)
    return { pagesError: e?.code || 'broken' }
  }
}
// The page pictures of an attachment the page sent back with its message, kept only when they are this upload's own: a path in the same
// workspace folder as the file (its path is checked to be the person's own — lib/agent.js), or a signed address of exactly this upload's
// private pages (the key says whose: pgpt-pro/<person>/att/<upload>.<ext> → chat/<tenant>/<person>/<upload>/page-…) → [path or address]
export function pageRefs(f) {
  const list = Array.isArray(f?.pages) ? f.pages.slice(0, AGENT_PAGES) : []
  if (!list.length) return []
  const dir = f.path ? `${path.posix.dirname(String(f.path))}/` : ''
  const m = /^pgpt-pro\/([0-9a-f-]{36})\/att\/([0-9a-f-]{36})\.[a-z0-9]+$/i.exec(String(f.key || ''))
  const prefix = m ? P.chatPagePrefix({ tenant: config.tenantId, userId: m[1], upload: m[2] }) : null
  return list.map((p) => {
    const at = String(p?.path || '')
    if (dir && at.startsWith(dir) && !at.slice(dir.length).includes('/') && !at.includes('..')) return at
    const o = P.isSignedUrl(p?.url) ? P.objectOfUrl(p.url) : null
    return prefix && o?.bucket === P.BUCKET && o.key.startsWith(prefix) && /^\d{1,3}\.png$/.test(o.key.slice(prefix.length)) ? String(p.url) : null
  }).filter(Boolean)
}
// the words for one attachment's pages (or why there are none)
function pagesHint(f) {
  if (f?.pagesError) {
    const [ko, en] = reasonOf({ code: f.pagesError })
    return L(` — 이 TIFF 는 ${ko} 쪽 그림으로 바꾸지 못했어요`, ` — this TIFF could not be turned into page pictures: ${en}`)
  }
  const refs = pageRefs(f)
  if (!refs.length) return ''
  const more = Number(f.pageTotal) > refs.length ? L(` (전체 ${f.pageTotal}쪽 가운데 앞 ${refs.length}쪽)`, ` (the first ${refs.length} of ${f.pageTotal} pages)`) : ''
  return L(` — 팩스·TIFF 라서 쪽마다 그림(PNG)으로도 두었어요. 그림을 열어 보고 읽으세요${more}: ${refs.map((r, n) => `${n + 1}쪽 ${r}`).join(', ')}`,
    ` — a fax/TIFF: each page is also a PNG picture; open the pictures to read it${more}: ${refs.map((r, n) => `page ${n + 1} ${r}`).join(', ')}`)
}

// At send time, once the conversation (= deepagents room) is known: memento stores and indexes
// each file for that room. A file it does not take still goes by its address.
export async function indexForRoom(files, roomId) {
  return Promise.all((files || []).map(async (f) => {
    const ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : ''
    if (f.fileId || !f.key || !roomId || !INDEXED.has(ext)) return f
    try {
      const { data, error } = await admin.storage.from('files').download(f.key)
      if (error) throw error
      const form = new FormData()
      form.set('file', new Blob([await data.arrayBuffer()], { type: f.type || 'application/octet-stream' }), f.name)
      form.set('tenant_id', config.tenantId)
      form.set('options', JSON.stringify({ room_id: roomId }))
      const r = await fetch(`${config.mementoUrl}/save-to-storage`, { method: 'POST', body: form, signal: AbortSignal.timeout(180_000) })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || !j.file_path) throw new Error(j.detail || `memento ${r.status}`)
      return { ...f, fileId: j.file_path, url: j.file_url || f.url }
    } catch (e) {
      console.warn('[attachments] memento', f.name, e.message)
      return f
    }
  }))
}

// process-gpt's chat contract for uploads (the shape its frontend sends)
export const chatFiles = (files) => files.map((f) => ({
  fileName: f.name, fileUrl: f.url, fileType: f.type, fileSize: f.size,
  ...(f.fileId ? { fileId: f.fileId, file_id: f.fileId, filePath: f.fileId } : f.path ? { filePath: f.path } : {}),
}))

// What the agent is told about the attachments: where each can be read.
export function attachmentHint(files) {
  if (!files?.length) return ''
  const list = files.map((f) => (f.path ? `${f.path} (${f.name})`
    : f.fileId ? L(`${f.name} — 이 대화의 지식 문서(문서 검색·읽기 도구)`, `${f.name} — a knowledge document of this conversation (document search/read tools)`)
      : `${f.name} — ${f.url}`) + pagesHint(f)).join(', ')
  return L(`\n\n(첨부 파일: ${list})`, `\n\n(Attached files: ${list})`)
}

// The files a page sends with a chat message are only ever this person's own uploads (POST /api/attachments: the files bucket's
// pgpt-pro/<their id>/att/<upload>.<ext>). A card made from any other address would name someone else's object — and a mail's
// attachments are read from the cards of the chat (lib/mailOut.js) — so other entries are dropped here, before the turn sees them.
export function pageFiles(userId, files) {
  const mine = (u) => {
    try {
      const m = /^\/storage\/v1\/object\/(?:public\/|authenticated\/)?files\/(.+)$/.exec(new URL(String(u)).pathname)
      const key = m ? decodeURIComponent(m[1]) : ''
      return new RegExp(`^pgpt-pro/${userId}/att/[0-9a-f-]{36}\\.[a-z0-9]+$`).test(key)
    } catch { return false }
  }
  const all = Array.isArray(files) ? files : []
  const kept = all.filter((f) => f && typeof f === 'object' && mine(f.url))
  if (kept.length !== all.length) console.warn(`[attachments] ${all.length - kept.length} file(s) from the page were not this person's uploads — left out user=${String(userId).slice(0, 8)}`)
  return kept
}
