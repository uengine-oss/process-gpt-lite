// Where the ArtCraft CLIs (mcp/craft.js) work on the agent's /workspace paths.
//   - deepagents' workspace on this machine (local development, the Docker bundle): that folder, as before.
//   - the agent on other machines (the cluster: deepagents runs in its own pods, no shared disk): a folder
//     per person on this server stands in for /workspace (PRO_CRAFT_WORK_ROOT/<tenant>/<person>). A
//     conversation-folder file a tool needs that is not there yet comes from that folder's copy in storage
//     (lib/roomStore.js — what deepagents uploads after each turn); what a tool writes in a conversation folder
//     goes back to that copy, where the next turn's pod and the room readers find it. Both only for a
//     conversation folder the person may use (mayUseRoom); another one is not fetched, not written back, and
//     a tool naming it finds nothing there. The chat card reads the person's stand-in (lib/office.js). Files
//     here are kept for a day.
// Either way, the person's own attachment or file card may be named by its storage URL: it is fetched into
// /workspace/uploads/<person>/files/ and the tool gets that path (the agent is told attachments by URL when
// the workspace is not shared — lib/attachments.js).
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'
import { workspaceHostPath } from './missions.js'
import { admin } from './supa.js'
import { fetchRoomFile, roomPrefix } from './roomStore.js'

const NAME = /^[A-Za-z0-9_-]{1,64}$/
const KEEP_MS = 24 * 60 * 60 * 1000
const MAX_FETCH = 300 * 1024 * 1024
const ROOM = /^\/workspace\/\.bpmn\/([^/]+)\//
// a conversation id, or a process instance id (deepagents' folder name for it)
const ROOM_ID = /^(?!\.{1,2}$)[A-Za-z0-9_.:-]{1,128}$/
const safe = (s) => (NAME.test(String(s || '')) ? String(s) : '_')

// the stand-in folder of a person in the request's tenant ('_': the tool catalog, read without a person)
export const standInRoot = (userId) => path.join(config.craftWorkRoot, safe(config.tenantId), safe(userId))

let swept = 0
// { root: what /workspace is for this person's CLIs, standIn: whether it is this server's stand-in }
export async function craftRoot({ userId = null, shared = () => workspaceHostPath('/workspace') } = {}) {
  const host = await shared().catch(() => null)
  if (host) return { root: host, standIn: false }
  const root = standInRoot(userId)
  await fs.mkdir(root, { recursive: true })
  if (Date.now() - swept > 60 * 60 * 1000) {
    swept = Date.now()
    sweep(config.craftWorkRoot).catch((e) => console.warn('[craft] sweep', e.message))
  }
  return { root, standIn: true }
}

// a /workspace path inside a root, or null when it would leave it
export function inRoot(root, p) {
  const host = path.resolve(root, '.' + String(p).slice('/workspace'.length))
  return host === root || host.startsWith(root + path.sep) ? host : null
}

// A /workspace path's file or folder in the person's stand-in, when the workspace is not shared and it is
// there (the chat card of a file a CLI wrote: lib/office.js)
export async function standInPath(p, { userId = null, shared = () => workspaceHostPath('/workspace') } = {}) {
  if (!userId || !/^\/workspace(\/|$)/.test(String(p || '')) || (await shared().catch(() => null))) return null
  const host = inRoot(standInRoot(userId), p)
  return host && (await fs.stat(host).catch(() => null)) ? host : null
}

// ---- which conversation folders a person's tools may fetch from and write back to ----
// The rules the workroom already uses for a folder (lib/workroom.js canAccess), without its override for the
// tenant's administrators — these calls are an agent's, made for one person: the person's own conversation
// (context_threads, pro_threads), a shared folder's run room of a folder where they may run its variations
// (runner and up, as the workroom's variation rooms: lib/folders/rooms.js), and a process instance's folder
// they take part in. The lookups are the existing ones; `look` replaces them in tests.
const LOOK = {
  owns: async (userId, room) => (await import('./workroom.js')).ownsConversation(userId, room),
  folderOfRoom: async (room) => (await import('./folders/work.js')).folderOfRoom(room),
  folderAccess: async (user, room) => (await import('./folders/rooms.js')).folderRoomAccess(user, room),
  takesPart: async (user, procInstId) => (await import('./workroom.js')).takesPartInInstance(user, procInstId),
}
export const roomRules = (look = LOOK) => ({
  own: (user, room) => look.owns(user.id, room),
  folder: async (user, room) => {
    const folder = await look.folderOfRoom(room)
    return !!folder && look.folderAccess(user, { folder, need: 'runner' })
  },
  instance: (user, room) => look.takesPart(user, room),
})
export const ROOM_RULES = roomRules()
// (a yes is remembered for a minute; a no is asked again — a new conversation is recorded for its person
// while its first turn runs. A lookup that fails counts as no.)
const allowed = new Map() // `${tenant}:${user}:${room}` → when
export async function mayUseRoom(user, room, rules = ROOM_RULES) {
  if (!user?.id || !ROOM_ID.test(String(room || ''))) return false
  const key = `${config.tenantId}:${user.id}:${room}`
  if (rules === ROOM_RULES && Date.now() - (allowed.get(key) || 0) < 60_000) return true
  for (const rule of Object.values(rules)) {
    if (await Promise.resolve().then(() => rule(user, room)).catch(() => false)) {
      if (rules === ROOM_RULES) {
        if (allowed.size > 5000) allowed.clear()
        allowed.set(key, Date.now())
      }
      return true
    }
  }
  return false
}
// one call's answers, so a room named several times is asked about once; `denied` is what was left out
export function roomGate(user, rules = ROOM_RULES) {
  const asked = new Map()
  const denied = new Set()
  return {
    denied,
    async ok(room) {
      if (!asked.has(room)) asked.set(room, mayUseRoom(user, room, rules))
      const ok = await asked.get(room)
      if (!ok) denied.add(room)
      return ok
    },
    async filter(rooms) {
      const out = new Set()
      for (const r of rooms) if (await this.ok(r)) out.add(r)
      return out
    },
  }
}

const strings = (v, out = []) => {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out))
  return out
}
const mapStrings = async (v, fn) => {
  if (typeof v === 'string') return fn(v)
  if (Array.isArray(v)) return Promise.all(v.map((x) => mapStrings(x, fn)))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = await mapStrings(x, fn)
    return out
  }
  return v
}

// the conversation folders (room ids) a call's arguments name
export const roomsOf = (args) => new Set(strings(args).map((s) => ROOM.exec(s)?.[1]).filter(Boolean))

// the storage key of a public `files` URL of this person's own (pgpt-pro/<person>/…: attachments, file cards), else null
export function ownFileKey(url, userId) {
  const base = `${String(config.supabaseUrl || '').replace(/\/+$/, '')}/storage/v1/object/public/files/`
  if (!userId || typeof url !== 'string' || !url.startsWith(base)) return null
  let key
  try { key = decodeURIComponent(url.slice(base.length).split(/[?#]/)[0]) } catch { return null }
  return key.startsWith(`pgpt-pro/${userId}/`) && !key.split('/').includes('..') ? key : null
}

const storageIo = {
  async download(key) {
    const { data, error } = await admin.storage.from('files').download(key)
    if (error) throw error
    return Buffer.from(await data.arrayBuffer())
  },
  async upload(key, buf) {
    const { error } = await admin.storage.from('files').upload(key, buf, { upsert: true, contentType: 'application/octet-stream' })
    if (error) throw error
  },
  fetchRoomFile,
}

// The arguments as the CLI should get them, and the files they name in place: the person's own storage
// URLs become /workspace/uploads/<person>/files/<name>; in the stand-in, a file of a conversation folder the
// person may use (gate) that is not here yet is fetched from that folder's storage copy (a file the agent
// itself is still writing on its pod this turn is not there yet: the tool says it is missing). A folder the
// person may not use is not fetched: the tool finds nothing there.
export async function prepareArgs(args, { root, standIn, userId, gate = null, io = storageIo }) {
  return mapStrings(args, async (s) => {
    const key = ownFileKey(s, userId)
    if (key) {
      const p = `/workspace/uploads/${userId}/files/${path.basename(key)}`
      const host = inRoot(root, p)
      if (!(await fs.stat(host).catch(() => null))) {
        const buf = await io.download(key)
        if (buf.length > MAX_FETCH) throw new Error(`file too large to open here: ${path.basename(key)}`)
        await fs.mkdir(path.dirname(host), { recursive: true })
        await fs.writeFile(host, buf)
      }
      return p
    }
    const room = standIn && /\.[A-Za-z0-9]{1,8}$/.test(s) ? ROOM.exec(s)?.[1] : null
    if (room) {
      const host = inRoot(root, s)
      if (host && !(await fs.stat(host).catch(() => null)) && (!gate || await gate.ok(room))) {
        const got = await io.fetchRoomFile(s).catch(() => null)
        if (got?.buf) {
          await fs.mkdir(path.dirname(host), { recursive: true })
          await fs.writeFile(host, got.buf)
        }
      }
    }
    return s
  })
}

// conversation folders a person's session of an app has worked in (a save without a path writes where the
// document came from), so what a later call writes there goes back too
const worked = new Map() // `${app}:${userId}` → Set of room ids
export function roomsWorked(key, rooms) {
  const set = worked.get(key) || new Set()
  for (const r of rooms) set.add(r)
  while (set.size > 20) set.delete(set.values().next().value)
  worked.set(key, set)
  return set
}
export const forgetRooms = (key) => worked.delete(key)

async function changedFiles(dir, since, depth = 0, out = []) {
  if (depth > 6) return out
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await changedFiles(p, since, depth + 1, out)
    else if (e.isFile() && (await fs.stat(p)).mtimeMs >= since) out.push(p)
  }
  return out
}

// In the stand-in: files written in those conversation folders since `since` go to the folders' storage
// copies — only folders the person may use (gate). Returns their /workspace paths.
export async function pushChanged({ root, rooms, since, gate = null, io = storageIo }) {
  const pushed = []
  for (const room of rooms) {
    if (gate && !(await gate.ok(room))) continue
    const dir = inRoot(root, `/workspace/.bpmn/${room}`)
    if (!dir || dir === root) continue
    // (a little slack for the clock's rounding: a file of the call before may go up again — the same bytes)
    for (const host of await changedFiles(dir, since - 50)) {
      const p = `/workspace/.bpmn/${room}/${path.relative(dir, host).split(path.sep).join('/')}`
      const key = roomPrefix(p)
      if (!key) continue
      try {
        await io.upload(key, await fs.readFile(host))
        pushed.push(p)
      } catch (e) { console.warn(`[craft] keeping a file for its conversation folder failed: ${e.message}`) }
    }
  }
  return pushed
}

// files not touched for a day go (their copies stay in storage), then folders left empty for as long —
// never a tenant's or a person's own folder (a CLI runs in it)
export async function sweep(dir, maxAgeMs = KEEP_MS, now = Date.now(), depth = 0) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    const st = await fs.lstat(p).catch(() => null)
    if (!st) continue
    if (e.isDirectory()) {
      await sweep(p, maxAgeMs, now, depth + 1)
      if (depth >= 2 && now - st.mtimeMs > maxAgeMs) await fs.rmdir(p).catch(() => {})
    } else if (now - st.mtimeMs > maxAgeMs) await fs.rm(p, { force: true })
  }
}
