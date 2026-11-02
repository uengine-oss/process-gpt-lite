// A conversation's folder as deepagents leaves it in storage. The agent runs on other machines than
// this server (several pods, no shared disk); at the end of every turn deepagents uploads the room
// folder /workspace/.bpmn/<room>/ to the `files` bucket at skills/<tenant>/<room>/<path>
// (core/storage/storage.py upload_workspace_directory), path segments it cannot use as keys
// encoded as __u8__<base64url>. A folder that is not on this machine is read from there.
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../config.js'
import { admin, q } from './supa.js'

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

// From the table, not storage's list API: that gives folder names in lower case (Docs → docs), and the
// __u8__ names of folders do not survive it.
const listObjects = async (prefix) => (await q(
  "select name as key, updated_at::text as \"updatedAt\" from storage.objects where bucket_id='files' and starts_with(name, $1)",
  [`${prefix}/`],
))

// The folder's files downloaded into a new temporary folder (same names, decoded); null when
// storage has nothing under it. The caller removes the folder (rmRoomCopy).
export async function fetchRoomDir(dir) {
  const prefix = roomPrefix(dir)
  if (!prefix) return null
  // oldest first: a file seeded under one key and uploaded back under another ends as the agent left it
  const keys = (await listObjects(prefix)).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).map((o) => o.key)
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
// one file of a room folder from storage, or null
export async function fetchRoomFile(file) {
  const key = roomPrefix(file)
  if (!key || /^skills\/[^/]+\/[^/]+$/.test(key)) return null
  const { data, error } = await admin.storage.from('files').download(key)
  return error || !data ? null : { buf: Buffer.from(await data.arrayBuffer()), type: data.type || '' }
}

export const rmRoomCopy =(local) => fs.rm(path.dirname(local), { recursive: true, force: true }).catch(() => {})

// every file under a local folder, relative to it; a checkout's .git pointer stays on this machine
async function localFiles(root, sub = '') {
  const out = []
  for (const e of await fs.readdir(path.join(root, sub), { withFileTypes: true })) {
    if (e.name === '.git') continue
    const rel = sub ? `${sub}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...await localFiles(root, rel))
    else if (e.isFile()) out.push(rel)
  }
  return out
}
// deepagents restores a room by walking storage's list API, which lowers folder names, so a file under
// 자료/Docs is not found again. One encoded segment has no folder to walk and decodes to the same path.
const seedKey = (rel) => (rel.includes('/') ? MARK + Buffer.from(rel, 'utf8').toString('base64url') : encodeSegment(rel))
const relOf = (prefix, key) => key.slice(prefix.length + 1).split('/').map(decodeSegment).join('/')
const digest = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// Puts a folder where deepagents restores a room it has not seen (download_workspace_directory), so
// the agent's pod gets the files. Returns what `pullRoomChanges` compares the agent's result with.
export async function pushRoomDir(local, dir) {
  const prefix = roomPrefix(dir)
  if (!prefix) throw new Error(`not a room folder: ${dir}`)
  const hashes = new Map()
  for (const rel of await localFiles(local)) {
    const buf = await fs.readFile(path.join(local, rel))
    const { error } = await admin.storage.from('files').upload(`${prefix}/${seedKey(rel)}`, buf, { upsert: true, contentType: 'application/octet-stream' })
    if (error) throw error
    hashes.set(rel, digest(buf))
  }
  const stamps = new Map((await listObjects(prefix)).map((o) => [relOf(prefix, o.key), o.updatedAt]))
  return { hashes, stamps }
}

// deepagents uploads the room after its answer has ended, and uploads every file: the turn is in
// storage once each pushed file has a new stamp and the listing has stopped changing.
async function roomSynced(dir, seeded, { timeoutMs, everyMs }) {
  const prefix = roomPrefix(dir)
  const deadline = Date.now() + (seeded.stamps.size ? timeoutMs : Math.min(timeoutMs, 10000))
  let last = null
  while (Date.now() < deadline) {
    const objects = await listObjects(prefix)
    const now = JSON.stringify(objects.map((o) => [o.key, o.updatedAt]).sort())
    const fresh = objects.length > 0 && [...seeded.stamps].every(([rel, stamp]) => objects.some((o) => relOf(prefix, o.key) === rel && o.updatedAt !== stamp))
    if (fresh && now === last) return true
    last = now
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return false
}

// The agent's changes into the checkout: files it made or altered. A pushed file that comes back the
// same is left alone, so a deletion on a shared disk stays deleted. A deletion on the agent's pod
// does not reach storage (deepagents only uploads) and cannot be seen here.
export async function pullRoomChanges(dir, seeded, local, { wait = true, timeoutMs = 45000, everyMs = 2000 } = {}) {
  if (wait) await roomSynced(dir, seeded, { timeoutMs, everyMs })
  const copy = await fetchRoomDir(dir)
  if (!copy) return []
  try {
    const changed = []
    for (const rel of await localFiles(copy)) {
      const buf = await fs.readFile(path.join(copy, rel))
      if (seeded.hashes.get(rel) === digest(buf)) continue
      await fs.mkdir(path.dirname(path.join(local, rel)), { recursive: true })
      await fs.writeFile(path.join(local, rel), buf)
      changed.push(rel)
    }
    return changed
  } finally { await rmRoomCopy(copy) }
}
