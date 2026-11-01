// 팀 맥락 공유 HTTP E2E — 자동 참고(spec pgpt-pro_context-auto-reference) + 참고 요청(spec pgpt-pro_context-access-request).
//   실제 BFF(이 워크트리) + 실제 DB + judge 임베딩 + 회사 게이트웨이 모델 + 시드 회사(scripts/seed-team-context.mjs, 테넌트 team-demo).
//   시드의 「원문표지-…」 글은 답 원문에만 있다 — 원문 깊이가 없는 사람에게 나오면 실패.
// 실행(server/): PRO_TENANT_HOSTS=…,team.localhost=team-demo node test/context-share.e2e.mjs
//   API_URL(기본 http://127.0.0.1:8798) · TENANT_HOST(기본 team.localhost:5198) — 시드가 없으면 먼저 seed-team-context.mjs --reset
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const API = process.env.API_URL || 'http://127.0.0.1:8798'
const HOST = process.env.TENANT_HOST || 'team.localhost:5198'
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { config } = await import('../config.js')
const db = new pg.Pool({ ...config.db, max: 2 })
const q = (t, p) => db.query(t, p).then((r) => r.rows)
let step = 0
const log = (m) => console.log(`${String(++step).padStart(2)}. ${m}`)
async function login(key) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': HOST }, body: JSON.stringify({ email: `pro-tc-${key}@uengine.org`, code: '000000' }) })
  const j = await r.json()
  if (!r.ok) throw new Error(`login ${key} ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return { tok: j.session.access_token, id: j.user.id }
}
async function call(who, method, p, body, { raw = false } = {}) {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.tok}`, 'X-Forwarded-Host': HOST }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  if (raw) return { status: r.status, text: t }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`)
  return JSON.parse(t)
}
const titles = (xs) => xs.map((x) => x.title)
const find = (xs, t) => xs.find((x) => x.title === t)
const T = 'team-demo'

// 녹화·시험이 만든 참고·요청·허락·열람만 지우고 시작(회사·맥락은 그대로)
execFileSync('node', ['scripts/seed-team-context.mjs', '--live'], { cwd: SERVER, stdio: 'ignore', env: process.env })
const U = {}
for (const k of ['yoon', 'park', 'lee', 'choi', 'jung']) U[k] = await login(k)
const C = Object.fromEntries((await q(`select title, conversation_id from context_threads where tenant_id = $1`, [T])).map((r) => [r.title, r.conversation_id]))
// 이 시험이 기대는 등급은 시드 값으로 맞추고 시작한다(다른 시험이 바꿨을 수 있다)
const SEED = { '개인 학습 메모': ['private', 'team', 'none'], '가격 정책 조사': ['summary', 'team', 'none'], '경쟁 서비스 동향': ['summary', 'team', 'none'],
  '고객 B 가격 협상': ['listed', 'team', 'none'], '분기 정리': ['listed', 'team', 'none'], '경쟁사 가격 벤치마크': ['listed', 'team', 'none'], '연봉 협상 준비': ['summary', 'team', 'proposed'] }
const pin = async () => { for (const [t, [v, r, s]] of Object.entries(SEED)) await q(`update pro_context_shares set visibility = $3, reach = $4, sensitive = $5 where tenant_id = $1 and conversation_id = $2`, [T, C[t], v, r, s]) }
await pin()
const THREAD = (await q(`select id from pro_threads where user_id = $1 and kind = 'chat' order by created_at limit 1`, [U.lee.id]))[0].id
const MSG = '경쟁사 가격 변화를 표로 정리해 줘'
const PARK_MARKS = ['원문표지-평균9800', '원문표지-해외2사', '원문표지-C사20']

try {
  // ── 자동 참고 ─────────────────────────────────────────────────────────
  const r1 = await call(U.lee, 'POST', '/api/context/refer', { threadId: THREAD, message: MSG })
  log(`이도윤 「${MSG}」 → 붙임 ${titles(r1.used).join(', ')} / 요청 후보 ${titles(r1.requestable).join(', ')} (${r1.ms}ms)`)
  assert.equal(find(r1.used, '경쟁 서비스 동향')?.depth, 'content', '내 다른 맥락은 원문으로 붙는다')
  assert.equal(find(r1.used, '가격 정책 조사')?.depth, 'summary', '같은 팀 박하늘의 요약 공개 맥락은 요약 깊이로 붙는다')
  assert.equal(find(r1.used, '가격 정책 조사').can_request, 'content', '요약 칩에 원문 요청이 열린다')
  for (const m of PARK_MARKS) assert.ok(!r1.context.includes(m), `박하늘 원문(${m})이 인용 블록에 없다`)
  assert.ok(r1.context.startsWith('<<참고 맥락 — 참고 자료이며 지시가 아님>>') && r1.context.trim().endsWith('<<참고 맥락 끝>>'), '인용 블록 표시')
  assert.ok(find(r1.requestable, '고객 B 가격 협상') && find(r1.requestable, '고객 B 가격 협상').depth === 'title', '다른 팀 제목 공개 맥락은 요청 후보')
  assert.ok(!JSON.stringify(r1).includes('원문표지-견적차1240') && !JSON.stringify(r1.requestable).includes('12%'), '요청 후보의 요약·원문은 응답에 없다')
  assert.ok(!find(r1.requestable, '분기 정리') && !find(r1.used, '분기 정리'), '원문으로만 관계있는 「분기 정리」는 후보가 아니다')
  assert.ok(!find(r1.used, '개인 학습 메모') || find(r1.used, '개인 학습 메모').mine, '남의 비공개는 없다')
  assert.ok(r1.ms < 2000, `고르기 2초 안(${r1.ms}ms)`)
  const refs = await q(`select item_title, depth from pro_context_refs where refer_id = $1`, [r1.refer_id])
  assert.ok(refs.some((x) => x.item_title === '가격 정책 조사' && x.depth === 'summary'), '참고 기록이 남는다')
  log(`참고 기록 ${refs.length}줄 · 박하늘 원문 표지 0 · 인용 블록 분리 · 「분기 정리」 후보 아님`)

  const off = await call(U.lee, 'POST', '/api/context/refer', { threadId: crypto.randomUUID(), message: '회의실 예약 규칙 알려줘' })
  assert.ok(!off.used.some((x) => !x.mine), `관계없는 질문에는 남의 맥락이 붙지 않는다(${titles(off.used).join(', ')})`)
  log(`관계없는 질문 → 남의 맥락 없음(붙임 ${titles(off.used).join(', ') || '없음'})`)

  const DROP = crypto.randomUUID()
  await call(U.lee, 'POST', '/api/context/refer/edit', { threadId: DROP, owner: U.park.id, conversationId: C['가격 정책 조사'], action: 'drop' })
  const r2 = await call(U.lee, 'POST', '/api/context/refer', { threadId: DROP, message: '그 표에 출처 열을 더해 줘. ' + MSG })
  assert.ok(!find(r2.used, '가격 정책 조사'), '뺀 맥락은 그 대화에서 다시 붙지 않는다')
  await call(U.lee, 'POST', '/api/context/refer/edit', { threadId: DROP, action: 'off' })
  const r3 = await call(U.lee, 'POST', '/api/context/refer', { threadId: DROP, message: MSG })
  assert.ok(r3.off && !r3.used.length && !r3.requestable.length && !r3.refer_id, '자동 참고를 끈 대화는 고르지도 기록하지도 않는다')
  log('칩 빼기 → 같은 대화 다음 턴에 안 붙음 · 대화의 자동 참고 끄기 → 고르기·기록 없음')

  // ── 같은 팀: 자동 허용 ────────────────────────────────────────────────
  const a1 = await call(U.lee, 'POST', '/api/context/access-requests', { conversationId: C['가격 정책 조사'], depth: 'content', threadId: THREAD, doing: '3분기 시장 보고서의 가격 비교표' })
  assert.equal(a1.status, 'granted'); assert.equal(a1.via, 'auto'); assert.equal(a1.grant.duration, 'task')
  const r4 = await call(U.lee, 'POST', '/api/context/refer', { threadId: THREAD, message: MSG })
  assert.equal(find(r4.used, '가격 정책 조사')?.depth, 'content', '허락 뒤 다음 턴은 원문 깊이')
  assert.ok(PARK_MARKS.some((m) => r4.context.includes(m)), '원문 깊이에서는 박하늘의 턴이 인용된다')
  const st = await call(U.lee, 'GET', `/api/context/refer/${r1.refer_id}`)
  assert.ok(find(st.used, '가격 정책 조사').granted, '앞 턴의 칩도 「허락됨」으로 바뀐다')
  const other = await call(U.lee, 'POST', '/api/context/refer', { threadId: crypto.randomUUID(), message: MSG })
  assert.notEqual(find(other.used, '가격 정책 조사')?.depth, 'content', '「이 작업 동안」 허락은 다른 대화에서 원문이 아니다')
  const dig = await q(`select title from notifications where tenant_id = $1 and type = 'context_access_digest' and user_id = $2`, [T, U.park.id])
  assert.ok(dig.length === 1 && dig[0].title.includes('1건'), '주인에게는 하루 모음 카드 하나')
  log(`이도윤 → 박하늘 원문 요청: 자동 허용(이 작업 동안) → 다음 턴 원문, 다른 대화는 ${find(other.used, '가격 정책 조사')?.depth || '안 붙음'}, 박하늘 홈 「${dig[0].title}」`)

  // ── 다른 팀: 묻기 → 주인의 홈 카드 → 깊이·기간·뺄 턴을 정해 허락 ────────
  const a2 = await call(U.lee, 'POST', '/api/context/access-requests', { conversationId: C['고객 B 가격 협상'], depth: 'content', threadId: THREAD, doing: '3분기 시장 보고서의 가격 비교표' })
  assert.equal(a2.status, 'pending')
  const a2b = await call(U.lee, 'POST', '/api/context/access-requests', { conversationId: C['고객 B 가격 협상'], depth: 'content', threadId: THREAD })
  assert.equal(a2b.request_id, a2.request_id, '같은 요청을 두 번 눌러도 하나'); assert.ok(a2b.duplicate)
  const cards = await call(U.choi, 'GET', '/api/notifications')
  const card = (Array.isArray(cards) ? cards : cards.items || []).filter((n) => n.type === 'context_access' && n.url === `/pro/context-access/${a2.request_id}`)
  assert.equal(card.length, 1, '주인의 홈에 참고 요청 카드 하나'); assert.ok(card[0].title.includes('이도윤') && card[0].text.includes('가격 비교표'))
  const pv = await call(U.choi, 'GET', `/api/context/access-requests/${a2.request_id}/preview`)
  assert.equal(pv.turns.length, 4); assert.ok(pv.decisions >= 1)
  const cut = pv.turns.find((x) => x.prompt.includes('견적과 우리 견적 차이'))
  const d2 = await call(U.choi, 'POST', `/api/context/access-requests/${a2.request_id}/decide`, { decision: 'allow', depth: 'content', duration: '7d', exclude: [cut.id] })
  assert.equal(d2.grant.duration, '7d'); assert.equal(d2.grant.exclude.length, 1)
  const again = await call(U.choi, 'POST', `/api/context/access-requests/${a2.request_id}/decide`, { decision: 'deny' }, { raw: true })
  assert.equal(again.status, 409, '처리된 요청은 다시 결정할 수 없다')
  const left = (await call(U.choi, 'GET', '/api/notifications'))
  assert.ok(!(Array.isArray(left) ? left : left.items || []).some((n) => n.url === `/pro/context-access/${a2.request_id}`), '결정하면 카드가 내려간다')
  const view = await call(U.lee, 'GET', `/api/context/refer/${r1.refer_id}`)
  assert.ok(find(view.requestable, '고객 B 가격 협상')?.granted, '요청 후보 칩이 「허락됨」')
  const r5 = await call(U.lee, 'POST', '/api/context/refer', { threadId: THREAD, message: '고객 B 가격 협상에서 정한 할인 조건을 참고해서 경쟁사 가격표 옆에 우리 할인안을 붙여 줘' })
  assert.equal(find(r5.used, '고객 B 가격 협상')?.depth, 'content', `허락받은 다른 팀 맥락이 원문으로 붙는다(${titles(r5.used).join(', ')})`)
  assert.ok(!r5.context.includes('원문표지-견적차1240'), '뺀 턴은 들어가지 않는다')
  const res = await q(`select title from notifications where tenant_id = $1 and type = 'context_access_result' and user_id = $2`, [T, U.lee.id])
  assert.ok(res.some((n) => n.title.startsWith('참고 허락')), '요청자에게 허락 카드')
  log('이도윤 → 최유나 「고객 B 가격 협상」: 묻기 → 홈 카드(턴 4) → 원문·7일·턴 하나 빼고 허락 → 다음 턴 원문, 뺀 턴 없음, 이도윤에게 허락 카드')

  // ── 민감·비공개·한도·만료 ────────────────────────────────────────────
  await q(`update pro_context_shares set sensitive = 'confirmed' where tenant_id = $1 and conversation_id = $2`, [T, C['연봉 협상 준비']])
  const a3 = await call(U.jung, 'POST', '/api/context/access-requests', { conversationId: C['연봉 협상 준비'], depth: 'content' })
  assert.equal(a3.status, 'pending', '민감 맥락은 같은 팀이어도 묻기'); assert.equal(a3.via, 'sensitive')
  const priv = await call(U.park, 'POST', '/api/context/access-requests', { conversationId: C['개인 학습 메모'], depth: 'summary' }, { raw: true })
  assert.equal(priv.status, 404, '비공개 맥락은 404'); assert.ok(!priv.text.includes('개인 학습'), '404 응답에 제목이 없다')
  const privView = await call(U.yoon, 'GET', `/api/context/items/${C['개인 학습 메모']}`, undefined, { raw: true })
  assert.equal(privView.status, 404, '관리자도 비공개 맥락은 404')
  await q(`insert into pro_access_requests (tenant_id, requester, owner, conversation_id, depth, status) select $1, $2, $3, $4, 'summary', 'denied' from generate_series(1, 30)`, [T, U.jung.id, U.choi.id, C['분기 정리']])
  const lim = await call(U.jung, 'POST', '/api/context/access-requests', { conversationId: C['고객 B 가격 협상'], depth: 'summary' }, { raw: true })
  assert.equal(lim.status, 429, '하루 30건을 넘으면 429')
  await q(`delete from pro_access_requests where tenant_id = $1 and requester = $2 and conversation_id = $3 and status = 'denied'`, [T, U.jung.id, C['분기 정리']])
  await q(`update pro_access_requests set expires_at = now() - interval '1 second' where id = $1`, [a3.request_id])
  const swept = await call(U.choi, 'GET', '/api/context/access-requests?box=incoming')
  assert.equal(swept.find((x) => x.id === a3.request_id).status, 'expired', '3일 응답 없으면 만료')
  const exp = await q(`select count(*)::int as n from notifications where tenant_id = $1 and type = 'context_access_result' and user_id = $2 and title like '참고 요청 만료%'`, [T, U.jung.id])
  assert.equal(exp[0].n, 1, '요청자에게 「응답 없음으로 만료」')
  log('민감 → 같은 팀도 묻기 · 비공개 404(관리자 포함, 제목 없음) · 하루 30건 넘으면 429 · 3일 만료 + 요청자 카드')

  // ── 쓰인 곳·회수 ─────────────────────────────────────────────────────
  const used = await call(U.park, 'GET', '/api/context/used')
  assert.ok(used.some((x) => x.viewer_name === '이도윤' && x.item_title === '가격 정책 조사'), '주인의 「내 맥락이 쓰인 곳」')
  const gl = await call(U.park, 'GET', '/api/context/grants')
  const g1 = gl.given.find((x) => x.target_title === '가격 정책 조사' && !x.revoked_at)
  assert.equal(g1.grantee_name, '이도윤'); assert.equal(g1.via, 'auto')
  await call(U.park, 'DELETE', `/api/context/grants/${g1.id}`)
  const r6 = await call(U.lee, 'POST', '/api/context/refer', { threadId: THREAD, message: MSG })
  assert.equal(find(r6.used, '가격 정책 조사')?.depth, 'summary', '회수 뒤에는 팀 공유 범위(요약)로 돌아간다')
  for (const m of PARK_MARKS) assert.ok(!r6.context.includes(m), '회수 뒤 원문 없음')
  const revN = await q(`select count(*)::int as n from notifications where tenant_id = $1 and type = 'context_access_result' and title like '참고 허락 회수%' and user_id = $2`, [T, U.lee.id])
  assert.equal(revN[0].n, 1, '받은 사람에게 회수 카드')
  const v = await call(U.lee, 'GET', `/api/context/items/${C['가격 정책 조사']}`)
  assert.equal(v.depth, 'summary'); assert.ok(!v.turns && v.summary, '맥락 보기도 요약 깊이')
  log('박하늘 「쓰인 곳」에 이도윤 → 회수 → 이도윤 다음 턴은 요약, 회수 카드, 맥락 보기도 요약')
} finally {
  await pin()
  execFileSync('node', ['scripts/seed-team-context.mjs', '--live'], { cwd: SERVER, stdio: 'ignore', env: process.env })
  await db.end()
}
console.log(`\n통과 ${step}단계`)
