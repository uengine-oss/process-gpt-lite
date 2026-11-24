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
//   runnerPrefs  — {enabled, ask}: local runs on or off, and asking before each run
//   runnerOptOut — { [server]: [userId…] }: people who disconnected this computer here (it is not paired again by itself)
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
const runnerPrefs = () => ({ enabled: data.runnerPrefs?.enabled !== false, ask: data.runnerPrefs?.ask === true })

module.exports = { init, get, set, useServer, setGate, gate, setPairing, pairing, forgetPairing, optedOut, runnerPrefs }
