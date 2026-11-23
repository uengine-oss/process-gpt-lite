// 같은 요청 알아보기 HTTP E2E (spec pgpt-pro_context-repeat-request): 메인 채팅의 요청이 에이전트로 가기 전에 이미 한 요청을 찾아 카드로 묻는다.
//   ① 내가 했던 요청 → 「이미 한 요청」 카드(에이전트 안 부름) → 그 답 보기(그 턴의 답) → 그래도 새로 하기(에이전트가 답함) → 같은 문장 다시 보내기는 묻지 않음
//   ② 형식이 다른 요청(표 ↔ 그래프)은 묻지 않음
//   ③ 같은 팀 팀원이 이미 한 일(제목만 보임) → 카드에 제목·주인만 → 그 답 보기는 403 → 요청하기(같은 팀 자동 허용, 결정 원장) → 그 답 보기(팀원의 답, 열람 기록)
//      → 주인이 회수하면 다시 볼 수 없음(복사하지 않았다)
//   ④ 같은 판별 모델 사례(repeat-cases.json)
//   실제 BFF(이 워크트리) + 실제 DB + 시드 회사(team-demo) + 실제 임베딩·게이트웨이 모델 + ①의 새로 하기만 실제 에이전트(deepagents).
// 실행(server/): PRO_TENANT_HOSTS 에 team.localhost=team-demo 를 더하고 node test/repeat.e2e.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
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
// 메인 채팅에 보내고 끝(done)의 메시지를 받는다
async function say(who, text, extra = {}) {
  const th = await call(who, 'GET', '/api/threads')
  const main = (th.threads || th).find((t) => t.kind === 'chat')
  const t0 = Date.now()
  const r = await fetch(`${API}/api/threads/${main.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who.tok}`, 'X-Forwarded-Host': HOST }, body: JSON.stringify({ text, ...extra }) })
  const body = await r.text()
  const done = body.split('\n\n').find((x) => x.startsWith('event: done'))
  return { thread: main.id, msg: done ? JSON.parse(done.split('\ndata: ')[1]) : null, ms: Date.now() - t0 }
}

execSync('node scripts/seed-team-context.mjs --live', { stdio: 'ignore', env: process.env })
const U = {}
for (const k of ['park', 'lee', 'choi', 'jung']) U[k] = await login(k)
const C = Object.fromEntries((await q(`select title, conversation_id from context_threads where tenant_id = $1`, [T])).map((r) => [r.title, r.conversation_id]))
for (const t of ['경쟁 서비스 동향', '경쟁사 가격 벤치마크', '개인 학습 메모']) assert.ok(C[t], `시드 맥락 「${t}」 — 먼저 seed-team-context.mjs --reset`)
const { tenantStore } = await import('../lib/tenantStore.js')
const R = await import('../lib/context/repeat.js')
const inTenant = (fn) => tenantStore.run({ tenant: T }, fn)
const stamp = new Date()

try {
  // ── ① 내가 했던 요청 ─────────────────────────────────────────────
  const ASK = '경쟁 3사 사용자당 월 요금을 표로 비교해줘'
  const s1 = await say(U.lee, ASK)
  const c1 = s1.msg?.content || {}
  log(`이도윤 「${ASK}」 → ${s1.msg?.kind} (${(s1.ms / 1000).toFixed(1)}초) · ${c1.hits?.map((h) => `${h.mine ? '내' : h.owner_name} 「${h.title}」 「${h.prompt}」`).join(' / ')}`)
  check(assert.equal, s1.msg?.kind, 'repeat')
  check(assert.deepEqual, [c1.hits[0].mine, c1.hits[0].conv, c1.hits[0].kind, c1.hits[0].prompt], [true, C['경쟁 서비스 동향'], 'turn', '경쟁 3사 사용자당 월 요금을 표로 비교해 줘'])
  check(assert.equal, c1.request, ASK)
  const after1 = await q(`select kind from pro_messages where thread_id = $1 and role = 'agent' and created_at > $2 order by created_at`, [s1.thread, stamp])
  check(assert.deepEqual, after1.map((m) => m.kind), ['repeat'], '에이전트를 부르지 않았다(답 메시지 없음)')
  const a1 = await call(U.lee, 'GET', `/api/context/repeats/${c1.repeat_id}/answer?n=0`)
  const [seedAns] = await q(`select content->>'text' as text from pro_messages where id = $1`, [c1.hits[0].turn_id])
  log(`그 답 보기 → 「${a1.turn.prompt}」의 답 ${a1.turn.answer.length}자 · 깊이 ${a1.depth}`)
  check(assert.equal, a1.turn.answer, seedAns.text)
  check(assert.equal, (await q(`select choice from pro_context_repeats where id = $1`, [c1.repeat_id]))[0].choice, 'view')

  // 그래도 새로 하기 → 에이전트가 답한다(이번에는 알아보지 않는다)
  await call(U.lee, 'POST', `/api/context/repeats/${c1.repeat_id}/choice`, { choice: 'fresh' })
  const s2 = await say(U.lee, ASK, { fresh: true })
  const [u2] = await q(`select id, content from pro_messages where thread_id = $1 and role = 'user' order by created_at desc limit 1`, [s2.thread])
  log(`그래도 새로 하기 → ${s2.msg?.kind} (${(s2.ms / 1000).toFixed(1)}초) · 사람 메시지 fresh=${!!u2.content.fresh}`)
  check(assert.equal, s2.msg?.kind !== 'repeat' && !!s2.msg, true)
  check(assert.equal, u2.content.fresh, true)
  // 같은 문장을 바로 다시 보내면 「다시 시켜 보기」 — 묻지 않는다
  const [u3] = await q(`insert into pro_messages (thread_id, role, kind, content) values ($1, 'user', 'text', $2) returning id`, [s2.thread, { text: ASK }])
  const again = await inTenant(() => R.findRepeat({ id: U.lee.id }, { threadId: s2.thread, message: ASK, userMsgId: u3.id }))
  log(`같은 문장 바로 다시 → ${again ? '카드' : '묻지 않음'}`)
  check(assert.equal, again, null)
  await q(`delete from pro_messages where id = $1`, [u3.id])

  // ── ② 형식이 다른 요청 ────────────────────────────────────────────
  const graph = await inTenant(() => R.findRepeat({ id: U.lee.id }, { threadId: s1.thread, message: '경쟁 3사 월 요금을 그래프로 그려 줘' }))
  log(`「경쟁 3사 월 요금을 그래프로 그려 줘」 → ${graph ? '카드' : '묻지 않음(표 ↔ 그래프는 다른 결과물)'}`)
  check(assert.equal, graph, null)

  // ── ③ 같은 팀 팀원이 이미 한 일 ───────────────────────────────────
  const ASK2 = '제안서 부록에 넣을 경쟁사 요금 비교표 만들어 줘'
  const s3 = await say(U.jung, ASK2)
  const c3 = s3.msg?.content || {}
  const h3 = c3.hits?.[0] || {}
  log(`정하은 「${ASK2}」 → ${s3.msg?.kind} · ${h3.owner_name} 「${h3.title}」 깊이 ${h3.depth} · 요청 ${h3.can_request}`)
  check(assert.equal, s3.msg?.kind, 'repeat')
  check(assert.deepEqual, [h3.owner_name, h3.conv, h3.kind, h3.depth, h3.can_request, h3.mine], ['최유나', C['경쟁사 가격 벤치마크'], 'context', 'title', 'content', false])
  check(assert.ok, !('prompt' in h3) && !('turn_id' in h3) && !JSON.stringify(c3).includes('부록 표를 만들었어요'), '제목 깊이: 요청 문장·답이 카드에 없다')
  const no3 = await call(U.jung, 'GET', `/api/context/repeats/${c3.repeat_id}/answer?n=0`, undefined, { raw: true })
  check(assert.equal, no3.status, 403, no3.text.slice(0, 300))
  const rq = await call(U.jung, 'POST', '/api/context/access-requests', { conversationId: h3.conv, depth: 'content', threadId: s3.thread, doing: ASK2 })
  const [led] = await q(`select decision, status from pro_policy_decisions where id = $1`, [rq.policy.decision_id])
  log(`요청하기 → ${rq.status}(${rq.via}) · 결정 원장 ${led.decision}/${led.status}`)
  check(assert.deepEqual, [rq.status, rq.via, led.decision, led.status], ['granted', 'auto', 'allow_audit', 'executed'])
  const a3 = await call(U.jung, 'GET', `/api/context/repeats/${c3.repeat_id}/answer?n=0`)
  log(`그 답 보기 → ${a3.owner_name}님의 「${a3.turn.prompt}」 → 「${a3.turn.answer.slice(0, 40)}」`)
  check(assert.equal, a3.depth, 'content')
  check(assert.match, a3.turn.prompt, /부록용 경쟁사 요금 비교표/)
  const views = await q(`select depth from pro_context_views where tenant_id = $1 and viewer = $2 and owner = $3 and conversation_id = $4 and last_at > $5`, [T, U.jung.id, U.choi.id, h3.conv, stamp])
  check(assert.ok, views.some((v) => v.depth === 'content'), '최유나의 본 기록에 원문 열람이 남는다')
  await call(U.choi, 'DELETE', `/api/context/grants/${rq.grant.id}`)
  const gone = await call(U.jung, 'GET', `/api/context/repeats/${c3.repeat_id}/answer?n=0`, undefined, { raw: true })
  log(`최유나가 회수 → 다시 그 답 보기 ${gone.status} 「${gone.json?.error}」`)
  check(assert.equal, gone.status, 403)
  // 제목만 보이는 다른 팀 사람(박하늘 — 목록 공개는 회사 전체에 제목이 보인다)에게도 카드는 제목·주인만
  const parkSees = await inTenant(() => R.findRepeat({ id: U.park.id }, { threadId: null, message: ASK2 }))
  const ph = (parkSees?.hits || []).find((h) => h.conv === C['경쟁사 가격 벤치마크'])
  check(assert.ok, !ph || (ph.depth === 'title' && !('prompt' in ph)), '제목 깊이 후보는 요청 문장이 없다')
  // 비공개 맥락(이도윤 「개인 학습 메모」)은 남에게 후보조차 아니다 — 같은 요청을 해도
  const priv = await inTenant(() => R.findRepeat({ id: U.jung.id }, { threadId: null, message: '회귀 분석 결과 해석하는 법을 쉽게 설명해 줘' }))
  log(`정하은 「회귀 분석 결과 해석하는 법을 쉽게 설명해 줘」 → ${priv ? priv.hits.map((h) => h.title).join(',') : '묻지 않음'} (이도윤의 비공개 맥락에 같은 요청이 있다)`)
  check(assert.ok, !(priv?.hits || []).some((h) => h.conv === C['개인 학습 메모']))

  // ── ④ 판별 모델 사례 ─────────────────────────────────────────────
  const CASES = JSON.parse(readFileSync(new URL('./repeat-cases.json', import.meta.url))).cases
  const bad = []
  for (const c of CASES) {
    const cand = { kind: c.earlier.kind, prompt: c.earlier.text, text: c.earlier.text, at: new Date(Date.now() - c.days * 864e5) }
    const v = await R.judge(c.message, [cand])
    const got = !v ? 'none' : (v.same || []).map(Number).includes(1) ? ((v.stale || []).map(Number).includes(1) ? 'stale' : 'same') : 'different'
    // stale 을 기대한 사례는 「올리지 않음」이면 된다(different 도 맞다)
    const ok = c.expect === 'stale' ? got !== 'same' : got === c.expect
    if (!ok) bad.push(`${c.message} ↔ ${c.earlier.text.replace('\n', ' / ')}: 기대 ${c.expect}, 실제 ${got}`)
  }
  log(`판별 사례 ${CASES.length}개 → 어긋남 ${bad.length}`)
  check(assert.deepEqual, bad, [])

  console.log(`\n통과 ${passed}개 확인 · ${step}단계`)
} finally {
  await q(`delete from pro_context_repeats where tenant_id = $1 and created_at > $2`, [T, stamp])
  await db.end()
  execSync('node scripts/seed-team-context.mjs --live', { stdio: 'ignore', env: process.env })
}
