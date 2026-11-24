'use strict'
// The Lite server the window opens: what the person typed → its base address, and a check that a Lite
// server answers there before it is saved (as the Android app does — a typo shows on the setup page,
// not as a blank window). No Electron here: unit-tested in test/server.test.js with a fake fetch.

// the web app's own pages: an address copied from the address bar (…/lite/chat) means its base
const APP_ROUTES = ['chat', 'login', 'auth', 'welcome', 'routines', 'projects', 'settings', 'workroom', 'folders', 'mining',
  'improve', 'process-map', 'strategy', 'agentic', 'backoffice', 'team-activity', 'context']
const LOCAL_HOST = /^(?:localhost|(?:[a-z0-9-]+\.)*localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i

/** "acme.process-gpt.io/lite/chat" → "https://acme.process-gpt.io/lite"; "localhost:18080" → "http://localhost:18080"; '' when not a web address.
 * Forgiving with what people type: spaces, a scheme typed twice or half ("https//", "https:/", "http;//"), a company name alone
 * ("acme" → acme.process-gpt.io), ".process-gpt" without ".io". */
const COMPANY_DOMAIN = 'process-gpt.io'
function normalize(raw) {
  let s = String(raw || '').replace(/\s+/g, '')
  // every scheme at the front, whole or half-typed: the last whole one counts (else inferred below)
  let scheme = ''
  for (;;) {
    const m = /^(https?)(?::\/\/|:\/|\/\/|;\/\/|:)/i.exec(s)
    if (!m) break
    scheme = m[1].toLowerCase()
    s = s.slice(m[0].length)
  }
  s = s.replace(/^\/+/, '')
  if (!s) return ''
  // the host: a company name alone gets the company domain, a ".process-gpt" its ".io"
  const cut = s.search(/[/?#]/)
  let hostPort = cut < 0 ? s : s.slice(0, cut)
  const rest = cut < 0 ? '' : s.slice(cut)
  const [, hostRaw = '', port = ''] = /^([^:]*)(:\d+)?$/.exec(hostPort) || []
  let host = hostRaw.toLowerCase().replace(/\.+$/, '')
  if (!host) return ''
  if (!LOCAL_HOST.test(host) && !host.includes('.') && !/^\[/.test(host)) host = `${host}.${COMPANY_DOMAIN}`
  else if (/\.process-gpt$/.test(host)) host = `${host}.io`
  hostPort = host + (port || '')
  // the company addresses answer on https only
  if (host.endsWith(`.${COMPANY_DOMAIN}`)) scheme = 'https'
  s = `${scheme || (LOCAL_HOST.test(host) ? 'http' : 'https')}://${hostPort}${rest}`
  let u
  try { u = new URL(s) } catch { return '' }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
  if (u.username || u.password) return ''
  const parts = u.pathname.split('/').filter(Boolean)
  const at = parts.findIndex((p) => APP_ROUTES.includes(p))
  const keep = at < 0 ? parts : parts.slice(0, at)
  return `${u.origin}${keep.length ? '/' + keep.join('/') : ''}`
}

/** The addresses to try: the base, and for a bare company domain also its /lite (Lite behind the ProcessGPT gateway). */
function candidates(raw) {
  const base = normalize(raw)
  if (!base) return []
  return new URL(base).pathname === '/' ? [base, `${base}/lite`] : [base]
}

// the Supabase sign-in a Lite behind the gateway sends Google sign-in through (/api/config sso.google)
function authOriginsOf(cfg) {
  const out = []
  try { if (cfg?.sso?.google) out.push(new URL(cfg.sso.google).origin) } catch { /* not an address */ }
  return out
}
const isLiteConfig = (j) => !!j && typeof j === 'object' && !Array.isArray(j) && ('demoLogin' in j || 'vault' in j || 'googleLogin' in j)

/**
 * Ask <base>/api/config. → { ok: true, server, authOrigins } or { ok: false, reason: 'empty' | 'unreachable' | 'auth' | 'notLite', detail? }
 * user/pass: the basic-auth pair of a server published behind one (a tunnel's gate).
 */
async function check(raw, { fetch, user = '', pass = '', timeout = 8000 } = {}) {
  const list = candidates(raw)
  if (!list.length) return { ok: false, reason: 'empty' }
  const headers = { Accept: 'application/json' }
  if (user) headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  let last = { ok: false, reason: 'unreachable' }
  for (const base of list) {
    let r
    try {
      r = await fetch(`${base}/api/config`, { headers, signal: AbortSignal.timeout(timeout) })
    } catch (e) {
      last = { ok: false, reason: 'unreachable', detail: String(e?.message || e).slice(0, 200) }
      continue
    }
    if (r.status === 401) { last = { ok: false, reason: 'auth' }; continue }
    let j = null
    try { j = r.ok ? await r.json() : null } catch { j = null }
    if (!isLiteConfig(j)) { if (last.reason !== 'auth') last = { ok: false, reason: 'notLite', detail: `HTTP ${r.status}` }; continue }
    return { ok: true, server: base, authOrigins: authOriginsOf(j) }
  }
  return last
}

module.exports = { normalize, candidates, check, authOriginsOf }
