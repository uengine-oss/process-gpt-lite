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

// Markdown the agents write → plain text Telegram shows as it is (no parse_mode).
export function toPlain(md) {
  let s = String(md ?? '').replace(/\r\n?/g, '\n')
  s = s.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code) => code.replace(/\n$/, ''))     // code fences: keep the code
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => (alt ? `${alt} (${url})` : url))
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, text, url) => (text === url ? url : `${text} (${url})`))
  const lines = []
  for (let line of s.split('\n')) {
    if (/^[\s|:-]+$/.test(line) && line.includes('-') && line.includes('|')) continue                                  // |---|---|
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { lines.push(''); continue }                                         // --- / ***
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' · ')
    line = line.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '')                                             // # headings
    line = line.replace(/^(\s*)>\s?/, '$1')                                                                           // > quotes
    line = line.replace(/^(\s*)[-*+]\s+\[( |x|X)\]\s+/, (_, sp, x) => `${sp}${x.trim() ? '☑' : '☐'} `)                // - [ ] tasks
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• ')                                                                     // - bullets
    lines.push(line)
  }
  s = lines.join('\n')
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')            // **bold**
  s = s.replace(/(^|\W)__(?=\S)([^\n]*?\S)__(?!\w)/g, '$1$2')    // __bold__ (not __init__ inside a word)
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')               // ~~strike~~
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2') // *italic* (not snake_case or 2*3*4)
  s = s.replace(/`([^`\n]+)`/g, '$1')                          // `code`
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
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
  const pick = (nonce && starts.findLast((m) => m.text.trim().split(/\s+/)[1] === nonce)) ||
    starts.findLast((m) => (m.date || 0) >= since - 300)
  return pick ? { chatId: pick.chat.id, chatName: nameOf(pick.chat, pick.from) } : null
}

// ---------- Bot API ----------
async function call(token, method, params = {}) {
  let res
  try {
    res = await fetch(`${apiBase()}/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw tgError(L('텔레그램 서버에 닿지 못했어요. 잠시 뒤 다시 해 주세요.', "Couldn't reach Telegram. Please try again in a moment."), 502, 'telegram_unreachable')
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
  throw tgError(L('텔레그램이 요청을 받지 않았어요.', 'Telegram did not accept the request.') + (desc ? ` (${desc.slice(0, 120)})` : ''), 502, 'telegram_error')
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
  if (!found) return { linked: false }
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
  const body = toPlain([title && `# ${title}`, text].filter(Boolean).join('\n\n'))
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
