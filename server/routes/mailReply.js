// HTTP routes for answering a mail from its Home card (lib/mailReply.js). Nothing here runs an agent:
// the reply leaves only through POST /actions/:id/reply, which the 보내기 button sends.
//   GET  /mail/cards               [action]                                          받은 편지함's mail list
//   GET  /actions/:id/mail         {provider, mode, mail, files, to, reply, sent}   the mail as it arrived
//   POST /actions/:id/reply-draft  → {reply, files}                                  a draft to read and change
//   POST /actions/:id/reply        {to, cc, subject, body, files} → {ok, sent}        sent (or put in Drafts)
// The mail's place in the work (lib/mailFlow.js) — nothing starts until the person presses 새로 시작 · 잇기:
//   GET  /mail/card?action=&mail=  action                                            the card a chat chip names
//   GET  /actions/:id/flow         {linked} | {matches, joins, declined}             its instance, or what it may start or join
//   POST /actions/:id/flow/start   {proc, task?} → {instId}                          a new case of that process
//   POST /actions/:id/flow/join    {instId} → {instId}                               the running instance
//   POST /actions/:id/flow/decline {undo?}                                           이번엔 안 해요
import express from 'express'
import * as R from '../lib/mailReply.js'
import * as MF from '../lib/mailFlow.js'
import { mailCards } from '../lib/homeCards.js'
import { L } from '../lib/lang.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[mail reply]', e.message)
  res.status(e.status || 500).json({ error: e.status ? e.message : L('메일을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', "Couldn't handle the mail. Please try again in a moment."), ...(e.code && { code: e.code }) })
})

export function mailReplyRoutes(auth) {
  const r = express.Router()
  // 받은 편지함: the cards made from mail — a card put away from Home is still here (lib/homeCards.js)
  r.get('/mail/cards', auth, (req, res) => send(res, mailCards(req.user.id)))
  r.get('/actions/:id/mail', auth, (req, res) => send(res, R.mailOfCard(req.user, req.params.id)))
  r.post('/actions/:id/reply-draft', auth, (req, res) => send(res, R.draftReply(req.user, req.params.id)))
  r.post('/actions/:id/reply', auth, (req, res) => send(res, R.sendReply(req.user, req.params.id, req.body || {})))
  r.get('/mail/card', auth, (req, res) => send(res, MF.cardByRef(req.user.id, { action: req.query.action ? String(req.query.action) : null, mail: req.query.mail ? String(req.query.mail) : null })))
  r.get('/actions/:id/flow', auth, (req, res) => send(res, MF.flowOfCard(req.user, req.params.id)))
  r.post('/actions/:id/flow/start', auth, (req, res) => send(res, MF.startFromCard(req.user, req.params.id, { proc: String(req.body?.proc || ''), task: req.body?.task ? String(req.body.task) : null })))
  r.post('/actions/:id/flow/join', auth, (req, res) => send(res, MF.joinFromCard(req.user, req.params.id, { instId: String(req.body?.instId || '') })))
  r.post('/actions/:id/flow/decline', auth, (req, res) => send(res, MF.declineFlow(req.user, req.params.id, { undo: req.body?.undo === true })))
  return r
}
