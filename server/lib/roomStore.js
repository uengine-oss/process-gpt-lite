// A conversation's folder as deepagents leaves it in storage. The agent runs on other machines than
// this server (several pods, no shared disk); at the end of every turn deepagents uploads the room
// folder /workspace/.bpmn/<room>/ to the `files` bucket at skills/<tenant>/<room>/<path>
// (core/storage/storage.py upload_workspace_directory), path segments it cannot use as keys
// encoded as __u8__<base64url>. A folder that is not on this machine is read from there.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { admin } from './supa.js'

// same as deepagents' _SAFE_KEY_SEGMENT / _ENCODED_MARK
const SAFE = /^[A-Za-z0-9_/!\-.*'() &$@=;:+,?]*$/
const MARK = '__u8__'
export const encodeSegment = (s) => (SAFE.test(s) && !s.startsWith(MARK) ? s : MARK + Buffer.from(s, 'utf8').toString('base64url'))
export const decodeSegment = (s) => {
  if (!s.startsWith(MARK)) return s
  try { return Buffer.from(s.slice(MARK.length), 'base64url').toString('utf8') } catch { return s }
}
const encodePath = (rel) => rel.split('/').map(encodeSegment).join('/')

// /workspace/.bpmn/<room>/<sub> → its storage prefix, or null for a path outside a room folder
export function roomPrefix(dir) {
  const m = /^\/workspace\/\.bpmn\/([^/]+)(?:\/(.*))?$/.exec(String(dir || '').replace(/\/+$/, ''))
  if (!m) return null
  return [`skills/${config.tenantId}/${m[1]}`, m[2] ? encodePath(m[2]) : ''].filter(Boolean).join('/')
}

async function listAll(prefix) {
  const out = []
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.storage.from('files').list(prefix, { limit: 1000, offset })
    if (error) throw error
    for (const e of data || []) {
      const key = `${prefix}/${e.name}`
      if (e.id) out.push(key) // a file; a folder has no id
      else out.push(...await listAll(key))
    }
    if (!data || data.length < 1000) return out
  }
}

// The folder's files downloaded into a new temporary folder (same names, decoded); null when
// storage has nothing under it. The caller removes the folder (rmRoomCopy).
export async function fetchRoomDir(dir) {
  const prefix = roomPrefix(dir)
  if (!prefix) return null
  const keys = await listAll(prefix)
  if (!keys.length) return null
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-room-'))
  const local = path.join(tmp, path.basename(String(dir).replace(/\/+$/, '')))
  for (const key of keys) {
    const rel = key.slice(prefix.length + 1).split('/').map(decodeSegment).join('/')
    const dest = path.join(local, rel)
    if (!dest.startsWith(local + path.sep)) continue
    const { data, error } = await admin.storage.from('files').download(key)
    if (error) throw error
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, Buffer.from(await data.arrayBuffer()))
  }
  return local
}
export const rmRoomCopy = (local) => fs.rm(path.dirname(local), { recursive: true, force: true }).catch(() => {})
