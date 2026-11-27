// 팀원에게 물어 채우기 (lib/askTeammate.js, skill skills/ask-teammate, spec openspec/specs/ask-teammate):
//   POST /api/asks/:id/send     {reason?, fields?, message?}  「물어보기」 · 「고쳐서 물어보기」 — the person's own card only; sent once
//   POST /api/asks/:id/decline                       「아니요(직접 채울게요)」 · 「직접 채우기」 — a request in the room is taken back
//   POST /api/asks/:id/again                         「다시 묻기」 — the same request once more
//   POST /api/team/asks/:id/answer {values, a2ui}    the asked teammate's form (the room's message id) — nobody else may answer
//   POST /api/asks/:id/fill-doc                      「문서에 채우기」 — a document's blanks, by a narrowed agent turn, only on the person's press
// Only teammates of this company (lib/team/access.js requireMember).
import express from 'express'
import { L } from '../lib/lang.js'
import { requireMember } from '../lib/team/access.js'
import * as AT from '../lib/askTeammate.js'

export function askTeammateRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try {
      await requireMember(req.user)
      res.json(await fn(req))
    } catch (e) {
      if (!e.status) console.warn('[ask-teammate]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.status ? e.message : L('처리하지 못했어요.', "I couldn't do that."), ...(e.checks ? { checks: e.checks } : {}) })
    }
  }
  const id = (req) => String(req.params.id || '')
  r.post('/asks/:id/send', auth, h((req) => AT.send(req.user, id(req), { message: req.body?.message, fields: req.body?.fields, reason: req.body?.reason })))
  r.post('/asks/:id/decline', auth, h((req) => AT.decline(req.user, id(req))))
  r.post('/asks/:id/again', auth, h((req) => AT.again(req.user, id(req))))
  r.post('/asks/:id/fill-doc', auth, h((req) => AT.fillDoc(req.user, req.session, id(req))))
  r.post('/team/asks/:id/answer', auth, h((req) => AT.answerForm(req.user, id(req), { values: req.body?.values, a2ui: req.body?.a2ui })))
  return r
}
