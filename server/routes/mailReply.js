// HTTP routes for answering a mail from its Home card (lib/mailReply.js). Nothing here runs an agent:
// the reply leaves only through POST /actions/:id/reply, which the 보내기 button sends.
//   GET  /actions/:id/mail         {provider, mode, mail, files, to, reply, sent}   the mail as it arrived
//   POST /actions/:id/reply-draft  → {reply, files}                                  a draft to read and change
//   POST /actions/:id/reply        {to, cc, subject, body, files} → {ok, sent}        sent (or put in Drafts)
import express from 'express'
import * as R from '../lib/mailReply.js'
import { L } from '../lib/lang.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[mail reply]', e.message)
  res.status(e.status || 500).json({ error: e.status ? e.message : L('메일을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', "Couldn't handle the mail. Please try again in a moment."), ...(e.code && { code: e.code }) })
})

export function mailReplyRoutes(auth) {
  const r = express.Router()
  r.get('/actions/:id/mail', auth, (req, res) => send(res, R.mailOfCard(req.user, req.params.id)))
  r.post('/actions/:id/reply-draft', auth, (req, res) => send(res, R.draftReply(req.user, req.params.id)))
  r.post('/actions/:id/reply', auth, (req, res) => send(res, R.sendReply(req.user, req.params.id, req.body || {})))
  return r
}
