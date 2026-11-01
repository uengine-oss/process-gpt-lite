// HTTP routes for 팀 활동 (openspec changes/pgpt-pro-team-context, spec pgpt-pro_team-activity). 계산은 lib/context/activity.js —
// 모든 칸은 보는 사람이 그 맥락에 가진 깊이(lib/context/visibility.depthOf)로만 채운다. 깊이가 모자란 곳에는
// request: {conversationId, depth: 'content'} 가 붙는다 → POST /api/context/access-requests 로 그대로 보낸다.
//
//   GET /api/team-activity?scope=team|department|company
//       → { scope, viewer: {id, name, admin, can_org, in_org}, at, cards: [{
//            user, name, team, relation(본인|관리자|장|같은 팀|같은 부서|다른 팀), built_at, stale?,
//            now: [{conversationId, title, purpose, depth, at, line?(요약부터), request?}]          지금 하는 일(7일, 세 개까지)
//            kinds: [{name, count}]                                                            주로 하는 일(30일, 제목 깊이도 셈)
//            prompt_types: [{name, count, examples?(원문 깊이 맥락에서만)}], prompt_types_unnamed  자주 쓰는 프롬프트 유형(요약부터)
//            running: {count, hidden, items: [{kind, kind_label, title, detail?, started_at, status, status_label, conversationId?}]}
//            artifacts: [{name, kind, ext, at, conversationId?, context?, url?(원문 깊이)}]         최근 산출물(요약부터)
//            amount: {turns, contexts, cost?: {usd, credits}(본인·장·관리자)}, private?: {count}(관리자) }] }
//       요약 깊이가 있는 카드는 사람마다 하루 한 줄로 열람 기록(pro_context_views)에 모인다.
//   GET /api/team-activity/:user/timeline?conv=<conversationId>
//       → { item: {conversationId, title, purpose, owner, owner_name, depth, why, mine, updated_at, turns, summary?, decisions?, questions?},
//           lines: [{kind: prompt|ai|artifact|excluded, at, work?, prompt?, answer?, type?, line?, title?, name?, request?}], request, built_at }
//       원문 = 프롬프트 문장 + 답 첫 줄 · 요약 = 유형 이름 + 바꿔 쓴 한 줄(프롬프트 문장 없음) · 제목 = 시각·작업 유형. 깊이 없음이면 404.
//   GET /api/team-activity/org            장·관리자만(아니면 403) → { roots: [{id, name, lead, members, stats: {people, contexts, private,
//                                          turns, cost, running, topics: [{conversationId, title, owner_name, depth, turns, line?}], kinds}, children}], built_at }
//   GET /api/team-activity/overlaps[?min=]  → { min, days, pairs: [{score, a: side, b: side}] } side = {conversationId, title, purpose, owner,
//                                          owner_name, depth, mine, line?, request?}. min 은 진단용(0.5~0.95) — 기본 0.75, 화면은 기본만 쓴다.
//   GET /api/team-activity/me/as?as=team|other|lead|admin → { as, label, choices, card, views: [{viewer_name, title, depth, basis, count, at}] }
import express from 'express'
import * as A from '../lib/context/activity.js'
import { viewerOf } from '../lib/context/items.js'

export function teamActivityRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) console.warn('[team-activity]', req.method, req.path, e.message)
      res.status(e.status || 500).json({ error: e.message })
    }
  }
  r.get('/team-activity', auth, h(async (req) => A.activity(await viewerOf(req.user), String(req.query.scope || 'team'))))
  r.get('/team-activity/org', auth, h(async (req) => A.orgView(await viewerOf(req.user))))
  r.get('/team-activity/overlaps', auth, h(async (req) => {
    const m = Number(req.query.min)
    return A.overlaps(await viewerOf(req.user), Number.isFinite(m) && m > 0 ? { min: Math.min(0.95, Math.max(0.5, m)) } : {})
  }))
  r.get('/team-activity/me/as', auth, h(async (req) => A.meAs(await viewerOf(req.user), String(req.query.as || 'team'))))
  r.get('/team-activity/:user/timeline', auth, h(async (req) => A.timeline(await viewerOf(req.user), req.params.user, String(req.query.conv || ''))))
  return r
}
