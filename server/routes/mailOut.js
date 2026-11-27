// The 「보낼 메일」 card (lib/mailOut.js): a mail the agent wrote for the person leaves only through POST …/send, which the card's
// 보내기 sends — from the mailbox this person connected, never from an account the card or the agent names. What leaves is the card
// as saved and as shown: the person's edits are saved first (…/edit), and 보내기 brings back the confirmation of what was shown.
//   GET  /mail-out/:id          {state, mode, provider, from, to, cc, subject, body, reply, answered, files, missing, sent, unknown, confirm}
//   POST /mail-out/:id/edit     {to, cc, subject, body} → the view (a new confirm)
//   POST /mail-out/:id/send     {confirm} → {ok, sent}      Gmail: sent in the thread it answers · IMAP: into Drafts · demo: recorded
//                               (409 stale: the card changed since it was shown · 504 send_unknown: no answer in time — check Sent)
//   POST /mail-out/:id/resolve  {sent} → {ok}               after send_unknown: 보냈어요 · 안 나갔어요(다시 보내기로)
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
  r.post('/mail-out/:id/edit', auth, (req, res) => send(res, O.editOut(req.user, req.params.id, req.body || {})))
  // (only the confirmation is read: recipients, subject and body come from the saved card)
  r.post('/mail-out/:id/send', auth, (req, res) => send(res, O.sendOut(req.user, req.params.id, { confirm: req.body?.confirm }).then(({ ok, sent }) => ({ ok, sent }))))
  r.post('/mail-out/:id/resolve', auth, (req, res) => send(res, O.resolveOut(req.user, req.params.id, { sent: req.body?.sent === true }).then(() => ({ ok: true }))))
  r.post('/mail-out/:id/keep', auth, (req, res) => send(res, O.keepOut(req.user, req.params.id).then(() => ({ ok: true }))))
  r.post('/mail-out/:id/reopen', auth, (req, res) => send(res, O.reopenOut(req.user, req.params.id).then(() => ({ ok: true }))))
  r.post('/mail-out/:id/cancel', auth, (req, res) => send(res, O.cancelOut(req.user, req.params.id).then(() => ({ ok: true }))))
  return r
}
