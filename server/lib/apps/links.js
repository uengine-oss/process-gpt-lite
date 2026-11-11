// Demo addresses for MCP Apps hosts outside Lite (docs/robo-dlc/plan-mcp-apps.md §6). A host such as Claude connects
// to an app's MCP server by URL and cannot carry Lite's sign-in, so this is a signed address for one app, one person
// and one folder, until a time: /api/apps/<id>/mcp/link/<key>. Off unless PRO_APPS_LINK_SECRET is set. It is for
// trying an app in another host, not a login: the product way is MCP's OAuth.
import crypto from 'node:crypto'

const b64u = (b) => Buffer.from(b).toString('base64url')
const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('base64url')

export function makeLink(secret, { app, user, folder, hours = 4 }) {
  if (!secret) throw new Error('PRO_APPS_LINK_SECRET is not set')
  const body = b64u(JSON.stringify({ a: app, u: user.id, n: user.name || '', f: folder, exp: Date.now() + hours * 3600_000 }))
  return `${body}.${sign(secret, body)}`
}

// {app, user: {id, name}, folder, exp} for a good address, null otherwise
export function readLink(secret, key) {
  if (!secret) return null
  const [body, mac] = String(key || '').split('.')
  if (!body || !mac) return null
  const want = Buffer.from(sign(secret, body))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null
  let v
  try { v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) } catch { return null }
  if (!v?.a || !v?.u || !v?.f || !(v.exp > Date.now())) return null
  return { app: v.a, user: { id: v.u, name: v.n || '' }, folder: v.f, exp: v.exp }
}

// every tool call through the address is about its folder: filled in when left out, refused when it names another
export function bindFolder(body, folder) {
  for (const m of Array.isArray(body) ? body : [body]) {
    if (m?.method !== 'tools/call') continue
    const p = (m.params ||= {})
    const a = (p.arguments ||= {})
    if (a.folder == null || a.folder === '') a.folder = folder
    else if (a.folder !== folder) return { jsonrpc: '2.0', id: m.id ?? null, error: { code: -32001, message: 'this address is for one folder' } }
  }
  return null
}
