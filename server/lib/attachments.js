// Files a person attaches in chat. Each goes two places: the deepagents workspace (so the agent can
// open it in its sandbox at /workspace/uploads/…) and the `files` storage bucket (a URL for the
// card, the document editor, and process-gpt's `files` field on the chat request).
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { admin } from './supa.js'
import { workspaceHostPath } from './missions.js'

const MAX = 50 * 1024 * 1024

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
  const rel = `/workspace/uploads/${user.id}/${id}/${name}`
  const root = await workspaceHostPath('/workspace')
  const host = path.join(root, rel.slice('/workspace'.length))
  await fs.mkdir(path.dirname(host), { recursive: true })
  await fs.writeFile(host, buf)
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'bin'
  // storage keys must be ASCII; the name the user sees travels with the card
  const key = `pgpt-pro/${user.id}/att/${id}.${ext.replace(/[^a-z0-9]/g, '') || 'bin'}`
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: type || 'application/octet-stream', upsert: false })
  if (error) throw error
  return { name, size: buf.length, type: type || '', path: rel, url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}` }
}

// What the agent is told about the attachments (it reads them in its sandbox).
export function attachmentHint(files) {
  if (!files?.length) return ''
  return `\n\n(첨부 파일 — 샌드박스에서 바로 읽을 수 있음: ${files.map((f) => `${f.path} (${f.name})`).join(', ')})`
}
