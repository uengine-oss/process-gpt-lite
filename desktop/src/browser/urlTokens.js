'use strict'
// Page addresses leave this PC with the values of sign-in tokens, keys and signatures as "…": the live view, a look, the page an answer
// is on (host.js — every answer also carries the address itself, for the server to go back there; the server never shows it). The
// server's own functions, copied as they are (keep identical: server/lib/urlTokens.js — server/test/urlTokens.test.js fails when the
// two differ). The browser here always goes to the address as it was.

// ---- the server's (keep identical: server/lib/urlTokens.js) ----
// The address with these values as "…", read from its own structure (it is parsed, never searched):
//   · parameters by name (any case, %-encoded or not), in the query and in the fragment (a hash route's query too), separated by
//     & or ; — access_token · refresh_token · id_token · provider_token · provider_refresh_token · token · token_hash · sig ·
//     signature · policy · key-pair-id · x-amz-signature · x-amz-credential · x-amz-security-token · x-goog-signature ·
//     x-goog-credential · oauth_token · oauth_verifier · jwt · key · api_key · apikey · client_secret; code when the same part has
//     a state (an OAuth answer) or the host is one opts.authHost(hostname) names
//   · an address inside a parameter's value (one level: ?next=https%3A…%23access_token%3D…), masked the same way
//   · the user name and password in the address itself, and a fragment that holds a JSON object (a sign-in's session)
// Anything that is not an absolute address is returned as it is.
function maskUrl(raw, opts = {}) {
  const s = String(raw ?? '')
  let u
  try { u = new URL(s) } catch { return s }
  const HIDE = ['access_token', 'refresh_token', 'id_token', 'provider_token', 'provider_refresh_token', 'token', 'token_hash', 'sig', 'signature',
    'policy', 'key-pair-id', 'x-amz-signature', 'x-amz-credential', 'x-amz-security-token', 'x-goog-signature', 'x-goog-credential', 'oauth_token',
    'oauth_verifier', 'jwt', 'key', 'api_key', 'apikey', 'client_secret']
  const decode = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')) } catch { return x } }
  const nameOf = (k) => decode(k).trim().toLowerCase()
  let authHost = false
  try { authHost = !!opts.authHost?.(u.hostname) } catch { /* no answer: not one */ }
  // name=value pieces (the separators kept as they were); depth: an address inside a value is looked into once
  const pairs = (part, depth) => {
    const bits = part.split(/([&;])/)
    const names = bits.filter((_, i) => i % 2 === 0).map((p) => nameOf(p.split('=')[0]))
    const code = authHost || names.includes('state')
    return bits.map((p, i) => {
      if (i % 2) return p
      const eq = p.indexOf('=')
      if (eq <= 0 || eq === p.length - 1) return p
      const name = nameOf(p.slice(0, eq))
      if (HIDE.includes(name) || (code && name === 'code')) return `${p.slice(0, eq)}=…`
      if (depth > 0) return p
      const value = decode(p.slice(eq + 1))
      let inner = null
      try { inner = new URL(value) } catch { try { if (/^\/[^/]/.test(value)) inner = new URL(value, 'http://x.invalid') } catch { /* not an address */ } }
      if (!inner || (!inner.search && !inner.hash && !inner.password && !inner.username)) return p
      const whole = inner.origin === 'http://x.invalid' ? null : value
      const masked = whole === null ? mask(inner, 1).slice('http://x.invalid'.length) : mask(inner, 1)
      return masked === value ? p : `${p.slice(0, eq + 1)}${encodeURIComponent(masked).replace(/%E2%80%A6/g, '…')}`
    }).join('')
  }
  const isJson = (part) => { try { const v = JSON.parse(decodeURIComponent(part)); return v !== null && typeof v === 'object' } catch { return false } }
  // a fragment: a JSON object, a hash route with its own query (#/path?a=1), or name=value pairs (#access_token=…)
  const fragment = (part, depth) => {
    if (isJson(part)) return '…'
    const q = part.indexOf('?')
    return q >= 0 && !part.slice(0, q).includes('=') ? `${part.slice(0, q + 1)}${pairs(part.slice(q + 1), depth)}` : pairs(part, depth)
  }
  const mask = (x, depth) => {
    const { search, hash } = x
    let head = x.href.slice(0, x.href.length - search.length - hash.length)
    if (x.username || x.password) head = head.replace(`//${x.username}${x.password ? `:${x.password}` : ''}@`, `//${x.username ? '…' : ''}${x.password ? ':…' : ''}@`)
    return `${head}${search ? `?${pairs(search.slice(1), depth)}` : ''}${hash ? `#${fragment(hash.slice(1), depth)}` : ''}`
  }
  return mask(u, 0)
}

// A page title as shown: a page with no title of its own is titled with its address (the PC's browser does so) — that address is
// masked like any other; any other title is returned as it is.
function maskTitle(title, url) {
  const t = String(title ?? '')
  const raw = String(url ?? '')
  if (!t || !raw) return t
  const shown = maskUrl(raw)
  if (shown === raw) return t
  const bare = (x) => x.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  if (t.includes(raw)) return t.split(raw).join(shown)
  if (t.includes(bare(raw))) return t.split(bare(raw)).join(bare(shown))
  return t
}

module.exports = { maskUrl, maskTitle }
