// 답을 공유 · 대화를 프로젝트로 (2026-11-27 22:33 휴대폰 녹화 — 스펙 openspec/specs/answer-share, openspec/specs/chat-to-project)
//   GET  /api/messages/:id/share/rooms        an answer of my chat: the rooms and teammates to send it to (lib/answerShare.js)
//   POST /api/messages/:id/share/room         {room | person, note} → the answer in that room
//   POST /api/messages/:id/share/doc          the answer as a Markdown file card under it
//   POST /api/messages/:id/project-offer      「프로젝트로 시작」 on an answer → the confirm card (lib/chatProject.js)
//   POST /api/project-offers/:id/make         {title, template} → the project
//   POST /api/project-offers/:id/decline      「아니요」
import express from 'express'
import { L } from '../lib/lang.js'
import * as AS from '../lib/answerShare.js'
import * as CP from '../lib/chatProject.js'

export function answerRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res)
      if (out !== undefined && !res.headersSent) res.json(out)
    } catch (e) {
      if (!e.status) console.warn('[answers]', req.method, req.path, e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.status ? e.message : L('처리하지 못했어요.', "I couldn't do that."), ...(e.code ? { code: e.code } : {}) })
    }
  }
  const me = (req) => ({ id: req.user.id, email: req.user.email, name: req.user.name })
  // (a small budget per person: a share posts into rooms and tells their people)
  const sent = new Map()
  const budget = (userId, n = 20, ms = 60_000) => {
    const now = Date.now()
    const list = (sent.get(userId) || []).filter((t) => now - t < ms)
    if (list.length >= n) throw Object.assign(new Error(L('잠시 후에 다시 보내 주세요.', 'Please send again in a moment.')), { status: 429 })
    list.push(now)
    sent.set(userId, list)
  }

  r.get('/messages/:id/share/rooms', auth, h((req) => AS.roomsFor(me(req), req.params.id)))
  r.post('/messages/:id/share/room', auth, h((req) => {
    budget(req.user.id)
    const b = req.body || {}
    return AS.shareToRoom(me(req), req.params.id, { room: b.room ? String(b.room) : null, person: b.person ? String(b.person) : null, note: b.note })
  }))
  r.post('/messages/:id/share/doc', auth, h((req) => AS.saveDoc(me(req), req.params.id)))
  r.post('/messages/:id/project-offer', auth, h(async (req) => {
    const msg = await AS.answerOf(me(req), req.params.id)
    return { offer: await CP.offer(me(req), { threadId: msg.thread_id, messageId: msg.id, via: 'button' }) }
  }))
  r.post('/project-offers/:id/make', auth, h((req) => CP.make(me(req), req.params.id, { title: req.body?.title, template: req.body?.template ? String(req.body.template) : null })))
  r.post('/project-offers/:id/decline', auth, h((req) => CP.decline(me(req), req.params.id)))
  return r
}
