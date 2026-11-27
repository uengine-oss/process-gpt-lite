// Notifications through the person's own Telegram bot (one they made with @BotFather).
//   vault item: kind 'apikey', site 'telegram',
//               data { key: <bot token>, bot: <bot username>, bot_name, chat_id: <number|null>, chat_name, nonce, since }
//   connectBot   getMe checks the token, saves it, gives the t.me link that starts the bot with a nonce
//   linkChat     finds that "/start <nonce>" in getUpdates (else the newest private /start since connecting)
//                and keeps the chat it came from
//   sendTelegram plain text (markdown marks taken out) in pieces of at most 4096 characters
// The Bot API address is PRO_TELEGRAM_API (default https://api.telegram.org): tests and recordings
// point it at scripts/mock-telegram.mjs. The token goes only into the request path — it is never
// logged, never put in an error message and never returned.
import crypto from 'node:crypto'
import { getSecret, putItem, listItems, deleteItem } from './vault.js'
import { L } from './lang.js'

export const SITE = 'telegram'
export const TG_LIMIT = 4096
// the most of a text a delivery reads (ten messages' worth)
export const TG_TEXT_MAX = TG_LIMIT * 10
const apiBase = () => String(process.env.PRO_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, '')

function tgError(message, status = 400, code) {
  return Object.assign(new Error(message), { status, ...(code && { code }) })
}
const notConnected = () => tgError(L('텔레그램 봇이 연결돼 있지 않아요. 설정 › 계정 › 연결에서 텔레그램을 연결해 주세요.', 'No Telegram bot is connected. Connect Telegram in Settings › Accounts › Connections.'), 409, 'telegram_not_connected')
const notLinked = () => tgError(L('봇은 연결됐지만 받을 대화가 아직 없어요. 봇 화면에서 시작(Start)을 눌러 주세요.', "The bot is connected but has no chat to send to yet. Press Start in the bot's chat."), 409, 'telegram_not_linked')

// ---------- pure parts (no database, no network) ----------

// What was pasted: the token alone, "bot<token>", or BotFather's whole message with the token in it
// (an input field drops the line breaks, so the token is found by its shape: digits, ":", 35 characters).
// Only the characters a token has, so nothing else can reach the request path.
export function cleanToken(input) {
  const s = String(input ?? '').trim().replace(/^bot(?=\d)/, '')
  if (/^[\w-]+:[\w-]+$/.test(s)) return s
  return /(?<![\w-])\d{5,}:[\w-]{35}/.exec(s)?.[0] || ''
}

// Markdown the agents write → plain text Telegram (and another app — an answer shared through the phone's share sheet, lib/answerShare.js)
// shows as it is (no parse_mode). Code is kept as it was written: fenced blocks (their fence lines dropped) and inline code step aside while
// the other rules run — `- name:`, `# comment`, `**kwargs` in code are code, not a list, a heading or bold — and come back at the end.
// Every rule reads a bounded stretch (a line, a label of 500, an address of 8,192, a bold run of 2,000 characters), so no shape of text — a run
// of 「[a](」 with no 「)」, of 「**a 」, of 「```x」 — costs more than a few passes over it (one froze the server before, PR #123).
const ASIDE = /[\uE000\uE001]/g
// inline code on a line: a run of backticks to the next run of the same length (so ``a `b` c`` holds a backtick), one space each side taken off
// when both are there — every run read once
function inlineCode(line, aside) {
  if (!line.includes('`')) return line
  const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index, n: m[0].length }))
  const next = new Array(runs.length).fill(-1)
  const later = new Map()
  for (let i = runs.length - 1; i >= 0; i--) { next[i] = later.get(runs[i].n) ?? -1; later.set(runs[i].n, i) }
  let out = '', from = 0
  for (let i = 0; i < runs.length; i++) {
    if (next[i] < 0) continue
    const open = runs[i], close = runs[next[i]]
    let code = line.slice(open.at + open.n, close.at)
    if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1)
    out += line.slice(from, open.at) + aside(code)
    from = close.at + close.n
    i = next[i]
  }
  return out + line.slice(from)
}
const BACK = /\uE000(\d+)\uE001/g
export function toPlain(md) {
  let s = String(md ?? '').replace(/\r\n?/g, '\n').replace(ASIDE, '')
  const codes = []
  const aside = (code) => `\uE000${codes.push(code) - 1}\uE001`
  // fenced code, line by line: ``` (no ` after it on the line) or ~~~, closed by a fence of the same mark at least as long on a line of its own;
  // one never closed runs to the end
  const kept = []
  let fence = null, body = []
  for (const line of s.split('\n')) {
    if (fence) {
      const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (c && c[1][0] === fence[0] && c[1].length >= fence.length) { kept.push(aside(body.join('\n'))); fence = null; body = [] } else body.push(line)
      continue
    }
    const o = /^ {0,3}(`{3,}(?![^`]*`)|~{3,})/.exec(line)
    if (o) { fence = o[1]; body = [] } else kept.push(line)
  }
  if (fence) kept.push(aside(body.join('\n')))
  s = kept.join('\n')
  s = s.split('\n').map((line) => inlineCode(line, aside)).join('\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // (the address read once — a lookahead takes it whole, so nothing goes back over it — and at most 8,192 characters: a signed S3 address is
  // longer than 2,048; the title after a space at most 300)
  s = s.replace(/!\[([^[\]\n]{0,500})\]\((?=([^)\s]{1,8192}))\2(?:\s[^)\n]{0,300})?\)/g, (_, alt, url) => (alt ? `${alt} (${url})` : url))
  s = s.replace(/\[([^[\]\n]{1,500})\]\((?=([^)\s]{1,8192}))\2(?:\s[^)\n]{0,300})?\)/g, (_, text, url) => (text === url ? url : `${text} (${url})`))
  const lines = []
  for (let line of s.split('\n')) {
    if (/^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|')) continue                                  // |---|---|
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { lines.push(''); continue }                                         // --- / ***
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ')
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/(?<!\s)\s+#+\s*$/, '')                                     // # headings
    line = line.replace(/^(\s*)>\s?/, '$1')                                                                           // > quotes
    line = line.replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/, (_, sp, x) => `${sp}${x.trim() ? '☑' : '☐'} `)                // - [ ] tasks
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• ')                                                                     // - bullets
    lines.push(line)
  }
  s = lines.join('\n')
  s = s.replace(/\*\*(?=\S)([^\n]{0,2000}?\S)\*\*/g, '$1')              // **bold** (on a line)
  s = s.replace(/(^|\W)__(?=\S)([^\n]{0,2000}?\S)__(?!\w)/g, '$1$2')     // __bold__ (not __init__ inside a word)
  s = s.replace(/~~(?=\S)([^\n]{0,2000}?\S)~~/g, '$1')                  // ~~strike~~
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')       // *italic* (not snake_case or 2*3*4)
  s = s.replace(/(?<![ \t])[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  // the code back, as it was written
  return s.replace(BACK, (_, i) => codes[Number(i)] ?? '')
}

// Pieces of at most `limit` characters, cut at a blank line, else a line end, else a space;
// numbered "(1/3)" when there is more than one.
export function splitMessage(text, limit = TG_LIMIT) {
  const all = String(text ?? '').trim()
  if (all.length <= limit) return all ? [all] : []
  const room = limit - 10 // " (12/34)" on its own line
  const out = []
  let rest = all
  while (rest.length > room) {
    const head = rest.slice(0, room)
    let cut = head.lastIndexOf('\n\n')
    if (cut < room * 0.5) cut = head.lastIndexOf('\n')
    if (cut < room * 0.5) cut = head.lastIndexOf(' ')
    if (cut < room * 0.5) {
      cut = room
      const c = rest.charCodeAt(cut - 1)
      if (c >= 0xd800 && c <= 0xdbff) cut-- // not between the two halves of an emoji
    }
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).replace(/^\s+/, '')
  }
  if (rest) out.push(rest)
  return out.map((p, i) => `${p}\n(${i + 1}/${out.length})`)
}

const nameOf = (chat = {}, from = {}) =>
  [chat.first_name || from.first_name, chat.last_name || from.last_name].filter(Boolean).join(' ') ||
  chat.title || (chat.username || from.username ? `@${chat.username || from.username}` : '') || String(chat.id)

// The chat to send to, from getUpdates: the "/start <nonce>" the link sent, else — the bot was found by
// name, so Telegram sent a bare /start — the newest private /start since connecting.
export function findStartChat(updates, nonce, { since = 0 } = {}) {
  const starts = (updates || [])
    .map((u) => u?.message)
    .filter((m) => m?.chat?.type === 'private' && typeof m.text === 'string' && /^\/start(@\w+)?(\s|$)/.test(m.text))
  // only the chat that opened this connection's link (/start <nonce>): a bot's name is public, so a plain
  // /start may be anyone's (2026-11-21 review: a stranger pressing Start first would get the alerts)
  const pick = nonce && starts.findLast((m) => m.text.trim().split(/\s+/)[1] === nonce)
  return pick ? { chatId: pick.chat.id, chatName: nameOf(pick.chat, pick.from) } : null
}
// a plain /start since connecting (the bot opened by searching its name, not by the link): the card asks for the link
export function plainStartSeen(updates, { since = 0 } = {}) {
  return (updates || []).some((u) => u?.message?.chat?.type === 'private' && /^\/start(@\w+)?\s*$/.test(String(u.message.text || '')) && (u.message.date || 0) >= since - 300)
}

// ---------- Bot API ----------
// Failures are answered with 503, not 502: in production Cloudflare stands in front and puts its own HTML
// error page in place of a 502 or 504, so the card showed that page's markup instead of the reason.
const host = () => { try { return new URL(apiBase()).host } catch { return 'api.telegram.org' } }
export function netCause(e, token = '') {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return `timeout ${host()}`
  const c = e?.cause
  const codes = [c?.code, ...(c?.errors || []).map((x) => x?.code)].filter(Boolean)
  // no code (fetch refusing a port, a certificate it does not trust): its words, without anything of the token
  const words = String(c?.message || e?.message || 'error').split(token || '\0').join('…').replace(/\s+/g, ' ').slice(0, 80)
  return `${[...new Set(codes)].join('/') || words} ${host()}`
}
async function call(token, method, params = {}) {
  let res
  try {
    res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000),
    })
  } catch (e) {
    // why the request never got an answer — the error code and the host, never the address (it holds the token).
    // Into the log and the answer: on 2026-11-23 every connect in production failed here and nothing said why.
    const why = netCause(e, token)
    console.warn(`[telegram] ${method} unreachable: ${why}`)
    throw Object.assign(tgError(L(`이 서버에서 텔레그램에 연결하지 못했어요 (${why}). 잠시 후 다시 시도해 보고, 문제가 계속되면 관리자에게 알려 주세요.`,
      `This server couldn't reach Telegram (${why}). Try again shortly; if it keeps happening, tell your administrator.`), 503, 'telegram_unreachable'), { detail: why })
  }
  const j = await res.json().catch(() => ({}))
  if (j.ok) return j.result
  const status = j.error_code || res.status
  const desc = String(j.description || '')
  console.warn(`[telegram] ${method} ${status} ${desc.slice(0, 120)}`)
  if (status === 401 || status === 404) throw tgError(L('이 토큰으로는 봇을 찾지 못했어요. BotFather 가 준 토큰 전체를 다시 붙여 넣어 주세요.', "No bot answers to this token. Paste the whole token BotFather gave you."), 400, 'telegram_bad_token')
  if (status === 403) throw tgError(L('봇이 차단됐거나 대화가 닫혔어요. 텔레그램에서 봇을 다시 시작해 주세요.', 'The bot was blocked or the chat was closed. Start the bot again in Telegram.'), 409, 'telegram_blocked')
  if (status === 400 && /chat not found/i.test(desc)) throw notLinked()
  if (status === 409 && /webhook/i.test(desc)) throw tgError(L('이 봇은 웹훅을 쓰고 있어 확인할 수 없어요. 알림용 봇을 새로 만들어 연결해 주세요.', 'This bot uses a webhook, so it cannot be checked. Make a new bot for notifications and connect it.'), 409, 'telegram_webhook')
  if (status === 429) throw Object.assign(tgError(L('텔레그램이 잠시 쉬어 가래요. 조금 뒤 다시 해 주세요.', 'Telegram asks to slow down. Please try again shortly.'), 429, 'telegram_rate_limited'), { retryAfter: j.parameters?.retry_after })
  // an answer that is not Telegram's (a proxy's page, a 5xx): its status in the answer too, as for no answer
  const detail = `HTTP ${res.status}${j.error_code ? ` ${j.error_code}` : ''} ${host()}`
  throw Object.assign(tgError(L('텔레그램이 요청을 받지 않았어요.', 'Telegram did not accept the request.') + ` (${desc ? desc.slice(0, 120) : detail})`, 503, 'telegram_error'), { detail })
}

const linkOf = (sec) => `https://t.me/${sec.bot}?start=${sec.nonce}`
const saved = (userId) => getSecret(userId, 'apikey', SITE)
const save = (userId, data) => putItem(userId, 'apikey', SITE, data, { actor: 'connector' })

// ---------- connect · link · status · send · disconnect ----------

export async function connectBot(userId, token) {
  const key = cleanToken(token)
  if (!key) throw tgError(L('BotFather 가 준 토큰을 붙여 넣어 주세요. 「123456789:AA…」 모양이에요.', 'Paste the token BotFather gave you. It looks like "123456789:AA…".'), 400, 'telegram_bad_token')
  const me = await call(key, 'getMe')
  if (!me?.username) throw tgError(L('봇 정보를 읽지 못했어요. 토큰을 다시 확인해 주세요.', "Couldn't read the bot's details. Please check the token."), 400, 'telegram_bad_token')
  const old = await saved(userId)
  // the same bot again keeps the chat it already sends to
  const keep = old?.key === key && old.chat_id
  const data = {
    key, bot: me.username, bot_name: me.first_name || me.username,
    chat_id: keep ? old.chat_id : null, chat_name: keep ? old.chat_name : null,
    nonce: keep && old.nonce ? old.nonce : crypto.randomBytes(9).toString('base64url'),
    since: Math.floor(Date.now() / 1000),
  }
  await save(userId, data)
  return { bot: data.bot, link: linkOf(data), linked: !!data.chat_id, chatName: data.chat_name }
}

const linking = new Map() // userId -> promise (two tabs asking at once send one welcome)
export function linkChat(userId) {
  if (!linking.has(userId)) linking.set(userId, doLink(userId).finally(() => linking.delete(userId)))
  return linking.get(userId)
}
async function doLink(userId) {
  const sec = await saved(userId)
  if (!sec?.key) throw notConnected()
  if (sec.chat_id) return { linked: true, chatName: sec.chat_name }
  let updates
  try {
    updates = await call(sec.key, 'getUpdates', { allowed_updates: ['message'], timeout: 0, limit: 100 })
  } catch (e) {
    if (e.code === 'telegram_error' && /terminated by other getUpdates/i.test(e.message)) return { linked: false }
    throw e
  }
  const found = findStartChat(updates, sec.nonce, { since: sec.since || 0 })
  if (!found) return { linked: false, ...(plainStartSeen(updates, { since: sec.since || 0 }) ? { hint: 'use_link' } : {}) }
  await save(userId, { ...stripId(sec), chat_id: found.chatId, chat_name: found.chatName })
  // what was read is acknowledged, so an old /start is never taken for a later connection
  const last = updates.reduce((m, u) => Math.max(m, u.update_id || 0), 0)
  if (last) await call(sec.key, 'getUpdates', { offset: last + 1, timeout: 0, limit: 1 }).catch(() => {})
  await call(sec.key, 'sendMessage', {
    chat_id: found.chatId, disable_web_page_preview: true,
    text: L('Process GPT Lite 와 연결됐어요. 예약한 작업의 알림이 여기로 와요.', 'Connected to Process GPT Lite. Notifications from your scheduled work will arrive here.'),
  }).catch((e) => console.warn('[telegram] welcome', e.code || e.message))
  return { linked: true, chatName: found.chatName }
}
const stripId = ({ id, site, ...data }) => data

// Never the token: whether a bot is connected, which one, and the chat it sends to.
export async function telegramStatus(userId) {
  let sec = await saved(userId)
  // a token saved by hand (설정 › API 키 추가) has no bot name yet: check it once
  if (sec?.key && !sec.bot) {
    try { await connectBot(userId, sec.key); sec = await saved(userId) } catch { return { connected: false, bot: null, linked: false, chatName: null } }
  }
  if (!sec?.key) return { connected: false, bot: null, linked: false, chatName: null }
  return { connected: true, bot: sec.bot, linked: !!sec.chat_id, chatName: sec.chat_name || null, ...(!sec.chat_id && { link: linkOf(sec) }) }
}

export async function sendTelegram(userId, text, { title } = {}) {
  const sec = await saved(userId)
  if (!sec?.key) throw notConnected()
  if (!sec.chat_id) throw notLinked()
  // (at most ten messages' worth goes in — a longer text ends in 「…」: what is read stays bounded, PR #123)
  const raw = [title && `# ${title}`, text].filter(Boolean).join('\n\n')
  const body = toPlain(raw.length > TG_TEXT_MAX ? `${raw.slice(0, TG_TEXT_MAX)}\n…` : raw)
  const pieces = splitMessage(body)
  if (!pieces.length) throw tgError(L('보낼 내용이 없어요.', 'There is nothing to send.'), 400, 'telegram_empty')
  const ids = []
  for (const piece of pieces) {
    const params = { chat_id: sec.chat_id, text: piece, disable_web_page_preview: true }
    let m
    try { m = await call(sec.key, 'sendMessage', params) } catch (e) {
      if (e.code !== 'telegram_rate_limited' || !(e.retryAfter <= 10)) throw e
      await new Promise((ok) => setTimeout(ok, e.retryAfter * 1000))
      m = await call(sec.key, 'sendMessage', params)
    }
    ids.push(m?.message_id)
  }
  return { sent: pieces.length, messageIds: ids, chatName: sec.chat_name || null }
}

// For deliveries that should not fail because Telegram is not set up: null when there is no linked
// chat (nothing sent), {error, code} when sending failed, else what sendTelegram returns.
export async function sendTelegramIfLinked(userId, text, opts) {
  try { return await sendTelegram(userId, text, opts) } catch (e) {
    if (e.code === 'telegram_not_connected' || e.code === 'telegram_not_linked') return null
    console.warn('[telegram] send', e.code || e.message)
    return { error: e.message, code: e.code }
  }
}

export async function disconnect(userId) {
  const items = (await listItems(userId)).filter((i) => i.kind === 'apikey' && i.site === SITE)
  for (const i of items) await deleteItem(userId, i.id, { actor: 'user' })
  return { ok: true, removed: items.length }
}
