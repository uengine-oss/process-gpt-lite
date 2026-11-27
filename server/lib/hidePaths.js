// Words that leave the person's own chat (an AI answer shared to a room, saved as a document, carried into a project — lib/answerShare.js ·
// lib/chatProject.js): no path of the agent's workspace or of the host, no private address.
//   paths      a sandbox (/workspace/…) or host path (/Users/… · /home/… · /private/… · /tmp/…, file://…) — in backticks, as a Markdown link's
//              address (with or without <…>, a space after the bracket), or bare — reads as its file name, a folder as 「산출물 폴더」.
//              The same rules as the page's src/paths.js (the server image has no src/, the web image no server/): the cases in
//              server/test/hidePaths.test.js hold both to the same answers.
//   addresses  a storage address of this app (its Supabase's host, any …/storage/v1/object/…) and any address that is a key — a signature
//              or a token in it (a mail attachment's 30-minute signed copy — lib/mailAttachments.js, a share's ?sig=, a folder file's
//              ?token=, an S3 · GCS signed URL; what makes one: keyed below) — reads as its file name (a Markdown link keeps its label), or
//              「비공개 주소」 when it has none worth showing. An ordinary web page's address stays as it is, its plain ?key=… too (a search's,
//              a map's, a document's). A query left on its own — not part of a whole address — that is a key goes as well (pieces below).
// Not routes/folders.js hidePaths: that one is for a server failure's own words (git's) — any absolute path of two parts or more, and this
// server's known places even with spaces in them, as 「…/<name>」. This one is for an answer's words a person reads (the page's rules too):
// only the places agents' files live, so an answer may still say /api/v1/… or 3/4.
import { config } from '../config.js'
import { L } from './lang.js'
// the parameters a page address never shows (the browser's own reading — lib/urlTokens.js, the desktop's copy the same)
import { maskUrl } from './urlTokens.js'

const folderWord = () => L('산출물 폴더', 'the output folder')

// ---- the path rules: the same text in src/paths.js and server/lib/hidePaths.js (server/test/hidePaths.test.js holds them to the same answers)
const B = '`'
// where the agents' files live: the sandbox (/workspace), the host (/Users/…, /home/…, /private/…, /tmp/…, a temporary folder — macOS's
// /var/folders/… (os.tmpdir()), /var/tmp/…)
const ROOT = String.raw`(?:/workspace|/Users/[^/\s` + B + String.raw`'"<>()]+|/home/[^/\s` + B + String.raw`'"<>()]+|/private/(?:tmp|var)|/tmp|/var/(?:folders|tmp))(?=/|\b)`
// a Windows path: a drive (C:\… or C:/…) or a share (\\server\share\…) — what is not a word or a slash before it (not a URL's scheme)
const WIN = String.raw`(?:(?<![\w\\/])[A-Za-z]:[\\/](?![\\/])|(?<![\w\\])\\\\[\w.$-]+\\)`
const WIN_REST = String.raw`[^\s` + B + String.raw`'"<>()|*?]*`
// a path in backticks may hold spaces ("Moonlight Coffee quote.xlsx"); a bare one ends at a space
const QUOTED = new RegExp(B + '((?:' + ROOT + '|' + WIN + ')[^' + B + '\\n]*)' + B, 'g')
// a markdown link to a sandbox or host file goes nowhere: its label stays (the address may be wrapped in <…>, after a space; the label holds no
// [ — an unclosed run of [ in a long answer is read once, not once per [)
const LINKED = new RegExp(String.raw`\[([^[\]\n]+)\]\(\s*(?:<\s*(?:sandbox:|file://)?(?:` + ROOT + '|' + WIN + String.raw`)[^>\n]*>|(?:sandbox:|file://)?(?:` + ROOT + '|' + WIN + String.raw`)[^)\n]*)\s*\)`, 'g')
const BARE_WIN = new RegExp(WIN + WIN_REST, 'g')
// (after a colon too — 「경로:/workspace/…」 — but never inside an address: a word, a slash or a dot before it)
const BARE = new RegExp(String.raw`(?<![\w/.~-])(?:sandbox:|file://)?` + ROOT + String.raw`(?:/[^\s` + B + String.raw`'"<>()\[\]*,;]*)*`, 'g')
// a file has an extension; a folder (or a run room id) does not
const fileName = (p) => {
  const s = String(p).replace(/^(?:sandbox:|file:\/\/)/i, '')
  const last = s.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
  return /\.[A-Za-z0-9]{1,8}$/.test(last) && !/[\\/]$/.test(s) ? last : null
}
const trailOf = (m) => /[.:!?]+$/.exec(m)?.[0] || ''

export function hidePaths(text) {
  let t = String(text ?? '')
  if (!/\/(workspace|Users|home|private|tmp|var)\b|[A-Za-z]:[\\/]|\\\\[\w.$-]+\\/.test(t)) return t
  // (a file address of this computer: file://localhost/… is file:///…, and a drive's file:///C:/… is the drive's path)
  t = t.replace(/file:\/\/localhost(?=\/)/gi, 'file://').replace(/file:\/\/\/?(?=[A-Za-z]:[\\/])/gi, '')
  return t
    .replace(LINKED, (m, label) => label)
    .replace(QUOTED, (m, p) => { const f = fileName(p.trim()); return f ? B + f + B : folderWord() })
    .replace(BARE_WIN, (m) => { const trail = trailOf(m); return (fileName(m.slice(0, m.length - trail.length)) || folderWord()) + trail })
    .replace(BARE, (m) => { const trail = trailOf(m); return (fileName(m.slice(0, m.length - trail.length)) || folderWord()) + trail })
}
// ---- end of the path rules

// ---------- private addresses ----------
// What makes an address a key, one parameter at a time (PR #118 follow-up, PR #122 review) — the same in a whole address, in a query left on its
// own (pieces below) and in an address inside a value:
//   by name, whatever the value  what lib/urlTokens.js hides of every page address (asked of it name by name — its list is never written here
//                                again: token · sig · signature · S3 · GCS · CloudFront signing · access_token · api_key · client_secret …), but not
//                                `key` — and auth · secret · password · passwd · pwd and the spellings it does not read (accessToken, auth_token,
//                                private_token, x-api-key, api-key, subscription-key, q-signature; a Markdown access\_token): NAMES
//   by its look                  `key` and a name with key · token · secret · auth · pass · session · sig · code in it, when the value — as written or
//                                decoded — looks like a secret (secretShape: its length and its characters); an OAuth answer's code (a state beside it)
//   whatever the name            a JWT, a Google API key, a GitHub token (SECRET_VALUE)
//   the address's own parts      a password; a user name that looks like a secret; a fragment holding a session (a JSON object); an address inside a
//                                value (once or twice %-encoded) that is a key
// A value that only names its place — …, ..., YOUR_TOKEN, your-api-key, ${t}, {token}, <값>, xxx, $TOKEN, getToken(), words in Hangul — is no secret
// (PLACEHOLDER: written as a placeholder is, and not itself a secret's look).
const NAMES = new Set(['auth', 'secret', 'password', 'passwd', 'pwd', 'accesstoken', 'authtoken', 'privatetoken', 'xapikey', 'apikey', 'subscriptionkey',
  'ocpapimsubscriptionkey', 'qsignature', 'xauthtoken', 'sessiontoken', 'refreshtoken', 'idtoken', 'clientsecret'])
// a name read in its parts (snake · kebab · dotted · camelCase): one of them is a key's word, or the name ends in one (apikey, accesstoken) —
// 「design」 · 「promotion」 have the letters but not the word
const SHAPED_PARTS = new Set(['key', 'token', 'secret', 'auth', 'pass', 'passwd', 'password', 'pwd', 'session', 'sig', 'signature', 'code', 'credential', 'credentials'])
const SHAPED_END = /(?:key|token|secret|signature|password)$/
function shapedName(rawName) {
  const parts = decoded(rawName).replace(/\\/g, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[-_.\s]+/).filter(Boolean)
  return parts.some((x) => SHAPED_PARTS.has(x)) || SHAPED_END.test(parts.join(''))
}
const SECRET_VALUE = /^(?:eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{30,})$/
const PLACEHOLDER = /^(?:…+|\.{2,}|\$\{\s*[\w.]+\s*\}|\$[A-Z_][A-Z0-9_]*|\{\{?\s*[\w.-]+\s*\}?\}|<[^<>"':=&]{1,40}>|[xX*]{3,}|(?:YOUR|your)[-_][\w-]*|[A-Za-z_$][\w$.]*\(\))$/
// a placeholder — and not a secret wearing one's brackets (what is inside <…> · {…} · ${…} is looked at too)
function placeholder(value, raw) {
  if (!PLACEHOLDER.test(value)) return false
  const bare = value.replace(/^(?:\$\{|\{\{?|<)\s*/, '').replace(/\s*(?:\}\}?|>)$/, '')
  return ![value, raw, bare].some(secretShape)
}
// a secret's look: 20 characters or more of a token's alphabet, letters and digits both, a run of 12 letters or digits in it — 「seoul-office-
// 2024-11-28」 is not one, a hex digest, a base64 token, a uuid are
export function secretShape(v) {
  const s = String(v ?? '')
  return s.length >= 20 && /^[A-Za-z0-9_\-.~+/=]+$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s) && /[A-Za-z0-9]{12}/.test(s)
}
const decoded = (x) => { try { return decodeURIComponent(String(x).replace(/\+/g, ' ')) } catch { return String(x) } }
// a parameter's name as it is read: decoded, any case, a Markdown escape taken off
const nameOf = (raw) => decoded(raw).trim().toLowerCase().replace(/\\/g, '')
const squash = (name) => name.replace(/[-_.\s]/g, '')
// urlTokens.js's own answer for a name (remembered: one question per name)
const asked = new Map()
function urlTokensHides(name) {
  // (a name past 64 characters is asked each time — the memory keeps short names only)
  if (name.length > 64) { const probe = `http://x.invalid/?${encodeURIComponent(name)}=1`; return maskUrl(probe) !== probe }
  if (!asked.has(name)) {
    if (asked.size > 2000) asked.clear()
    const probe = `http://x.invalid/?${encodeURIComponent(name)}=1`
    asked.set(name, maskUrl(probe) !== probe)
  }
  return asked.get(name)
}
// an address written in a value, once or twice %-encoded (a relative one with its own query too)
function innerUrl(value) {
  let v = value
  for (let i = 0; i < 3 && v; i++) {
    if (/^(?:https?:)?\/\/[^/\s]/i.test(v)) { try { return new URL(/^\/\//.test(v) ? `https:${v}` : v) } catch { return null } }
    if (/^\/[^/\s]/.test(v) && /[?#]/.test(v)) { try { return new URL(v, 'http://x.invalid') } catch { return null } }
    let next
    try { next = decodeURIComponent(v) } catch { return null }
    if (next === v) return null
    v = next
  }
  return null
}
// one parameter (raw: as written); state: the same part has a state (an OAuth answer)
function hiddenParam(rawName, raw, { state = false, depth = 0 } = {}) {
  if (!raw) return false
  const name = nameOf(rawName)
  const value = decoded(raw)
  if (placeholder(value, raw) || /^[^\x00-\x7f]+$/.test(value)) return false
  if ((name !== 'key' && urlTokensHides(name)) || NAMES.has(squash(name))) return true
  if (name === 'code' && state) return true
  if (SECRET_VALUE.test(value) || SECRET_VALUE.test(raw)) return true
  if ((name === 'key' || shapedName(rawName)) && (secretShape(raw) || secretShape(value))) return true
  const inner = depth < 2 ? innerUrl(value) : null
  return !!inner && keyed(inner, depth + 1)
}
// a query's (or a fragment's) name=value pieces, as urlTokens.js splits them (& and ;) — a hash route's own query after its ?
const partOf = (part) => {
  const q = part.indexOf('?')
  return q >= 0 && !part.slice(0, q).includes('=') ? part.slice(q + 1) : part
}
function partKeyed(part, depth) {
  const pieces = partOf(part).split(/[&;]/).filter(Boolean)
  const state = pieces.some((p) => nameOf(p.split('=')[0]) === 'state')
  return pieces.some((p) => { const eq = p.indexOf('='); return eq > 0 && hiddenParam(p.slice(0, eq), p.slice(eq + 1), { state, depth }) })
}
const sessionLike = (hash) => { try { const v = JSON.parse(decodeURIComponent(hash)); return !!v && typeof v === 'object' && Object.keys(v).length > 0 } catch { return false } }
// a parsed address that is a key (the storage rules aside)
function keyed(u, depth = 0) {
  if (u.password) return true
  if (u.username) { const n = decoded(u.username); if (secretShape(n) || SECRET_VALUE.test(n)) return true }
  const hash = u.hash.slice(1)
  return partKeyed(u.search.slice(1), depth) || (!!hash && (partKeyed(hash, depth) || sessionLike(hash)))
}
const hostOf = (u) => { try { return new URL(u).host.toLowerCase() } catch { return '' } }
// this app's own storage hosts (its Supabase, the address the office host gives the documents it makes)
export const storageHosts = () => [config.supabaseUrl, config.supabasePublicUrl].map(hostOf).filter(Boolean)
// (an address without a scheme — //host/… — is read as https; a scheme in capitals is a scheme)
const parse = (raw) => { try { return new URL(/^\/\//.test(raw) ? `https:${raw}` : raw) } catch { return null } }
export function privateUrl(raw, hosts = storageHosts()) {
  const u = parse(String(raw || '').trim())
  if (!u || !/^https?:$/.test(u.protocol)) return false
  if (hosts.includes(u.host.toLowerCase())) return true
  if (/\/storage\/v1\/object\//i.test(u.pathname)) return true
  return keyed(u)
}
// what a private address reads as: its file's name — not a storage key's made-up name (a uuid) — or 「비공개 주소」
export function urlName(raw) {
  let last = ''
  try { last = decodeURIComponent(parse(String(raw).trim())?.pathname.split('/').filter(Boolean).pop() || '') } catch { last = '' }
  if (!/\.[A-Za-z0-9]{1,8}$/.test(last) || /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\./i.test(last) || /^[0-9a-f]{24,}\./i.test(last)) return L('비공개 주소', 'a private address')
  return last
}
const URLISH = /^(?:https?:)?\/\//i
// a Markdown link: its address in <…> (spaces and brackets allowed) or bare (one level of brackets allowed), with or without a title
// (its words hold no [ — an unclosed run of [ in a long answer is read once, not once per [: PR #122 review)
const MD_LINK = /\[([^[\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"[^"\n]*")?\s*\)/g
const ANGLED = /<((?:https?:)?\/\/[^\s<>]+)>/gi
// a bare address — with a scheme in any case, or //host/… (one level of brackets in it, as Markdown allows) — and what carries it on when it was
// broken: a line that starts with its query or its path (「…/report.pdf」 then 「?token=…」), or its query after a space on the same line
// (「…/report.pdf ?token=…」)
const CH = String.raw`[^\s<>()[\]"'` + '`' + ']'
const TAIL = `(?:${CH}|\\(${CH}*\\))*`
const MORE = String.raw`(?:(?:\r?\n[?&/]|[ \t]+[?&](?=[\w.~%+-]+=))` + TAIL + ')*'
const BARE_URL = new RegExp(String.raw`(?:\bhttps?:\/\/|(?<![\w:/.])\/\/(?:[\w-]+\.)+[\w-]{2,}(?::\d+)?(?=[/?]))` + TAIL + MORE, 'gi')
// A query left on its own (PR #118 follow-up, PR #122 review): 「?token=…」 · 「&sig=…」 · 「#access_token=…」, a pair after a space or at a line's start
// (「token=…」), in the words, in backticks, after a word or a piece of an address that is no whole address — each value that is a key (hiddenParam)
// reads 「…」, as urlTokens.js masks it; the rest stays as written (an example, a code sample keeps its shape).
// (a value may hold one level of (…) or {…} — getToken(), ${t} — but never takes a closing bracket it did not open: 「{auth=abc}」)
const VALUE = String.raw`(?:[^\s&;#<>()[\]{}"'` + '`' + String.raw`]|\([^\s&;#<>()[\]{}"'` + '`' + String.raw`]*\)|\{[^\s&;#<>()[\]{}"'` + '`' + String.raw`]*\})*`
const PAIR = String.raw`[\w.~%+\\-]+=` + VALUE
const PIECE = new RegExp(String.raw`(?:([?&#;])|(?<![^\s(\[{"'` + '`' + String.raw`,:]))(` + PAIR + String.raw`(?:[&;]` + PAIR + ')*)', 'g')
function maskPiece(m, lead, body) {
  const bits = body.split(/([&;])/)
  const state = bits.some((p, i) => i % 2 === 0 && nameOf(p.slice(0, p.indexOf('='))) === 'state')
  let changed = false
  const out = bits.map((p, i) => {
    const eq = p.indexOf('=')
    if (i % 2 || eq <= 0 || !hiddenParam(p.slice(0, eq), p.slice(eq + 1), { state })) return p
    changed = true
    return `${p.slice(0, eq)}=…`
  }).join('')
  return changed ? `${lead || ''}${out}` : m
}
export function dropPrivateUrls(text, hosts = storageHosts()) {
  const t = String(text ?? '')
  if (!/\/\/|[\w%\\-]=/.test(t)) return t
  return t
    .replace(MD_LINK, (m, label, angled, bare) => {
      const url = (angled || bare || '').trim()
      return URLISH.test(url) && privateUrl(url, hosts) ? (label.trim() || urlName(url)) : m
    })
    .replace(ANGLED, (m, url) => (privateUrl(url, hosts) ? urlName(url) : m))
    .replace(BARE_URL, (m) => {
      const trail = /[.,;:!?]+$/.exec(m)?.[0] || ''
      const url = m.slice(0, m.length - trail.length).replace(/\s+/g, '')
      return privateUrl(url, hosts) ? urlName(url) + trail : m
    })
    .replace(PIECE, maskPiece)
}

// both at once: what a shared answer may say (the addresses first — a broken address's next line may look like a path)
export const cleanShared = (text, hosts) => hidePaths(dropPrivateUrls(text, hosts))
