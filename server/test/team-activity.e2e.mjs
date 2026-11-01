// 팀 활동 HTTP E2E (spec pgpt-pro_team-activity) — 실제 BFF(이 워크트리) + 실제 DB + judge 임베딩 + 시드 회사(scripts/seed-team-context.mjs, 테넌트 team-demo).
//   카드(장·같은 부서·관리자·본인), 시간순 보기(요약 → 원문 보기 자동 허용 → 원문), 조직도(403·장·관리자), 겹침(0.75, 보는 사람의 글로만), 다른 사람 눈으로 내 카드.
//   시드의 「원문표지-…」 글은 답 원문에만 있다 — 원문 깊이가 없는 사람에게 나오면 실패.
//   이 시험이 만드는 것(이도윤의 진행 중 작업·파일 카드, 박하늘·정하은의 요청·허락)은 끝에 지우고, 바꾼 등급은 시드 값으로 되돌린다.
// 실행(server/): node test/team-activity.e2e.mjs   API_URL(기본 http://127.0.0.1:8798) · TENANT_HOST(기본 team.localhost:5198)
import assert from 'node:assert/strict'
import pg from 'pg'

const API = process.env.API_URL || 'http://127.0.0.1:8798'
const HOST = process.env.TENANT_HOST || 'team.localhost:5198'
const { config } = await import('../config.js')
const db = new pg.Pool({ ...config.db, max: 2 })
const q = (t, p) => db.query(t, p).then((r) => r.rows)
const T = 'team-demo'
let step = 0
const log = (m) => console.log(`${String(++step).padStart(2)}. ${m}`)
const H = { 'Content-Type': 'application/json', 'X-Forwarded-Host': HOST }
async function login(key) {
  const email = `pro-tc-${key}@uengine.org`
  await fetch(`${API}/api/auth/email/start`, { method: 'POST', headers: H, body: JSON.stringify({ email }) })
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: H, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  if (!r.ok) throw new Error(`login ${key} ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
  return { tok: j.session.access_token, id: j.user.id, key }
}
async function call(who, method, p, body, { raw = false } = {}) {
  const r = await fetch(API + p, { method, headers: { ...H, Authorization: `Bearer ${who.tok}` }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await r.text()
  if (raw) return { status: r.status, text: t }
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${t.slice(0, 300)}`)
  return JSON.parse(t)
}
const get = (who, p) => call(who, 'GET', p)
const has = (o, s) => JSON.stringify(o).includes(s)
const cardOf = (r, who) => r.cards.find((c) => c.user === who.id)
const noMarks = (o, what) => { const s = JSON.stringify(o); const m = s.match(/원문표지-[^"\\),.]+/); assert.ok(!m, `${what}: 원문 표지 ${m?.[0]} 가 나오면 안 된다`) }

const U = {}
for (const k of ['yoon', 'park', 'lee', 'choi', 'jung']) U[k] = await login(k)
const C = Object.fromEntries((await q(`select title, conversation_id from context_threads where tenant_id = $1`, [T])).map((r) => [r.title, r.conversation_id]))
for (const t of ['경쟁 서비스 동향', '개인 학습 메모', '사내 교육 자료 정리', '경쟁사 가격 벤치마크']) assert.ok(C[t], `시드 맥락 「${t}」 — 먼저 seed-team-context.mjs --reset`)
const TREND = C['경쟁 서비스 동향']
// 이 시험이 기대는 등급(시드 값). 끝나면 시작할 때의 값으로 되돌린다
const SEED = { '경쟁 서비스 동향': ['summary', 'team', 'none'], '개인 학습 메모': ['private', 'team', 'none'], '사내 교육 자료 정리': ['listed', 'team', 'none'], '경쟁사 가격 벤치마크': ['listed', 'team', 'none'] }
const before = await q(`select conversation_id, visibility, reach, sensitive from pro_context_shares where tenant_id = $1 and conversation_id = any($2::text[])`, [T, Object.keys(SEED).map((t) => C[t])])
const setGrade = (title, [v, r, s]) => q(`update pro_context_shares set visibility = $3, reach = $4, sensitive = $5 where tenant_id = $1 and conversation_id = $2`, [T, C[title], v, r, s])
for (const [t, g] of Object.entries(SEED)) await setGrade(t, g)
// 이 시험의 요청·허락(박하늘·정하은 → 「경쟁 서비스 동향」)은 지우고 시작한다 — 남아 있으면 「원문 보기」가 곧바로 「이미 허락」이 된다
const wipeMine = async () => {
  const reqs = await q(`delete from pro_access_requests where tenant_id = $1 and conversation_id = $2 and requester = any($3::uuid[]) returning id`, [T, TREND, [U.park.id, U.jung.id]])
  if (reqs.length) await q(`delete from notifications where tenant_id = $1 and url = any($2::text[])`, [T, reqs.map((r) => `/pro/context-access/${r.id}`)])
  await q(`delete from pro_grants where tenant_id = $1 and conversation_id = $2 and grantee = any($3::uuid[])`, [T, TREND, [U.park.id, U.jung.id]])
}
await wipeMine()
// 이도윤의 진행 중인 AI 작업 두 가지(메인 채팅이 「경쟁 서비스 동향」에서 일하는 중 + 정기 작업)와 그 맥락의 파일 카드
const [main] = await q(`select id, status, conversation_id from pro_threads where user_id = $1 and kind = 'chat' order by created_at limit 1`, [U.lee.id])
await q(`update pro_threads set status = 'working', conversation_id = $2 where id = $1`, [main.id, TREND])
const [sch] = await q(`insert into pro_schedules (user_id, name, cron, prompt, paused) values ($1, '주간 경쟁 동향 조사', '0 9 * * 1', '매주 월요일 경쟁 3사 요금제 페이지를 확인해 바뀐 점을 정리해 줘', true) returning id`, [U.lee.id])
await q(`insert into pro_mission_runs (schedule_id, trigger, status) values ($1, 'manual', 'running')`, [sch.id])
const [file] = await q(`insert into pro_messages (thread_id, role, kind, content) values ($1, 'agent', 'file', $2) returning id`,
  [main.id, { name: '경쟁 3사 요금 비교.xlsx', ext: 'xlsx', url: 'http://127.0.0.1:54321/storage/v1/object/public/files/test/e2e-trend.xlsx', conv: TREND, test: 'team-activity' }])
const SEED_PROMPTS = (await q(`select m.content->>'text' as t from pro_messages m where m.thread_id = $1 and m.role = 'user' and m.content->>'conv' = $2`, [main.id, TREND])).map((r) => r.t)
assert.ok(SEED_PROMPTS.length >= 6, '이도윤의 프롬프트 문장')
const viewsRow = () => q(`select count(*)::int as rows, coalesce(sum(count), 0)::int as n from pro_context_views where tenant_id = $1 and viewer = $2 and owner = $3 and conversation_id is null and day = current_date`, [T, U.park.id, U.lee.id]).then((r) => r[0])

let failed = null
try {
  // ── 카드 ──────────────────────────────────────────────────────────────
  const v0 = await viewsRow()
  const park = await get(U.park, '/api/team-activity?scope=team')
  assert.deepEqual(park.cards.map((c) => c.name), ['박하늘', '이도윤'], '팀 범위 = 전략팀(나 먼저)')
  assert.equal(park.viewer.can_org, true)
  const lee = cardOf(park, U.lee)
  assert.equal(lee.relation, '내 팀원')
  const now = lee.now.find((x) => x.title === '경쟁 서비스 동향')
  assert.ok(now && now.depth === 'summary' && now.line && now.request?.depth === 'content', '지금 하는 일: 제목·한 줄·원문 요청')
  assert.ok(lee.kinds.some((k) => k.name === '조사') && lee.kinds.some((k) => k.name === '분석·계산'), '주로 하는 일')
  assert.ok(lee.prompt_types.length && lee.prompt_types.every((t) => !t.examples), '프롬프트 유형은 이름·횟수만')
  for (const s of SEED_PROMPTS) assert.ok(!has(lee, s), `장에게 프롬프트 문장 「${s}」 없음`)
  assert.ok(lee.running.count >= 2, '이 시험이 넣은 두 작업(시드의 예약 실행이 더 있을 수 있다)')
  assert.ok(lee.running.items.some((r) => r.kind === 'mission' && r.title === '주간 경쟁 동향 조사' && r.status_label === '실행 중'), '장은 정기 작업의 내용을 본다')
  assert.ok(lee.running.items.some((r) => r.kind === 'chat' && r.conversationId === TREND))
  assert.ok(lee.artifacts.some((a) => a.name === '경쟁 3사 요금 비교.xlsx' && a.context === '경쟁 서비스 동향'), '이 시험이 넣은 산출물(시드의 파일이 더 있을 수 있다)')
  assert.ok(lee.artifacts.every((a) => a.url === undefined), '산출물은 이름만(링크는 원문 깊이)')
  assert.ok(lee.amount.turns > 0 && lee.amount.cost, '양: 턴 + 비용(장)')
  assert.ok(!lee.private, '비공개 건수는 관리자만')
  assert.ok(!has(park, '개인 학습 메모'), '비공개 맥락은 존재도 없다')
  noMarks(park, '박하늘 팀 활동')
  log(`박하늘(장) 팀 활동: ${park.cards.map((c) => c.name).join('·')} · 이도윤 지금 「${now.title}」— ${now.line} · 유형 ${lee.prompt_types.map((t) => `${t.name} ${t.count}회`).join(', ')} · AI 작업 ${lee.running.items.map((r) => r.kind_label + ' ' + r.title).join(' / ')} · 산출물 ${lee.artifacts.map((a) => a.name).join(', ')}`)
  await get(U.park, '/api/team-activity?scope=team')
  const v1 = await viewsRow()
  assert.equal(v1.rows, Math.max(1, v0.rows), '요약 열람은 사람·날짜별 한 줄')
  assert.equal(v1.n, v0.n + 2, '카드를 열 때마다 그 줄의 횟수가 는다')
  log(`열람 기록: 박하늘→이도윤 오늘 ${v1.rows}줄 · ${v1.n}회`)

  const jung = await get(U.jung, '/api/team-activity?scope=company')
  assert.deepEqual(jung.cards.map((c) => c.name).sort(), ['박하늘', '윤서진', '이도윤', '정하은', '최유나'].sort(), '회사 범위 = 다섯 명')
  assert.equal(jung.viewer.can_org, false)
  const jl = cardOf(jung, U.lee)
  assert.equal(jl.relation, '같은 부서')
  assert.ok(jl.now.length && jl.now.every((x) => x.depth === 'title' && !x.line), '다른 팀은 제목만')
  assert.deepEqual(jl.prompt_types, [])
  assert.ok(jl.prompt_types_unnamed > 0 && jl.kinds.length, '작업 유형 횟수와 이름 없는 횟수')
  assert.ok(!jl.amount.cost, '비용은 장·관리자·본인만')
  assert.ok(jl.running.count >= 2 && jl.running.hidden === jl.running.count && jl.running.items.length === 0, '진행 중인 AI 작업은 건수만')
  assert.deepEqual(jl.artifacts, [])
  assert.ok(!has(jl, '요금 비교') && !has(jl, now.line), '한 줄·산출물 이름 없음')
  noMarks(jung, '정하은 회사 범위')
  log(`정하은(같은 부서) 회사 범위 ${jung.cards.length}명 · 이도윤 카드 = 제목 ${jl.now.map((x) => x.title).join(', ')} + 유형 횟수 ${jl.prompt_types_unnamed} · AI 작업 ${jl.running.hidden}건(내용 없음)`)

  const yoon = await get(U.yoon, '/api/team-activity?scope=company')
  const yl = cardOf(yoon, U.lee)
  assert.equal(yl.relation, '관리자로 봄')
  assert.deepEqual(yl.private, { count: 1 }, '관리자에게 「비공개 작업 1건」')
  assert.ok(!has(yoon, '개인 학습 메모') && !has(yoon, '회귀 분석'), '비공개 맥락의 제목·요약은 관리자에게도 없다')
  noMarks(yoon, '윤서진 회사 범위')
  log(`윤서진(관리자): 이도윤 비공개 작업 ${yl.private.count}건 · 지금 「${yl.now[0].title}」 요약 깊이`)

  // ── 시간순 보기 ───────────────────────────────────────────────────────
  const tl = `/api/team-activity/${U.lee.id}/timeline?conv=${TREND}`
  const t1 = await get(U.park, tl)
  assert.equal(t1.item.depth, 'summary')
  assert.ok(t1.item.summary && t1.request?.depth === 'content')
  const prompts = t1.lines.filter((l) => l.kind === 'prompt')
  assert.ok(prompts.length >= 6 && prompts.every((l) => l.type && l.request?.depth === 'content' && !l.prompt && !l.answer), '요약 깊이 줄 = 유형 이름 + 한 줄 + 요청하기')
  assert.ok(prompts.filter((l) => l.line).length >= 4, '요약이 만든 바꿔 쓴 한 줄')
  for (const s of SEED_PROMPTS) assert.ok(!has(t1, s), `요약 깊이 시간순에 프롬프트 문장 「${s}」 없음`)
  assert.ok(t1.lines.some((l) => l.kind === 'ai') && t1.lines.some((l) => l.kind === 'artifact' && l.name && !l.url))
  noMarks(t1, '박하늘 시간순(요약)')
  log(`박하늘 시간순(요약): ${prompts.length}줄 — 「${prompts[0].type} — ${prompts[0].line}」 · 프롬프트 문장 0 · 원문 표지 0`)
  const tj = await get(U.jung, tl)
  assert.equal(tj.item.depth, 'title')
  assert.ok(tj.lines.filter((l) => l.kind === 'prompt').every((l) => l.work && !l.type && !l.line), '제목 깊이 줄 = 시각·작업 유형')
  assert.ok(!tj.item.summary)
  noMarks(tj, '정하은 시간순(제목)')
  const memo = await call(U.park, 'GET', `/api/team-activity/${U.lee.id}/timeline?conv=${C['개인 학습 메모']}`, undefined, { raw: true })
  assert.equal(memo.status, 404, '비공개 맥락의 시간순 보기는 404')
  const wrong = await call(U.park, 'GET', `/api/team-activity/${U.park.id}/timeline?conv=${TREND}`, undefined, { raw: true })
  assert.equal(wrong.status, 404, '주인이 다르면 404')
  log(`정하은 시간순(제목): 시각·작업 유형만 · 비공개 맥락 404 · 주인 다르면 404`)

  // 「원문 보기」: 같은 팀 기본 규칙 → 자동 허용 → 원문
  const ask = await call(U.park, 'POST', '/api/context/access-requests', { conversationId: TREND, depth: 'content', doing: '팀 활동에서 살펴봄' })
  assert.equal(ask.status, 'granted')
  assert.equal(ask.via, 'auto')
  const t2 = await get(U.park, tl)
  assert.equal(t2.item.depth, 'content')
  assert.equal(t2.request, null)
  const p2 = t2.lines.filter((l) => l.kind === 'prompt')
  assert.ok(p2.every((l) => l.prompt && !l.request), '원문 깊이 줄 = 프롬프트 문장')
  assert.ok(has(t2, '원문표지-A사9900'), '원문에는 답 첫 줄이 보인다')
  assert.ok(t2.lines.some((l) => l.kind === 'artifact' && l.url), '원문 깊이에는 산출물 링크')
  const [seen] = await q(`select depth, basis from pro_context_views where tenant_id = $1 and viewer = $2 and owner = $3 and conversation_id = $4 and depth = 'content' order by last_at desc limit 1`, [T, U.park.id, U.lee.id, TREND])
  assert.ok(seen && /자동 허용/.test(seen.basis), `이도윤의 열람 기록에 원문 · 자동 허용(${seen?.basis})`)
  const park2 = cardOf(await get(U.park, '/api/team-activity?scope=team'), U.lee)
  assert.ok(park2.prompt_types.some((t) => t.examples?.length), '허락을 받으면 카드에 그 맥락의 예시 문장이 나온다')
  log(`「원문 보기」 → ${ask.via} 허용 → 원문 ${p2.length}줄(「${p2[0].prompt}」 → ${p2[0].answer}) · 열람 기록 「${seen.basis}」`)

  const askJ = await call(U.jung, 'POST', '/api/context/access-requests', { conversationId: TREND, depth: 'content', doing: '팀 활동에서 살펴봄' })
  assert.equal(askJ.status, 'pending', '다른 팀은 주인에게 묻는다(「요청함 — 주인에게 갔습니다」)')
  log(`정하은 「원문 보기」 → ${askJ.status}(주인에게 감)`)

  // ── 조직도 ────────────────────────────────────────────────────────────
  const o403 = await call(U.jung, 'GET', '/api/team-activity/org', undefined, { raw: true })
  assert.equal(o403.status, 403, '장이 아닌 사람은 403')
  const op = await get(U.park, '/api/team-activity/org')
  assert.deepEqual(op.roots.map((n) => n.name), ['전략팀'], '장은 자기 팀 노드')
  const oy = await get(U.yoon, '/api/team-activity/org')
  assert.equal(oy.roots[0].name, '서진컨설팅')
  const hq = oy.roots[0].children.find((n) => n.name === '컨설팅본부')
  const st = hq.children.find((n) => n.name === '전략팀'), pr = hq.children.find((n) => n.name === '제안팀')
  assert.ok(st && pr, '본부 아래 전략팀·제안팀')
  assert.equal(st.lead?.name, '박하늘')
  assert.equal(st.stats.private, 1, '이도윤의 비공개 맥락은 전략팀 건수에만')
  assert.ok(st.stats.contexts >= 5 && st.stats.topics.length && !st.stats.topics.some((t) => t.title === '개인 학습 메모'), '비공개는 주제에 없다')
  assert.ok(st.stats.running >= 2 && st.stats.kinds.length && st.stats.cost, '진행 중인 AI 작업 수·유형·비용')
  assert.ok(!has(oy, '개인 학습 메모'))
  noMarks(oy, '윤서진 조직도')
  log(`조직도: 정하은 403 · 박하늘 ${op.roots.map((n) => n.name)} · 윤서진 ${oy.roots[0].name} › ${hq.name} › ${hq.children.map((n) => `${n.name}(맥락 ${n.stats.contexts} · 비공개 ${n.stats.private} · AI ${n.stats.running} · 주제 ${n.stats.topics.map((t) => t.title).slice(0, 2).join('/')})`).join(', ')}`)

  // ── 겹침 ──────────────────────────────────────────────────────────────
  const pairOf = (r) => r.pairs.find((p) => [p.a.title, p.b.title].sort().join('|') === ['경쟁 서비스 동향', '경쟁사 가격 벤치마크'].sort().join('|'))
  const measured = {}
  for (const k of ['lee', 'park', 'choi', 'yoon']) {
    const d = await get(U[k], '/api/team-activity/overlaps')
    assert.equal(d.min, 0.75)
    assert.ok(!d.error, d.error)
    assert.ok(d.pairs.every((p) => p.score >= 0.75 && p.a.owner !== p.b.owner), '기본 기준 0.75')
    noMarks(d, `${k} 겹침`)
    const diag = await get(U[k], '/api/team-activity/overlaps?min=0.5')
    const p = pairOf(diag)
    measured[k] = p ? p.score : null
    if (p) {
      const choiSide = p.a.title === '경쟁사 가격 벤치마크' ? p.a : p.b
      if (k !== 'choi' && k !== 'yoon') assert.ok(choiSide.depth === 'title' && !choiSide.line && choiSide.request, '제목 깊이 상대는 제목·목적으로만 비교, 요청하기')
    }
    assert.equal(!!pairOf(d), (measured[k] ?? 0) >= 0.75, '기준을 넘을 때만 기본 응답에 나온다')
  }
  log(`겹침(기준 0.75, 보는 사람의 글로만) 이도윤 「경쟁 서비스 동향」~최유나 「경쟁사 가격 벤치마크」: ${Object.entries(measured).map(([k, s]) => `${k} ${s ?? '없음'}`).join(' · ')}`)

  // ── 다른 사람 눈으로 내 카드 ───────────────────────────────────────────
  const asOther = await get(U.lee, '/api/team-activity/me/as?as=other')
  assert.ok(asOther.card.now.every((x) => x.depth === 'title' && !x.line) && !asOther.card.prompt_types.length && !asOther.card.amount.cost, '다른 팀 눈 = 제목만')
  const asAdmin = await get(U.lee, '/api/team-activity/me/as?as=admin')
  assert.equal(asAdmin.label, '관리자')
  assert.deepEqual(asAdmin.card.private, { count: 1 }, '관리자 눈 = 비공개 작업 1건')
  assert.ok(asAdmin.card.now.some((x) => x.title === '경쟁 서비스 동향' && x.depth === 'summary'))
  assert.ok(!has(asAdmin.card, '개인 학습 메모'))
  assert.ok(asAdmin.views.some((v) => v.viewer_name === '박하늘' && v.depth === 'content' && v.title === '경쟁 서비스 동향'), '이번 주 내 원문을 연 사람')
  assert.ok(asAdmin.views.some((v) => v.viewer_name === '박하늘' && v.depth === 'summary' && v.title === '팀 활동 카드'), '이번 주 내 카드를 본 사람')
  assert.equal((await call(U.lee, 'GET', '/api/team-activity/me/as?as=boss', undefined, { raw: true })).status, 400)
  noMarks(asOther, '다른 팀 눈')
  log(`이도윤 「관리자 눈으로 보기」: 비공개 작업 ${asAdmin.card.private.count}건 · 이번 주 열람 ${asAdmin.views.length}줄(${asAdmin.views.slice(0, 3).map((v) => `${v.viewer_name} ${v.depth === 'content' ? '원문' : '요약'} ${v.title}`).join(', ')})`)

  // ── 등급을 좁히면 다음 조립부터 바로 빠진다(허락이 있어도 비공개는 없음) ──
  await setGrade('경쟁 서비스 동향', ['private', 'team', 'none'])
  const narrowed = cardOf(await get(U.park, '/api/team-activity?scope=team'), U.lee)
  assert.ok(!narrowed.now.some((x) => x.title === '경쟁 서비스 동향') && !narrowed.prompt_types.some((t) => /경쟁사 가격|변동/.test(t.name)), '비공개로 바꾸면 카드에서 바로 빠진다')
  assert.ok(!has(narrowed, '경쟁 서비스 동향') && !narrowed.artifacts.length, '맥락 제목은 어디에도 없고 그 맥락의 산출물도 빠진다')
  assert.ok(narrowed.running.items.some((r) => r.kind === 'chat' && r.private && !r.title) && narrowed.running.items.some((r) => r.kind === 'mission'),
    '장에게 그 맥락의 AI 작업은 「비공개 맥락」으로만, 정기 작업 내용은 그대로')
  assert.equal((await call(U.park, 'GET', tl, undefined, { raw: true })).status, 404)
  await setGrade('경쟁 서비스 동향', SEED['경쟁 서비스 동향'])
  log(`「경쟁 서비스 동향」 비공개로 → 박하늘 카드에서 바로 빠짐(지금 하는 일 ${narrowed.now.map((x) => x.title).join(', ') || '없음'}) · 시간순 404 → 되돌림`)
} catch (e) { failed = e } finally {
  await wipeMine().catch(() => {})
  await q(`delete from pro_messages where id = $1`, [file.id]).catch(() => {})
  await q(`delete from pro_schedules where id = $1`, [sch.id]).catch(() => {})
  await q(`update pro_threads set status = $2, conversation_id = $3 where id = $1`, [main.id, main.status, main.conversation_id]).catch(() => {})
  for (const b of before) await q(`update pro_context_shares set visibility = $3, reach = $4, sensitive = $5 where tenant_id = $1 and conversation_id = $2`, [T, b.conversation_id, b.visibility, b.reach, b.sensitive]).catch(() => {})
  await db.end()
}
if (failed) { console.error(`\n실패(${step}단계 뒤):`, failed.message); process.exit(1) }
console.log(`\n팀 활동 E2E 통과 — ${step}단계`)
