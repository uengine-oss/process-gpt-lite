// HTTP routes for business packs (업무 팩, lib/skillInstall.js): which packs this install has, which this
// company has on, and the admin's switch. Turning one on installs its skills for the company (deepagents
// tenant skills, the admin's own JWT); turning it off takes our untouched copies away again.
// Mounted from routes/process.js until index.js mounts it itself (app.use('/api', packRoutes(auth))).
import express from 'express'
import { L } from '../lib/lang.js'
import { packStatus, enablePack, disablePack, checkPacksSoon } from '../lib/skillInstall.js'
import { isAdmin } from '../lib/mining/service.js'

export function packRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) console.warn('[packs]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.message, ...(e.code ? { code: e.code } : {}) })
    }
  }
  const adminOnly = async (req) => {
    if (!(await isAdmin(req.user))) throw Object.assign(new Error(L('관리자만 업무 팩을 켜고 끌 수 있어요.', 'Only an administrator can turn business packs on or off.')), { status: 403, code: 'ADMIN_ONLY' })
  }
  r.get('/packs', auth, h(async (req) => {
    // a newer version of a pack this company has on goes over the copies it has not changed (in the background)
    checkPacksSoon(req.session?.access_token, req.user.id)
    return { admin: await isAdmin(req.user), packs: await packStatus() }
  }))
  r.put('/packs/:name', auth, h(async (req) => {
    await adminOnly(req)
    const opts = { jwt: req.session?.access_token, by: req.user.id }
    const out = req.body?.enabled === false ? await disablePack(req.params.name, opts) : await enablePack(req.params.name, opts)
    return { ...out, packs: await packStatus() }
  }))
  return r
}
