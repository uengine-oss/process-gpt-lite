// The 「보낼 메일」 card (lib/mailOut.js): a mail the agent wrote for the person leaves only through POST …/send, which the card's
// 보내기 sends — from the mailbox this person connected, never from an account the card or the agent names.
//   GET  /mail-out/:id          {state, mode, provider, from, to, cc, subject, body, reply, files, missing, sent}  the sender read now
//   POST /mail-out/:id/send     {to, cc, subject, body} → {ok, sent}     Gmail: sent in the thread it answers · IMAP: into Drafts · demo: recorded
//   POST /mail-out/:id/keep     초안으로 두기 (nothing leaves)
//   POST /mail-out/:id/reopen   a kept draft back to 보내기
//   POST /mail-out/:id/cancel   그만두기
// (someone else's card — even in a room they share — is 404)
import express from 'express'
import * as O from '../lib/mailOut.js'
import { L } from '../lib/lang.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[mail out]', e.message)
  res.status(e.status || 500).json({ error: e.status ? e.message : L('메일을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', "Couldn't handle the mail. Please try again in a moment."), ...(e.code && { code: e.code }) })
})

export function mailOutRoutes(auth) {
  const r = express.Router()
  r.get('/mail-out/:id', auth, (req, res) => send(res, O.cardView(req.user, req.params.id)))
  r.post('/mail-out/:id/send', auth, (req, res) => send(res, O.sendOut(req.user, req.params.id, req.body || {}).then(({ ok, sent }) => ({ ok, sent }))))
  r.post('/mail-out/:id/keep', auth, (req, res) => send(res, O.keepOut(req.user, req.params.id).then(() => ({ ok: true }))))
  r.post('/mail-out/:id/reopen', auth, (req, res) => send(res, O.reopenOut(req.user, req.params.id).then(() => ({ ok: true }))))
  r.post('/mail-out/:id/cancel', auth, (req, res) => send(res, O.cancelOut(req.user, req.params.id).then(() => ({ ok: true }))))
  return r
}
