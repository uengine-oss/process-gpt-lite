'use strict'
// What the app remembers, in <userData>/desktop-settings.json:
//   server       — the Lite server's base address (https://acme.process-gpt.io/lite, http://localhost:18080)
//   recent       — servers used before (setup page list), newest first
//   authOrigins  — the server's Supabase sign-in origin(s) (server.js authOriginsOf), refreshed on every start
//   gate         — { user, pass } basic-auth pair for a server published behind one; pass encrypted with the
//                  OS keychain (safeStorage) when it is available
//   window       — { x, y, width, height, maximized }
//   lang         — 'ko' | 'en': the web app's language last seen (menu labels)
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

module.exports = { init, get, set, useServer, setGate, gate }
