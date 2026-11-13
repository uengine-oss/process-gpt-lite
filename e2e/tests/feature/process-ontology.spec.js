// 프로세스 온톨로지 — 메일 이력 + 채팅 핸드오버 → Ontological 의 회사 프로세스 지도, 자동 값, 시점, 스냅샷 실행, 고정 · 은퇴.
// spec process-gpt openspec/specs/pgpt-pro_process-ontology (e2e/README.md 20절). 시나리오 전체(메일 읽기 · 에이전트 단계)는
// server/test/ontology-{map,run,review}.e2e.mjs, 판단 사례는 server/test/ontology-cases.json(server/test/ontology-stats.test.js).
// 데모 테넌트에서 돈다: PGPT_URL=http://ax.localhost:5191 API_URL=http://ax.localhost:8790 PGPT_TENANT=ax-demo, 지도가 셈해진 뒤
// (node server/scripts/ax-demo.mjs --reset --seed → ontology-map.e2e.mjs). 지도가 없으면 건너뛴다. 모델은 부르지 않는다.
import { test, expect } from '../../lib/fixtures.js'
import { hasServerSource, SERVER_DIR } from '../../lib/env.js'

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
