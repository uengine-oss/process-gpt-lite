// Words that leave the person's own chat (an AI answer shared to a room, saved as a document, carried into a project — lib/answerShare.js ·
// lib/chatProject.js): no path of the agent's workspace or of the host, no private address.
//   paths      a sandbox (/workspace/…) or host path (/Users/… · /home/… · /private/… · /tmp/…, file://…) — in backticks, as a Markdown link's
//              address (with or without <…>, a space after the bracket), or bare — reads as its file name, a folder as 「산출물 폴더」.
//              The same rules as the page's src/paths.js (the server image has no src/, the web image no server/): the cases in
//              server/test/hidePaths.test.js hold both to the same answers.
//   addresses  a storage address of this app (its Supabase's host, any …/storage/v1/object/…) and any address whose query carries a
//              signature or a token (a mail attachment's 30-minute signed copy — lib/mailAttachments.js, a share's ?sig=, a folder file's
//              ?token=, an S3 · GCS signed URL) reads as its file name (a Markdown link keeps its label), or 「비공개 주소」 when it has none
//              worth showing. An ordinary web page's address stays as it is.
import { config } from '../config.js'
import { L } from './lang.js'

const folderWord = () => L('산출물 폴더', 'the output folder')

// ---- the path rules: the same text in src/paths.js and server/lib/hidePaths.js (server/test/hidePaths.test.js holds them to the same answers)
const B = '`'
// where the agents' files live: the sandbox (/workspace), the host (/Users/…, /home/…, /private/…, /tmp/…)
const ROOT = String.raw`(?:/workspace|/Users/[^/\s` + B + String.raw`'"<>()]+|/home/[^/\s` + B + String.raw`'"<>()]+|/private/(?:tmp|var)|/tmp)(?=/|\b)`
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
  if (!/\/(workspace|Users|home|private|tmp)\b|[A-Za-z]:[\\/]|\\\\[\w.$-]+\\/.test(t)) return t
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
// a query parameter that makes an address a key: a signature, a token, an API key — and a value that is one (a Google API key, AIza…)
const SECRET = /^(?:token|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|access_token|id_token|refresh_token|jwt|key|apikey|api_key|auth|secret)$/i
const SECRET_VALUE = /^AIza[0-9A-Za-z_-]{20,}$/
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
  for (const [k, v] of u.searchParams) if (SECRET.test(k) || SECRET_VALUE.test(v)) return true
  return false
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
// a bare address — with a scheme in any case, or //host/… — and the lines that carry it on when it was broken (a line that starts with its
// query or its path: 「…/report.pdf」 then 「?token=…」)
const MORE = String.raw`(?:\r?\n[?&/][^\s<>()[\]"'` + '`' + String.raw`]*)*`
const BARE_URL = new RegExp(String.raw`(?:\bhttps?:\/\/|(?<![\w:/.])\/\/(?:[\w-]+\.)+[\w-]{2,}(?::\d+)?(?=[/?]))[^\s<>()[\]"'` + '`' + ']*' + MORE, 'gi')
export function dropPrivateUrls(text, hosts = storageHosts()) {
  const t = String(text ?? '')
  if (!/(?:https?:)?\/\//i.test(t)) return t
  return t
    .replace(MD_LINK, (m, label, angled, bare) => {
      const url = (angled || bare || '').trim()
      return URLISH.test(url) && privateUrl(url, hosts) ? (label.trim() || urlName(url)) : m
    })
    .replace(ANGLED, (m, url) => (privateUrl(url, hosts) ? urlName(url) : m))
    .replace(BARE_URL, (m) => {
      const trail = /[.,;:!?]+$/.exec(m)?.[0] || ''
      const url = m.slice(0, m.length - trail.length).replace(/\r?\n/g, '')
      return privateUrl(url, hosts) ? urlName(url) + trail : m
    })
}

// both at once: what a shared answer may say (the addresses first — a broken address's next line may look like a path)
export const cleanShared = (text, hosts) => hidePaths(dropPrivateUrls(text, hosts))
