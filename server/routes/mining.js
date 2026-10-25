// HTTP routes for process mining: recommendations from repeated ad-hoc work and the admin's decision.
import express from 'express'
import * as M from '../lib/mining/service.js'

export function miningRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) console.warn('[mining]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.status ? e.message : '처리하지 못했어요.' })
    }
  }
  const admin = async (req) => { if (!(await M.isAdmin(req.user))) throw Object.assign(new Error('관리자만 볼 수 있어요.'), { status: 403 }) }

  r.get('/mining/me', auth, h(async (req) => ({ admin: await M.isAdmin(req.user) })))
  r.get('/mining/suggestions', auth, h(async (req) => { await admin(req); return M.list() }))
  r.post('/mining/scan', auth, h(async (req) => { await admin(req); return { made: (await M.scan()).map((s) => s.id) } }))
  r.get('/mining/suggestions/:id', auth, h(async (req) => {
    await admin(req)
    const s = await M.get(req.params.id)
    if (!s) throw Object.assign(new Error('추천을 찾지 못했어요.'), { status: 404 })
    return s
  }))
  r.post('/mining/suggestions/:id/register', auth, h((req) => M.register(req.user, req.params.id)))
  r.post('/mining/suggestions/:id/hold', auth, h((req) => M.hold(req.user, req.params.id)))
  return r
}

// the miner looks again now and then: a pattern appears once enough cases have piled up
export function startMiningScan() {
  setInterval(() => M.scan().catch((e) => console.warn('[mining] scan', e.message)), 60_000)
  setTimeout(() => M.scan().catch((e) => console.warn('[mining] scan', e.message)), 8000)
}
