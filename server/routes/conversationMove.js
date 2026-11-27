// 대화를 프로젝트로 옮기기 (lib/conversationMove.js — spec openspec/specs/thread-to-project)
//   GET  /api/conversations/:cid/move           the conversation (name · messages · may it move) and the person's projects (may it go there, who
//                                               else sees what it makes)
//   POST /api/conversations/:cid/move           {project, membersOk} → it moves there
//   POST /api/conversations/:cid/move/undo      {project} → back to the chat (only the one who moved it)
//   POST /api/conversations/:cid/move/offer     → 「새 프로젝트로」: the confirm card of 「프로젝트로 시작」 (lib/chatProject.js) for this conversation;
//                                               its 「만들고 옮기기」 makes the project and moves the conversation into it
//   GET  /api/conversations/:cid/place          where a conversation of this person now lives (a link to /chat/c/<id> follows it there)
//   POST /api/conv-move-cards/:id/decline       「아니요」 on the card the words made (「이 대화 프로젝트로 옮겨 줘」 — lib/conversationMove.js offerByWords)
import express from 'express'
import { L } from '../lib/lang.js'
import * as CM from '../lib/conversationMove.js'

export function conversationMoveRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res)
      if (out !== undefined && !res.headersSent) res.json(out)
    } catch (e) {
      if (!e.status) console.warn('[conv-move]', req.method, req.path, e.message)
      if (!res.headersSent) {
        res.status(e.status || 500).json({ error: e.status ? e.message : L('처리하지 못했어요.', "I couldn't do that."), ...(e.code ? { code: e.code } : {}),
          ...(e.members ? { members: e.members } : {}), ...(e.place ? { place: e.place } : {}) })
      }
    }
  }
  const me = (req) => ({ id: req.user.id, email: req.user.email, name: req.user.name })
  r.get('/conversations/:cid/move', auth, h((req) => CM.targets(me(req), req.params.cid)))
  r.post('/conversations/:cid/move', auth, h((req) => CM.move(me(req), req.params.cid, { project: req.body?.project ? String(req.body.project) : null, membersOk: req.body?.membersOk === true })))
  r.post('/conversations/:cid/move/undo', auth, h((req) => CM.undo(me(req), req.params.cid, { project: req.body?.project ? String(req.body.project) : null })))
  r.post('/conversations/:cid/move/offer', auth, h(async (req) => ({ offer: await CM.offerNew(me(req), req.params.cid) })))
  r.post('/conv-move-cards/:id/decline', auth, h((req) => CM.declineCard(me(req), req.params.id)))
  r.get('/conversations/:cid/place', auth, h(async (req, res) => {
    const place = await CM.placeOf(me(req), req.params.cid)
    if (!place) { res.status(404).json({ error: L('대화를 찾지 못했어요.', "I couldn't find that conversation.") }); return undefined }
    return place
  }))
  return r
}
