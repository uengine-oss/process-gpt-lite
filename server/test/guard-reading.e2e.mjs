// 가드레일이 글을 읽는 순서 HTTP E2E (spec pgpt-pro_guardrail-reading): 실제 BFF + 실제 DB + 실제 모델.
//   돌려 말한 민감한 글 → 모델이 읽고 주인에게 묻기 / 낱말만 같은 일반 글 → 자동 허용 / 형식 일치 → 모델 없이 묻기 / 글이 그대로면 다시 안 부름 /
//   민감 제안 / 정책을 끄면 읽지 않음 / 모델이 답하지 못하면 낱말로 대신하고 그렇게 적으며, 모델이 돌아오면 다시 읽음.
//   시드 회사(scripts/seed-team-context.mjs, 테넌트 team-demo). 끝나면 만든 것을 지우고 정책 스위치를 되돌린다.
// 실행(server/): node test/guard-reading.e2e.mjs — API_URL(기본 http://127.0.0.1:8798) · TENANT_HOST(기본 team.localhost:5198)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import pg from 'pg'

const API = process.env.API_URL || 'http://127.0.0.1:8798'
const HOST = process.env.TENANT_HOST || 'team.localhost:5198'
const DOWN_PORT = 8796
const { config } = await import('../config.js')
const { compileTopics, topicHit } = await import('../lib/context/sensitive.js')
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
async function call(who, method, p, body, api = API) {
  const r = await fetch(api + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.tok}`, 'X-Forwarded-Host': HOST }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`)
  return JSON.parse(t)
}
const ledger = async (id) => (await q(`select * from pro_policy_decisions where id = $1`, [id]))[0]
const readingRow = async (conv) => (await q(`select * from pro_context_readings where tenant_id = $1 and conversation_id = $2`, [T, conv]))[0]

const U = {}
for (const k of ['yoon', 'park', 'lee', 'choi', 'jung']) U[k] = await login(k)
const stamp = Date.now()
const made = { convs: [], requests: [], decisions: [] }
const [topicSwitch] = await q(`select enabled from pro_policies where tenant_id = $1 and id = 'context-sensitive-topic'`, [T])
// 박하늘의 새 맥락: 요약 공개 · 팀(같은 팀 이도윤의 원문 요청은 주인 규칙으로 자동 허용)
async function newContext(title, purpose = '') {
  const conv = `guard-e2e-${stamp}-${made.convs.length}`
  await q(`insert into context_threads (tenant_id, user_id, conversation_id, title, summary, gist, kind, turns, created_at, updated_at) values ($1,$2,$3,$4,'','', 'chat', 0, now(), now())`, [T, U.park.id, conv, title])
  await q(`insert into pro_context_shares (tenant_id, user_id, conversation_id, visibility, reach, sensitive, purpose) values ($1,$2,$3,'summary','team','none',$4)`, [T, U.park.id, conv, purpose])
  made.convs.push(conv)
  return conv
}
async function ask(who, conv, api = API) {
  const r = await call(who, 'POST', '/api/context/access-requests', { conversationId: conv, depth: 'content', doing: '읽기 E2E' }, api)
  if (r.request_id) made.requests.push(r.request_id)
  if (r.policy?.decision_id) made.decisions.push(r.policy.decision_id)
  return r
}
const words = compileTopics()
let down = null

try {
  // ── 1. 돌려 말한 민감한 글: 낱말 목록에 없어도 모델이 읽고 주인에게 묻는다 ─────────
  const said = '최 대리 권고사직 면담 메모'
  check(assert.equal, topicHit(words, said), null, '낱말 목록에는 걸리지 않는 글이어야 한다')
  const conv1 = await newContext(said)
  const a1 = await ask(U.lee, conv1)
  const d1 = await ledger(a1.policy.decision_id)
  log(`「${said}」 → ${a1.status}(${a1.via}) · 주제 ${d1.facts.topic} · ${d1.facts.topic_source} ${d1.facts.topic_p} · ${d1.facts.topic_model}`)
  check(assert.deepEqual, [a1.status, a1.via, a1.policy.decision], ['pending', 'sensitive', 'require_approval'])
  check(assert.deepEqual, a1.policy.matched.map((m) => m.id), ['context-sensitive-topic'])
  check(assert.ok, d1.facts.topic && d1.facts.topic_source === 'logprob' && d1.facts.topic_p >= 0.5 && d1.facts.topic_model, '원장에 주제·방법·확률·모델이 남는다')
  check(assert.ok, !JSON.stringify(a1).includes('"topic"') && !JSON.stringify(a1).includes('topic_p'), '요청자에게는 주제도 확률도 주지 않는다')
  check(assert.match, d1.subject, /제목 가림/)
  const pv1 = await call(U.park, 'GET', `/api/context/access-requests/${a1.request_id}/preview`)
  log(`주인 카드 미리보기: 주제 ${pv1.policy.topic} · ${pv1.policy.source} · ${pv1.policy.p}`)
  check(assert.deepEqual, [pv1.policy.source, pv1.policy.topic], ['logprob', d1.facts.topic])

  // ── 2. 낱말만 같은 일반 글: 낱말 규칙이면 걸릴 글을 모델이 읽어 자동 허용 ───────────
  const benign = '쿠버네티스 클러스터 건강 점검 대시보드'
  check(assert.equal, topicHit(words, benign), '건강', '낱말 목록에는 걸리는 글이어야 한다')
  const conv2 = await newContext(benign, '노드별 CPU와 메모리 상태를 한 화면에서 본다')
  const a2 = await ask(U.lee, conv2)
  const d2 = await ledger(a2.policy.decision_id)
  log(`「${benign}」 → ${a2.status}(${a2.via}) · 주제 ${d2.facts.topic} · ${d2.facts.topic_source} ${d2.facts.topic_p}`)
  check(assert.deepEqual, [a2.status, a2.via, d2.decision, d2.status], ['granted', 'auto', 'allow_audit', 'executed'])
  check(assert.ok, d2.facts.topic === null && d2.facts.topic_source === 'logprob' && d2.facts.topic_p < 0.5, '주제 없음 · 낮은 확률도 원장에 남는다')
  check(assert.match, d2.subject, /쿠버네티스/)

  // ── 3. 형식 일치: 모델을 부르지 않고 사람에게 ──────────────────────────────
  const conv3 = await newContext('거래처 담당자 정리', '담당자 휴대폰 010-2345-6789')
  const a3 = await ask(U.lee, conv3)
  const d3 = await ledger(a3.policy.decision_id)
  const r3 = await readingRow(conv3)
  log(`형식 일치 → ${a3.status} · 주제 ${d3.facts.topic} · ${d3.facts.topic_source} · 모델 ${d3.facts.topic_model}`)
  check(assert.deepEqual, [a3.status, d3.facts.topic, d3.facts.topic_source, d3.facts.topic_p, d3.facts.topic_model, r3.source], ['pending', '전화번호', 'format', null, null, 'format'])
  check(assert.ok, !JSON.stringify(d3.facts).includes('010-2345-6789') && !d3.subject.includes('010-2345-6789'), '값 자체는 원장에 남지 않는다')

  // ── 4. 글이 그대로면 모델을 다시 부르지 않고, 글이 바뀌면 다시 읽는다 ────────────
  const before = await readingRow(conv2)
  const a4 = await ask(U.choi, conv2)
  const after = await readingRow(conv2)
  log(`같은 글 재요청(${a4.status}): 읽은 때 ${before.read_at.toISOString() === after.read_at.toISOString() ? '그대로' : '바뀜'}`)
  check(assert.equal, before.read_at.toISOString(), after.read_at.toISOString())
  check(assert.equal, (await ledger(a4.policy.decision_id)).facts.topic_p, (await ledger(a2.policy.decision_id)).facts.topic_p)
  await q(`update pro_context_shares set purpose = $3 where tenant_id = $1 and conversation_id = $2`, [T, conv2, '노드 상태와 함께 담당자 교체 이력까지 본다'])
  const a4b = await ask(U.jung, conv2)
  const changed = await readingRow(conv2)
  log(`글을 고친 뒤 재요청(${a4b.status}): 읽은 때 ${before.read_at.toISOString() === changed.read_at.toISOString() ? '그대로' : '바뀜'}`)
  check(assert.notEqual, before.text_hash, changed.text_hash)

  // ── 5. 민감 제안: 돌려 말한 글은 제안하고, 낱말만 같은 글은 제안하지 않는다 ──────
  const mine = await call(U.park, 'GET', '/api/context/mine')
  const p1 = mine.proposed.find((p) => p.id === conv1)
  log(`박하늘 공유 화면: 「${said}」 제안 ${p1 ? `예(${p1.hit})` : '아니오'} · 「${benign}」 제안 ${mine.proposed.some((p) => p.id === conv2) ? '예' : '아니오'}`)
  check(assert.ok, p1 && p1.hit, '돌려 말한 글을 제안한다')
  check(assert.equal, mine.proposed.some((p) => p.id === conv2), false)

  // ── 6. 회사가 주제 정책을 끄면 읽지도 묻지도 않는다 ─────────────────────────
  await call(U.yoon, 'PUT', '/api/policies/context-sensitive-topic', { enabled: false })
  const conv6 = await newContext('이 과장 공황 증세로 회의 줄이기')
  const a6 = await ask(U.lee, conv6)
  const d6 = await ledger(a6.policy.decision_id)
  log(`주제 정책 끔 → ${a6.status}(${a6.via}) · 방법 ${d6.facts.topic_source} · 읽은 값 ${(await readingRow(conv6)) ? '있음' : '없음'}`)
  check(assert.deepEqual, [a6.status, d6.facts.topic, d6.facts.topic_source, !!(await readingRow(conv6))], ['granted', null, null, false])
  await call(U.yoon, 'PUT', '/api/policies/context-sensitive-topic', { enabled: true })

  // ── 7. 모델이 답하지 못하면: 낱말이 대신하고 그렇게 적는다(게이트웨이가 닿지 않는 서버를 하나 더 띄운다) ──
  down = spawn(process.execPath, ['index.js'], { env: { ...process.env, PRO_PORT: String(DOWN_PORT), PRO_BACKGROUND: '0', PRO_LLM_BASE_URL: 'http://127.0.0.1:9', PRO_TENANT_HOSTS: `${process.env.PRO_TENANT_HOSTS || ''},team.localhost=team-demo`.replace(/^,/, ''), PRO_PUBLIC_URL: `http://${HOST}` }, stdio: 'ignore' })
  const DOWN = `http://127.0.0.1:${DOWN_PORT}`
  for (let i = 0; i < 60; i++) { if (await fetch(`${DOWN}/api/health`).then((r) => r.status < 500, () => false)) break; await new Promise((r) => setTimeout(r, 500)) }
  const conv7 = await newContext('3분기 성과급 기준 정리')
  const a7 = await ask(U.lee, conv7, DOWN)
  const d7 = await ledger(a7.policy.decision_id)
  log(`모델 없음, 낱말 있음 → ${a7.status} · 주제 ${d7.facts.topic} · ${d7.facts.topic_source} · 저장 ${(await readingRow(conv7)) ? '함' : '안 함'}`)
  check(assert.deepEqual, [a7.status, d7.facts.topic, d7.facts.topic_source, d7.facts.topic_p, !!(await readingRow(conv7))], ['pending', '급여', 'regex', null, false])
  const pol7 = await call(U.yoon, 'GET', '/api/policies', undefined, DOWN)
  log(`모델 없음: 정책 화면 상태 ${pol7.reading.state}`)
  check(assert.equal, pol7.reading.state, 'down')
  const conv7b = await newContext('한 대리 이혼 소송으로 재택 요청')
  const a7b = await ask(U.lee, conv7b, DOWN)
  const d7b = await ledger(a7b.policy.decision_id)
  log(`모델 없음, 돌려 말한 글 → ${a7b.status} · ${d7b.facts.topic_source} (낱말 규칙의 한계: 원장에 regex 로 남아 알아볼 수 있다)`)
  check(assert.deepEqual, [a7b.status, d7b.facts.topic_source], ['granted', 'regex'])
  down.kill(); down = null

  // ── 8. 모델이 돌아오면 다시 읽는다(낱말로 대신한 값을 남기지 않았으므로) ─────────
  const a8 = await ask(U.jung, conv7b)
  const d8 = await ledger(a8.policy.decision_id)
  log(`모델 복귀, 같은 글 → ${a8.status} · 주제 ${d8.facts.topic} · ${d8.facts.topic_source} ${d8.facts.topic_p}`)
  check(assert.deepEqual, [a8.status, d8.facts.topic_source], ['pending', 'logprob'])

  console.log(`\n통과 ${passed}개 확인 · ${step}단계`)
} finally {
  down?.kill()
  const reqs = (await q(`select id, policy_decision from pro_access_requests where tenant_id = $1 and (conversation_id = any($2::text[]) or id = any($3::uuid[]))`, [T, made.convs, made.requests]))
  const decs = [...new Set([...made.decisions, ...reqs.map((r) => r.policy_decision).filter(Boolean)])]
  if (decs.length) await q(`delete from pro_policy_decisions where id = any($1::uuid[])`, [decs])
  await q(`delete from notifications where tenant_id = $1 and type in ('context_access', 'context_sensitive', 'context_access_result', 'context_access_digest') and time_stamp > to_timestamp($2 / 1000.0)`, [T, stamp])
  await q(`delete from pro_grants where tenant_id = $1 and (request_id = any($2::uuid[]) or conversation_id = any($3::text[]))`, [T, reqs.map((r) => r.id), made.convs])
  await q(`delete from pro_access_requests where id = any($1::uuid[])`, [reqs.map((r) => r.id)])
  for (const t of ['pro_context_shares', 'pro_context_digests', 'pro_context_readings']) await q(`delete from ${t} where tenant_id = $1 and conversation_id = any($2::text[])`, [T, made.convs])
  await q(`delete from context_threads where tenant_id = $1 and conversation_id = any($2::text[])`, [T, made.convs])
  await q(`update pro_policies set enabled = $2 where tenant_id = $1 and id = 'context-sensitive-topic'`, [T, topicSwitch.enabled])
  await db.end()
}
