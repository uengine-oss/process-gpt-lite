// HTTP routes for panel apps (패널 앱). Every route checks the caller's role in the app's folder.
import express from 'express'
import * as P from '../lib/panelApps/service.js'
import { generatePanel } from '../lib/panels.js'

// a db row's version is a timestamp ("…12.700084+00"); sent unencoded, its "+" arrives as a space
const rowVersion = (v) => (typeof v === 'string' ? v.replace(/ (\d{2}(?::?\d{2})?)$/, '+$1') : v)

export function panelAppRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out) } catch (e) {
      if (!e.status) console.warn('[panelApps]', req.method, req.path, e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.message, problems: e.problems, needConfirm: e.needConfirm })
    }
  }
  // the JWT goes along: a db app's reads and writes run as this person in the database (RLS)
  const me = (req) => ({ id: req.user.id, name: req.user.name, email: req.user.email, jwt: req.session.access_token })

  r.get('/panel-apps', auth, h((req) => P.listApps(me(req), { all: req.query.all === '1' })))
  // design + create from a description (the Home button and the chat use the same function)
  r.post('/panel-apps', auth, h(async (req) => {
    const d = await P.design(req.body.description)
    if (d.kind === 'live') return { kind: 'live', panel: await generatePanel({ userId: req.user.id, description: req.body.description }) }
    return { kind: 'data', app: await P.createApp(me(req), { description: req.body.description, def: d.def, rows: d.rows, folderHint: req.body.folder || '' }) }
  }))
  r.get('/panel-apps/:id/rows', auth, h((req) => P.rows(me(req), req.params.id)))
  r.post('/panel-apps/:id/rows', auth, h((req) => P.write(me(req), req.params.id, { add: req.body.values || {} })))
  r.put('/panel-apps/:id/rows/:rid', auth, h((req) => P.write(me(req), req.params.id, { update: { id: req.params.rid, v: req.body._v, vals: req.body.values || {} } })))
  r.delete('/panel-apps/:id/rows/:rid', auth, h((req) => P.write(me(req), req.params.id, { remove: { id: req.params.rid, v: rowVersion(req.query._v) } })))
  r.post('/panel-apps/:id/sheet', auth, h((req) => P.sheetCopy(me(req), req.params.id)))
  r.post('/panel-apps/:id/sheet-saved', auth, h((req) => P.sheetSaved(me(req), req.params.id, req.body || {})))
  r.post('/panel-apps/:id/hide', auth, h((req) => P.hide(me(req), req.params.id, req.body?.hidden !== false)))
  r.post('/panel-apps/:id/announce', auth, h(async (req) => { const { folder } = await P.appFor(me(req), req.params.id); await P.announce(folder.slug); return { ok: true } }))
  // tier db: rules (owner), fields (owner, drops need confirmDrop), folder snapshot (editor), migration log (owner)
  r.put('/panel-apps/:id/rules', auth, h((req) => P.setRules(me(req), req.params.id, req.body || {})))
  r.put('/panel-apps/:id/fields', auth, h((req) => P.changeFields(me(req), req.params.id, req.body || {})))
  r.post('/panel-apps/:id/snapshot', auth, h((req) => P.snapshot(me(req), req.params.id)))
  r.get('/panel-apps/:id/migrations', auth, h((req) => P.migrations(me(req), req.params.id)))
  // kind events: append a record (부여·신청·취소…); nothing is ever edited or deleted
  r.post('/panel-apps/:id/events', auth, h((req) => P.appendEvent(me(req), req.params.id, req.body || {})))
  r.put('/panel-apps/:id/event-rules', auth, h((req) => P.setEventRules(me(req), req.params.id, req.body || {})))
  r.post('/panel-apps/:id/convert', auth, h((req) => P.convertToEvents(me(req), req.params.id, req.body || {})))
  // privacy: the creator confirms the defaults; sensitivity changes (lowering needs confirm, audited)
  r.post('/panel-apps/:id/privacy-ack', auth, h((req) => P.privacyAck(me(req), req.params.id)))
  r.put('/panel-apps/:id/sensitivity', auth, h((req) => P.setSensitivity(me(req), req.params.id, req.body || {})))
  r.delete('/panel-apps/:id', auth, h((req) => P.remove(me(req), req.params.id)))
  return r
}
