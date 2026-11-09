// HTTP routes for AI-DLC dashboards (Robo-DLC Lite). Read-only; every route checks the caller's role
// in the shared folder that holds the AI-DLC record.
import express from 'express'
import * as A from '../lib/aidlc/service.js'
import { createPresetPanels, PRESETS } from '../lib/aidlc/presets.js'

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
  return r
}
