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
import { L } from './lang.js'

const MAX = 50 * 1024 * 1024
// memento's chat attachment policy (ingest.py save_to_storage, room_id set): other types are kept
// in storage and passed by address only
const INDEXED = new Set(['pdf', 'hwp', 'hwpx', 'doc', 'docx', 'pptx', 'txt', 'xlsx'])

// "../../x.pdf", "a/b.txt" → a plain file name; nothing outside the upload folder
function safeName(raw) {
  const n = path.basename(String(raw || 'file')).replace(/[\u0000-\u001f\\/:*?"<>|]/g, '_').trim()
  return n && n !== '.' && n !== '..' ? n.slice(0, 160) : 'file'
}

export async function saveAttachment(user, rawName, type, buf) {
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
  if (root) {
    const host = path.join(root, rel.slice('/workspace'.length))
    await fs.mkdir(path.dirname(host), { recursive: true })
    await fs.writeFile(host, buf)
    out.path = rel
  }
  return out
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
  const list = files.map((f) => f.path ? `${f.path} (${f.name})`
    : f.fileId ? L(`${f.name} — 이 대화의 지식 문서(문서 검색·읽기 도구)`, `${f.name} — a knowledge document of this conversation (document search/read tools)`)
      : `${f.name} — ${f.url}`).join(', ')
  return L(`\n\n(첨부 파일: ${list})`, `\n\n(Attached files: ${list})`)
}
