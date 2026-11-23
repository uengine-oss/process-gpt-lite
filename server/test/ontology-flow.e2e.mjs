// E2E 「병목 보기」(흐름 분석, lib/ontology/flowload.js): over HTTP against a running server + the real DB + Ontological.
// The source is the process map: its tasks and ways (the mining), the work items its cases left (todolist rows of the map engine —
// activity_id = the task's hash), and the mail · chat records. The seed (scripts/seed-flow-demo.mjs) puts six weeks of map-engine cases
// in ax-demo, engine-shaped; nothing on the map is changed.
//   S1 할 일 수 = 병목: the open items per task equal the todolist rows counted directly by activity_id; the bottleneck is our people's step
//      with the most (평면도 작성), not the agent's or the customer's
//   S2 흔한 길 = 크리티컬 패스: the usual way from the main start goes through the bottleneck, and it is the longest link for a case arriving now
//   S3 회사의 제약: the designer carries open items in two processes; the company's constraint is that role
//   S4 실시간: 김민지 hands in one 평면도 작성 from her 할 일 → the map engine opens the next step from the map → 평면도 −1, 제안서 작성 +1
//   S5 보기 권한 · 시점: someone else sees the counts but not the cases' subjects or who holds them; a past day counts the items open then
//
//   cd server && node scripts/seed-flow-demo.mjs && PRO_API=http://ax.localhost:8790 node test/ontology-flow.e2e.mjs [--keep]
// --keep: leave the hand-in (else the seed is written again at the end, so the screen starts from the same numbers)
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { q, pool } from '../lib/supa.js'
import { actId } from '../lib/ontology/run.js'

const API = process.env.PRO_API || 'http://ax.localhost:8790'
const T = 'ax-demo'
const PROC = 'process:79928ca715' // 요청 접수 · 견적 제안
const PROC_B = 'process:a3d73e0d85' // 계약서 제출 · 일정 조율
let failed = 0
const step = async (name, fn) => {
  try { const r = await fn(); console.log(`✓ ${name}`, JSON.stringify(r ?? '').slice(0, 300)) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
async function call(tok, method, path, body) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}`)
  return { id: j.user.id, tok: j.session.access_token }
}
const flow = async (tok, qs = '') => { const r = await call(tok, 'GET', `/ontology/flow${qs}`); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body }
// the open work items of a process's map cases, counted straight from todolist by activity_id
async function openByActivity(proc) {
  const rows = await q(`select t.activity_id, count(*)::int as n from pro_po_cases c join todolist t on t.proc_inst_id = any(c.instances)
                         where c.tenant_id=$1 and c.bundle=$2 and t.status::text in ('NEW','TODO','IN_PROGRESS','PENDING') and coalesce(t.activity_id,'') <> 'intake' group by 1`, [T, proc])
  return new Map(rows.map((r) => [r.activity_id, r.n]))
}

const [{ n: seeded }] = await q(`select count(*)::int as n from pro_po_cases where tenant_id=$1 and request->>'seed'='flow-demo'`, [T])
assert.ok(seeded > 20, '시드가 없어요 — node scripts/seed-flow-demo.mjs 먼저')
const boss = await signIn('pro-ax-jinyoung@uengine.org')
const minji = await signIn('pro-ax-minji@uengine.org')
const doyun = await signIn('pro-ax-doyun@uengine.org')
let A

await step('S1 할 일 수 = 병목: 일마다 열린 할 일이 todolist 를 activity_id 로 센 수와 같고, 가장 많은 사람 단계가 병목', async () => {
  A = await flow(boss.tok, `?proc=${encodeURIComponent(PROC)}`)
  const direct = await openByActivity(PROC)
  for (const t of A.tasks) assert.equal(t.wip, direct.get(actId(t.key)) || 0, `「${t.key}」 할 일 ${t.wip} ≠ todolist ${direct.get(actId(t.key)) || 0}`)
  const ours = A.tasks.filter((t) => !t.agent && !t.outside)
  const top = Math.max(...ours.map((t) => t.wip))
  assert.equal(A.bottleneck.key, '평면도 작성')
  assert.equal(A.bottleneck.wip, top)
  assert.equal(A.bottleneck.by, 'wip')
  assert.equal(A.bottleneck.role, '디자이너')
  // the agent's step (요청 메일 접수, done by the agent in minutes) is an agent stretch, not a candidate
  const intake = A.tasks.find((t) => t.key === '요청 메일 접수')
  assert.equal(intake.agent, true)
  assert.ok(A.agentSteps.some((a) => a.key === '요청 메일 접수' && a.run?.n > 10 && a.run.medH < 0.5), JSON.stringify(A.agentSteps))
  // time: the run records when there are five, else the records (추정)
  assert.equal(A.tasks.find((t) => t.key === '평면도 작성').time.grade, 'run')
  assert.equal(A.tasks.find((t) => t.key === '현장 방문').time.grade, 'mined')
  return { bottleneck: A.bottleneck.key, wip: A.bottleneck.wip, open: A.measured.openItems }
})

await step('S2 흔한 길 = 크리티컬 패스: 보통 건의 길이 병목을 지나고, 지금 들어오는 건에게 가장 긴 고리가 병목', async () => {
  const p = A.path
  const keys = p.steps.map((s) => s.key)
  assert.equal(keys[0], '요청 메일 접수')
  for (const k of ['현장 실측', '평면도 작성', '제안서 작성', '견적서 작성', '고객 회신']) assert.ok(keys.includes(k), `흔한 길에 「${k}」: ${keys.join(' → ')}`)
  assert.equal(p.bottOnPath, true)
  assert.equal(p.longest, '평면도 작성')
  assert.ok(p.nowH >= p.pastH, '지금 들어오면 지난 건보다 짧지 않다(줄이 섰으니)')
  const b = p.steps.find((s) => s.key === '평면도 작성')
  assert.ok(b.queued && b.extraH > 0, JSON.stringify(b))
  // where a case's time goes: the bottleneck's share is the largest
  const top = [...A.tasks].sort((x, y) => (y.share || 0) - (x.share || 0))[0]
  assert.equal(top.key, '평면도 작성')
  // the stretches between steps (records): the ways a case takes, the longest first
  assert.ok(A.ways.length >= 3 && A.ways[0].medH >= A.ways.at(-1).medH)
  return { path: keys.join('→'), pastH: p.pastH, nowH: p.nowH }
})

await step('S3 회사의 제약: 디자이너가 두 프로세스의 할 일을 함께 짊어져서 회사 전체의 제약이 된다', async () => {
  const B = await flow(boss.tok, `?proc=${encodeURIComponent(PROC_B)}`)
  assert.equal(B.bottleneck.key, '일정 조율', '계약 흐름만 보면 일정 조율')
  assert.equal(B.bottleneck.role, '디자이너')
  const all = await flow(boss.tok)
  assert.equal(all.constraint.key, '디자이너')
  const d = all.constraint.roles.find((r) => r.role === '디자이너')
  assert.ok(d.procs.length >= 2, JSON.stringify(d.procs))
  const sales = all.constraint.roles.find((r) => r.role === '영업')
  assert.ok(sales.members >= 4 && sales.perPerson < d.perPerson)
  assert.ok(!all.constraint.roles.some((r) => r.role === '고객'), '바깥 역할은 제약 후보가 아니다')
  const sum = all.tasks.filter((t) => t.role === '디자이너' && !t.agent).reduce((s, t) => s + t.wip, 0)
  assert.equal(d.wip, sum)
  return { constraint: all.constraint.key, perPerson: d.perPerson, procs: d.procs.map((p) => `${p.name}:${p.wip}`) }
})

await step('S4 실시간: 김민지가 할 일에서 평면도 작성을 내면 지도 엔진이 다음 단계를 열고, 할 일 수가 따라 움직인다', async () => {
  const before = await flow(boss.tok, `?proc=${encodeURIComponent(PROC)}`)
  const w = (x, k) => x.tasks.find((t) => t.key === k)?.wip || 0
  const [t] = await q(`select t.id::text as id, t.proc_inst_id from todolist t join pro_po_cases c on t.proc_inst_id = any(c.instances)
                       where c.tenant_id=$1 and c.bundle=$2 and t.activity_name='평면도 작성' and t.status='IN_PROGRESS' and t.user_id=$3 order by t.start_date limit 1`, [T, PROC, minji.id])
  assert.ok(t, '김민지의 열린 평면도 작성')
  const r = await call(minji.tok, 'POST', `/todos/${t.id}/submit`, { values: { result: '평면도 올렸어요' } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  const [next] = await q(`select activity_name, status::text as status from todolist where proc_inst_id=$1 and status::text not in ('DONE','CANCELLED')`, [t.proc_inst_id])
  assert.ok(next, '다음 단계가 열렸다')
  const after = await flow(boss.tok, `?proc=${encodeURIComponent(PROC)}`)
  assert.equal(w(after, '평면도 작성'), w(before, '평면도 작성') - 1)
  assert.equal(w(after, next.activity_name), w(before, next.activity_name) + 1)
  return { next: next.activity_name, plan: `${w(before, '평면도 작성')}→${w(after, '평면도 작성')}`, nextWip: `${w(before, next.activity_name)}→${w(after, next.activity_name)}` }
})

await step('S5 보기 권한 · 시점: 다른 사람은 숫자만(건 제목 · 맡은 사람 없음), 지난 날은 그때 열려 있던 것', async () => {
  const mine = await flow(boss.tok, `?proc=${encodeURIComponent(PROC)}`)
  assert.ok(mine.tasks.find((t) => t.key === '평면도 작성').open.some((o) => o.subject && o.who), '관리자에게는 건 제목 · 맡은 사람')
  const other = await flow(doyun.tok, `?proc=${encodeURIComponent(PROC)}`)
  assert.equal(other.admin, false)
  assert.equal(other.bottleneck.key, mine.bottleneck.key)
  assert.ok(other.tasks.every((t) => t.open.every((o) => !o.subject && !o.who)), '관리자가 아니면 건 제목 · 맡은 사람이 없다')
  const day = new Date(Date.now() - 28 * 86_400_000).toISOString()
  const past = await flow(boss.tok, `?proc=${encodeURIComponent(PROC)}&at=${encodeURIComponent(day)}`)
  assert.ok(past.measured.runItems < mine.measured.runItems, '4주 전에는 그 뒤에 생긴 할 일이 없다')
  assert.ok(past.tasks.find((t) => t.key === '평면도 작성').wip < mine.tasks.find((t) => t.key === '평면도 작성').wip, '요청이 늘기 전이라 덜 쌓였다')
  return { pastOpen: past.measured.openItems, nowOpen: mine.measured.openItems }
})

if (!process.argv.includes('--keep')) {
  const r = spawnSync(process.execPath, ['scripts/seed-flow-demo.mjs'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' })
  console.log(r.status === 0 ? '(시드를 다시 썼어요)' : `(시드 다시 쓰기 실패: ${r.stderr.slice(0, 200)})`)
}
await pool.end()
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과')
process.exit(failed ? 1 : 0)
