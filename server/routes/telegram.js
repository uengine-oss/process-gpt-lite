// HTTP routes for 텔레그램 알림 (lib/telegram.js): the person's own bot, the chat it sends to, a test message.
//   GET    /telegram          {connected, bot, linked, chatName, link?}   (never the token)
//   POST   /telegram/connect  {token} → {bot, link, linked, chatName}
//   POST   /telegram/link     → {linked, chatName}   (the card asks every 2 seconds after 「봇 열기」)
//   POST   /telegram/test     → {ok, sent, chatName}
//   DELETE /telegram          → {ok, removed}
import express from 'express'
import * as T from '../lib/telegram.js'
import { L } from '../lib/lang.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[telegram]', e.message)
  res.status(e.status || 500).json({ error: e.status ? e.message : L('텔레그램 연결을 처리하지 못했어요.', "Couldn't handle the Telegram connection."), ...(e.code && { code: e.code }) })
})

export function telegramRoutes(auth) {
  const r = express.Router()
  r.get('/telegram', auth, (req, res) => send(res, T.telegramStatus(req.user.id)))
  r.post('/telegram/connect', auth, (req, res) => send(res, T.connectBot(req.user.id, req.body?.token)))
  r.post('/telegram/link', auth, (req, res) => send(res, T.linkChat(req.user.id)))
  r.post('/telegram/test', auth, (req, res) => send(res, T.sendTelegram(req.user.id,
    L('Process GPT Lite 연결 시험 메시지예요. 알림이 이렇게 와요.', 'A test message from Process GPT Lite. Notifications will arrive like this.'))
    .then((x) => ({ ok: true, ...x }))))
  r.delete('/telegram', auth, (req, res) => send(res, T.disconnect(req.user.id)))
  return r
}
