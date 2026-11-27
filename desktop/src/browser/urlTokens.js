'use strict'
// Page addresses leave this PC (the live view, every answer's page, a look) with the values of sign-in tokens and signatures as "…"
// (host.js). The server's own function, copied as it is (keep identical: server/lib/urlTokens.js — server/test/urlTokens.test.js fails
// when the two differ); the server masks what it shows and keeps of them too. The browser here always goes to the address as it was.

// ---- the server's (keep identical: server/lib/urlTokens.js) ----
function maskUrl(raw) {
  const s = String(raw ?? '')
  let u
  try { u = new URL(s) } catch { return s }
  const HIDE = ['access_token', 'refresh_token', 'id_token', 'provider_token', 'provider_refresh_token', 'code', 'token', 'sig']
  const nameOf = (k) => { try { return decodeURIComponent(k.replace(/\+/g, ' ')).trim().toLowerCase() } catch { return k.trim().toLowerCase() } }
  const pairs = (part) => part.split('&').map((p) => {
    const eq = p.indexOf('=')
    return eq > 0 && eq < p.length - 1 && HIDE.includes(nameOf(p.slice(0, eq))) ? `${p.slice(0, eq)}=…` : p
  }).join('&')
  const isJson = (part) => { try { const v = JSON.parse(decodeURIComponent(part)); return v !== null && typeof v === 'object' } catch { return false } }
  // a fragment: a JSON object, a hash route with its own query (#/path?a=1), or name=value pairs (#access_token=…)
  const fragment = (part) => {
    if (isJson(part)) return '…'
    const q = part.indexOf('?')
    return q >= 0 && !part.slice(0, q).includes('=') ? `${part.slice(0, q + 1)}${pairs(part.slice(q + 1))}` : pairs(part)
  }
  const { search, hash } = u
  let head = u.href.slice(0, u.href.length - search.length - hash.length)
  if (u.password) head = head.replace(`//${u.username}:${u.password}@`, `//${u.username}:…@`)
  return `${head}${search ? `?${pairs(search.slice(1))}` : ''}${hash ? `#${fragment(hash.slice(1))}` : ''}`
}

module.exports = { maskUrl }
