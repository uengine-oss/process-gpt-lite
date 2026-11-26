// 프로젝트 계획(lib/projectNote.js): the room's plan — read with its history, edited by the room's owner, a change taken back from its chip or
// its history entry — and the rule's
// skill picked on the rule bar (lib/roomRules.js setRuleSkill, design turnplan §4.4). Every route answers only the room's owner (a project
// of someone else's is 404 — 사용자 결정 11-25 「프로젝트 메모 = 주인만」).
import express from 'express'
import { getNote, editNote, undoChange, revertChange } from '../lib/projectNote.js'
import { setRuleSkill } from '../lib/roomRules.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[project-plan]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message })
})

export function projectNoteRoutes(auth) {
  const r = express.Router()
  r.get('/threads/:id/note', auth, (req, res) => send(res, getNote(req.user.id, req.params.id)))
  r.put('/threads/:id/note', auth, (req, res) => send(res, editNote(req.user.id, req.params.id, req.body || {})))
  r.post('/threads/:id/note/undo', auth, (req, res) => send(res, undoChange(req.user.id, req.params.id, req.body?.chipId)))
  // one entry of the plan's history (GET …/note → history[]), taken back
  r.post('/threads/:id/note/revert', auth, (req, res) => send(res, revertChange(req.user.id, req.params.id, req.body?.noteId)))
  r.put('/threads/:id/rule', auth, (req, res) => send(res, setRuleSkill(req.user.id, req.params.id, req.body?.skill).then((rule) => {
    if (!rule) throw Object.assign(new Error('no rule'), { status: 404 })
    return { rule }
  })))
  return r
}
