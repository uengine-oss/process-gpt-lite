// E2E S4 「역할과 습관」 (spec pgpt-pro_process-ontology, design-v0.3): the personal habits of the demo tenant — 영업 이도윤 · 최유나 ·
// 한지호 each put the company seal on a quote, in their own words; one-person habits elsewhere — are counted into role routines.
// The map shows 「영업 루틴 · 직인 넣기(3명)」 at the default setting and not the one-person habits, never anyone's words; the setting
// moves that line. 영업 has four people (정하나 joined and has done nothing yet). The admin drafts and confirms the role's
// definition. Two of the three share their way; each way runs once for real (quote sheet by the agent → their own habit asked →
// accepted → the agent does it), timed; the fastest becomes a skill of 「직인 넣기」. 정하나, with no habit, gets the role's routine
// asked the company's way, and it becomes her habit.
//
//   PRO_API=http://ax.localhost:8790 node test/ontology-roles.e2e.mjs
// Needs: node scripts/ax-demo.mjs --reset --seed (cast + practice habits), the map built (S1, or POST /ontology/build), the agent.
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { q, pool } from '../lib/supa.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
const AWAIT_MS = 8 * 60_000
let failed = 0
const out = {}
const step = async (name, fn) => {
  try { out[name] = await fn(); console.log(`✓ ${name}`, JSON.stringify(out[name]).slice(0, 420)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(2000) }
  throw new Error(`시간 초과: ${what}`)
}
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  const tok = j.session.access_token
  return { id: j.user.id, email, tok,
    call: async (method, path, body) => { const res = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined }); return { status: res.status, body: await res.json().catch(() => ({})) } } }
}
const WORDS = ['오른쪽 아래에 회사 직인 이미지', '공급자 칸 옆에 대표 직인', '합계 아래에 회사 직인', 'PDF로도 저장', '표지에 대외비', '재무 검토 날짜']
const noWords = (m) => { const s = JSON.stringify(m); return WORDS.filter((w) => s.includes(w)) }
const routine = (m) => m.triggers.find((t) => t.to === '직인 넣기' && t.scope === 'role:영업')

const boss = await signIn('pro-ax-jinyoung@uengine.org')
const minji = await signIn('pro-ax-minji@uengine.org')
const doyun = await signIn('pro-ax-doyun@uengine.org')
const yuna = await signIn('pro-ax-yuna@uengine.org')
const jiho = await signIn('pro-ax-jiho@uengine.org')
const hana = await signIn('pro-ax-hana@uengine.org')
const cast = [doyun, yuna, jiho, hana]

// this scenario's leftovers: shared ways, the setting, 정하나's habit, the asked-in-this-conversation marks, the chats
await q('delete from pro_habit_shares where tenant_id=$1', ['ax-demo'])
await q('delete from pro_onto_settings where tenant_id=$1', ['ax-demo'])
await q('delete from pro_followups where tenant_id=$1 and user_id=$2', ['ax-demo', hana.id])
await q('update pro_followups set last_asked_conv=null where tenant_id=$1 and user_id = any($2::uuid[])', ['ax-demo', cast.map((u) => u.id)])
for (const u of cast) {
  await q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [u.id])
  await q(`update pro_threads set conversation_id=null where user_id=$1`, [u.id])
}
{
  const { withTenant } = await import('../lib/tenant.js')
  await withTenant('ax-demo', async () => { const { cypher } = await import('../lib/ontology/store.js'); await cypher('MATCH (w:Way) SET w.status=$s RETURN w.key AS key', { s: 'withdrawn' }).catch(() => {}) })
}

await step('다시 셈하기(관리자): 개인 습관이 역할 루틴으로', async () => {
  const b = await boss.call('POST', '/ontology/build')
  assert.equal(b.status, 200, JSON.stringify(b.body))
  const j = await until(async () => { const r = (await boss.call('GET', `/ontology/jobs/${b.body.job}`)).body; return r.status !== 'running' && r }, 20 * 60_000, '셈')
  assert.equal(j.status, 'done', j.error)
  return { routines: j.detail?.routines, roles: j.detail?.roles }
})

let map
await step('지도: 같은 역할 3명이 같은 목표(직인 넣기)에 다른 말로 → 「영업 루틴」, 한 사람 습관은 안 보이고, 누구의 말도 없다', async () => {
  map = (await boss.call('GET', '/ontology/map')).body
  const r = routine(map)
  assert.ok(r, JSON.stringify(map.triggers.filter((t) => t.source !== 'mined')))
  assert.equal(r.people, 3)
  const proc = map.processes.find((p) => p.kind === 'routine' && p.role === '영업')
  assert.ok(proc?.tasks.includes('직인 넣기'))
  assert.ok(map.habits.hidden >= 3, `hidden ${map.habits.hidden}`)
  assert.ok(!map.triggers.some((t) => ['대외비 표기', 'PDF 저장', '검토 날짜 기록'].includes(t.to)))
  assert.deepEqual(noWords(map), [])
  return { routine: `${proc.name} · ${r.from} → ${r.to} (${r.people}명)`, hidden: map.habits.hidden }
})

await step('설정: 관리자만, 기준 4명이면 사라지고, 「모두」면 한 사람 습관도(이름 · 말 없이), 다시 기준 3명', async () => {
  assert.equal((await minji.call('PUT', '/ontology/settings', { mode: 'all', min: 3 })).status, 403)
  await boss.call('PUT', '/ontology/settings', { mode: 'threshold', min: 4 })
  const four = (await boss.call('GET', '/ontology/map')).body
  assert.equal(routine(four), undefined)
  await boss.call('PUT', '/ontology/settings', { mode: 'all', min: 4 })
  const all = (await boss.call('GET', '/ontology/map')).body
  const shown = all.triggers.filter((t) => t.source === 'habit').map((t) => `${t.scope}:${t.to}(${t.people})`)
  assert.ok(shown.some((x) => x.includes('대외비 표기')) && shown.some((x) => x.includes('검토 날짜')), shown.join(', '))
  assert.deepEqual(noWords(all), [])
  const back = (await boss.call('PUT', '/ontology/settings', { mode: 'threshold', min: 3 })).body
  assert.deepEqual(back, { mode: 'threshold', min: 3 })
  return { four: 'hidden', all: shown }
})

await step('역할: 영업은 4명(정하나는 아직 일하지 않았지만 역할 사람), 맡은 일 · 루틴 · 지표', async () => {
  const v = (await boss.call('GET', `/ontology/roles/${encodeURIComponent('영업')}`)).body
  const names = v.performers.map((p) => p.name)
  for (const n of ['이도윤', '최유나', '한지호', '정하나']) assert.ok(names.includes(n), names.join(','))
  const hanaP = v.performers.find((p) => p.name === '정하나')
  assert.equal(hanaP.n, 0); assert.equal(hanaP.assigned, true)
  assert.ok(v.routineTasks.some((r) => r.task === '직인 넣기' && r.people === 3))
  assert.ok(v.tasks.length >= 3)
  return { members: v.role.members, tasks: v.tasks.slice(0, 4).map((t) => t.task), single: v.role.single_tasks, agent_share: v.role.agent_share }
})

await step('역할 정의: 근거로 초안(관리자) → 확정, 그래프에 남는다', async () => {
  assert.equal((await minji.call('POST', `/ontology/roles/${encodeURIComponent('영업')}/draft`)).status, 403)
  const d = (await boss.call('POST', `/ontology/roles/${encodeURIComponent('영업')}/draft`)).body
  assert.ok(d.definition && d.competencies?.length >= 3, JSON.stringify(d).slice(0, 300))
  const s = (await boss.call('PUT', `/ontology/roles/${encodeURIComponent('영업')}`, { definition: d.definition, competencies: d.competencies })).body
  assert.equal(s.role.confirmed, true)
  return { definition: d.definition, competencies: d.competencies.map((c) => c.name) }
})

const habitOf = async (u, like) => (await q(`select * from pro_followups where tenant_id='ax-demo' and user_id=$1 and action like $2`, [u.id, `%${like}%`]))[0]
await step('방법 공유: 이도윤 · 한지호는 공유, 최유나는 나만 — 공유한 방법만 그 목표의 후보로(그래프의 Way)', async () => {
  for (const [u, like, answer] of [[doyun, '회사 직인 이미지', 'shared'], [jiho, '합계 아래', 'shared'], [yuna, '대표 직인', 'private']]) {
    const h = await habitOf(u, like)
    const r = await u.call('POST', '/ontology/ways/answer', { followupId: h.id, answer })
    assert.equal(r.status, 200, JSON.stringify(r.body))
    if (answer === 'shared') assert.equal(r.body.task, '직인 넣기')
  }
  assert.equal((await minji.call('POST', '/ontology/ways/answer', { followupId: (await habitOf(doyun, '회사 직인 이미지')).id, answer: 'shared' })).status, 404, '남의 습관은 공유할 수 없다')
  const ways = (await boss.call('GET', `/ontology/ways?task=${encodeURIComponent('직인 넣기')}`)).body
  assert.deepEqual(ways.map((w) => w.name).sort(), ['이도윤', '한지호'])
  const m = (await boss.call('GET', '/ontology/map')).body
  assert.equal(m.ways.filter((w) => w.task === '직인 넣기').length, 2)
  return ways.map((w) => `${w.name}: ${w.how.split('\n')[0]}`)
})

// one real run: the agent makes a quote sheet, the person's own habit is asked, accepted, the agent does it
async function threadOf(u) {
  const [t] = await q(`select id from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [u.id])
  return t?.id || (await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','채팅') returning id`, [u.id]))[0].id
}
async function quote(u, customer) {
  const th = await threadOf(u)
  const since = new Date()
  const r = await fetch(`${API}/api/threads/${th}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${u.tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `${customer} 매장 인테리어 견적서를 엑셀로 만들어서 고객에게 보낼 수 있게 해 줘. 품목은 설계비 · 인테리어 공사 · 가구 세 줄, 단가는 합리적으로.` }), signal: AbortSignal.timeout(AWAIT_MS) })
  assert.equal(r.status, 200, `send ${r.status}`)
  await r.text()
  await until(async () => (await q(`select 1 from pro_messages where thread_id=$1 and kind='file' and lower(content->>'name') like '%.xlsx' and created_at > $2`, [th, since]))[0], AWAIT_MS, '견적서 xlsx')
  const card = await until(async () => (await q(`select * from pro_messages where thread_id=$1 and kind='followup' and content->>'state'='pending' and created_at > $2 order by created_at desc limit 1`, [th, since]))[0], 60_000, '묻는 카드')
  return { th, card, since }
}
async function acceptAndRun(u, card, th) {
  const before = new Date()
  const r = await u.call('POST', `/followups/answer/${card.id}`, { choice: 'accept' })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  await until(async () => (await q(`select 1 from pro_messages where thread_id=$1 and role='agent' and kind in ('text','doc') and created_at > $2 and content ? 'event'`, [th, before]))[0], AWAIT_MS, '습관 실행')
}
const runs = {}
for (const [u, name, like] of [[jiho, '한지호', '합계 아래'], [doyun, '이도윤', '회사 직인 이미지']]) {
  await step(`${name}의 방법을 실제로 한 번: 견적서 → 내 습관을 묻는다 → 받아들임 → 에이전트가 함 → 걸린 시간`, async () => {
    const { th, card } = await quote(u, name === '한지호' ? '봄날 플라워' : '하늘 문구')
    assert.match(card.content.text, /직인|도장/, card.content.text)
    await acceptAndRun(u, card, th)
    const h = await habitOf(u, like)
    const way = await until(async () => (await q(`select * from pro_habit_shares where followup_id=$1 and runs > 0`, [h.id]))[0], 60_000, '걸린 시간 기록')
    runs[name] = way.minutes
    return { asked: card.content.text, minutes: Math.round(way.minutes * 10) / 10 }
  })
}

let skill
await step('가장 빠른 방법(받아들인 비율 0.6 이상 중) → 관리자가 「직인 넣기」의 스킬로', async () => {
  const ways = (await boss.call('GET', `/ontology/ways?task=${encodeURIComponent('직인 넣기')}`)).body
  const best = ways.find((w) => w.best)
  assert.ok(best, JSON.stringify(ways.map((w) => [w.name, w.minutes, w.taken])))
  const fastest = Object.entries(runs).sort((a, b) => a[1] - b[1])[0][0]
  assert.equal(best.name, fastest)
  assert.equal((await minji.call('POST', `/ontology/ways/${best.id}/skill`)).status, 403)
  const s = await boss.call('POST', `/ontology/ways/${best.id}/skill`)
  assert.equal(s.status, 200, JSON.stringify(s.body))
  skill = s.body.name
  const t = (await boss.call('GET', `/ontology/tasks/${encodeURIComponent('직인 넣기')}`)).body
  assert.ok(t.parsed.skills.includes(skill), JSON.stringify(t.parsed.skills))
  const m = (await boss.call('GET', '/ontology/map')).body
  assert.equal(m.ways.find((w) => w.key === best.id)?.status, 'skill')
  return { best: `${best.name} ${best.minutes}분 · 받아들임 ${Math.round(best.taken * 100)}%`, skill }
})

await step('정하나(같은 역할, 습관 없음): 견적서가 나오면 역할 루틴을 회사가 고른 방법으로 묻고, 받아들이면 그의 습관이 된다', async () => {
  const { th, card } = await quote(hana, '바다 서점')
  assert.equal(card.content.source, 'routine', JSON.stringify(card.content))
  assert.match(card.content.text, /같은 역할\(영업\).*직인 넣기.*3명/)
  assert.ok(card.content.routine.way?.name, '회사가 고른 방법')
  await acceptAndRun(hana, card, th)
  const mine = await until(async () => (await q(`select * from pro_followups where tenant_id='ax-demo' and user_id=$1 and event_cls='sheet'`, [hana.id]))[0], 30_000, '정하나의 습관')
  return { asked: card.content.text, habit: mine.action }
})

console.log(failed ? `\n${failed} failed` : '\nall passed')
fs.writeFileSync(new URL('../.scratch/ontology-roles.e2e.json', import.meta.url), JSON.stringify(out, null, 1))
await pool.end()
process.exit(failed ? 1 : 0)
