// Safety policies (decision 1, 2026-11-21): the word lists of policies/*.json, which a company may add to.
//   GET  /policies/:name            what applies to this company (the shipped list + its additions)
//   GET  /policies/:name/history    who changed it, when, why
//   POST /policies/:name {level, add?, remove?, note?}   adding is open to members; taking words out — lowering
//        a safety floor — is an administrator's explicit act (403 POLICY_LOWER_ADMIN_ONLY otherwise)
import express from 'express'
import { config } from '../config.js'
import * as POL from '../lib/policies.js'
import { isAdmin } from '../lib/team.js'

const NAMES = ['purchase', 'privacy']
const send = (res, p) => p.then((x) => res.json(x)).catch((e) => res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) }))

export function policyRoutes(auth) {
  const r = express.Router()
  const known = (req, res, next) => (NAMES.includes(req.params.name) ? next() : res.status(404).json({ error: 'unknown policy', code: 'UNKNOWN_POLICY' }))
  r.get('/policies/:name', auth, known, (req, res) => send(res, (async () => {
    const p = POL.load(req.params.name)
    return { name: req.params.name, levels: p.levels, history: await POL.history(config.tenantId, req.params.name) }
  })()))
  r.get('/policies/:name/history', auth, known, (req, res) => send(res, POL.history(config.tenantId, req.params.name)))
  r.post('/policies/:name', auth, known, (req, res) => send(res, (async () => {
    const b = req.body || {}
    return POL.change({ tenant: config.tenantId, policy: req.params.name, list: b.list || 'words', level: b.level, add: b.add || [], remove: b.remove || [],
      by: req.user.id, admin: await isAdmin(req.user).catch(() => false), note: b.note || '' })
  })()))
  return r
}
