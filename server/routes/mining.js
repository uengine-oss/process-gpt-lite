// HTTP routes for process mining: recommendations from repeated ad-hoc work and the admin's decision.
import express from 'express'
import * as M from '../lib/mining/service.js'
import { q, eachTenant } from '../lib/supa.js'
import { canSeeInstance, getInstance } from '../lib/processes.js'
import { mainThread, addMessage } from '../lib/store.js'
import { L } from '../lib/lang.js'

// The outputs of a work item's instance (files the earlier steps produced), for whoever reviews it.
// Only a participant or work-item holder of that instance may see or open them (canSeeInstance).
async function outputsOf(me, todoId) {
  const [t] = await q('select proc_inst_id from todolist where id=$1', [todoId])
  if (!t?.proc_inst_id) throw Object.assign(new Error(L('작업을 찾지 못했어요.', "I couldn't find that work item.")), { status: 404 })
  if (!(await canSeeInstance(t.proc_inst_id, me))) throw Object.assign(new Error(L('이 프로세스를 볼 권한이 없어요.', "You don't have access to this process.")), { status: 403 })
  const d = await getInstance(t.proc_inst_id, me)
  const seen = new Set()
  return { instId: t.proc_inst_id, files: (d?.artifacts || []).filter((a) => a.kind === 'file' && a.url && !seen.has(a.url) && seen.add(a.url))
    .map((a) => ({ name: a.name, url: a.url, step: a.activity })) }
}

export function miningRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) console.warn('[mining]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.status ? e.message : L('처리하지 못했어요.', "I couldn't do that.") })
    }
  }
  const admin = async (req) => { if (!(await M.isAdmin(req.user))) throw Object.assign(new Error(L('관리자만 볼 수 있어요.', 'Only an administrator can see this.')), { status: 403 }) }

  r.get('/todos/:id/outputs', auth, h((req) => outputsOf(req.user, req.params.id)))
  // open one output: the reviewer gets their own file card (edits save to their card, never the step's file)
  r.post('/todos/:id/outputs/open', auth, h(async (req) => {
    const { files } = await outputsOf(req.user, req.params.id)
    const f = files.find((x) => x.url === req.body?.url)
    if (!f) throw Object.assign(new Error(L('산출물을 찾지 못했어요.', "I couldn't find that output.")), { status: 404 })
    const t = await mainThread(req.user.id)
    const [have] = await q(`select * from pro_messages where thread_id=$1 and kind='file' and content->>'source_url'=$2 order by created_at desc limit 1`, [t.id, f.url])
    return have || addMessage(req.user.id, t.id, 'agent', 'file', { name: f.name, url: f.url, source_url: f.url, step: f.step })
  }))
  r.get('/mining/me', auth, h(async (req) => ({ admin: await M.isAdmin(req.user) })))
  r.get('/mining/suggestions', auth, h(async (req) => { await admin(req); return M.list() }))
  r.post('/mining/scan', auth, h(async (req) => { await admin(req); return { made: (await M.scan()).map((s) => s.id) } }))
  r.get('/mining/suggestions/:id', auth, h(async (req) => {
    await admin(req)
    const s = await M.get(req.params.id)
    if (!s) throw Object.assign(new Error(L('추천을 찾지 못했어요.', "I couldn't find that recommendation.")), { status: 404 })
    return s
  }))
  r.post('/mining/suggestions/:id/register', auth, h((req) => M.register(req.user, req.params.id)))
  r.post('/mining/suggestions/:id/hold', auth, h((req) => M.hold(req.user, req.params.id)))
  return r
}

// the miner looks again now and then: a pattern appears once enough cases have piled up
export function startMiningScan() {
  setInterval(() => eachTenant(() => M.scan()).catch((e) => console.warn('[mining] scan', e.message)), 60_000)
  setTimeout(() => eachTenant(() => M.scan()).catch((e) => console.warn('[mining] scan', e.message)), 8000)
}
