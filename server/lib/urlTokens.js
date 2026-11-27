// Page addresses as they are shown or kept — the browser agent's view of the page (the model), the live view, a task's card and
// result, log lines — never carry the values of sign-in tokens or signatures. Both browsers use the same function: this server's
// (lib/browser.js, for this server's Chromium and for what a PC's browser reports) and the browser on the person's PC
// (desktop/src/browser/urlTokens.js — the desktop runs its own copy; test/urlTokens.test.js fails when the two differ). The browser
// itself always goes to the address as it was: only what is shown or kept is masked.

// The address with these parameters' values as "…" — access_token · refresh_token · id_token · provider_token ·
// provider_refresh_token · code · token · sig — in the query and in the fragment (a hash route's query too), by name (any case,
// %-encoded or not); a password in the address itself, and a fragment that holds a JSON object (a sign-in's session), as "…" too.
// Read from the address's own structure (it is parsed, never searched). Anything that is not an absolute address is returned as it is.
export function maskUrl(raw) {
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
