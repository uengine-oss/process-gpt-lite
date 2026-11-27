// 답을 공유 · 대화를 프로젝트로 (2026-11-27 22:33 휴대폰 녹화 — 스펙 openspec/specs/answer-share, openspec/specs/chat-to-project)
//   GET  /api/messages/:id/share/rooms        an answer of my chat: the rooms and teammates to send it to (lib/answerShare.js)
//   POST /api/messages/:id/share/room         {room | person, note} → the answer in that room
//   POST /api/messages/:id/share/doc          the answer as a Markdown file card under it
//   GET  /api/messages/:id/share/text         the cleaned words for 「글 복사」 (text) and 「다른 앱으로 보내기」 (plain — the phone's share sheet)
//   POST /api/messages/:id/project-offer      「프로젝트로 시작」 on an answer → the confirm card (lib/chatProject.js)
//   POST /api/project-offers/:id/make         {title, template} → the project
//   POST /api/project-offers/:id/decline      「아니요」
import express from 'express'
import { L } from '../lib/lang.js'
import * as AS from '../lib/answerShare.js'
import * as CP from '../lib/chatProject.js'
import { requireMember } from '../lib/team/access.js'

// how many times a minute one person may ask for an answer's words (GET …/share/text — each sheet opened asks once)
export const TEXT_PER_MIN = Number(process.env.PRO_ANSWER_TEXT_PER_MIN || 60)

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
  // (a small budget per person and kind: a share posts into rooms and tells their people; the words for 「글 복사」 · 「다른 앱으로 보내기」 are
  // cleaned and read into plain text on each ask — one per sheet opened, a larger bucket of its own)
  const sent = new Map()
  const budget = (key, n = 20, ms = 60_000) => {
    const now = Date.now()
    const list = (sent.get(key) || []).filter((t) => now - t < ms)
    if (list.length >= n) throw Object.assign(new Error(L('잠시 후에 다시 보내 주세요.', 'Please send again in a moment.')), { status: 429 })
    list.push(now)
    sent.set(key, list)
  }

  // (to a room or a person: teammates only — someone taken off the team neither lists the rooms nor opens a conversation of two by sending:
  // the messenger's own rule, routes/team.js)
  r.get('/messages/:id/share/rooms', auth, h(async (req) => { await requireMember(req.user); return AS.roomsFor(me(req), req.params.id) }))
  r.post('/messages/:id/share/room', auth, h(async (req) => {
    await requireMember(req.user)
    budget(req.user.id)
    const b = req.body || {}
    return AS.shareToRoom(me(req), req.params.id, { room: b.room ? String(b.room) : null, person: b.person ? String(b.person) : null, note: b.note })
  }))
  r.post('/messages/:id/share/doc', auth, h((req) => AS.saveDoc(me(req), req.params.id)))
  // (「글 복사」 · 「다른 앱으로 보내기」: the words only — the person's clipboard or phone takes them, wherever they pick; their own answer, no team rule)
  r.get('/messages/:id/share/text', auth, h((req) => { budget(`${req.user.id}:text`, TEXT_PER_MIN); return AS.textFor(me(req), req.params.id) }))
  r.post('/messages/:id/project-offer', auth, h(async (req) => {
    const msg = await AS.answerOf(me(req), req.params.id)
    return { offer: await CP.offer(me(req), { threadId: msg.thread_id, messageId: msg.id, via: 'button' }) }
  }))
  // (what the card showed and the person confirmed — the name, the purpose, what it will make, the background: lib/chatProject.js confirmed)
  r.post('/project-offers/:id/make', auth, h((req) => {
    const b = req.body || {}
    return CP.make(me(req), req.params.id, { template: b.template ? String(b.template) : null,
      ...Object.fromEntries(['title', 'intent', 'background', 'deliverables'].filter((k) => k in b).map((k) => [k, b[k]])) })
  }))
  r.post('/project-offers/:id/decline', auth, h((req) => CP.decline(me(req), req.params.id)))
  return r
}
