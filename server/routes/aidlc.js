// HTTP routes for AI-DLC (Robo-DLC Lite): the dashboards (read-only), and the team session — roles,
// the folder's Claude Code session, the decision page and the decisions typed into the session.
// Every route checks the caller's role in the shared folder that holds the AI-DLC record.
import express from 'express'
import * as A from '../lib/aidlc/service.js'
import { createPresetPanels, PRESETS } from '../lib/aidlc/presets.js'
import * as TM from '../lib/aidlc/team.js'
import * as MOB from '../lib/aidlc/mob.js'
import { scanFolder, poke } from '../lib/aidlc/watch.js'
import * as HK from '../lib/aidlc/hooks.js'
import { folderBySlug } from '../lib/folders/service.js'

export function aidlcRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out) } catch (e) {
      if (!e.status) console.warn('[aidlc]', req.method, req.path, e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.message })
    }
  }
  const me = (req) => ({ id: req.user.id, name: req.user.name, email: req.user.email })
  const at = '/aidlc/:folder/intents/:space/:slug'

  // the team session's own Claude Code hooks (lib/aidlc/hooks.js): from this machine only, signed per session
  const LOCAL = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/
  r.post('/aidlc/hook/:name', h((req) => {
    const name = String(req.params.name)
    if (!LOCAL.test(req.socket.remoteAddress || '') || !HK.verify(name, req.get('x-lite-hook'))) throw Object.assign(new Error('not this server\'s session'), { status: 403 })
    const ev = HK.receive(name, req.body || {})
    if (ev) poke(name)
    if (ev && process.env.PRO_AIDLC_HOOK_LOG === '1') console.log('[aidlc hook]', name, req.body?.hook_event_name, ev.turn, String(req.body?.notification_type || ''))
    return { ok: true }
  }))

  r.get('/aidlc/projects', auth, h((req) => A.projects(me(req))))
  r.get('/aidlc/presets', auth, h(() => PRESETS.map(({ kind, icon, title }) => ({ kind, icon, title: title() }))))
  r.get('/aidlc/:folder/intents', auth, h((req) => A.intents(req.params.folder, me(req))))
  r.get(`${at}/summary`, auth, h((req) => A.summary(req.params.folder, me(req), req.params.space, req.params.slug)))
  r.get(`${at}/timeline`, auth, h((req) => A.timeline(req.params.folder, me(req), req.params.space, req.params.slug,
    { limit: Math.min(Number(req.query.limit) || 50, 500) })))
  r.get(`${at}/questions`, auth, h((req) => A.questions(req.params.folder, me(req), req.params.space, req.params.slug)))
  r.get(`${at}/reviews`, auth, h((req) => A.reviews(req.params.folder, me(req), req.params.space, req.params.slug)))
  // put the ready-made dashboards for one intent on the caller's Home
  r.post('/aidlc/:folder/panels', auth, h(async (req) => {
    const { space, slug, kinds } = req.body || {}
    // access check, and the intent must exist in that folder, before anything is written
    const list = await A.intents(req.params.folder, me(req))
    if (!list.some((i) => i.space === space && i.slug === slug)) throw Object.assign(new Error('intent not found'), { status: 404 })
    return createPresetPanels(req.user.id, { folder: req.params.folder, space, slug, kinds })
  }))
  // ---------- the team (docs/robo-dlc/plan-team.md) ----------
  r.get('/aidlc/:folder/roles', auth, h((req) => TM.roles(req.params.folder, me(req))))
  r.put('/aidlc/:folder/roles', auth, h((req) => TM.setRole(req.params.folder, me(req), { roleKey: req.body?.roleKey, userIds: req.body?.userIds || [] })))
  r.get('/aidlc/:folder/session', auth, h((req) => TM.sessionInfo(req.params.folder, me(req))))
  r.post('/aidlc/:folder/session', auth, h((req) => TM.startSession(req.params.folder, me(req))))
  r.delete('/aidlc/:folder/session', auth, h((req) => TM.stopSession(req.params.folder, me(req))))
  r.get('/aidlc/:folder/decide', auth, h((req) => TM.decideView(req.params.folder, me(req))))
  // a decision changes what waits: look again now rather than at the watcher's next pass
  const rescan = (slug) => folderBySlug(slug).then((f) => f && setTimeout(() => scanFolder(f).catch(() => {}), 2500)).catch(() => {})
  r.post('/aidlc/:folder/decide', auth, h(async (req) => {
    const out = await TM.decide(req.params.folder, me(req), { fingerprint: req.body?.fingerprint, option: req.body?.option, text: req.body?.text })
    rescan(req.params.folder)
    return out
  }))
  r.post('/aidlc/:folder/reply', auth, h(async (req) => {
    const out = await TM.reply(req.params.folder, me(req), { fingerprint: req.body?.fingerprint, text: req.body?.text })
    rescan(req.params.folder)
    return out
  }))
  r.post('/aidlc/:folder/answers', auth, h(async (req) => {
    const out = await TM.submitAnswers(req.params.folder, me(req), { path: req.body?.path, answers: req.body?.answers, proposalId: req.body?.proposalId })
    rescan(req.params.folder)
    return out
  }))
  // the folder's mob room: the team meets there; the meeting's agreed answers come back as a proposal
  r.post('/aidlc/:folder/mob', auth, h((req) => MOB.startMob(req.params.folder, me(req))))
  return r
}
