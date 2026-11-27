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

const B = '`'
const ROOT = String.raw`(?:/workspace|/Users/[^/\s` + B + String.raw`'"<>()]+|/home/[^/\s` + B + String.raw`'"<>()]+|/private/(?:tmp|var)|/tmp)(?=/|\b)`
const QUOTED = new RegExp(B + '(' + ROOT + '[^' + B + '\\n]*)' + B, 'g')
// a Markdown link to a sandbox or host file goes nowhere: its label stays (the address may be wrapped in <…>, after a space)
const LINKED = new RegExp(String.raw`\[([^\]\n]+)\]\(\s*<?\s*(?:sandbox:|file://)?` + ROOT + String.raw`[^)\n]*\)`, 'g')
const BARE = new RegExp(String.raw`(?<![\w/.:~-])(?:sandbox:|file://)?` + ROOT + String.raw`(?:/[^\s` + B + String.raw`'"<>()\[\]*,;]*)*`, 'g')

const folderWord = () => L('산출물 폴더', 'the output folder')
// a file has an extension; a folder (or a run room id) does not
const fileName = (p) => {
  const last = String(p).replace(/\/+$/, '').split('/').pop() || ''
  return /\.[A-Za-z0-9]{1,8}$/.test(last) && !String(p).endsWith('/') ? last : null
}

export function hidePaths(text) {
  const t = String(text ?? '')
  if (!/\/(workspace|Users|home|private|tmp)\b/.test(t)) return t
  return t
    .replace(LINKED, (m, label) => label)
    .replace(QUOTED, (m, p) => { const f = fileName(p.trim()); return f ? B + f + B : folderWord() })
    .replace(BARE, (m) => {
      const trail = /[.:!?]+$/.exec(m)?.[0] || ''
      return (fileName(m.slice(0, m.length - trail.length).replace(/^(?:sandbox:|file:\/\/)/, '')) || folderWord()) + trail
    })
}

// ---------- private addresses ----------
// a query parameter that makes an address a key: a signature, a token, an API key
const SECRET = /^(?:token|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential|access_token|id_token|refresh_token|jwt|apikey|api_key|auth|secret)$/i
const hostOf = (u) => { try { return new URL(u).host.toLowerCase() } catch { return '' } }
// this app's own storage hosts (its Supabase, the address the office host gives the documents it makes)
export const storageHosts = () => [config.supabaseUrl, config.supabasePublicUrl].map(hostOf).filter(Boolean)
export function privateUrl(raw, hosts = storageHosts()) {
  let u
  try { u = new URL(raw) } catch { return false }
  if (!/^https?:$/.test(u.protocol)) return false
  if (hosts.includes(u.host.toLowerCase())) return true
  if (/\/storage\/v1\/object\//.test(u.pathname)) return true
  for (const k of u.searchParams.keys()) if (SECRET.test(k)) return true
  return false
}
// what a private address reads as: its file's name — not a storage key's made-up name (a uuid) — or 「비공개 주소」
export function urlName(raw) {
  let last = ''
  try { last = decodeURIComponent(new URL(raw).pathname.split('/').filter(Boolean).pop() || '') } catch { last = '' }
  if (!/\.[A-Za-z0-9]{1,8}$/.test(last) || /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\./i.test(last) || /^[0-9a-f]{24,}\./i.test(last)) return L('비공개 주소', 'a private address')
  return last
}
const MD_LINK = /\[([^\]\n]*)\]\(\s*<?\s*(https?:\/\/[^\s)>]+)\s*>?(?:\s+"[^"\n]*")?\s*\)/g
const ANGLED = /<(https?:\/\/[^\s>]+)>/g
const BARE_URL = /https?:\/\/[^\s<>()[\]"'`]+/g
export function dropPrivateUrls(text, hosts = storageHosts()) {
  const t = String(text ?? '')
  if (!/https?:\/\//i.test(t)) return t
  return t
    .replace(MD_LINK, (m, label, url) => (privateUrl(url, hosts) ? (label.trim() || urlName(url)) : m))
    .replace(ANGLED, (m, url) => (privateUrl(url, hosts) ? urlName(url) : m))
    .replace(BARE_URL, (m) => {
      const trail = /[.,;:!?]+$/.exec(m)?.[0] || ''
      const url = m.slice(0, m.length - trail.length)
      return privateUrl(url, hosts) ? urlName(url) + trail : m
    })
}

// both: what a shared answer may say
export const cleanShared = (text, hosts) => dropPrivateUrls(hidePaths(text), hosts)
