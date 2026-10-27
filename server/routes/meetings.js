// HTTP routes for meetings in a team room (lib/meetings/service.js). Every route: signed in, on the
// team, and one of the room's people (the service checks the room; anything else is a 404).
// Design: process-gpt/openspec/changes/pgpt-pro-meetings/design.md
import express from 'express'
import { TeamError, requireMember } from '../lib/team/access.js'
import * as S from '../lib/meetings/service.js'
import { runAs } from './teamAssist.js'

export function meetingRoutes(auth) {
  const r = express.Router()
  if (process.env.PRO_BACKGROUND !== '0') S.startSweeper()
  const h = (fn) => async (req, res) => {
    try {
      if (!S.enabled()) throw new TeamError(404, '회의 기능이 꺼져 있어요.')
      await requireMember(req.user)
      const out = await fn(req, res)
      if (out !== undefined && !res.headersSent) res.json(out)
    } catch (e) {
      if (!(e instanceof TeamError) && !e.status) console.warn('[meetings]', req.method, req.path, e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ error: e instanceof TeamError || e.status ? e.message : '처리하지 못했어요.' })
    }
  }
  const id = (req) => String(req.params.id || '')

  r.get('/meetings/config', auth, (req, res) => res.json({ enabled: S.enabled(), agent: S.agentEnabled(), max: S.MAX }))
  r.get('/meetings/stats', auth, h(() => S.report()))
  // the room's meeting (header button / card), start, the room's assistant switch
  r.get('/meetings/room/:roomId', auth, h((req) => S.roomMeeting(req.user, req.params.roomId)))
  r.post('/meetings/room/:roomId/start', auth, h((req) => S.start(req.user, req.params.roomId, { consent: !!req.body?.consent })))
  r.put('/meetings/room/:roomId/agent', auth, h((req) => S.setRoomAgent(req.user, req.params.roomId, !!req.body?.on)))

  r.get('/meetings/:id', auth, h((req) => S.state(req.user, id(req))))
  r.post('/meetings/:id/join', auth, h((req) => S.join(req.user, id(req), { consent: !!req.body?.consent })))
  r.post('/meetings/:id/leave', auth, h((req) => S.leave(req.user, id(req))))
  r.post('/meetings/:id/end', auth, h((req) => S.endFor(req.user, id(req))))
  r.post('/meetings/:id/heartbeat', auth, h((req) => S.heartbeat(req.user, id(req))))
  r.put('/meetings/:id/consent', auth, h((req) => S.setConsent(req.user, id(req), !!req.body?.on)))
  r.post('/meetings/:id/signal', auth, h((req) => S.signal(req.user, id(req), req.body || {})))
  r.post('/meetings/:id/media', auth, h((req) => S.media(req.user, id(req), req.body || {})))
  // one spoken piece (WAV) from the speaker's own microphone; a typed line goes the same way
  r.post('/meetings/:id/audio', express.raw({ type: () => true, limit: '3mb' }), auth, h((req) => S.audio(req.user, id(req), req.body, String(req.headers['content-type'] || 'audio/wav'))))
  r.post('/meetings/:id/lines', auth, h((req) => S.typed(req.user, id(req), req.body?.text)))
  // materials: open (my card or my copy), present to everyone, take it down
  r.post('/meetings/:id/materials/:mid/open', auth, h((req) => S.openMaterial(req.user, id(req), req.params.mid)))
  r.post('/meetings/:id/materials/:mid/present', auth, h((req) => S.present(req.user, id(req), req.params.mid)))
  r.post('/meetings/:id/present/clear', auth, h((req) => S.unpresent(req.user, id(req))))
  // a request heard in the meeting: 시작 runs it as me (team assist's runAs), 아니요 hides it for me
  r.post('/meetings/:id/suggestions/:sid/start', auth, h((req) => S.startSuggestion(req.user, id(req), req.params.sid, runAs(req.user, req.session))))
  r.post('/meetings/:id/suggestions/:sid/dismiss', auth, h((req) => S.dismissSuggestion(req.user, id(req), req.params.sid)))
  return r
}
