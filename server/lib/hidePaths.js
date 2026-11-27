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
// a markdown link to a sandbox or host file goes nowhere: its label stays (the address may be wrapped in <…>, after a space)
const LINKED = new RegExp(String.raw`\[([^\]\n]+)\]\(\s*(?:<\s*(?:sandbox:|file://)?(?:` + ROOT + '|' + WIN + String.raw`)[^>\n]*>|(?:sandbox:|file://)?(?:` + ROOT + '|' + WIN + String.raw`)[^)\n]*)\s*\)`, 'g')
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
// What makes an address a key (PR #118 follow-up — narrowed: an ordinary ?key=… is not one):
//   · what lib/urlTokens.js hides of every page address (maskUrl — read as it reads it, nothing listed twice): its signing and sign-in
//     parameters by name whatever their value (token · sig · signature · S3 · GCS · CloudFront signing · access_token · api_key · apikey ·
//     jwt · client_secret …), an OAuth answer's code, an address inside a value, a password in the address, a fragment that holds a session —
//     but not `key`, nor a user name with no password: ordinary pages use them too (a search's, a map's, a document's key)
//   · key · auth · secret when the value looks like a secret (secretShape: its length and its characters)
//   · a value that is one whatever its name: a Google API key (AIza…), a JWT (eyJ….….…)
const PLAIN = new Set(['key'])
const SHAPED = new Set(['key', 'auth', 'secret'])
const SECRET_VALUE = /^(?:AIza[0-9A-Za-z_-]{20,}|eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*)$/
// a secret's look: 20 characters or more of a token's alphabet, letters and digits both, a run of 12 letters or digits in it — 「seoul-office-
// 2024-11-28」 is not one, a hex digest, a base64 token, a uuid are
export function secretShape(v) {
  const s = String(v ?? '')
  return s.length >= 20 && /^[A-Za-z0-9_\-.~+/=]+$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s) && /[A-Za-z0-9]{12}/.test(s)
}
const decoded = (x) => { try { return decodeURIComponent(String(x).replace(/\+/g, ' ')) } catch { return String(x) } }
const nameOf = (piece) => decoded(String(piece).split('=')[0]).trim().toLowerCase()
// a query or a fragment's name=value pieces, as urlTokens.js splits them (& and ;; a hash route's own query after its ?)
const piecesOf = (part) => {
  const q = part.indexOf('?')
  return (q >= 0 && !part.slice(0, q).includes('=') ? part.slice(q + 1) : part).split(/[&;]/).filter(Boolean)
}
const withoutPlain = (part) => {
  const q = part.indexOf('?')
  const [head, rest] = q >= 0 && !part.slice(0, q).includes('=') ? [part.slice(0, q + 1), part.slice(q + 1)] : ['', part]
  return head + rest.split(/[&;]/).filter((p) => !PLAIN.has(nameOf(p))).join('&')
}
// a parsed address that is a key (the storage rules aside)
function keyed(u) {
  const search = u.search.slice(1), hash = u.hash.slice(1)
  for (const p of [...piecesOf(search), ...piecesOf(hash)]) {
    const eq = p.indexOf('=')
    if (eq <= 0) continue
    const v = decoded(p.slice(eq + 1))
    if (SECRET_VALUE.test(v) || (SHAPED.has(nameOf(p)) && secretShape(v))) return true
  }
  // urlTokens.js's own reading, its plain names left out (and a user name that has no password)
  const w = new URL(u.href)
  if (!w.password) w.username = ''
  const s = withoutPlain(search), h = withoutPlain(hash)
  const href = `${w.href.slice(0, w.href.length - w.search.length - w.hash.length)}${s ? `?${s}` : ''}${h ? `#${h}` : ''}`
  return maskUrl(href) !== href
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
const MD_LINK = /\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:[^()\s]|\([^()\s]*\))+))(?:\s+"[^"\n]*")?\s*\)/g
const ANGLED = /<((?:https?:)?\/\/[^\s>]+)>/gi
// a bare address — with a scheme in any case, or //host/… — and what carries it on when it was broken: a line that starts with its query or
// its path (「…/report.pdf」 then 「?token=…」), or its query after a space on the same line (「…/report.pdf ?token=…」)
const TAIL = String.raw`[^\s<>()[\]"'` + '`' + ']*'
const MORE = String.raw`(?:(?:\r?\n[?&/]|[ \t]+[?&](?=[\w.~%+-]+=))` + TAIL + ')*'
const BARE_URL = new RegExp(String.raw`(?:\bhttps?:\/\/|(?<![\w:/.])\/\/(?:[\w-]+\.)+[\w-]{2,}(?::\d+)?(?=[/?]))` + TAIL + MORE, 'gi')
// a query left on its own (PR #118 follow-up): 「?token=…」 · 「&sig=…」 · 「#access_token=…」 in the words, in backticks, after a word or a piece of an
// address that is no whole address (「files.example/a.pdf?sig=…」) — read as the query of an address on a made-up host (x.invalid), by the same
// rules (keyed). On its own it reads 「비공개 주소」; after a word only the query goes. (An address kept above is no key: no piece of its query is
// one either — the same rules, piece by piece.)
const VALUE = String.raw`[^\s&;#<>()[\]"'` + '`' + ']*'
const PIECE = new RegExp(String.raw`([?&#;])((?:[\w.~%+-]+=` + VALUE + String.raw`)(?:[&;][\w.~%+-]+=` + VALUE + ')*)', 'g')
const ALONE = /[\s(<[{"'`「『:,]/
export function dropPrivateUrls(text, hosts = storageHosts()) {
  const t = String(text ?? '')
  if (!/\/\/|[?&#;][\w.~%+-]+=/.test(t)) return t
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
    .replace(PIECE, (m, lead, body, at, all) => {
      let u = null
      try { u = new URL(`http://x.invalid/${lead === '#' ? '#' : '?'}${body}`) } catch { return m }
      if (!keyed(u)) return m
      return at === 0 || ALONE.test(all[at - 1]) ? L('비공개 주소', 'a private address') : ''
    })
}

// both at once: what a shared answer may say (the addresses first — a broken address's next line may look like a path)
export const cleanShared = (text, hosts) => hidePaths(dropPrivateUrls(text, hosts))
