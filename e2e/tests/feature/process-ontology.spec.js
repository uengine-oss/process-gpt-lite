// 프로세스 온톨로지 — 메일 이력 + 채팅 핸드오버 → Ontological 의 회사 프로세스 지도, 자동 값, 시점, 스냅샷 실행, 고정 · 은퇴.
// spec process-gpt openspec/specs/pgpt-pro_process-ontology (e2e/README.md 20절). 시나리오 전체(메일 읽기 · 에이전트 단계)는
// server/test/ontology-{map,run,review}.e2e.mjs, 판단 사례는 server/test/ontology-cases.json(server/test/ontology-stats.test.js).
// 데모 테넌트에서 돈다: PGPT_URL=http://ax.localhost:5191 API_URL=http://ax.localhost:8790 PGPT_TENANT=ax-demo, 지도가 셈해진 뒤
// (node server/scripts/ax-demo.mjs --reset --seed → ontology-map.e2e.mjs). 지도가 없으면 건너뛴다. 모델은 부르지 않는다.
import { test, expect, RUN, api } from '../../lib/fixtures.js'
import { hasServerSource, SERVER_DIR, API_URL, LOGIN_CODE, TENANT } from '../../lib/env.js'
import { spawnSync } from 'node:child_process'

const nextMonthFirst = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10) }
async function mapOf(u) {
  const r = await u.get('/ontology/map')
  test.skip(r.status === 503 || !r.body?.tasks?.length, 'Ontological 이나 셈한 지도가 없다(데모 테넌트에서 돌린다)')
  return r.body
}
const admin = async (db, c, cleanup) => { await db.q('update users set is_admin=true where id=$1', [c.id]); cleanup(() => db.q('update users set is_admin=false where id=$1', [c.id])); return c }

test('F-PO-01 지도 — 일 · 관계 · 프로세스과 자동 값(θ · 반감기 · 띠)이 근거와 함께', async ({ as }) => {
  const u = await as('po-user')
  const m = await mapOf(u)
  expect(m.edges.length).toBeGreaterThan(m.tasks.length - 1)
  for (const b of m.processes.filter((p) => p.kind !== 'routine')) {
    expect([0, 0.01, 0.02, 0.05, 0.1, 0.2]).toContain(b.theta)
    expect([14, 30, 60, 90, 180]).toContain(b.half_life)
    expect(['paved', 'open', 'watch']).toContain(b.band)
    expect(b.curve.length).toBe(6)
    if (b.band === 'paved') expect(b.a1).toBeGreaterThanOrEqual(0.5)
  }
  const src = m.meta.sources
  expect(src.mail_history).toBeGreaterThan(0)
  expect(src.chat_handover).toBeGreaterThan(0)
})

test('F-PO-02 배운 조건 · 드문 경로 · 은퇴 후보', async ({ as }) => {
  const m = await mapOf(await as('po-user'))
  const fin = m.edges.find((e) => e.from === '견적서 작성' && e.to === '재무 검토')
  expect(fin?.cond).toMatch(/10,000,000원 이상/)
  expect(fin.cond_cases.loo).toBeGreaterThan(fin.cond_cases.baseline)
  const legal = m.edges.find((e) => e.from === '견적서 작성' && e.to === '법무 검토')
  if (legal) { expect(legal.p).toBeLessThan(0.05); expect(legal.stale).toBe(false) }
  const bypass = m.edges.find((e) => /요청/.test(e.from) && e.to === '평면도 작성')
  expect(bypass?.stale).toBe(true)
  // 주 경로는 은퇴 후보가 아니다(끝나지 않은 최근 건 때문에 걸리면 안 된다)
  const main = m.edges.filter((e) => e.to !== '__end__' && e.p >= 0.5)
  expect(main.filter((e) => e.stale)).toEqual([])
})

test('F-PO-03 시점 고르기 — 9월 1일의 지도', async ({ as }) => {
  const u = await as('po-user')
  const now = await mapOf(u)
  const then = (await u.get('/ontology/map?at=2026-09-01')).body
  const b = then.edges.find((e) => /요청/.test(e.from) && e.to === '평면도 작성')
  expect(b?.stale).toBe(false)
  expect(b.p).toBeGreaterThan(now.edges.find((e) => e.from === b.from && e.to === b.to).p)
})

test('F-PO-04 스냅샷 — 같은 키는 같은 정의를 다시 쓴다, 맨 앞은 요청 접수', async ({ as, db }) => {
  const u = await as('po-user')
  const m = await mapOf(u)
  const A = m.processes.find((b) => b.tasks.includes('견적서 작성'))
  const qs = `proc=${encodeURIComponent(A.key)}&entry=${encodeURIComponent('견적서 작성')}`
  const one = (await u.get(`/ontology/snapshot?${qs}`)).body
  const two = (await u.get(`/ontology/snapshot?${qs}`)).body
  expect(two.procDefId).toBe(one.procDefId)
  expect(two.reused).toBe(true)
  expect(one.skipped.length).toBeGreaterThan(0)
  const [d] = await db.q('select definition from proc_def where id=$1', [one.procDefId])
  expect(d.definition.activities[0].name).toBe('요청 접수')
  // the steps before the start are skipped, not in the definition (their names are the model's: 현장 실측 or 현장 확인)
  for (const k of one.skipped) expect(d.definition.activities.map((a) => a.name)).not.toContain(k)
})

test('F-PO-05 앞날짜 고정 — 그날 뒤 스냅샷에만 재무 검토가 반드시, 결정 원장, 관리자만', async ({ as, db, cleanup }) => {
  const u = await as('po-user')
  const m = await mapOf(u)
  const A = m.processes.find((b) => b.tasks.includes('견적서 작성'))
  const day = nextMonthFirst()
  expect((await u.post(`/ontology/tasks/${encodeURIComponent('재무 검토')}/pin`, { validFrom: day })).status).toBe(403)
  const a = await admin(db, await as('po-admin'), cleanup)
  const r = await a.post(`/ontology/tasks/${encodeURIComponent('재무 검토')}/pin`, { validFrom: day, reason: '회귀 시험' })
  expect(r.status, r.text).toBe(200)
  cleanup(() => a.post(`/ontology/tasks/${encodeURIComponent('재무 검토')}/pin`, { pinned: false, validFrom: day, reason: '회귀 시험 정리' }))
  const outs = async (at) => {
    const s = (await a.get(`/ontology/snapshot?proc=${encodeURIComponent(A.key)}&entry=${encodeURIComponent('견적서 작성')}${at ? `&at=${at}T12:00:00Z` : ''}`)).body
    const [d] = await db.q('select definition from proc_def where id=$1', [s.procDefId])
    // the ways out of the quote: straight to an activity, or through the gateway right after it
    const D = d.definition, gw = new Set((D.gateways || []).map((g) => g.id))
    const id = D.activities.find((x) => x.name === '견적서 작성').id
    const first = D.sequences.filter((x) => x.source === id).map((x) => x.target)
    const via = first.filter((t) => gw.has(t))
    return [...first.filter((t) => !gw.has(t)), ...D.sequences.filter((x) => via.includes(x.source)).map((x) => x.target)].map((t) => D.activities.find((y) => y.id === t)?.name || t)
  }
  expect(await outs('')).toEqual(expect.arrayContaining(['재무 검토', '고객 회신']))
  const later = await outs(day)
  expect(later).toContain('재무 검토')
  expect(later).not.toContain('고객 회신')
  const led = await db.q(`select action_kind, subject from pro_policy_decisions where tenant_id=$1 and action_kind='ontology.pin' and user_id=$2 order by created_at desc limit 1`, [db.tenant, a.id])
  expect(led[0]?.subject).toMatch(/재무 검토/)
})

test('F-PO-06 검토 안건 — 은퇴 후보는 근거 숫자와 함께, 은퇴는 관리자만', async ({ as }) => {
  const u = await as('po-user')
  await mapOf(u)
  const a = (await u.get('/ontology/review')).body
  const item = a.items.find((x) => x.kind === 'retire' && x.to === '평면도 작성')
  expect(item?.expected).toBeGreaterThan(3)
  expect(item.text).toMatch(/0건/)
  expect((await u.post('/ontology/edges', { from: item.from, to: item.to, status: 'retired' })).status).toBe(403)
})

test('F-PO-07 일 정의 — SKILL.md 형식을 읽고 쓰기가 되돌아온다', async () => {
  test.skip(!hasServerSource(), 'server source not next to the suite')
  const { parseDefinition, toDefinition, taskDefinition } = await import(`${SERVER_DIR}/lib/ontology/taskdef.js`)
  const md = toDefinition({ name: '견적서 작성', kind: 'task', runner: 'agent', skills: ['xlsx', 'quote-check'], outputs: [{ name: '견적서', format: 'xlsx', template: '견적서_양식.xlsx' }],
    checkpoints: ['품목 · 수량 · 단가 · 금액 칸이 모두 채워져 있다', '부가세 별도 여부: 적혀 있다'], autonomy: 'draft' }, '## 하는 일\n1. 견적을 낸다.')
  const { front, body } = parseDefinition(md)
  expect(front.skills).toEqual(['xlsx', 'quote-check'])
  expect(front.outputs[0]).toEqual({ name: '견적서', format: 'xlsx', template: '견적서_양식.xlsx' })
  expect(front.checkpoints[1]).toBe('부가세 별도 여부: 적혀 있다')
  expect(body).toMatch(/하는 일/)
  const d = await taskDefinition('견적서 작성', { definition_md: md })
  expect(d).toMatchObject({ runner: 'agent', skills: ['xlsx', 'quote-check'], autonomy: 'draft' })
  expect((await taskDefinition('x', {})).runner).toBe('person')
})

test('F-PO-08 화면 — 지도 · θ · 값 보기 · 검토 안건 · 스냅샷이 오류 없이', async ({ pageAs }) => {
  const page = await pageAs('po-user')
  const r = await page.user.get('/ontology/map')
  test.skip(!r.body?.tasks?.length, '셈한 지도가 없다')
  await page.goto('/process-map')
  await expect(page.getByRole('heading', { name: '회사 프로세스 지도' })).toBeVisible()
  const nodes = page.locator('svg g.node, svg [data-task]')
  await expect.poll(async () => nodes.count(), { timeout: 15000 }).toBeGreaterThan(2)
  await page.getByRole('button', { name: '값 보기' }).click()
  await expect(page.getByText('입도 θ').first()).toBeVisible()
  await page.getByRole('button', { name: '검토 안건' }).click()
  // (the map's edge tooltips also say 은퇴 후보, in hidden <title>s — look in the agenda itself)
  await expect(page.getByTestId('onto-review-item').first()).toContainText(/0건/, { timeout: 15000 })
  await page.getByRole('button', { name: '스냅샷 보기' }).click()
  await expect(page.locator('.djs-container, .bjs-container').first()).toBeVisible({ timeout: 60000 })
  expect(page.errors).toEqual([])
})

// ---- v0.3 (design-v0.3): 사건 · 프로세스 소속 · 역할 · 역할 루틴과 그 설정 · 일의 방법

test('F-PO-09 사건과 소속 — 요청 메일이 첫 일을, 결과물이 다음 일을 일으키고, 한 일이 여러 프로세스에', async ({ as }) => {
  const m = await mapOf(await as('po-user'))
  expect(m.events.some((e) => e.key === 'mail')).toBe(true)
  const art = m.events.find((e) => e.kind === 'artifact' && e.key.startsWith('artifact:견적서 작성:'))
  expect(art?.n).toBeGreaterThan(0)
  expect(m.triggers.some((t) => t.from === 'mail' && t.source === 'mined')).toBe(true)
  expect(m.raises.some((r) => r.from === '견적서 작성' && r.to === art.key)).toBe(true)
  for (const t of m.triggers.filter((x) => x.split)) expect(['xor', 'and']).toContain(t.split)
  expect(m.tasks.some((t) => (t.procs || []).length > 1)).toBe(true)
})

test('F-PO-10 역할 — 사람 · 에이전트 · 지표, 보기는 누구나, 정의 초안은 관리자만', async ({ as }) => {
  const u = await as('po-user')
  const m = await mapOf(u)
  const role = m.roles.find((r) => !r.outside && r.members > 0)
  expect(role).toBeTruthy()
  const v = (await u.get(`/ontology/roles/${encodeURIComponent(role.key)}`)).body
  expect(v.performers.length).toBeGreaterThan(0)
  expect(typeof v.role.agent_share).toBe('number')
  expect((await u.post(`/ontology/roles/${encodeURIComponent(role.key)}/draft`, {})).status).toBe(403)
})

test('F-PO-11 개인 습관을 지도에 보이는 설정 — 관리자만 바꾸고, 지도에는 역할 · 일 · 사람 수만', async ({ as, db, cleanup }) => {
  const u = await as('po-user')
  const m = await mapOf(u)
  expect((await u.put('/ontology/settings', { mode: 'all', min: 3 })).status).toBe(403)
  const a = await admin(db, await as('po-admin'), cleanup)
  const was = (await a.get('/ontology/settings')).body
  cleanup(() => a.put('/ontology/settings', was))
  expect((await a.put('/ontology/settings', { mode: 'off', min: 3 })).status).toBe(200)
  const off = (await a.get('/ontology/map')).body
  expect(off.triggers.filter((t) => ['habit', 'told', 'rule'].includes(t.source))).toEqual([])
  expect(off.processes.filter((p) => p.kind === 'routine')).toEqual([])
  for (const t of m.triggers.filter((x) => x.source === 'habit')) { expect(t.scope).toMatch(/^role:/); expect(typeof t.people).toBe('number') }
  expect(JSON.stringify(m)).not.toMatch(/user_id|followup/)
})

test('F-PO-12 일의 방법 — 목표마다 공유한 방법, 남의 습관은 공유할 수 없고, 스킬은 관리자만', async ({ as }) => {
  const u = await as('po-user')
  await mapOf(u)
  const ways = (await u.get('/ontology/ways')).body
  expect(Array.isArray(ways)).toBe(true)
  for (const w of ways) { expect(w.task).toBeTruthy(); expect(typeof w.best).toBe('boolean') }
  expect((await u.post('/ontology/ways/answer', { followupId: '00000000-0000-0000-0000-000000000000', answer: 'shared' })).status).toBe(404)
  if (ways[0]) expect((await u.post(`/ontology/ways/${ways[0].id}/skill`, {})).status).toBe(403)
})

// ---- v0.3 §12 · §13: 승격 단계(관찰 · 제안 · 자동)와 타이머 사건 — 메일 · 채팅 제안과 실제 시작은 server/test/ontology-triggers.e2e.mjs

test('F-PO-13 승격 단계 — 관찰 · 제안 · 자동은 관리자만 바꾸고, 바꾸면 결정 원장에', async ({ as, db, cleanup }) => {
  const u = await as('po-user')
  const m = await mapOf(u)
  const p = m.processes.find((x) => x.kind !== 'routine')
  expect(['paused', 'suggested', 'adopted']).toContain(p.status)
  expect((await u.post('/ontology/processes/status', { key: p.key, status: 'suggested' })).status).toBe(403)
  const a = await admin(db, await as('po-admin'), cleanup)
  cleanup(() => a.post('/ontology/processes/status', { key: p.key, status: p.status }))
  const since = new Date()
  const next = p.status === 'suggested' ? 'paused' : 'suggested'
  expect((await a.post('/ontology/processes/status', { key: p.key, status: next })).status).toBe(200)
  const [l] = await db.q(`select action_kind from pro_policy_decisions where action_kind like 'ontology.%mote' and created_at >= $1 order by created_at desc`, [since])
  expect(l?.action_kind).toBe('ontology.demote')
  expect((await a.get('/ontology/map')).body.processes.find((x) => x.key === p.key).status).toBe(next)
  expect((await a.post('/ontology/processes/status', { key: p.key, status: 'bogus' })).status).toBe(400)
})

test('F-PO-14 타이머 — 회사 타이머는 관리자만 걸고 프로세스의 시작 사건이 되며, 멈추고 지우면 예약도 따라간다', async ({ as, db, cleanup }) => {
  const u = await as('po-user')
  const m = await mapOf(u)
  const p = m.processes.find((x) => x.kind !== 'routine')
  expect((await u.post('/ontology/timers', { proc: p.key, cron: '0 9 1 * *' })).status).toBe(403)
  const a = await admin(db, await as('po-admin'), cleanup)
  expect((await a.post('/ontology/timers', { proc: p.key, entry: '없는 일', cron: '0 9 1 * *' })).status).toBe(400)
  const r = await a.post('/ontology/timers', { proc: p.key, cron: '0 9 1 * *' })
  expect(r.status).toBe(200)
  cleanup(() => a.put(`/ontology/timers/${encodeURIComponent(r.body.key)}`, { status: 'gone' }))
  expect(r.body.when).toBe('매월 1일 9시')
  const m2 = (await a.get('/ontology/map')).body
  expect(m2.startsOn.some((s) => s.from === p.key && s.to === r.body.key)).toBe(true)
  expect(m2.events.find((e) => e.key === r.body.key)).toMatchObject({ kind: 'timer', cron: '0 9 1 * *', scope: 'company', status: 'active' })
  expect((await a.put(`/ontology/timers/${encodeURIComponent(r.body.key)}`, { status: 'paused' })).status).toBe(200)
  expect((await db.q('select paused from pro_schedules where id=$1', [r.body.scheduleId]))[0].paused).toBe(true)
  expect((await a.put(`/ontology/timers/${encodeURIComponent(r.body.key)}`, { status: 'gone' })).status).toBe(200)
  expect((await db.q('select id from pro_schedules where id=$1', [r.body.scheduleId])).length).toBe(0)
  // 사람의 예약은 공개 기준을 넘은 루틴 단계와 함께만 지도에 보인다
  for (const e of m2.events.filter((x) => x.kind === 'timer' && x.scope !== 'company')) expect(m2.triggers.some((t) => t.from === e.key)).toBe(true)
})

test('F-PO-15 화면 — 승격 단계 · 타이머 · 사건 보기', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('po-admin')
  await db.q('update users set is_admin=true where id=$1', [page.user.id]); cleanup(() => db.q('update users set is_admin=false where id=$1', [page.user.id]))
  const r = await page.user.get('/ontology/map')
  test.skip(!r.body?.tasks?.length, '셈한 지도가 없다')
  const p = r.body.processes.find((x) => x.kind !== 'routine')
  await page.goto(`/process-map?proc=${encodeURIComponent(p.key)}`)
  await expect(page.getByTestId('onto-ladder')).toHaveAttribute('data-status', p.status, { timeout: 15000 })
  await expect(page.getByTestId(`onto-ladder-${p.status}`)).toBeDisabled()
  await page.getByTestId('onto-timer-button').click()
  await expect(page.getByTestId('onto-timer-panel')).toBeVisible()
  await expect(page.getByTestId('onto-timer-cron')).toBeVisible()
  expect(page.errors).toEqual([])
})

// 병목 보기(server lib/ontology/flowload.js · flowtime.js): 원천은 지도 — 지도 엔진 · 스냅샷 건의 todolist 행을 일(activity_id)마다 센 할 일,
// 지도의 길(θ), 메일 · 대화 기록의 응답 시간. 시나리오(시드 · 실시간 내기 · 시점)는 server/test/ontology-flow.e2e.mjs,
// 셈은 server/test/ontology-flowtime.test.js. 시드(node server/scripts/seed-flow-demo.mjs)가 없어도 돈다(할 일 0이면 기록으로 추정).
const actId = async (task) => { const { createHash } = await import('node:crypto'); return `t_${createHash('sha1').update(String(task)).digest('hex').slice(0, 10)}` }
test('F-PO-16 병목 보기 — 일마다 할 일 = todolist 를 activity_id 로 센 수, 병목은 우리 쪽 사람 단계, 제약은 역할로, 건 제목은 관리자만', async ({ as, db }) => {
  const u = await as('po-user')
  const m = await mapOf(u)
  const p = m.processes.filter((x) => x.kind !== 'routine' && (x.tasks || []).length > 2).sort((a, b) => (b.cases || 0) - (a.cases || 0))[0]
  test.skip(!p, '흐름이 있는 프로세스가 없다')
  const r = await u.get(`/ontology/flow?proc=${encodeURIComponent(p.key)}`)
  expect(r.status).toBe(200)
  const f = r.body
  const rows = await db.q(`select t.activity_id, count(*)::int as n from pro_po_cases c join todolist t on t.proc_inst_id = any(c.instances)
                            where c.tenant_id=$1 and c.bundle=$2 and t.status::text in ('NEW','TODO','IN_PROGRESS','PENDING') and coalesce(t.activity_id,'') <> 'intake' group by 1`, [process.env.PGPT_TENANT || 'ax-demo', p.key])
  const direct = new Map(rows.map((x) => [x.activity_id, x.n]))
  for (const t of f.tasks) expect(t.wip, t.key).toBe(direct.get(await actId(t.key)) || 0)
  if (f.bottleneck?.by === 'wip') {
    const ours = f.tasks.filter((t) => !t.agent && !t.outside)
    expect(f.bottleneck.wip).toBe(Math.max(...ours.map((t) => t.wip)))
    expect(f.tasks.find((t) => t.key === f.bottleneck.key).outside).toBe(false)
  }
  expect(f.path.steps.length).toBeGreaterThan(1)
  expect(p.entries).toContain(f.path.steps[0].key)
  expect(f.path.nowH).toBeGreaterThanOrEqual(f.path.pastH)
  const outside = new Set((m.roles || []).filter((r2) => r2.outside).map((r2) => r2.key))
  expect(f.constraint.roles.some((r2) => outside.has(r2.role))).toBe(false)
  // 관리자가 아니면 열린 할 일의 건 제목 · 맡은 사람이 없다
  expect(f.admin).toBe(false)
  expect(f.tasks.every((t) => t.open.every((o) => !o.subject && !o.who))).toBe(true)
})

test('F-PO-17 화면 — 병목 보기: 패널(병목 · 회사의 제약 · 흔한 길) · 지도에 꼬리표와 범례', async ({ pageAs }) => {
  const page = await pageAs('po-user')
  const r = await page.user.get('/ontology/map')
  test.skip(!r.body?.tasks?.length, '셈한 지도가 없다')
  const p = r.body.processes.filter((x) => x.kind !== 'routine' && (x.tasks || []).length > 2).sort((a, b) => (b.cases || 0) - (a.cases || 0))[0]
  await page.goto(`/process-map?proc=${encodeURIComponent(p.key)}`)
  await page.getByTestId('onto-flow-button').click()
  await expect(page.getByTestId('onto-flow')).toBeVisible({ timeout: 20000 })
  await expect(page.getByTestId('onto-flow-legend')).toBeVisible()
  await expect(page.getByTestId('onto-flow-path')).toBeVisible()
  const f = (await page.user.get(`/ontology/flow?proc=${encodeURIComponent(p.key)}`)).body
  if (f.bottleneck) {
    await expect(page.getByTestId('onto-flow-bottleneck')).toHaveAttribute('data-task', f.bottleneck.key)
    if (f.bottleneck.wip) await expect(page.locator('[data-testid=onto-flow-badge][data-kind=bott]')).toHaveCount(1)
  }
  // 닫으면 지도의 칠 · 꼬리표가 사라진다
  await page.getByTestId('onto-flow-button').click()
  await expect(page.getByTestId('onto-flow-badge')).toHaveCount(0)
  expect(page.errors).toEqual([])
})

// 건 화면에서 내 단계 내기(server lib/ontology/runmode.js runView 의 mine → OntoCaseRun 의 TodoCard): 시드(seed-flow-demo.mjs)가 데모 출연진
// 김민지(pro-ax-minji, 디자이너)에게 맡긴 열린 평면도 작성을 그 사람으로 연다 — 회귀 계정(pro-rt-*)이 아니라 시드가 단계를 맡긴 출연진이라
// 데모 테넌트(ax-demo)에서만 돈다. HTTP 쪽(길 · mine · 남에게는 아님 · 내기)은 server/test/ontology-case-submit.e2e.mjs. 끝나면 시드를 다시 쓴다.
const CAST = /^pro-ax-[a-z]+@uengine\.org$/
async function castPage(browser, email) {
  if (!CAST.test(email)) throw new Error(`데모 출연진 계정만 열어요: ${email}`)
  const r = await fetch(`${API_URL}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: LOGIN_CODE }) })
  const s = await r.json()
  if (!s?.session?.access_token) throw new Error(`로그인 ${email}: ${r.status}`)
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: 'ko-KR' })
  await ctx.addInitScript((x) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', x) }, JSON.stringify(s))
  const page = await ctx.newPage()
  page.errors = []
  page.on('pageerror', (e) => page.errors.push(String(e?.message || e)))
  page.user = api.client(s)
  return page
}
const reseedFlow = () => {
  const r = spawnSync(process.execPath, ['scripts/seed-flow-demo.mjs'], { cwd: SERVER_DIR, encoding: 'utf8' })
  if (r.status) console.warn('[seed-flow-demo]', String(r.stderr || '').slice(0, 200))
}
test('F-PO-18 화면 — 건 화면에서 내 단계 내기: 김민지가 프로세스 목록에서 건을 열면 자기 단계(평면도 작성)의 양식이 있고, 내면 지도 엔진이 다음 단계(제안서 작성)를 연다', async ({ browser, db, cleanup }) => {
  test.skip(TENANT !== 'ax-demo', '데모 테넌트(ax-demo)의 시드 자료로 돈다')
  const [{ n }] = await db.q(`select count(*)::int as n from pro_po_cases where tenant_id=$1 and request->>'seed'='flow-demo'`, [TENANT])
  test.skip(n < 20, '시드가 없다(node server/scripts/seed-flow-demo.mjs)')
  if (hasServerSource()) cleanup(reseedFlow)
  const page = await castPage(browser, 'pro-ax-minji@uengine.org')
  cleanup(() => page.context().close())
  // her open step of a map case — 평면도 작성 when she has one (a decided 개선안 that added a designer can leave her only 현장 실측) — whose
  // case is in her 프로세스 list (the list shows her newest 30, the ones waiting on her first)
  const listed = new Set(((await page.user.get('/instances')).body || []).map((i) => i.proc_inst_id))
  const open = await db.q(`select t.id::text as id, t.proc_inst_id, t.activity_name as task, c.id::text as case_id from todolist t join pro_po_cases c on t.proc_inst_id = any(c.instances)
                           where c.tenant_id=$1 and c.engine='map' and t.status='IN_PROGRESS' and coalesce(t.agent_orch,'')='' and t.user_id like '%'||$2||'%'
                           order by (t.activity_name='평면도 작성') desc, t.start_date`, [TENANT, page.user.id])
  const T0 = open.find((t) => listed.has(t.proc_inst_id))
  test.skip(!T0, '김민지의 열린 단계가 없다')

  // 프로젝트 › 프로세스: the case (지도에서 바로 · 입력 필요) opens its case screen on the map; the routine screen links only the map
  await page.goto('/projects')
  await expect(page.getByRole('link', { name: '프로세스 지도 →' })).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('link', { name: '개선 분석 →' })).toHaveCount(0)
  await page.locator(`[data-testid=instance-map-case][data-inst="${T0.proc_inst_id}"]`).click()
  await expect.poll(() => new URL(page.url()).searchParams.get('case'), { timeout: 15000 }).toBe(T0.case_id)
  expect(new URL(page.url()).pathname).toBe('/process-map')
  const mine = page.locator(`[data-testid=onto-case-step][data-todo="${T0.id}"]`)
  await expect(mine).toHaveAttribute('data-state', 'person', { timeout: 20000 })
  await expect(mine).toHaveAttribute('data-mine', '1')
  // only her step carries the form
  await expect(page.getByTestId('onto-case-todo')).toHaveCount(1)
  const card = mine.getByTestId('onto-case-todo')
  await expect(card).toHaveAttribute('data-todo', T0.id)
  await card.locator('textarea').fill(`${T0.task} 했어요(F-PO-18, 건 화면에서)`)
  await page.screenshot({ path: test.info().outputPath('f-po-18-form.png') })
  await card.getByRole('button', { name: '제출' }).click()

  // handed in: the step is done, the map engine opened the map's next step (after 평면도 작성: 제안서 작성) and the case screen shows it
  await expect(mine).toHaveAttribute('data-state', 'done', { timeout: 20000 })
  await expect(mine.getByTestId('onto-case-todo')).toHaveCount(0)
  await expect(page.getByTestId('onto-case-note')).toContainText('냈어요')
  const [next] = await db.q(`select t.id::text as id, t.activity_name from pro_case_steps s join todolist t on t.id = s.todo_id where s.case_id=$1 and s.via->>'fromTodo' = $2`, [T0.case_id, T0.id])
  expect(next, '지도 엔진이 다음 단계를 열었다').toBeTruthy()
  if (T0.task === '평면도 작성') expect(next.activity_name).toBe('제안서 작성')
  await expect(page.locator(`[data-testid=onto-case-step][data-todo="${next.id}"]`)).toHaveAttribute('data-task', next.activity_name, { timeout: 20000 })
  await page.screenshot({ path: test.info().outputPath('f-po-18-next.png') })
  // the instance's address (/projects/p/<instId>) lands on the same case screen
  await page.goto(`/projects/p/${encodeURIComponent(T0.proc_inst_id)}`)
  await expect.poll(() => new URL(page.url()).searchParams.get('case'), { timeout: 15000 }).toBe(T0.case_id)
  expect(page.errors).toEqual([])
})

// 개선 분석은 지도로 합쳤다(pgpt-pro/docs/auto-ax-onboarding/design-improve-on-map.md §7 · 결정 4 — src/main.js 의 넘기기, server routes/improve.js
// GET /improve/:defId/map): /improve 는 지도의 병목 보기로, 지도 프로세스의 스냅샷 정의는 그 프로세스의 병목 보기로, 지도에 없는 정의(손으로 그린 ·
// 생성한 프로세스)는 옛 개선 화면 그대로(그 회귀는 improve.spec.js F-IM-*). 알림의 /improve/… 주소와 인스턴스 머리글의 링크도 같은 넘기기를 지난다.
test('F-PO-19 /improve 넘기기 — 목록은 지도의 병목 보기로, 지도 프로세스의 스냅샷 정의는 그 프로세스로, 지도에 없는 정의는 옛 개선 화면 그대로', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('po-user')
  const m = await mapOf(page.user)
  const A = m.processes.find((b) => b.kind !== 'routine' && b.tasks.includes('견적서 작성'))
  test.skip(!A, '견적서 작성이 있는 프로세스가 없다')
  const snap = (await page.user.get(`/ontology/snapshot?proc=${encodeURIComponent(A.key)}&entry=${encodeURIComponent('견적서 작성')}`)).body
  expect(snap.procDefId).toBeTruthy()
  expect((await page.user.get(`/improve/${encodeURIComponent(snap.procDefId)}/map`)).body).toMatchObject({ proc: A.key })
  // a definition that is not on the map (drawn by hand / generated)
  const DEF = `rt_po_improve_${RUN}`.toLowerCase()
  await db.q(`insert into proc_def (id, name, definition, type, tenant_id, owner, isdeleted) values ($1,$2,$3,'bpmn',$4,$5,false)`,
    [DEF, `회귀 정의 ${RUN}`, { processDefinitionId: DEF, processDefinitionName: `회귀 정의 ${RUN}`, activities: [], sequences: [], gateways: [], roles: [] }, db.tenant, page.user.id])
  cleanup(() => db.q('delete from proc_def where id=$1', [DEF]))
  expect((await page.user.get(`/improve/${DEF}/map`)).body).toEqual({ proc: null })
  // where the page is: path · view (· proc) — the map may add the process it opens to the address (?proc=) once it has loaded
  const at = (withProc) => () => { const u = new URL(page.url()); return `${u.pathname}?view=${u.searchParams.get('view')}${withProc ? `&proc=${u.searchParams.get('proc')}` : ''}` }

  // the list → the map's 병목 보기
  await page.goto('/improve')
  await expect.poll(at(false), { timeout: 15000 }).toBe('/process-map?view=flow')
  // a snapshot of a map process (the instance header's 「병목 · 크리티컬 패스 보기」 and a notice's address look like this) → that process
  await page.goto(`/improve/${encodeURIComponent(snap.procDefId)}?tab=path`)
  await expect.poll(at(true), { timeout: 15000 }).toBe(`/process-map?view=flow&proc=${A.key}`)
  // not on the map: the old improve screen, unchanged — and its 「프로세스 개선」(back to the list) goes to the map, in the app
  await page.goto(`/improve/${DEF}`)
  await expect(page.getByRole('button', { name: '프로세스 개선' })).toBeVisible({ timeout: 15000 })
  expect(new URL(page.url()).pathname).toBe(`/improve/${DEF}`)
  await page.getByRole('button', { name: '프로세스 개선' }).click()
  await expect.poll(at(false), { timeout: 15000 }).toBe('/process-map?view=flow')
  expect(page.errors).toEqual([])
})
