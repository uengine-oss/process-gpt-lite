// A file card for a file the agent left in the tenant workspace but outside a conversation folder
// (e.g. /workspace/메모.txt): there is no workroom to open it in, so opening it publishes a copy to
// storage for this user — the way the agent's documents are published (lib/office.js publish) — and
// the card keeps the link (the editor for documents, a download for anything else).
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q, admin } from './supa.js'
import { publish, extOf, editable } from './office.js'
import { workspaceHostPath } from './missions.js'
import { updateMessage } from './store.js'
import { L } from './lang.js'

// plain text opens as text in the browser (markup too — never rendered from the storage origin)
const TEXT = new Set(['txt', 'md', 'markdown', 'log', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'htm', 'js', 'ts', 'py', 'sh', 'sql', 'css'])
async function publishPlain(userId, host, name) {
  const buf = await fs.readFile(host)
  const ext = extOf(name).replace(/[^a-z0-9]/g, '') || 'bin'
  const key = `pgpt-pro/${userId}/ws/${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32)}.${ext}`
  const type = TEXT.has(ext) ? 'text/plain; charset=utf-8' : 'application/octet-stream'
  const { error } = await admin.storage.from('files').upload(key, buf, { contentType: type, upsert: true })
  if (error) throw error
  return { name, url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, ext }
}

const err = (status, message) => Object.assign(new Error(message), { status })
const MAX = 50 * 1024 * 1024

export async function openFileCard(user, msgId) {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id
                       where m.id=$1 and t.user_id=$2 and m.kind='file'`, [msgId, user.id])
  if (!m) throw err(404, L('파일 카드를 찾지 못했어요.', "I couldn't find the file card."))
  const c = m.content || {}
  if (c.url) return c
  const p = String(c.path || '')
  if (!p.startsWith('/workspace/') || p.split('/').includes('..')) throw err(400, L('작업 공간의 파일만 열 수 있어요.', 'Only files in the workspace can be opened.'))
  const host = await workspaceHostPath(p).catch(() => null)
  const root = await workspaceHostPath('/workspace').catch(() => null)
  if (!host || !root) throw err(404, L('파일이 작업 공간에 더 이상 없어요.', 'The file is no longer in the workspace.'))
  // a link may not lead outside the workspace
  const [real, realRoot] = await Promise.all([fs.realpath(host), fs.realpath(root)])
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw err(400, L('작업 공간 밖의 파일은 열 수 없어요.', "Files outside the workspace can't be opened."))
  const st = await fs.stat(real)
  if (!st.isFile()) throw err(404, L('파일이 아니에요.', "It isn't a file."))
  if (st.size > MAX) throw err(413, L('파일이 너무 커요(50MB 초과).', 'The file is too large (over 50 MB).'))
  const name = c.name || path.basename(p)
  // documents go the editor's way (lib/office.js publish); other files as they are
  const pub = editable(name) ? await publish(user.id, p) : await publishPlain(user.id, real, name)
  const u = await updateMessage(user.id, m.id, { url: pub.url, ext: pub.ext })
  return u?.content || { ...c, url: pub.url }
}
