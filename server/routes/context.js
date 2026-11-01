// HTTP routes for 팀 맥락 공유 (openspec changes/pgpt-pro-team-context): 자동 참고의 칩 상태·빼기·고정·끄기, 참고 요청·허락·회수,
// 자동 허용 규칙, 「내 맥락이 쓰인 곳」, 맥락 하나를 보는 사람의 깊이로 보기. 남의 맥락은 언제나 깊이 판정(lib/context)을 거친다.
import express from 'express'
import * as R from '../lib/context/refer.js'
import * as A from '../lib/context/access.js'
import { viewerOf, contextView } from '../lib/context/items.js'

export function contextRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) console.warn('[context]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.message })
    }
  }
  r.post('/context/refer', auth, h((req) => R.refer(req.user, { threadId: req.body.threadId || null, message: req.body.message, current: req.body.current || null })))
  r.get('/context/refer/:id', auth, h((req) => R.referState(req.user, req.params.id)))
  r.post('/context/refer/edit', auth, h((req) => R.referEdit(req.user, req.body)))
  r.post('/context/access-requests', auth, h((req) => A.createRequest(req.user, req.body)))
  r.get('/context/access-requests', auth, h((req) => A.listRequests(req.user, req.query.box || 'incoming')))
  r.get('/context/access-requests/:id/preview', auth, h((req) => A.preview(req.user, req.params.id)))
  r.post('/context/access-requests/:id/decide', auth, h((req) => A.decideRequest(req.user, req.params.id, req.body)))
  r.get('/context/grants', auth, h((req) => A.grantsList(req.user)))
  r.delete('/context/grants/:id', auth, h((req) => A.revoke(req.user, req.params.id)))
  r.get('/context/sharing-rules', auth, h((req) => A.rulesOf(req.user.id)))
  r.put('/context/sharing-rules', auth, h((req) => A.saveRules(req.user, req.body)))
  r.get('/context/used', auth, h((req) => A.usedBy(req.user)))
  r.get('/context/items/:conv', auth, h(async (req) => contextView(await viewerOf(req.user), req.params.conv, { threadId: req.query.thread || null })))
  // 켜질 때와 5분마다 맥락 임베딩을 데운다(첫 턴이 2초 제한에 걸리지 않게)
  const heat = () => import('../lib/supa.js').then(({ eachTenant }) => eachTenant(() => R.warm())).catch((e) => console.warn('[context] warm', e.message))
  setTimeout(heat, 3000).unref?.(); setInterval(heat, 5 * 60000).unref?.()
  return r
}
