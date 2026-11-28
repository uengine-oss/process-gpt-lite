// HTTP routes for answering a mail from its Home card (lib/mailReply.js). Nothing here runs an agent:
// the reply leaves only through POST /actions/:id/reply, which the 보내기 button sends.
//   GET  /mail/cards               [action]                                          the messenger's 대화 › 메일 list
//   GET  /actions/:id/mail         {provider, mode, mail, files, to, reply, sent}   the mail as it arrived
//   POST /actions/:id/reply-draft  → {reply, files}                                  a draft to read and change
//   POST /actions/:id/reply        {to, cc, subject, body, files} → {ok, sent}        sent (or put in Drafts); no answer in time → 504 send_unknown
//   POST /actions/:id/reply/resolve {sent} → {ok}                                    after send_unknown: 보냈어요 · 안 나갔어요
// What the card is for, and the calendar card's event (lib/mailCard.js) — nothing is made until the person presses 캘린더에 추가:
//   GET  /actions/:id/kind         {kind: calendar|reply|task, by, p}               decided once (the judge) and kept on the card
//   GET  /actions/:id/event?tz=    {mode: google|demo|none|scope, draft, event?}     the event read from the mail, to edit
//   POST /actions/:id/event        {title, date, start, durationMin, allDay, location, link, description, tz} → {ok, event, already?}
// (someone else's card: 403)
// The mail's place in the work (lib/mailFlow.js) — nothing starts until the person presses 새로 시작 · 잇기:
//   GET  /mail/card?action=&mail=  action                                            the card a chat chip names
//   GET  /actions/:id/flow         {linked} | {matches, joins, declined}             its instance, or what it may start or join
//   POST /actions/:id/flow/start   {proc, task?} → {instId}                          a new case of that process
//   POST /actions/:id/flow/join    {instId} → {instId}                               the running instance
//   POST /actions/:id/flow/decline {undo?}                                           이번엔 안 해요
// Not only a reply (lib/mailFollow.js) — the sheet's row of follow-up actions; an agent action runs only when pressed:
//   GET  /actions/:id/follow       {actions: [{key, do, label, go, says, p?, run?}], read}   이 회사 알아보기 · 채팅에서 이어서 · the judge's picks
//   POST /actions/:id/follow/:key  {again?} → {run, already?}                        an agent action (research …) — its result's place stays on the card
// The mail to a conversation (lib/mailRooms.js) — nothing is sent before 보내기:
//   GET  /actions/:id/rooms[?only=shared] {rooms: [{id, title, why, suggested}], people, shared, choices, choice, files}   the picker, the likeliest first
//   POST /actions/:id/rooms        {room | person, note?, body?, files?, follow?} → {room, message, shared}         a mail mention in that room
//   POST /actions/:id/rooms/:room/stop {what: body | files | follow} → {shared}                                    본문 · 첨부 · 앞으로 올리기 끄기
import express from 'express'
import * as R from '../lib/mailReply.js'
import * as MF from '../lib/mailFlow.js'
import * as C from '../lib/mailCard.js'
import * as F from '../lib/mailFollow.js'
import * as MR from '../lib/mailRooms.js'
import { rateLimit, requireMember } from '../lib/team/access.js'
import { mailCards } from '../lib/homeCards.js'
import { L } from '../lib/lang.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[mail reply]', e.message)
  res.status(e.status || 500).json({ error: e.status ? e.message : L('메일을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.', "Couldn't handle the mail. Please try again in a moment."), ...(e.code && { code: e.code }) })
})

export function mailReplyRoutes(auth) {
  const r = express.Router()
  // 대화 › 메일 (the messenger's 메일 chip): the cards made from mail — a card put away from Home is still here (lib/homeCards.js)
  r.get('/mail/cards', auth, (req, res) => send(res, mailCards(req.user.id)))
  r.get('/actions/:id/mail', auth, (req, res) => send(res, R.mailOfCard(req.user, req.params.id)))
  r.post('/actions/:id/reply-draft', auth, (req, res) => send(res, R.draftReply(req.user, req.params.id)))
  r.post('/actions/:id/reply', auth, (req, res) => send(res, R.sendReply(req.user, req.params.id, req.body || {})))
  // after 「보냈는지 확인하지 못했어요」 (a send with no answer in time): 보냈어요 · 안 나갔어요
  r.post('/actions/:id/reply/resolve', auth, (req, res) => send(res, R.resolveReply(req.user, req.params.id, { sent: req.body?.sent === true })))
  r.get('/actions/:id/kind', auth, (req, res) => send(res, C.kindOfCard(req.user, req.params.id)))
  r.get('/actions/:id/event', auth, (req, res) => send(res, C.eventOfCard(req.user, req.params.id, { tz: req.query.tz ? String(req.query.tz) : null })))
  r.post('/actions/:id/event', auth, (req, res) => send(res, C.addEvent(req.user, req.params.id, req.body || {})))
  r.get('/mail/card', auth, (req, res) => send(res, MF.cardByRef(req.user.id, { action: req.query.action ? String(req.query.action) : null, mail: req.query.mail ? String(req.query.mail) : null })))
  r.get('/actions/:id/flow', auth, (req, res) => send(res, MF.flowOfCard(req.user, req.params.id)))
  r.post('/actions/:id/flow/start', auth, (req, res) => send(res, MF.startFromCard(req.user, req.params.id, { proc: String(req.body?.proc || ''), task: req.body?.task ? String(req.body.task) : null })))
  r.post('/actions/:id/flow/join', auth, (req, res) => send(res, MF.joinFromCard(req.user, req.params.id, { instId: String(req.body?.instId || '') })))
  r.post('/actions/:id/flow/decline', auth, (req, res) => send(res, MF.declineFlow(req.user, req.params.id, { undo: req.body?.undo === true })))
  r.get('/actions/:id/follow', auth, (req, res) => send(res, F.followOfCard(req.user, req.params.id)))
  r.post('/actions/:id/follow/:key', auth, (req, res) => send(res, F.runFollow(req.user, req.session, req.params.id, String(req.params.key || ''), { again: req.body?.again === true })))
  // (the rooms are the team's: someone signed in but not on the team gets none — routes/team.js does the same)
  // (where it is shared stays the owner's to see — and to switch off — after they left the team)
  r.get('/actions/:id/rooms', auth, (req, res) => send(res, (req.query.only === 'shared' ? Promise.resolve() : requireMember(req.user))
    .then(() => MR.roomsOfCard(req.user, req.params.id, { only: req.query.only === 'shared' ? 'shared' : null }))))
  r.post('/actions/:id/rooms', auth, (req, res) => send(res, requireMember(req.user).then(() => {
    rateLimit(req.user.id)
    const b = req.body || {}
    return MR.shareToRoom(req.user, req.params.id, { room: b.room ? String(b.room) : null, person: b.person ? String(b.person) : null, note: typeof b.note === 'string' ? b.note : '',
      body: b.body === true, files: b.files === true, follow: MR.BY.includes(b.follow) ? b.follow : null })
  })))
  r.post('/actions/:id/rooms/:room/stop', auth, (req, res) => send(res, MR.stopRoom(req.user, req.params.id, String(req.params.room || ''), String(req.body?.what || ''))))
  return r
}
