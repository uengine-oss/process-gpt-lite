// 공개 등급 HTTP E2E (spec pgpt-pro_context-visibility): 내 맥락 목록·등급 바꾸기(주인만, 남이면 404)·미리보기(바꾸지 않음)·
// 민감 제안·승인·무시(전체 공개 422, 장·관리자에게 제목만)·비공개는 존재도 숨김·열람 기록·기본 등급.
//   실제 BFF(이 워크트리) + 실제 DB + 시드 회사(scripts/seed-team-context.mjs, 테넌트 team-demo). 모델은 부르지 않는다.
//   다른 시험과 데이터를 함께 쓰므로 --live 로 지우지 않는다: 기대는 등급만 시드 값으로 맞추고 시작해, 끝나면 바꾼 것을 되돌린다.
// 실행(server/): node test/context-grade.e2e.mjs
//   API_URL(기본 http://127.0.0.1:8798) · TENANT_HOST(기본 team.localhost:5198) — 시드가 없으면 먼저 seed-team-context.mjs --reset
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
const names = (xs) => xs.map((x) => x.name).sort((a, b) => a.localeCompare(b, 'ko'))
const MARK = /원문표지-/

const U = {}
for (const k of ['yoon', 'park', 'lee', 'choi', 'jung']) U[k] = await login(k)
const C = Object.fromEntries((await q(`select title, conversation_id from context_threads where tenant_id = $1`, [T])).map((r) => [r.title, r.conversation_id]))
for (const t of ['경쟁 서비스 동향', '개인 학습 메모', '사내 교육 자료 정리', '연봉 협상 준비', '제안서 표준 목차']) assert.ok(C[t], `시드 맥락 「${t}」 — 먼저 seed-team-context.mjs --reset`)
// 이 시험이 기대는 등급(시드 값). 시작할 때 맞추고, 끝나면 시작 전 값(목적 포함)으로 되돌린다.
const SEED = { '경쟁 서비스 동향': ['summary', 'team', 'none'], '개인 학습 메모': ['private', 'team', 'none'], '사내 교육 자료 정리': ['listed', 'team', 'none'],
  '연봉 협상 준비': ['summary', 'team', 'proposed'], '제안서 표준 목차': ['open', 'department', 'none'] }
const touched = Object.keys(SEED).map((t) => C[t])
const before = await q(`select * from pro_context_shares where tenant_id = $1 and conversation_id = any($2::text[])`, [T, touched])
const rulesBefore = await q(`select * from pro_sharing_rules where tenant_id = $1 and user_id = $2`, [T, U.jung.id])
const viewsBefore = new Set((await q(`select id from pro_context_views where tenant_id = $1`, [T])).map((r) => r.id))
for (const [t, [v, r, s]] of Object.entries(SEED)) await q(`update pro_context_shares set visibility = $3, reach = $4, sensitive = $5, sensitive_dismissed_at = null where tenant_id = $1 and conversation_id = $2`, [T, C[t], v, r, s])

try {
  // ── 내 맥락 ──────────────────────────────────────────────────────────
  const m1 = await call(U.lee, 'GET', '/api/context/mine')
  const comp = m1.items.find((x) => x.title === '경쟁 서비스 동향')
  log(`이도윤 내 맥락 ${m1.items.length}개: ${m1.items.map((x) => `${x.title}(${x.label})`).join(', ')} · 기본 ${m1.defaults.effective}`)
  check(assert.equal, m1.items.length, 3)
  check(assert.deepEqual, [comp.visibility, comp.reach, comp.sensitive, comp.inherited], ['summary', 'team', 'none', false])
  check(assert.equal, comp.label, '요약 공개 · 팀')
  check(assert.ok, comp.purpose.length > 0 && comp.turns > 0, '한 줄 목적·턴 수')
  check(assert.equal, m1.defaults.enabled, true)
  const one = await call(U.lee, 'GET', `/api/context/mine?conv=${C['경쟁 서비스 동향']}`)
  check(assert.deepEqual, one.items.map((x) => x.id), [C['경쟁 서비스 동향']], 'conv 하나만')
  check(assert.equal, (await call(U.choi, 'GET', `/api/context/mine?conv=${C['경쟁 서비스 동향']}`, undefined, { raw: true })).status, 404, '남의 맥락은 내 목록에 없다')

  // ── 미리보기: 바꾸지 않는다 ─────────────────────────────────────────
  const pv = await call(U.lee, 'GET', `/api/context/visibility/preview?conv=${C['경쟁 서비스 동향']}&visibility=summary&reach=company`)
  log(`미리보기 요약 공개 · 회사: 요약 ${names(pv.summary).join('·')} (새로 ${pv.added.summary.join('·')}) / 원문 ${pv.content.length}명 / 제목 ${pv.title.length}명`)
  check(assert.deepEqual, names(pv.summary), ['박하늘', '윤서진', '정하은', '최유나'])
  check(assert.deepEqual, [...pv.added.summary].sort(), ['정하은', '최유나'].sort(), 'spec: 요약 칸에 정하은·최유나가 새로')
  check(assert.equal, pv.content.length, 0, '원문 칸은 허락받은 사람만(없음)')
  check(assert.equal, pv.current, '요약 공개 · 팀'); check(assert.equal, pv.next.label, '요약 공개 · 회사')
  check(assert.equal, (await call(U.lee, 'GET', `/api/context/mine?conv=${C['경쟁 서비스 동향']}`)).items[0].reach, 'team', '미리보기는 아무것도 바꾸지 않는다')
  const pl = await call(U.lee, 'GET', `/api/context/visibility/preview?conv=${C['경쟁 서비스 동향']}&visibility=listed&reach=team`)
  const park = pl.summary.find((p) => p.name === '박하늘'), yoon = pl.summary.find((p) => p.name === '윤서진')
  log(`미리보기 제목 공개: 요약 ${pl.summary.map((p) => `${p.name}(${p.reason})`).join(', ')} · 덜 보게 됨 ${pl.lost.map((p) => p.name).join('·') || '없음'}`)
  check(assert.deepEqual, [park?.via, park?.reason], ['lead', '전략팀장'])
  check(assert.deepEqual, [yoon?.via, yoon?.reason], ['admin', '관리자'])
  const pp = await call(U.lee, 'GET', `/api/context/visibility/preview?conv=${C['경쟁 서비스 동향']}&visibility=private&reach=team`)
  check(assert.equal, pp.hidden, 4); check(assert.equal, pp.title.length + pp.summary.length + pp.content.length, 0)
  check(assert.equal, (await call(U.choi, 'GET', `/api/context/visibility/preview?conv=${C['경쟁 서비스 동향']}&visibility=open&reach=company`, undefined, { raw: true })).status, 404, '남의 맥락 미리보기는 404')

  // ── 등급 바꾸기: 주인만 ─────────────────────────────────────────────
  const nope = await call(U.choi, 'PATCH', `/api/context/items/${C['경쟁 서비스 동향']}/grade`, { visibility: 'open', reach: 'company' }, { raw: true })
  const ghost = await call(U.choi, 'PATCH', '/api/context/items/00000000-0000-4000-8000-000000000000/grade', { visibility: 'open', reach: 'company' }, { raw: true })
  log(`최유나가 이도윤 맥락을 바꾸려 함 → ${nope.status} 「${nope.json?.error}」 (없는 맥락 ${ghost.status} 「${ghost.json?.error}」)`)
  check(assert.equal, nope.status, 404); check(assert.equal, nope.text, ghost.text, '없는 맥락과 같은 응답')
  check(assert.equal, (await call(U.choi, 'POST', `/api/context/items/${C['경쟁 서비스 동향']}/sensitive`, { action: 'mark' }, { raw: true })).status, 404)
  check(assert.equal, (await call(U.lee, 'PATCH', `/api/context/items/${C['경쟁 서비스 동향']}/grade`, { visibility: 'wide-open' }, { raw: true })).status, 400)

  const jungBefore = await call(U.jung, 'GET', `/api/context/items/${C['경쟁 서비스 동향']}`)
  check(assert.equal, jungBefore.depth, 'title', '다른 팀 정하은은 제목만')
  check(assert.ok, !('summary' in jungBefore) && !MARK.test(JSON.stringify(jungBefore)))
  const sg = await call(U.lee, 'PATCH', `/api/context/items/${C['경쟁 서비스 동향']}/grade`, { visibility: 'summary', reach: 'company', purpose: '  경쟁 3사 가격·기능   변화를 매주 추적 ' })
  log(`이도윤 「경쟁 서비스 동향」 → ${sg.item.label}: 「${sg.note}」`)
  check(assert.equal, sg.note, '「경쟁 서비스 동향」을 요약 공개 · 회사로 바꿨습니다')
  check(assert.equal, sg.item.purpose, '경쟁 3사 가격·기능 변화를 매주 추적', '한 줄 목적은 공백을 고른다')
  const jungAfter = await call(U.jung, 'GET', `/api/context/items/${C['경쟁 서비스 동향']}`)
  log(`정하은이 다시 열면 깊이 ${jungAfter.depth} — 근거 ${jungAfter.why.join(', ')}`)
  check(assert.equal, jungAfter.depth, 'summary'); check(assert.ok, jungAfter.summary.length > 0 && !jungAfter.turns && !MARK.test(JSON.stringify(jungAfter)), '요약만, 원문 표지 없음')
  await call(U.jung, 'GET', `/api/context/items/${C['경쟁 서비스 동향']}`)
  const pt = await call(U.lee, 'PATCH', `/api/context/items/${C['경쟁 서비스 동향']}/grade`, { purpose: '경쟁 3사 가격 변화를 매주 추적' })
  check(assert.equal, pt.note, '한 줄 목적을 저장했습니다')

  // ── 비공개: 존재도 숨긴다 ─────────────────────────────────────────
  const priv = await call(U.yoon, 'GET', `/api/context/items/${C['개인 학습 메모']}`, undefined, { raw: true })
  log(`관리자 윤서진이 이도윤 「개인 학습 메모」(비공개)를 id 로 → ${priv.status} 「${priv.json?.error}」`)
  check(assert.equal, priv.status, 404); check(assert.ok, !priv.text.includes('개인 학습 메모'))

  // ── 민감: 제안 → 승인 → 전체 공개 422 · 장·관리자에게 제목만 ─────────
  const m2 = await call(U.choi, 'GET', '/api/context/mine')
  const prop = m2.proposed.find((p) => p.id === C['연봉 협상 준비'])
  log(`최유나 민감 표시 제안: ${m2.proposed.map((p) => `「${p.title}」(${p.hit})`).join(', ')}`)
  check(assert.equal, prop?.hit, '연봉')
  check(assert.equal, (await call(U.yoon, 'GET', `/api/context/items/${C['연봉 협상 준비']}`)).depth, 'summary', '제안은 승인 전까지 적용되지 않는다(관리자 요약)')
  const cf = await call(U.choi, 'POST', `/api/context/items/${C['연봉 협상 준비']}/sensitive`, { action: 'confirm' })
  log(`최유나 승인 → ${cf.sensitive} · 「${cf.note}」`)
  check(assert.equal, cf.sensitive, 'confirmed'); check(assert.equal, cf.narrowed_to, null)
  const open422 = await call(U.choi, 'PATCH', `/api/context/items/${C['연봉 협상 준비']}/grade`, { visibility: 'open', reach: 'team' }, { raw: true })
  log(`민감 항목을 전체 공개로 → ${open422.status} 「${open422.json?.error}」`)
  check(assert.equal, open422.status, 422); check(assert.equal, open422.json?.error, '민감 항목은 전체 공개로 열 수 없습니다')
  check(assert.equal, (await call(U.choi, 'GET', `/api/context/visibility/preview?conv=${C['연봉 협상 준비']}&visibility=open&reach=team`)).problem, '민감 항목은 전체 공개로 열 수 없습니다')
  const yoonS = await call(U.yoon, 'GET', `/api/context/items/${C['연봉 협상 준비']}`)
  const parkS = await call(U.park, 'GET', `/api/context/items/${C['연봉 협상 준비']}`)
  const jungS = await call(U.jung, 'GET', `/api/context/items/${C['연봉 협상 준비']}`)
  log(`민감 뒤 깊이: 윤서진(관리자) ${yoonS.depth} · 박하늘(다른 팀장) ${parkS.depth} · 정하은(같은 팀) ${jungS.depth}`)
  check(assert.equal, yoonS.depth, 'title'); check(assert.ok, !('summary' in yoonS), '관리자에게도 제목만')
  check(assert.equal, parkS.depth, 'title'); check(assert.equal, jungS.depth, 'summary')
  check(assert.ok, !MARK.test(JSON.stringify([yoonS, parkS, jungS])))
  const pS = await call(U.choi, 'GET', `/api/context/visibility/preview?conv=${C['연봉 협상 준비']}&visibility=summary&reach=team`)
  check(assert.ok, pS.title.some((p) => p.name === '윤서진') && !pS.summary.some((p) => p.name === '윤서진'), '미리보기도 관리자 제목')

  // 민감 표시를 붙이면 전체 공개가 요약 공개로 좁혀진다 → 떼면 다시 제안하지 않는다
  const mk = await call(U.choi, 'POST', `/api/context/items/${C['제안서 표준 목차']}/sensitive`, { action: 'mark' })
  log(`「제안서 표준 목차」(전체 공개 · 부서)에 민감 표시 → ${mk.item.label} · 「${mk.note}」`)
  check(assert.equal, mk.narrowed_to, 'summary'); check(assert.deepEqual, [mk.item.visibility, mk.item.reach], ['summary', 'department'])
  check(assert.match, mk.note, /요약 공개 · 부서로 좁혔습니다/)
  const cl = await call(U.choi, 'POST', `/api/context/items/${C['제안서 표준 목차']}/sensitive`, { action: 'clear' })
  check(assert.equal, cl.sensitive, 'none')
  const reopen = await call(U.choi, 'PATCH', `/api/context/items/${C['제안서 표준 목차']}/grade`, { visibility: 'open', reach: 'department' })
  check(assert.equal, reopen.item.label, '전체 공개 · 부서', '표시를 떼면 다시 전체 공개로 열 수 있다')
  check(assert.equal, (await call(U.choi, 'POST', `/api/context/items/${C['제안서 표준 목차']}/sensitive`, { action: 'boom' }, { raw: true })).status, 400)

  // 무시한 제안은 다시 하지 않는다 · 목적에 낱말이 생기면 새로 제안한다
  const dm = await call(U.choi, 'POST', `/api/context/items/${C['연봉 협상 준비']}/sensitive`, { action: 'dismiss' })
  const sc = await call(U.choi, 'POST', '/api/context/sensitive/scan')
  log(`최유나가 「연봉 협상 준비」 표시를 무시 → 「${dm.note}」 · 다시 훑어도 제안 ${sc.proposed.length}건`)
  check(assert.ok, !sc.proposed.some((p) => p.id === C['연봉 협상 준비']))
  check(assert.equal, (await call(U.choi, 'GET', `/api/context/mine?conv=${C['연봉 협상 준비']}`)).items[0].sensitive, 'none')
  await call(U.lee, 'PATCH', `/api/context/items/${C['사내 교육 자료 정리']}/grade`, { purpose: '신입 컨설턴트 급여 체계 안내 자료' })
  const sc2 = await call(U.lee, 'POST', '/api/context/sensitive/scan')
  const fresh = sc2.proposed.find((p) => p.id === C['사내 교육 자료 정리'])
  log(`이도윤 「사내 교육 자료 정리」 목적에 「급여」 → 훑기: 제안 ${fresh ? `「${fresh.title}」(${fresh.hit}, new=${fresh.new})` : '없음'}`)
  check(assert.equal, fresh?.hit, '급여'); check(assert.equal, fresh?.new, true)
  check(assert.equal, (await call(U.lee, 'POST', '/api/context/sensitive/scan')).proposed.find((p) => p.id === C['사내 교육 자료 정리'])?.new, false, '두 번째는 이미 제안 중')

  // ── 열람 기록 ─────────────────────────────────────────────────────
  const lv = await call(U.lee, 'GET', `/api/context/items/${C['제안서 표준 목차']}`)
  check(assert.equal, lv.depth, 'content', '부서 범위 전체 공개 → 다른 팀 이도윤도 원문')
  const vLee = await call(U.lee, 'GET', '/api/context/views')
  const vChoi = await call(U.choi, 'GET', '/api/context/views')
  const jungRow = vLee.find((r) => r.viewer_name === '정하은' && r.conversation_id === C['경쟁 서비스 동향'] && r.depth === 'summary')
  const leeRow = vChoi.find((r) => r.viewer_name === '이도윤' && r.conversation_id === C['제안서 표준 목차'] && r.depth === 'content')
  log(`이도윤의 「내 맥락을 본 기록」: 정하은 · 요약 · ${jungRow?.count}번 · ${jungRow?.basis} / 최유나의: 이도윤 · 원문 · ${leeRow?.basis}`)
  check(assert.ok, jungRow && jungRow.count >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(jungRow.day), '요약 열람은 사람·날짜별로 모은다')
  check(assert.ok, leeRow && leeRow.item_title === '제안서 표준 목차', '원문 열람은 건마다')
  check(assert.ok, !vLee.some((r) => r.viewer_name === '이도윤'), '내가 본 것은 남지 않는다')
  check(assert.ok, Array.isArray(await call(U.lee, 'GET', '/api/context/used')))

  // ── 기본 등급 ─────────────────────────────────────────────────────
  const rj = await call(U.jung, 'GET', '/api/context/sharing-rules')
  const df = await call(U.jung, 'PUT', '/api/context/defaults', { default_visibility: 'listed', default_reach: 'team' })
  log(`정하은 기본 등급 → ${df.default_visibility}/${df.default_reach} (자동 허용 규칙 ${df.rules.length}줄 그대로)`)
  check(assert.equal, df.default_visibility, 'listed'); check(assert.deepEqual, df.rules, rj.rules)
  check(assert.equal, (await call(U.jung, 'PUT', '/api/context/defaults', { default_visibility: 'everyone' }, { raw: true })).status, 400)
} finally {
  // 되돌리기: 등급 행(목적·민감 포함), 정하은 규칙 행, 이 시험이 새로 만든 열람 기록
  for (const b of before) await q(`update pro_context_shares set visibility = $3, reach = $4, sensitive = $5, purpose = $6, sensitive_dismissed_at = $7 where tenant_id = $1 and conversation_id = $2`,
    [T, b.conversation_id, b.visibility, b.reach, b.sensitive, b.purpose, b.sensitive_dismissed_at ?? null])
  for (const r of rulesBefore) await q(`update pro_sharing_rules set rules = $3, default_visibility = $4, default_reach = $5 where tenant_id = $1 and user_id = $2`, [T, r.user_id, JSON.stringify(r.rules), r.default_visibility, r.default_reach])
  const mine = (await q(`select id from pro_context_views where tenant_id = $1 and conversation_id = any($2::text[])`, [T, touched])).map((r) => r.id).filter((id) => !viewsBefore.has(id))
  if (mine.length) await q(`delete from pro_context_views where id = any($1::uuid[])`, [mine])
  await db.end()
}
console.log(`\n공개 등급 E2E: ${step}단계 · 확인 ${passed}개 통과`)
