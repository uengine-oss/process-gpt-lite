#!/usr/bin/env node
// A stand-in for the Telegram Bot API (https://api.telegram.org) for tests and screen recordings.
// The Lite server talks to it when started with PRO_TELEGRAM_API=http://127.0.0.1:18443.
//
//   node scripts/mock-telegram.mjs [port=18443]
//
// Bot API (GET or POST; JSON, form or query parameters), per token:
//   /bot<token>/getMe        a token starting with "bad" → 401 Unauthorized (every method); no ":" → 404
//   /bot<token>/getUpdates   what /_press queued; offset=N acknowledges (drops) the updates before N
//   /bot<token>/sendMessage  kept for /_sent; 400 "chat not found" for a chat that never pressed Start,
//                            400 "message is too long" above 4096 characters, 403 after /_block
// Test controls (JSON bodies):
//   POST /_press  {token?, text?, chat?: {id, first_name, last_name?, username?}}
//                 the person pressed Start in the bot's chat. text defaults to "/start", chat to
//                 {id: 700100200, first_name: '지윤'}; token defaults to the bot asked last.
//                 Use text "/start <nonce>" with the nonce from the t.me/<bot>?start=<nonce> link.
//   POST /_bot    {token, username?, first_name?}   the name getMe gives for that token
//   POST /_block  {token?, chat_id}                  the person blocked the bot
//   GET  /_sent?token=                               messages sent (all bots without token)
//   GET  /_state                                     bots (tokens masked), queued updates, sent counts
//   POST /_reset                                     forget everything
//   GET  /_view?token=                               the bot's messages as a phone chat page (recordings; plainly a mock)
// import { startMockTelegram } from '…/scripts/mock-telegram.mjs' → { url, port, close(), reset() }
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const LIMIT = 4096
const mask = (t) => (String(t).includes(':') ? `${String(t).split(':')[0]}:…` : '…')

export function startMockTelegram({ port = 18443, host = '127.0.0.1', log = () => {}, username = 'my_lite_alert_bot', firstName = '내 알림 봇' } = {}) {
  let bots, lastToken, nextUpdate, nextMessage
  const reset = () => { bots = new Map(); lastToken = null; nextUpdate = 500001; nextMessage = 1 }
  reset()

  const botOf = (token) => {
    if (!bots.has(token)) {
      const id = Number(String(token).split(':')[0]) || 100000 + bots.size
      bots.set(token, { me: { id, is_bot: true, first_name: firstName, username, can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false },
        updates: [], sent: [], chats: new Map(), blocked: new Set() })
    }
    return bots.get(token)
  }
  const now = () => Math.floor(Date.now() / 1000)
  const fail = (code, description) => ({ status: code, body: { ok: false, error_code: code, description } })
  const ok = (result) => ({ status: 200, body: { ok: true, result } })

  function botApi(token, method, p) {
    if (!token.includes(':')) return fail(404, 'Not Found')
    if (token.startsWith('bad')) return fail(401, 'Unauthorized')
    const bot = botOf(token)
    lastToken = token
    switch (method) {
      case 'getMe': return ok(bot.me)
      case 'getUpdates': {
        const offset = Number(p.offset) || 0
        if (offset) bot.updates = bot.updates.filter((u) => u.update_id >= offset)
        return ok(bot.updates.slice(0, Math.min(Number(p.limit) || 100, 100)))
      }
      case 'sendMessage': {
        const chatId = Number(p.chat_id)
        const text = String(p.text ?? '')
        if (!bot.chats.has(chatId)) return fail(400, 'Bad Request: chat not found')
        if (bot.blocked.has(chatId)) return fail(403, 'Forbidden: bot was blocked by the user')
        if (!text.trim()) return fail(400, 'Bad Request: message text is empty')
        if (text.length > LIMIT) return fail(400, 'Bad Request: message is too long')
        const m = { message_id: nextMessage++, date: now(), chat: bot.chats.get(chatId), from: { id: bot.me.id, is_bot: true, first_name: bot.me.first_name, username: bot.me.username }, text }
        bot.sent.push({ chat_id: chatId, text, parse_mode: p.parse_mode || null, message_id: m.message_id, date: m.date })
        log(`sendMessage → ${chatId} (${text.length}자) ${text.split('\n')[0].slice(0, 60)}`)
        return ok(m)
      }
      case 'getWebhookInfo': return ok({ url: '', has_custom_certificate: false, pending_update_count: bot.updates.length })
      case 'deleteWebhook': return ok(true)
      default: return fail(404, 'Not Found')
    }
  }

  function control(route, p, query) {
    const tokenOr = (t) => t || lastToken
    switch (route) {
      case 'POST /_press': {
        const token = tokenOr(p.token)
        if (!token) return { status: 400, body: { ok: false, error: 'no bot yet: connect one first, or pass token' } }
        const bot = botOf(token)
        const c = p.chat || {}
        const chat = { id: Number(c.id) || 700100200, type: 'private', first_name: c.first_name || '지윤', ...(c.last_name && { last_name: c.last_name }), ...(c.username && { username: c.username }) }
        const text = String(p.text || '/start')
        bot.chats.set(chat.id, chat)
        bot.blocked.delete(chat.id)
        const update = { update_id: nextUpdate++, message: { message_id: nextMessage++, from: { id: chat.id, is_bot: false, first_name: chat.first_name, ...(chat.last_name && { last_name: chat.last_name }), language_code: 'ko' }, chat, date: now(), text, entities: [{ offset: 0, length: text.split(' ')[0].length, type: 'bot_command' }] } }
        bot.updates.push(update)
        log(`press ${text.split(' ')[0]} ← ${chat.first_name} (${chat.id})`)
        return { status: 200, body: { ok: true, update_id: update.update_id, chat } }
      }
      case 'POST /_bot': {
        if (!p.token) return { status: 400, body: { ok: false, error: 'token is required' } }
        const bot = botOf(p.token)
        if (p.username) bot.me.username = String(p.username)
        if (p.first_name) bot.me.first_name = String(p.first_name)
        return { status: 200, body: { ok: true, me: bot.me } }
      }
      case 'POST /_block': {
        const bot = botOf(tokenOr(p.token))
        bot.blocked.add(Number(p.chat_id))
        return { status: 200, body: { ok: true } }
      }
      case 'GET /_sent': {
        const list = query.get('token') ? (bots.get(query.get('token'))?.sent || []) : [...bots.values()].flatMap((b) => b.sent)
        return { status: 200, body: { ok: true, result: list } }
      }
      case 'GET /_state':
        return { status: 200, body: { ok: true, bots: [...bots].map(([t, b]) => ({ token: mask(t), username: b.me.username, updates: b.updates.length, chats: [...b.chats.keys()], sent: b.sent.length })) } }
      case 'POST /_reset': reset(); log('reset'); return { status: 200, body: { ok: true } }
      default: return null
    }
  }

  // what a person would see in the bot's chat, for a recording: the bot's messages in order
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  function viewPage(token) {
    const bot = token ? bots.get(token) : bots.get(lastToken) || [...bots.values()].at(-1)
    const name = bot?.me?.first_name || '봇'
    const at = (m) => new Date((m.date || now()) * 1000).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Seoul' })
    const items = (bot?.sent || []).map((m) => `<div class="b"><div class="t">${esc(m.text || '')}</div><small>${at(m)}</small></div>`).join('')
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(name)} (모의)</title>
<style>body{margin:0;font:15px/1.45 -apple-system,system-ui,sans-serif;background:#cfd9e3;color:#111}header{position:sticky;top:0;background:#fff;padding:12px 16px;border-bottom:1px solid #d6dde4}
header b{display:block;font-size:16px}header small{color:#6b7785}.m{padding:12px 12px 40px;display:flex;flex-direction:column;gap:8px}.b{align-self:flex-start;max-width:86%;background:#fff;border-radius:14px 14px 14px 4px;padding:8px 12px;box-shadow:0 1px 1px rgba(0,0,0,.08)}
.t{white-space:pre-wrap;overflow-wrap:anywhere}.b small{display:block;text-align:right;color:#8a96a3;font-size:11px;margin-top:2px}.note{margin:10px auto 0;text-align:center;font-size:12px;color:#5d6b79}</style></head>
<body><header><b>${esc(name)}</b><small>@${esc(bot?.me?.username || 'bot')} · 시험용 모의 텔레그램</small></header><div class="note">이 화면은 시험용 모의 서버가 받은 메시지예요</div><div class="m">${items || '<div class="note">아직 받은 메시지가 없어요</div>'}</div>
<script>scrollTo(0, document.body.scrollHeight)</script></body></html>`
  }

  const readBody = (req) => new Promise((done) => {
    let raw = ''
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => {
      const type = req.headers['content-type'] || ''
      try {
        if (type.includes('json')) return done(raw ? JSON.parse(raw) : {})
        if (type.includes('urlencoded')) return done(Object.fromEntries(new URLSearchParams(raw)))
      } catch { return done(null) }
      done({})
    })
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mock')
    const body = await readBody(req)
    const reply = ({ status, body: out }) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(out)) }
    if (body === null) return reply(fail(400, 'Bad Request: can\'t parse JSON'))
    const p = { ...Object.fromEntries(url.searchParams), ...body }
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(url.pathname)
    if (m) {
      const r = botApi(decodeURIComponent(m[1]), m[2], p)
      if (r.status !== 200 || !['getUpdates', 'sendMessage'].includes(m[2])) log(`${m[2]} ${mask(m[1])} → ${r.status}`)
      return reply(r)
    }
    if (req.method === 'GET' && url.pathname === '/_view') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(viewPage(url.searchParams.get('token')))
    }
    const r = control(`${req.method} ${url.pathname}`, body, url.searchParams)
    return reply(r || fail(404, 'Not Found'))
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const actual = server.address().port
      resolve({ port: actual, url: `http://${host}:${actual}`, reset, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()) }) })
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 18443
  const stamp = () => new Date().toTimeString().slice(0, 8)
  const mock = await startMockTelegram({ port, log: (s) => console.log(`${stamp()} ${s}`) })
  console.log(`mock Telegram Bot API on ${mock.url}  (PRO_TELEGRAM_API=${mock.url})`)
  const stop = () => mock.close().then(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
