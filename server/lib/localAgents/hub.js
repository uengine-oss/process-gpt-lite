// The desktops' links (lib/localAgents): each desktop app keeps one outgoing WebSocket to /api/local-agents/link — no port is opened
// on anyone's computer. The first message is {type:'hello', token, device, caps, prefs, active}; the token (devices.js) names one
// person on one device, so a link only ever gets that person's jobs (jobs.js). Presence is this map, in memory: a desktop is "on"
// while its link is open (one server process — like the workroom's terminals).
// The page never talks to this link; it is the desktop app's main process (desktop/src/runner/link.js).
import { WebSocketServer } from 'ws'
import { withTenant, servesTenant } from '../tenant.js'
import * as D from './devices.js'
import * as R from './relay.js'
import * as BL from './browserLink.js'
import * as SY from '../folders/sources.js'

const HELLO_MS = 10_000
const PING_MS = 25_000
const links = new Map() // `${tenant}:${userId}` → Map(deviceId → link)
// online: a link came on (what it was running is checked against what it says it runs) · caps: it reported new capabilities or settings
// (only the queue is worked again — a run is never taken back for that) · message · offline
let handlers = { online: async () => {}, caps: async () => {}, message: async () => {}, offline: async () => {} }
export function setHandlers(h) { handlers = { ...handlers, ...h } }

const keyOf = (tenant, userId) => `${tenant}:${userId}`
export const linksOf = (tenant, userId) => [...(links.get(keyOf(tenant, String(userId))) || new Map()).values()]
export const linkOf = (tenant, deviceId) => { for (const [k, m] of links) if (k.startsWith(`${tenant}:`) && m.has(deviceId)) return m.get(deviceId); return null }
export const allLinks = (tenant) => [...links.entries()].filter(([k]) => k.startsWith(`${tenant}:`)).flatMap(([, m]) => [...m.values()])

// A link: what it reported and how to talk to it. `transport` is {send(text), close(code, reason)} — a WebSocket, or a test's fake.
function makeLink(transport, device, hello) {
  return {
    id: device.id,
    device,
    tenant: device.tenant_id,
    userId: String(device.user_id),
    name: device.name,
    caps: D.capsOf(hello.caps),
    prefs: D.prefsOf(hello.prefs),
    active: new Set((Array.isArray(hello.active) ? hello.active : []).map(String).slice(0, 20)),
    since: new Date(),
    send(msg) { try { transport.send(JSON.stringify(msg)); return true } catch { return false } },
    close(code = 1000, reason = '') { try { transport.close(code, reason) } catch { /* gone */ } },
  }
}

// a hello checked → the link registered (an older link of the same device is replaced) → link, or {error, code}
export async function open(transport, hello) {
  if (hello?.type !== 'hello') return { error: 'say hello first', code: 4400 }
  const device = await D.byToken(hello.token)
  if (!device) return { error: 'this device token is not valid (revoked, or never issued here)', code: 4401 }
  if (!servesTenant(device.tenant_id)) return { error: 'this server does not serve the device\'s company', code: 4403 }
  const link = makeLink(transport, device, hello)
  const k = keyOf(link.tenant, link.userId)
  if (!links.has(k)) links.set(k, new Map())
  const old = links.get(k).get(link.id)
  if (old) { old.replaced = true; old.close(4409, 'replaced by a newer link of this device') }
  links.get(k).set(link.id, link)
  await withTenant(link.tenant, () => D.seen(link.id, { caps: link.caps, prefs: link.prefs, name: hello.device?.name, appVersion: hello.device?.appVersion })).catch(() => {})
  const [u] = await withTenant(link.tenant, async () => (await import('../supa.js')).q('select name from pro_profile where user_id=$1', [link.userId])).catch(() => [])
  link.send({ type: 'welcome', device: { id: link.id, name: link.name }, user: { id: link.userId, name: u?.name || '' } })
  console.log(`[local-agents] ${link.name} (${link.userId.slice(0, 8)}) online · ${Object.entries(link.caps.clis).filter(([, c]) => c.installed).map(([k, c]) => `${k} ${c.version || ''}`.trim()).join(', ') || 'no CLI'}`)
  await withTenant(link.tenant, () => handlers.online(link)).catch((e) => console.warn('[local-agents] online', e.message))
  // (a browser task paused because this PC went off goes on — browserLink.js waitForLink)
  BL.linkOn(link)
  return link
}

// a message from a link (after its hello)
export async function receive(link, msg) {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'pong') { link.lastPong = Date.now(); return }
  if (msg.type === 'caps') {
    const had = !!link.caps?.browser
    if (msg.caps) link.caps = D.capsOf(msg.caps)
    if (msg.prefs) link.prefs = D.prefsOf(msg.prefs)
    // (what it runs now, when it says: the jobs it holds are its own)
    if (Array.isArray(msg.active)) link.active = new Set(msg.active.map(String).slice(0, 20))
    await withTenant(link.tenant, () => D.seen(link.id, { caps: link.caps, prefs: link.prefs })).catch(() => {})
    await withTenant(link.tenant, () => handlers.caps(link)).catch((e) => console.warn('[local-agents] caps', e.message))
    if (!had && link.caps.browser) BL.linkOn(link)
    return
  }
  // a terminal's bytes, hook events and watched files (relay.js)
  if (R.handles(msg)) return withTenant(link.tenant, () => R.receive(link, msg)).catch((e) => console.warn('[local-agents] relay', msg.type, e.message))
  // the browser on this PC: answers, live frames, downloads (browserLink.js — a browser task routed to this desktop)
  if (BL.handles(msg)) return withTenant(link.tenant, () => BL.receive(link, msg)).catch((e) => console.warn('[local-agents] browser', msg.type, e.message))
  // a folder this PC uploads (champion folders — folders/sources.js): bind · token · pushed · unbind. (What a push brought in goes into
  // main in the folder's own lock: the link's other messages — a run's terminal bytes — do not wait for it.)
  if (SY.handles(msg)) {
    const run = withTenant(link.tenant, () => SY.receive(link, msg)).catch((e) => console.warn('[local-agents] sync', msg.type, e.message))
    return msg.type === 'sync:pushed' ? undefined : run
  }
  await withTenant(link.tenant, () => handlers.message(link, msg)).catch((e) => console.warn('[local-agents] message', msg.type, e.message))
}

export async function gone(link) {
  const m = links.get(keyOf(link.tenant, link.userId))
  if (m?.get(link.id) === link) m.delete(link.id)
  if (m && !m.size) links.delete(keyOf(link.tenant, link.userId))
  R.linkGone(link)
  BL.linkGone(link)
  if (link.replaced) return
  console.log(`[local-agents] ${link.name} (${link.userId.slice(0, 8)}) offline`)
  await withTenant(link.tenant, () => handlers.offline(link)).catch((e) => console.warn('[local-agents] offline', e.message))
}

// a revoked device: its link goes now
export function closeDevice(tenant, deviceId, reason = 'revoked') {
  const l = linkOf(tenant, deviceId)
  if (l) l.close(4401, reason)
  return !!l
}

// how many desktops of the company can run each local agent now (the activity settings show it)
export function catalog(tenant) {
  const out = {}
  for (const l of allLinks(tenant)) {
    for (const [id, c] of Object.entries(l.caps.clis || {})) {
      if (!c.installed) continue
      out[id] ||= { devices: 0, people: new Set() }
      out[id].devices++
      out[id].people.add(l.userId)
    }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { devices: v.devices, people: v.people.size }]))
}

// ---------- the WebSocket ----------
export function attach(server, { path = '/api/local-agents/link' } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
  server.on('upgrade', (req, socket, head) => {
    let url
    try { url = new URL(req.url, 'http://x') } catch { return }
    if (url.pathname !== path && !url.pathname.endsWith(path)) return
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws))
  })
  return wss
}

function serve(ws) {
  let link = null
  let closed = false
  const transport = { send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) }
  const helloTimer = setTimeout(() => { if (!link) ws.close(4408, 'no hello') }, HELLO_MS)
  const ping = setInterval(() => {
    if (!link) return
    if (link.lastPong && Date.now() - link.lastPong > PING_MS * 3) return ws.terminate()
    link.send({ type: 'ping', at: Date.now() })
  }, PING_MS)
  let chain = Promise.resolve()
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw) } catch { return }
    // one message at a time, in order (a job's progress before its done)
    chain = chain.then(async () => {
      if (closed) return
      if (!link) {
        const r = await open(transport, msg).catch((e) => ({ error: e.message, code: 4500 }))
        if (r.error) { ws.send(JSON.stringify({ type: 'denied', code: r.code, reason: r.error })); ws.close(r.code, 'denied'); return }
        link = r
        link.lastPong = Date.now()
        clearTimeout(helloTimer)
        return
      }
      await receive(link, msg)
    }).catch((e) => console.warn('[local-agents] link', e.message))
  })
  ws.on('close', () => {
    closed = true
    clearTimeout(helloTimer)
    clearInterval(ping)
    if (link) chain = chain.then(() => gone(link))
  })
  ws.on('error', () => {})
}

// tests: forget every link
export function reset() { links.clear() }
