// 팀원 맥락 참고 ↔ 회사 정책 HTTP E2E (spec pgpt-pro_context-access-request · pgpt-pro_context-visibility):
//   참고 요청의 결정은 정책 엔진이 먼저(민감 표시·민감할 수 있는 주제 → 주인에게 묻기), 주인 규칙은 그 안에서. 모든 결정·허락·거절·만료·회수가
//   결정 원장(설정 › 정책 › 결정 원장)의 한 줄로 남고, 원장에서 승인 버튼은 뜨지 않는다(주인이 홈 카드에서). 관리자가 정책을 끄면 그대로 따른다.
//   맥락 요약을 만들면 같은 주제 목록으로 민감 표시를 제안하고 주인에게 홈 카드가 간다.
//   실제 BFF(이 워크트리) + 실제 DB + 시드 회사(scripts/seed-team-context.mjs, 테넌트 team-demo). 요약 한 번은 회사 게이트웨이 모델을 부른다(실패해도 제목으로 판단).
//   이 시험이 만든 맥락·요청·허락·원장 줄·알림은 끝나면 지우고, 바꾼 정책 스위치·민감 표시는 되돌린다.
// 실행(server/): node test/context-policy.e2e.mjs   — API_URL(기본 http://127.0.0.1:8798) · TENANT_HOST(기본 team.localhost:5198)
import assert from 'node:assert/strict'
import pg from 'pg'

const API = process.env.API_URL || 'http://127.0.0.1:8798'
const HOST = process.env.TENANT_HOST || 'team.localhost:5198'
const { config } = await import('../config.js')
const db = new pg.Pool({ ...config.db, max: 2 })
const q = (t, p) => db.query(t, p).then((r) => r.rows)
const T = 'team-demo'
let step = 0, passed = 0
const log = (m) => console.log(`${String(++step).padStart(2)}. ${m}`)
const check = (fn, ...a) => { fn(...a); passed++ }
async function login(key) {
  const h = { 'Content-Type': 'application/json', 'X-Forwarded-Host': HOST }
  const email = `pro-tc-${key}@uengine.org`
  await fetch(`${API}/api/auth/email/start`, { method: 'POST', headers: h, body: JSON.stringify({ email }) })
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: h, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  if (!r.ok) throw new Error(`login ${key} ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return { tok: j.session.access_token, id: j.user.id }
}
async function call(who, method, p, body, { raw = false } = {}) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.tok}`, 'X-Forwarded-Host': HOST }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  if (raw) return { status: r.status, text: t, json: (() => { try { return JSON.parse(t) } catch { return null } })() }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`)
  return JSON.parse(t)
}
const ledger = async (id) => (await q(`select * from pro_policy_decisions where id = $1`, [id]))[0]
const POLICIES = ['context-sensitive-owner', 'context-sensitive-topic', 'context-access-record']

const U = {}
for (const k of ['yoon', 'park', 'lee', 'choi', 'jung']) U[k] = await login(k)
const C = Object.fromEntries((await q(`select title, conversation_id from context_threads where tenant_id = $1`, [T])).map((r) => [r.title, r.conversation_id]))
for (const t of ['가격 정책 조사', '연봉 협상 준비']) assert.ok(C[t], `시드 맥락 「${t}」 — 먼저 seed-team-context.mjs --reset`)
const stamp = Date.now()
const made = { convs: [], requests: [], decisions: [] }
const sharesBefore = await q(`select * from pro_context_shares where tenant_id = $1 and conversation_id = any($2::text[])`, [T, [C['가격 정책 조사'], C['연봉 협상 준비']]])
const switchesBefore = await q(`select id, enabled from pro_policies where tenant_id = $1 and id = any($2::text[])`, [T, POLICIES])
// 박하늘의 새 맥락(이 시험이 만들고 지운다): 요약 공개 · 팀
async function newContext(title, purpose = '') {
  const conv = `tc-policy-${stamp}-${made.convs.length}`
  await q(`insert into context_threads (tenant_id, user_id, conversation_id, title, summary, gist, kind, turns, created_at, updated_at) values ($1,$2,$3,$4,'','', 'chat', 0, now(), now())`, [T, U.park.id, conv, title])
  await q(`insert into pro_context_shares (tenant_id, user_id, conversation_id, visibility, reach, sensitive, purpose) values ($1,$2,$3,'summary','team','none',$4)`, [T, U.park.id, conv, purpose])
  made.convs.push(conv)
  return conv
}
async function ask(who, conv, depth = 'content') {
  const r = await call(who, 'POST', '/api/context/access-requests', { conversationId: conv, depth, doing: '정책 E2E' })
  if (r.request_id) made.requests.push(r.request_id)
  if (r.policy?.decision_id) made.decisions.push(r.policy.decision_id)
  return r
}

try {
  // ── 정책 카탈로그 ────────────────────────────────────────────────────
  for (const id of POLICIES) await call(U.yoon, 'PUT', `/api/policies/${id}`, { enabled: true })
  const pol = await call(U.yoon, 'GET', '/api/policies')
  const ctx = pol.policies.filter((p) => p.spec.scope?.action?.includes('context.access'))
  log(`설정 › 정책 · 팀원 맥락 참고: ${ctx.map((p) => `${p.spec.title[0]}(${p.spec.decide}${p.enabled ? '' : ', 꺼짐'})`).join(' · ')}`)
  check(assert.deepEqual, ctx.map((p) => p.id).sort(), [...POLICIES].sort())
  const topicSpec = ctx.find((p) => p.id === 'context-sensitive-topic').spec
  check(assert.ok, topicSpec.topics.length >= 10 && topicSpec.topics.some((t) => t.name === '급여'), '주제 목록이 정책에 있다')
  check(assert.equal, ctx.find((p) => p.id === 'context-sensitive-owner').spec.approver.owner, true)

  // ── 1. 평범한 맥락 · 같은 팀 → 자동 허락, 원장에 「기록」 ─────────────────
  await q(`update pro_context_shares set sensitive = 'none', sensitive_dismissed_at = null where tenant_id = $1 and conversation_id = $2`, [T, C['가격 정책 조사']])
  await q(`update pro_grants set revoked_at = now() where tenant_id = $1 and grantee = $2 and conversation_id = $3 and revoked_at is null`, [T, U.lee.id, C['가격 정책 조사']])
  const a1 = await ask(U.lee, C['가격 정책 조사'])
  const d1 = await ledger(a1.policy.decision_id)
  log(`이도윤 → 박하늘 「가격 정책 조사」 원문: ${a1.status}(${a1.via}) · 원장 ${d1.decision}/${d1.status} · ${d1.subject}`)
  check(assert.deepEqual, [a1.status, a1.via, a1.policy.by], ['granted', 'auto', 'rule'])
  check(assert.deepEqual, [d1.action_kind, d1.decision, d1.status, d1.ref], ['context.access', 'allow_audit', 'executed', `context-request:${a1.request_id}`])
  check(assert.deepEqual, d1.matched.map((m) => m.id), ['context-access-record'])
  check(assert.deepEqual, [d1.facts.relation, d1.facts.depth, d1.facts.owner_rule, d1.facts.sensitive, d1.facts.topic], ['team', 'content', 'allow', false, null])
  check(assert.match, d1.subject, /박하늘의 「가격 정책 조사」 원문 참고/)
  check(assert.equal, (await q(`select policy_decision from pro_access_requests where id = $1`, [a1.request_id]))[0].policy_decision, d1.id)

  // 회수 → 같은 원장 줄이 「회수함」
  await call(U.park, 'DELETE', `/api/context/grants/${a1.grant.id}`)
  const d1b = await ledger(d1.id)
  log(`박하늘이 회수 → 원장 ${d1b.status} (${d1b.result?.revoked_at ? '회수 시각 남음' : '—'})`)
  check(assert.equal, d1b.status, 'undone')
  check(assert.ok, d1b.result.revoked_at)

  // ── 2. 민감할 수 있는 주제(성과급 → 급여) · 표시 전 → 주인에게 묻기 ────────
  const conv2 = await newContext('3분기 성과급 기준 정리', '팀 성과급 배분 원칙 초안')
  const a2 = await ask(U.lee, conv2)
  const d2 = await ledger(a2.policy.decision_id)
  log(`이도윤 → 박하늘 「3분기 성과급 기준 정리」 원문: ${a2.status}(${a2.via}) · 정책 「${a2.policy.matched[0]?.title}」 · 원장 ${d2.decision}/${d2.status} · ${d2.subject}`)
  check(assert.deepEqual, [a2.status, a2.via, a2.policy.by, a2.policy.decision], ['pending', 'sensitive', 'policy', 'require_approval'])
  check(assert.deepEqual, a2.policy.matched.map((m) => m.id), ['context-sensitive-topic'])
  check(assert.ok, !JSON.stringify(a2).includes('"topic"'), '요청자에게는 주제 이름을 주지 않는다')
  check(assert.deepEqual, [d2.status, d2.approver_role, d2.facts.topic], ['pending', '맥락 주인', '급여'])
  check(assert.ok, !d2.subject.includes('성과급') && /제목 가림/.test(d2.subject), `원장 한 줄은 제목을 가린다: ${d2.subject}`)
  const [n2] = await q(`select description from notifications where tenant_id = $1 and user_id = $2 and type = 'context_access' and url = $3`, [T, U.park.id, `/pro/context-access/${a2.request_id}`])
  check(assert.match, n2.description, /회사 정책 「민감할 수 있는 주제는 자동 허용하지 않음」 · 급여/)
  const pv2 = await call(U.park, 'GET', `/api/context/access-requests/${a2.request_id}/preview`)
  log(`박하늘 홈 카드 미리보기: 정책 ${pv2.policy.decision} · 주제 ${pv2.policy.topic}`)
  check(assert.deepEqual, [pv2.policy.decision, pv2.policy.topic, pv2.policy.matched[0].id], ['require_approval', '급여', 'context-sensitive-topic'])

  // 원장에서는 승인 버튼이 없고, 승인 API 로도 허락되지 않는다(주인이 홈 카드에서)
  const led = await call(U.yoon, 'GET', '/api/decisions?status=pending')
  const row2 = led.decisions.find((d) => d.id === d2.id)
  log(`관리자 결정 원장(승인 대기): 이 줄 mayDecide=${row2?.mayDecide} · ${row2?.subject}`)
  check(assert.equal, row2.mayDecide, false)
  const ap = await call(U.yoon, 'POST', `/api/decisions/${d2.id}/approve`, {}, { raw: true })
  check(assert.equal, ap.status, 404)
  check(assert.equal, (await ledger(d2.id)).status, 'pending')

  // 주인이 허락 → 원장 「주인이 허락」
  await call(U.park, 'POST', `/api/context/access-requests/${a2.request_id}/decide`, { decision: 'allow', depth: 'summary', duration: 'task' })
  const d2b = await ledger(d2.id)
  log(`박하늘이 요약까지 허락 → 원장 ${d2b.status} · ${d2b.result.depth}/${d2b.result.duration} · 승인자 박하늘=${d2b.approved_by === U.park.id}`)
  check(assert.deepEqual, [d2b.status, d2b.approved_by, d2b.result.outcome, d2b.result.depth], ['approved', U.park.id, 'granted', 'summary'])

  // ── 3. 민감 표시(연봉 협상 준비, 최유나) → 같은 팀 정하은의 요청도 묻기 → 거절이 원장에 ──
  await call(U.choi, 'POST', `/api/context/items/${encodeURIComponent(C['연봉 협상 준비'])}/sensitive`, { action: 'confirm' })
  await q(`update pro_grants set revoked_at = now() where tenant_id = $1 and grantee = $2 and conversation_id = $3 and revoked_at is null`, [T, U.jung.id, C['연봉 협상 준비']])
  const a3 = await ask(U.jung, C['연봉 협상 준비'], 'content')
  const d3 = await ledger(a3.policy.decision_id)
  log(`정하은 → 최유나 「연봉 협상 준비」(민감 표시) 원문: ${a3.status} · 정책 ${a3.policy.matched.map((m) => m.id).join(',')}`)
  check(assert.deepEqual, [a3.status, d3.decision, d3.facts.sensitive, d3.facts.topic], ['pending', 'require_approval', true, null])
  check(assert.deepEqual, a3.policy.matched.map((m) => m.id), ['context-sensitive-owner'])
  await call(U.choi, 'POST', `/api/context/access-requests/${a3.request_id}/decide`, { decision: 'deny', reason: '면담 전 자료' })
  const d3b = await ledger(d3.id)
  log(`최유나가 거절 → 원장 ${d3b.status} · 사유 「${d3b.result.reason}」`)
  check(assert.deepEqual, [d3b.status, d3b.approved_by, d3b.result.via, d3b.result.reason], ['rejected', U.choi.id, 'owner', '면담 전 자료'])

  // ── 4. 주인이 민감 제안을 무시한 맥락 → 주제를 보지 않고 주인 규칙대로 ─────────
  const conv4 = await newContext('신입 연봉 테이블 비교')
  await call(U.park, 'POST', `/api/context/items/${encodeURIComponent(conv4)}/sensitive`, { action: 'dismiss' })
  const a4 = await ask(U.lee, conv4)
  const d4 = await ledger(a4.policy.decision_id)
  log(`박하늘이 「신입 연봉 테이블 비교」 제안을 무시 → 이도윤 요청 ${a4.status}(${a4.via}) · 원장 ${d4.decision}/${d4.status} · 주제 ${d4.facts.topic}`)
  check(assert.deepEqual, [a4.status, a4.via, d4.decision, d4.status, d4.facts.topic], ['granted', 'auto', 'allow_audit', 'executed', null])

  // ── 5. 관리자가 주제 정책을 끄면: 주제로 묻지 않고, 설정 › 공유와 허락의 고정 줄도 바뀐다 ──
  await call(U.yoon, 'PUT', '/api/policies/context-sensitive-topic', { enabled: false })
  const conv5 = await newContext('건강검진 일정 조율')
  const a5 = await ask(U.lee, conv5)
  const rules5 = await call(U.park, 'GET', '/api/context/sharing-rules')
  log(`주제 정책 끔 → 「건강검진 일정 조율」 요청 ${a5.status}(${a5.via}) · 고정 줄 topic=${rules5.fixed.policy.topic} sensitive=${rules5.fixed.policy.sensitive}`)
  check(assert.deepEqual, [a5.status, a5.via], ['granted', 'auto'])
  check(assert.deepEqual, [rules5.fixed.policy.topic, rules5.fixed.policy.sensitive, rules5.fixed.decision], [false, true, 'ask'])
  await call(U.yoon, 'PUT', '/api/policies/context-sensitive-topic', { enabled: true })
  const rules5b = await call(U.park, 'GET', '/api/context/sharing-rules')
  check(assert.equal, rules5b.fixed.policy.topic, true)

  // ── 6. 응답 없이 만료 → 원장 「만료」 ────────────────────────────────
  const conv6 = await newContext('징계 위원회 준비')
  const a6 = await ask(U.lee, conv6)
  check(assert.equal, a6.status, 'pending')
  await q(`update pro_access_requests set expires_at = now() - interval '1 second' where id = $1`, [a6.request_id])
  await call(U.lee, 'GET', '/api/context/access-requests?box=outgoing')
  const d6 = await ledger(a6.policy.decision_id)
  log(`「징계 위원회 준비」 요청이 3일 응답 없음 → 원장 ${d6.status}`)
  check(assert.equal, d6.status, 'expired')

  // ── 7. 맥락 요약을 만들 때 민감 표시 제안 + 주인 홈 카드 ─────────────────────
  const conv7 = await newContext('팀원 병가 일정 정리')
  const { tenantStore } = await import('../lib/tenantStore.js')
  const { buildDigest } = await import('../lib/context/digest.js')
  const t0 = Date.now()
  const dg = await tenantStore.run({ tenant: T }, () => buildDigest(U.park.id, conv7))
  const [sh7] = await q(`select sensitive from pro_context_shares where tenant_id = $1 and conversation_id = $2`, [T, conv7])
  const [n7] = await q(`select title, description, url from notifications where tenant_id = $1 and user_id = $2 and type = 'context_sensitive' and title like $3`, [T, U.park.id, '%팀원 병가 일정 정리%'])
  log(`「팀원 병가 일정 정리」 요약 만듦(${((Date.now() - t0) / 1000).toFixed(1)}초) → 민감 ${sh7.sensitive} · 주제 ${dg.proposed} · 홈 카드 「${n7?.title}」`)
  check(assert.deepEqual, [sh7.sensitive, dg.proposed], ['proposed', '병가'])
  check(assert.ok, n7 && n7.url === '/settings/sharing' && /「병가」에 관한 내용/.test(n7.description), '주인에게 민감 표시 제안 카드')
  // 같은 맥락 요약을 다시 만들어도 카드는 한 장(이미 제안 중)
  await tenantStore.run({ tenant: T }, () => buildDigest(U.park.id, conv7))
  const [{ n: cards }] = await q(`select count(*)::int n from notifications where tenant_id = $1 and user_id = $2 and type = 'context_sensitive' and title like $3`, [T, U.park.id, '%팀원 병가 일정 정리%'])
  check(assert.equal, cards, 1)
  const mine7 = await call(U.park, 'GET', '/api/context/mine')
  check(assert.equal, mine7.proposed.find((p) => p.id === conv7)?.hit, '병가')

  console.log(`\n통과 ${passed}개 확인 · ${step}단계`)
} finally {
  // 되돌리기: 만든 맥락과 그 요청·허락·원장 줄·알림, 바꾼 민감 표시·정책 스위치
  const reqs = (await q(`select id, policy_decision from pro_access_requests where tenant_id = $1 and (conversation_id = any($2::text[]) or id = any($3::uuid[]))`, [T, made.convs, made.requests]))
  const decs = [...new Set([...made.decisions, ...reqs.map((r) => r.policy_decision).filter(Boolean)])]
  if (decs.length) await q(`delete from pro_policy_decisions where id = any($1::uuid[])`, [decs])
  await q(`delete from notifications where tenant_id = $1 and type in ('context_access', 'context_sensitive', 'context_access_result') and time_stamp > to_timestamp($2 / 1000.0)`, [T, stamp])
  await q(`delete from pro_grants where tenant_id = $1 and request_id = any($2::uuid[])`, [T, reqs.map((r) => r.id)])
  await q(`delete from pro_access_requests where id = any($1::uuid[])`, [reqs.map((r) => r.id)])
  for (const t of ['pro_context_shares', 'pro_context_digests']) await q(`delete from ${t} where tenant_id = $1 and conversation_id = any($2::text[])`, [T, made.convs])
  await q(`delete from context_threads where tenant_id = $1 and conversation_id = any($2::text[])`, [T, made.convs])
  for (const s of sharesBefore) await q(`update pro_context_shares set sensitive = $3, sensitive_dismissed_at = $4, visibility = $5 where tenant_id = $1 and conversation_id = $2`, [T, s.conversation_id, s.sensitive, s.sensitive_dismissed_at, s.visibility])
  for (const s of switchesBefore) await q(`update pro_policies set enabled = $3 where tenant_id = $1 and id = $2`, [T, s.id, s.enabled])
  await db.end()
}
