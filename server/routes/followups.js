// 후행 습관(lib/followups.js): a person's habits in Settings, and the answers to the card that asks about one.
import express from 'express'
import { runTurn } from '../lib/agent.js'
import { HABIT, answerCard, listHabits, removeHabit, setHabit, whenText } from '../lib/followups.js'
import { removeRule, ruleOf } from '../lib/roomRules.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[followups]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message })
})

export function followupRoutes(auth) {
  const r = express.Router()
  r.get('/followups', auth, (req, res) => send(res, listHabits(req.user.id).then((rows) => ({ minSeen: HABIT.minSeen, habits: rows.map((h) => ({ ...h, when: whenText(h.event_cls) })) }))))
  r.patch('/followups/:id', auth, (req, res) => send(res, setHabit(req.user.id, req.params.id, req.body?.state)))
  r.delete('/followups/:id', auth, (req, res) => send(res, removeHabit(req.user.id, req.params.id)))
  r.post('/followups/answer/:messageId', auth, (req, res) => send(res, answerCard(req.user, req.params.messageId, req.body?.choice).then((a) => {
    // the same turn the person would have asked for by hand, in the conversation it belongs to
    if (a.action) runTurn({ user: req.user, session: req.session, threadId: a.threadId, text: a.action, files: a.files, conversation: a.conversation, fresh: true, habitId: a.habitId }).catch((e) => console.warn('[followups] run', e.message))
    return { state: a.state }
  })))
  // 방 규칙(lib/roomRules.js): 이 방에 걸린 약속을 보고 끈다
  r.get('/threads/:id/rule', auth, (req, res) => send(res, ruleOf(req.user.id, req.params.id).then((rule) => ({ rule }))))
  r.delete('/threads/:id/rule', auth, (req, res) => send(res, removeRule(req.user.id, req.params.id)))
  return r
}
