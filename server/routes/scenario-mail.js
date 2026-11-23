// The mail scenario's routes (pgpt-pro/docs/agentic-bpm/plan.md §6, lib/scenarios/mail.js): send one mail
// through the policies — the same path the chat's send_mail tool takes, without a model, for tests and demos —
// and read my demo outbox (nothing there was really e-mailed).
import express from 'express'
import { getThread } from '../lib/store.js'
import { sendMail, outboxOf, demoFiles, companyDomains } from '../lib/scenarios/mail.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[scenario-mail]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message })
})

export function scenarioMailRoutes(auth) {
  const r = express.Router()

  // {to: [..] | "a, b", subject, body, attachment?: name | text | {name, text}, attachments?: [..], threadId?, card?: false}
  // → the PEP's outcome {decisionId, decision, status, matched, approver, undoUntil, result, facts, messageId}
  r.post('/scenarios/mail/send', auth, (req, res) => send(res, (async () => {
    const b = req.body || {}
    if (b.threadId && !(await getThread(req.user.id, b.threadId))) throw Object.assign(new Error('no such thread'), { status: 404 })
    return sendMail(req.user, b, { threadId: b.threadId || null, card: b.card !== false })
  })()))
  r.get('/scenarios/mail/outbox', auth, (req, res) => send(res, (async () => ({ demo: true, outbox: await outboxOf(req.user, { limit: req.query.limit }) }))()))
  r.get('/scenarios/mail/files', auth, (req, res) => res.json({ files: demoFiles(), companyDomains: companyDomains() }))

  return r
}
