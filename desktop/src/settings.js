'use strict'
// What the app remembers, in <userData>/desktop-settings.json:
//   server       — the Lite server's base address (https://acme.process-gpt.io/lite, http://localhost:18080)
//   recent       — servers used before (setup page list), newest first
//   authOrigins  — the server's Supabase sign-in origin(s) (server.js authOriginsOf), refreshed on every start
//   gate         — { user, pass } basic-auth pair for a server published behind one; pass encrypted with the
//                  OS keychain (safeStorage) when it is available
//   window       — { x, y, width, height, maximized }
//   lang         — 'ko' | 'en': the web app's language last seen (menu labels)
//   runner       — { [server]: {token, enc, deviceId, userId, userName} }: this computer's device token for the local CLI agents of the
//                  person signed in on that server (runner/, design docs/local-agents/design.md); the token encrypted like the gate's
//   runnerPrefs  — {enabled, ask, finishMinutes, browser}: local runs on or off, asking before each run, and how long a step waits after its CLI's
//                  turn ended for the people on the instance before it ends by itself (runner/settle.js — default 5)
//   runnerOptOut — { [server]: [userId…] }: people who disconnected this computer here (it is not paired again by itself)
//   folders      — { [server]: [{folderId, userId, path, label, include, exclude, sourceId, branch, state, why, paths, head, taken, files, bytes,
//                  lastPushedAt, boundAt}] }: the folders of this computer kept as Lite folders (챔피언 폴더 — runner/sync.js), per server and
//                  person. The picked folder's path is kept here only (the server and the page know its label — the folder's name)
//   seats        — { [server]: [{variationId, userId, folderId, folderName, title, branch, dir, epoch, head, pushedAt, autoSave, state, why, dirty,
//                  ahead, branchOk, flagged, person}] }: the variations' working copies this computer holds (작업본 — runner/seats.js), per
//                  server and person. The working copy's path (dir — always under the app's data folder) is kept here only
const fs = require('node:fs')
const path = require('node:path')

let file = ''
let data = {}
let safe = null

function init(dir, safeStorage) {
  file = path.join(dir, 'desktop-settings.json')
  safe = safeStorage || null
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch { data = {} }
  if (typeof data !== 'object' || Array.isArray(data)) data = {}
  return data
}

function save() {
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (e) { console.warn('[settings]', e.message) }
}

const get = () => data
function set(patch) { data = { ...data, ...patch }; save(); return data }

function useServer(server, authOrigins = []) {
  const recent = [server, ...(data.recent || []).filter((s) => s !== server)].slice(0, 6)
  return set({ server, recent, authOrigins })
}

const canEncrypt = () => { try { return !!safe && safe.isEncryptionAvailable() } catch { return false } }
function setGate(user, pass) {
  if (!user) return set({ gate: null })
  if (canEncrypt()) return set({ gate: { user, pass: safe.encryptString(pass || '').toString('base64'), enc: true } })
  return set({ gate: { user, pass: Buffer.from(pass || '').toString('base64'), enc: false } })
}
function gate() {
  const g = data.gate
  if (!g?.user) return null
  try {
    const raw = Buffer.from(g.pass || '', 'base64')
    return { user: g.user, pass: g.enc ? safe.decryptString(raw) : raw.toString() }
  } catch { return { user: g.user, pass: '' } }
}

// ---------- the local runner's pairing (one per server) ----------
const seal = (v) => (canEncrypt() ? { v: safe.encryptString(v).toString('base64'), enc: true } : { v: Buffer.from(v).toString('base64'), enc: false })
const unseal = (x) => { try { const raw = Buffer.from(x.v || '', 'base64'); return x.enc ? safe.decryptString(raw) : raw.toString() } catch { return '' } }
function setPairing(server, { token, deviceId, userId, userName = '' }) {
  const all = { ...(data.runner || {}) }
  all[server] = { token: seal(token), deviceId, userId, userName }
  const out = { ...(data.runnerOptOut || {}) }
  if (out[server]) out[server] = out[server].filter((u) => u !== userId)
  return set({ runner: all, runnerOptOut: out })
}
function pairing(server) {
  const p = (data.runner || {})[server]
  if (!p?.token) return null
  const token = unseal(p.token)
  return token ? { token, deviceId: p.deviceId, userId: p.userId, userName: p.userName || '' } : null
}
// optOut: this person disconnected this computer on purpose — the page does not pair it again by itself
function forgetPairing(server, { optOut = false } = {}) {
  const all = { ...(data.runner || {}) }
  const was = all[server]
  delete all[server]
  const out = { ...(data.runnerOptOut || {}) }
  if (optOut && was?.userId) out[server] = [...new Set([...(out[server] || []), was.userId])]
  return set({ runner: all, runnerOptOut: out })
}
const optedOut = (server, userId) => ((data.runnerOptOut || {})[server] || []).includes(userId)
const FINISH_MINUTES = [1, 3, 5, 10, 30, 60]
const finishMinutesOf = (v) => (FINISH_MINUTES.includes(Number(v)) ? Number(v) : 5)
// 「브라우저 작업은 내 PC에서」 — this PC's own consent (0.2.3; server lib/browserRemote.js routeOf): 'own' (the person's own tasks — the
// default) · 'all' (also tasks nobody watches: process steps, scheduled and agents' runs) · 'off'
const BROWSER_PREFS = ['own', 'all', 'off']
const browserPrefOf = (v) => (BROWSER_PREFS.includes(v) ? v : 'own')
const runnerPrefs = () => ({ enabled: data.runnerPrefs?.enabled !== false, ask: data.runnerPrefs?.ask === true, finishMinutes: finishMinutesOf(data.runnerPrefs?.finishMinutes),
  browser: browserPrefOf(data.runnerPrefs?.browser) })

// ---------- the folders of this computer kept as Lite folders (runner/sync.js) — one person's on one server ----------
// put(entry) adds or replaces that person's entry for entry.folderId; another person's entries on the same server are never seen or changed
function folderStore(server, userId) {
  const uid = String(userId || '')
  const listOf = () => ((data.folders || {})[server] || []).filter((e) => e && typeof e === 'object')
  const mine = () => listOf().filter((e) => e.userId === uid)
  const write = (list) => set({ folders: { ...(data.folders || {}), [server]: list } })
  return {
    all: () => mine().map((e) => ({ ...e })),
    get: (folderId) => { const e = mine().find((x) => x.folderId === folderId); return e ? { ...e } : null },
    // (in its place: the list keeps the order the folders were connected in)
    put: (entry) => {
      const list = listOf()
      const at = list.findIndex((e) => e.userId === uid && e.folderId === entry.folderId)
      const next = { ...entry, userId: uid }
      write(at < 0 ? [...list, next] : list.map((e, i) => (i === at ? next : e)))
    },
    drop: (folderId) => write(listOf().filter((e) => !(e.userId === uid && e.folderId === folderId))),
  }
}

// ---------- the variations' working copies on this computer (runner/seats.js) — one person's on one server ----------
// the same shape as folderStore, keyed by the variation
function seatStore(server, userId) {
  const uid = String(userId || '')
  const listOf = () => ((data.seats || {})[server] || []).filter((e) => e && typeof e === 'object')
  const mine = () => listOf().filter((e) => e.userId === uid)
  const write = (list) => set({ seats: { ...(data.seats || {}), [server]: list } })
  return {
    all: () => mine().map((e) => ({ ...e })),
    get: (variationId) => { const e = mine().find((x) => x.variationId === variationId); return e ? { ...e } : null },
    put: (entry) => {
      const list = listOf()
      const at = list.findIndex((e) => e.userId === uid && e.variationId === entry.variationId)
      const next = { ...entry, userId: uid }
      write(at < 0 ? [...list, next] : list.map((e, i) => (i === at ? next : e)))
    },
    drop: (variationId) => write(listOf().filter((e) => !(e.userId === uid && e.variationId === variationId))),
  }
}

module.exports = { init, get, set, useServer, setGate, gate, setPairing, pairing, forgetPairing, optedOut, runnerPrefs, finishMinutesOf, FINISH_MINUTES, browserPrefOf, BROWSER_PREFS, folderStore,
  seatStore }
