// HTTP routes for 공개 등급 (openspec changes/pgpt-pro-team-context, spec pgpt-pro_context-visibility): 내 대화 맥락과 그 등급,
// 등급 바꾸기(주인만 — 남이면 없는 맥락과 같은 404), 민감 표시·제안, 「누가 무엇을 보게 되나」 미리보기, 내 맥락을 본 기록, 새 맥락의 기본 등급.
import express from 'express'
import * as G from '../lib/context/grade.js'

export function contextGradeRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) console.warn('[context-grade]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.message })
    }
  }
  r.get('/context/mine', auth, h((req) => G.myContexts(req.user, { conv: req.query.conv || null })))
  r.patch('/context/items/:conv/grade', auth, h((req) => G.setGrade(req.user, req.params.conv, req.body || {})))
  r.post('/context/items/:conv/sensitive', auth, h((req) => G.setSensitive(req.user, req.params.conv, req.body?.action)))
  r.post('/context/sensitive/scan', auth, h((req) => G.scanSensitive(req.user)))
  r.get('/context/visibility/preview', auth, h((req) => G.previewGrade(req.user, req.query)))
  r.get('/context/views', auth, h((req) => G.myViews(req.user)))
  r.put('/context/defaults', auth, h((req) => G.saveDefaults(req.user, req.body || {})))
  return r
}
