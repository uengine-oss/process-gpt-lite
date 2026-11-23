// 회귀: 고쳐 보기 · 개선안 · 시행 전후(server lib/ontology/flowplan.js · improveplans.js, 설계 docs/auto-ax-onboarding/design-improve-on-map.md §5).
// 데모 테넌트(ax-demo)의 흐름 시드(server/scripts/seed-flow-demo.mjs — 디자이너 혼자 평면도 작성을 짊어진 6주)로 돈다. 끝나면 이 시험이 만든 안 ·
// 고침 · 역할에 넣은 사람 · 의견을 지운다. HTTP 쪽 전체 흐름(합의 · 상충 · 일마다 초안 · 시행 전후)은 server/test/ontology-improve.e2e.mjs.
import { test, expect } from '../../lib/fixtures.js'
import { TENANT } from '../../lib/env.js'

const PROC_NAME = '요청 접수 · 견적 제안'
async function procOf(u) {
  test.skip(TENANT !== 'ax-demo', '데모 테넌트(ax-demo)의 흐름 시드로 돈다')
  const r = await u.get('/ontology/map')
  test.skip(r.status === 503 || !r.body?.tasks?.length, '셈한 지도가 없다')
  const p = r.body.processes.find((x) => x.name === PROC_NAME)
  test.skip(!p, `「${PROC_NAME}」 프로세스가 없다`)
  const f = (await u.get(`/ontology/flow?proc=${encodeURIComponent(p.key)}`)).body
  test.skip(!f?.bottleneck || f.bottleneck.by !== 'wip', '쌓인 할 일이 없다(시드 — node server/scripts/seed-flow-demo.mjs --plans)')
  return { key: p.key, flow: f }
}
// what a plan left: its corrections (batch), the people it put in roles, its opinions, the plan
const undoPlan = (db, id) => async () => {
  const [p] = await db.q(`select batch::text as batch, members_added, opinion_id::text as opinion_id, proc_key from pro_improve_plans where id::text=$1`, [id])
  if (!p) return
  if (p.batch) await db.q(`delete from pro_corrections where tenant_id=$1 and batch::text=$2`, [TENANT, p.batch])
  for (const m of p.members_added || []) await db.q(`delete from pro_role_members where tenant_id=$1 and role=$2 and user_id::text=$3`, [TENANT, m.role, m.userId])
  if (p.opinion_id) {
    const [o] = await db.q(`select ops_key from pro_map_opinions where id::text=$1`, [p.opinion_id])
    if (o) await db.q(`delete from pro_map_opinions where tenant_id=$1 and proc_key=$2 and ops_key=$3`, [TENANT, p.proc_key, o.ops_key])
  }
  await db.q(`delete from pro_improve_plans where id::text=$1`, [id])
}

test('F-PO-20 고쳐 보기 · 개선안 — 고쳐 보기는 아무것도 쓰지 않고, 안은 앞 · 뒤를 지니며, 정하기는 관리자만 · 정하면 고침과 사람이 들어간다', async ({ as, db, cleanup }) => {
  const u = await as('po-user')
  const { key, flow } = await procOf(u)
  const b = flow.bottleneck
  const count = async () => (await db.q(`select (select count(*) from pro_corrections where tenant_id=$1 and proc_key=$2)::int as c, (select count(*) from pro_improve_plans where tenant_id=$1)::int as p`, [TENANT, key]))[0]
  const c0 = await count()
  const w = await u.post('/ontology/flow/whatif', { proc: key, levers: [{ type: 'draft', task: b.key, save: 0.5 }, { type: 'capacity', role: b.role, n: 1 }] })
  expect(w.status).toBe(200)
  expect(w.body.before.bottleneck.key).toBe(b.key)
  expect(w.body.before.nowH).toBe(flow.path.nowH)
  expect(w.body.after.nowH).toBeLessThan(w.body.before.nowH)
  const r0 = w.body.before.roles.find((r) => r.role === b.role), r1 = w.body.after.roles.find((r) => r.role === b.role)
  expect(r1.members).toBe(r0.members + 1)
  expect(r1.rho).toBeLessThan(r0.rho)
  expect(await count()).toEqual(c0)
  // 안: 누구나 저장 · 정하기는 관리자만
  const s = await u.post('/ontology/plans', { proc: key, name: '회귀 — 초안 먼저', levers: [{ type: 'draft', task: b.key, save: 0.5 }] })
  expect(s.status).toBe(200)
  cleanup(undoPlan(db, s.body.id))
  expect(s.body.status).toBe('draft')
  expect(s.body.baseline.nowH).toBe(flow.path.nowH)
  expect(s.body.can.decide).toBe(false)
  expect((await u.post(`/ontology/plans/${s.body.id}/decide`, {})).status).toBe(403)
  // 관리자가 정하면: 고친 기록 한 줄(set_runner draft) · 효력일
  const a = await as('po-admin')
  await db.q('update users set is_admin=true where id=$1', [a.id])
  cleanup(() => db.q('update users set is_admin=false where id=$1', [a.id]))
  const d = await a.post(`/ontology/plans/${s.body.id}/decide`, { note: '회귀 시험' })
  expect(d.status).toBe(200)
  expect(d.body.status).toBe('decided')
  expect(d.body.effectiveAt).toBeTruthy()
  const rows = await db.q(`select op, args from pro_corrections where tenant_id=$1 and batch::text=$2`, [TENANT, d.body.batch])
  expect(rows.map((x) => `${x.op}:${x.args.runner}:${x.args.task}`)).toEqual([`set_runner:draft:${b.key}`])
  const rv = await a.get(`/ontology/plans/${s.body.id}/review`)
  expect(rv.status).toBe(200)
  expect(rv.body.rows.map((x) => x.key)).toContain('path')
})

test('F-PO-21 화면 — 지도(?view=flow)에서 고쳐 보기: 칩을 누르면 앞 · 뒤 표, 지도에 「할 일 8 → n」, 저장하면 안 카드, 합의에 올리면 「합의 중」', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('po-user')
  const { key, flow } = await procOf(page.user)
  const b = flow.bottleneck
  cleanup(async () => { for (const p of await db.q(`select id::text as id from pro_improve_plans where tenant_id=$1 and created_name like '회귀-%'`, [TENANT])) await undoPlan(db, p.id)() })
  // the old /improve addresses land here: the flow panel opens by itself
  await page.goto(`/process-map?proc=${encodeURIComponent(key)}&view=flow`)
  await expect(page.getByTestId('onto-flow-bottleneck')).toHaveAttribute('data-task', b.key, { timeout: 30000 })
  const plan = page.getByTestId('onto-plan')
  await plan.scrollIntoViewIfNeeded()
  await page.locator(`[data-testid=onto-plan-chip][data-kind=draft][data-task="${b.key}"]`).click()
  await expect(page.getByTestId('onto-plan-result')).toBeVisible({ timeout: 30000 })
  await expect(page.getByTestId('onto-plan-row-now').locator('td.good')).toBeVisible()
  // the map shows what the bottleneck would carry
  await expect(page.locator(`g.node[data-task="${b.key}"] [data-testid=onto-flow-badge]`)).toHaveText(new RegExp(`할 일 ${b.wip} → `))
  await page.getByTestId('onto-plan-name').fill('회귀 — 화면 안')
  await page.getByTestId('onto-plan-save').click()
  const card = page.locator('[data-testid=onto-plan-card]', { hasText: '회귀 — 화면 안' })
  await expect(card).toHaveAttribute('data-status', 'draft', { timeout: 20000 })
  await card.getByTestId('onto-plan-vote').click()
  await expect(card).toHaveAttribute('data-status', 'voted', { timeout: 20000 })
  await expect(card.getByTestId('onto-plan-agree-count')).toContainText('같은 의견 1명')
  expect(page.errors).toEqual([])
})
