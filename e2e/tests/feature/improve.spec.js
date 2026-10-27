// 프로세스 개선 (server/lib/improve/*, routes/improve.js, mcp/improve.js, src/views/ImproveView.vue) —
// 병목(리드타임 분해) · 가치 흐름(흐름 효율) · 제약(가동률·5단계) · 크리티컬 패스 · what-if · 개선 적용(새 버전) · 알림 · 사람 착수 신호.
// 이력은 모델 없이 고정 시뮬레이션(lib/improve/demoProcess.js)을 엔진이 남기는 모양(shape.js) 그대로 이 실행 전용 정의에 써 넣는다.
import { test, expect, RUN } from '../../lib/fixtures.js'
import crypto from 'node:crypto'
import { mcp } from '../../lib/api.js'

const DEF = `rt_improve_${RUN}`.toLowerCase()

// save_contract (개선 적용) lists the process in configuration.proc_map; take it out again
async function dropFromProcMap(db, drop) {
  const [cfg] = await db.q(`select value from configuration where key='proc_map' and tenant_id=$1`, [db.tenant])
  if (!cfg?.value?.mega_proc_list) return
  for (const mg of cfg.value.mega_proc_list) for (const mj of mg.major_proc_list || []) mj.sub_proc_list = (mj.sub_proc_list || []).filter((x) => !drop(x.id))
  await db.q(`update configuration set value=$2 where key='proc_map' and tenant_id=$1`, [db.tenant, cfg.value])
}

async function seed({ db, lib, as, cleanup }) {
  const owner = await as('im-owner'), designer = await as('im-design'), finance = await as('im-finance')
  const { simulate, contract } = await lib('lib/improve/demoProcess.js')
  const { writeInstance, flatDefinition } = await lib('lib/improve/shape.js')
  const people = { jang: owner.id, minji: designer.id, seoyeon: finance.id }
  const names = { jang: '회귀 영업', minji: '회귀 디자인', seoyeon: '회귀 재무' }
  const c = contract(people)
  c.processDefinition.processDefinitionId = DEF
  const def = flatDefinition(c)
  cleanup(async () => {
    const insts = (await db.q('select proc_inst_id from bpm_proc_inst where proc_def_id=$1', [DEF])).map((r) => r.proc_inst_id)
    await db.q('delete from events where proc_inst_id = any($1)', [insts])
    await db.q('delete from todolist_status_history where proc_inst_id = any($1)', [insts])
    await db.q('delete from task_execution_properties where proc_inst_id = any($1)', [insts]).catch(() => {})
    await db.q('delete from todolist where proc_inst_id = any($1)', [insts])
    await db.q('delete from bpm_proc_inst where proc_def_id=$1', [DEF])
    await db.q('delete from proc_def_version where proc_def_id=$1', [DEF])
    await db.q('delete from form_def where proc_def_id=$1', [DEF])
    await db.q('delete from pro_improve_state where proc_def_id=$1', [DEF]).catch(() => {})
    await db.q('delete from pro_improve_runs where proc_def_id=$1', [DEF]).catch(() => {})
    await db.q(`delete from notifications where url=$1`, [`/improve/${DEF}`])
    await db.q(`delete from users where tenant_id=$1 and alias like $2`, [db.tenant, `pro-improve-${DEF}-%`])
    await db.q('delete from proc_def where id=$1', [DEF])
    await dropFromProcMap(db, (id) => id === DEF)
  })
  await db.q(`insert into proc_def (id, name, definition, type, tenant_id, owner, isdeleted) values ($1,$2,$3,'bpmn',$4,$5,false)`, [DEF, `회귀 개선 ${RUN}`, def, db.tenant, owner.id])
  await db.q(`insert into proc_def_version (arcv_id, proc_def_id, version, version_tag, "timeStamp", definition, message, tenant_id, is_draft) values ($1,$2,'1.0','major',now(),$3,'회귀 v1',$4,false)`, [`${DEF}_1.0`, DEF, def, db.tenant])
  const now = Date.now()
  const sims = simulate({ people, names, from: now - 70 * 86400_000, to: now - 3600_000, seed: 7, defId: DEF })
  for (const sim of sims) await writeInstance(db.q, { tenant: db.tenant, defId: DEF, sim, arcv: `${DEF}_1.0`, version: '1.0', roles: def.roles })
  return { owner, designer, finance, sims, names }
}

test.describe('프로세스 개선 (lib/improve)', () => {
  test.describe.configure({ mode: 'serial' })
  let S, S_cleanup
  test.afterAll(async () => { if (S_cleanup) await S_cleanup().catch((e) => console.warn('[cleanup]', e.message)) })

  test('F-IM-01 분석: 참여하지 않은 사람 403, 담당자는 병목·가치 흐름·제약·크리티컬 패스를 받는다', async ({ db, lib, as, cleanup, browser }) => {
    test.setTimeout(240_000)
    S = await seed({ db, lib, as, cleanup: (fn) => { S_cleanup = fn } })
    test.info().annotations.push({ type: 'seed', description: `${S.sims.length} instances` })
    const out = await as('im-outsider')
    expect((await out.get(`/improve/${DEF}`)).status).toBe(403)
    const r = await S.owner.get(`/improve/${DEF}`)
    expect(r.status).toBe(200)
    const o = r.body
    expect(o.counts.completed).toBe(S.sims.length)
    // every completed instance decomposes exactly into its lead time (the inherited invariant)
    for (const i of o.instances) if (i.leadSec) expect(Object.values(i.totals).reduce((a, b) => a + b, 0)).toBe(i.leadSec)
    // 병목 점수는 실행 횟수 × 평균 소요시간의 몫 — 합이 100
    expect(o.steps.reduce((a, s) => a + s.normalizedBottleneck, 0)).toBeCloseTo(100, 5)
    const fin = o.steps.find((s) => s.id === 'finance_review')
    expect(fin.sums.review_wait).toBeGreaterThan(0)
    // 흐름 효율 = Σ 작업 / 리드타임
    const done = o.instances.filter((i) => i.leadSec)
    expect(o.vsm.flowEfficiency).toBeGreaterThan(0)
    expect(o.vsm.flowEfficiency).toBeLessThan(0.3)
    // 제약: 재무 검토 담당, 5단계가 순서대로
    expect(o.toc.constraint.name).toBe(S.names.seoyeon)
    expect(o.toc.focus.map((s) => s.stage)).toEqual(['identify', 'exploit', 'subordinate', 'elevate', 'repeat'])
    // CPM: 평면도 쪽이 크리티컬, 견적 초안은 여유가 있다
    expect(o.cpm.median.path).toEqual(expect.arrayContaining(['floor_plan', 'finance_review']))
    const quote = o.cpm.median.rows.find((x) => x.id === 'quote_draft')
    expect(quote.critical).toBe(false)
    expect(quote.slack).toBeGreaterThan(60)
    expect(o.cpm.p80.expectedSec).toBeGreaterThan(o.cpm.median.expectedSec)
    expect(done.length).toBeGreaterThan(10)
  })

  test('F-IM-02 what-if: 사전 초안·기준 미만 건너뛰기·인원 추가가 리드타임을 줄이고, 잘못된 요청은 400', async () => {
    test.skip(!S, 'F-IM-01 시드 없음')
    const thr = (await S.owner.get(`/improve/${DEF}`)).body.suggestedThreshold
    expect(thr?.field).toBe('amount')
    const r = await S.owner.post(`/improve/${DEF}/whatif`, { changes: [{ type: 'predraft', step: 'finance_review', saving: 0.5 }, { type: 'skip', step: 'finance_review', field: 'amount', threshold: thr.threshold }] })
    expect(r.status).toBe(200)
    expect(r.body.after.leadSec).toBeLessThan(r.body.before.leadSec)
    expect(r.body.after.flowEfficiency).toBeGreaterThan(r.body.before.flowEfficiency)
    expect(r.body.after.steps.finance_review.p).toBeCloseTo(1 - r.body.skip.finance_review.share, 5)
    const cap = await S.owner.post(`/improve/${DEF}/whatif`, { changes: [{ type: 'capacity', step: 'finance_review', add: 1 }] })
    expect(cap.body.after.leadSec).toBeLessThan(cap.body.before.leadSec)
    expect((await S.owner.post(`/improve/${DEF}/whatif`, { changes: [{ type: 'parallel', step: 'quote_draft' }] })).status).toBe(400)
    expect((await S.owner.post(`/improve/${DEF}/whatif`, { changes: [{ type: 'nope', step: 'reply' }] })).status).toBe(400)
  })

  test('F-IM-03 알림: 새 제약은 소유자에게 한 번만 (같은 제약이면 다시 알리지 않음)', async ({ db, lib }) => {
    test.skip(!S, 'F-IM-01 시드 없음')
    const { checkConstraint } = await lib('lib/improve/service.js')
    await db.q('delete from pro_improve_state where proc_def_id=$1', [DEF])
    const first = await checkConstraint(DEF)
    expect(first?.notified).toEqual([S.owner.id])
    expect(await checkConstraint(DEF)).toBeNull()
    // (opening the view in F-IM-01 already checked once; a new notice replaces the unread one)
    const n = await db.q(`select title from notifications where url=$1 and user_id=$2 and type='improve' and not coalesce(is_checked,false)`, [`/improve/${DEF}`, S.owner.id])
    expect(n.length).toBe(1)
    expect(n[0].title).toContain('재무 검토')
  })

  test('F-IM-04 MCP /mcp/improve: 도구 6개, JWT 없으면 거부, 병목·what-if 숫자는 결정적 계산', async () => {
    test.skip(!S, 'F-IM-01 시드 없음')
    const list = (await mcp('/mcp/improve', 'tools/list')).body
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(['improve_bottlenecks', 'improve_constraint', 'improve_critical_path', 'improve_processes', 'improve_value_stream', 'improve_what_if'])
    const anon = (await mcp('/mcp/improve', 'tools/call', { name: 'improve_bottlenecks', arguments: { process: DEF } })).body
    expect(anon.result.isError).toBe(true)
    const b = (await mcp('/mcp/improve', 'tools/call', { name: 'improve_bottlenecks', arguments: { process: DEF } }, S.owner.token())).body
    const body = JSON.parse(b.result.content[0].text)
    expect(body.bottlenecks[0].step).toBe('재무 검토')
    const w = (await mcp('/mcp/improve', 'tools/call', { name: 'improve_what_if', arguments: { process: DEF, changes: [{ type: 'capacity', step: '재무 검토' }] } }, S.owner.token())).body
    const wb = JSON.parse(w.result.content[0].text)
    expect(wb.before.lead_time).not.toBe(wb.after.lead_time)
  })

  test('F-IM-05 개선 적용: 확인 없으면 400, 소유자 아니면 403, 적용하면 새 버전·PI Flag·기록·버전 비교', async ({ db }) => {
    test.skip(!S, 'F-IM-01 시드 없음')
    test.setTimeout(180_000)
    const changes = [{ type: 'skip', step: 'finance_review', field: 'amount', threshold: 40000000 }]
    expect((await S.owner.post(`/improve/${DEF}/apply`, { changes })).status).toBe(400)
    expect((await S.finance.post(`/improve/${DEF}/apply`, { changes, confirm: true })).status).toBe(403)
    const r = await S.owner.post(`/improve/${DEF}/apply`, { changes, confirm: true }, { timeout: 150_000 })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(r.body.version).toBe('2.0')
    const [v] = await db.q(`select version, version_tag, snapshot, definition, parent_version from proc_def_version where arcv_id=$1`, [`${DEF}_2.0`])
    expect(v.version_tag).toBe('major')
    expect(v.parent_version).toBe(`${DEF}_1.0`)
    expect(v.snapshot).toContain('gw_skip_finance_review')
    expect(v.definition.gateways.some((g) => g.id === 'gw_skip_finance_review')).toBe(true)
    const fin = v.definition.activities.find((a) => a.id === 'finance_review')
    expect(JSON.parse(fin.properties).comments[0]).toMatchObject({ status: 'resolved', type: '개선 적용' })
    const [d] = await db.q('select definition from proc_def where id=$1', [DEF])
    expect(d.definition.sequences.some((s) => s.id === 'seq_skip_finance_review_skip' && s.target === 'reply')).toBe(true)
    const cmp = await S.owner.get(`/improve/${DEF}/compare`)
    expect(cmp.body.versions.map((x) => x.version)).toEqual(['1.0', '2.0'])
    expect(cmp.body.runs.length).toBe(1)
  })

  test('F-IM-06 화면: 다섯 탭(병목 열지도·가치 흐름·제약 5단계·크리티컬 패스 간트·개선 실행)이 오류 없이', async ({ pageAs }) => {
    test.skip(!S, 'F-IM-01 시드 없음')
    test.setTimeout(120_000)
    const page = await pageAs('im-owner')
    await page.goto(`/improve/${DEF}?version=1.0`)
    await expect(page.getByRole('heading', { name: `회귀 개선 ${RUN}` })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.tr', { hasText: '재무 검토' }).first()).toBeVisible()
    await page.getByRole('button', { name: '가치 흐름' }).click()
    await expect(page.getByText('흐름 효율').first()).toBeVisible()
    await page.getByRole('button', { name: '제약', exact: true }).click()
    await expect(page.getByText('찾기 — 제약은 어디인가')).toBeVisible()
    await page.getByRole('button', { name: '크리티컬 패스' }).click()
    await expect(page.locator('svg.gantt')).toBeVisible()
    await page.getByRole('button', { name: '개선 실행' }).click()
    await page.locator('.presets .chip').first().click()
    await expect(page.locator('.kpi').first()).toContainText('→', { timeout: 20_000 })
    expect(page.errors).toEqual([])
  })
})

test.describe('사람 착수 신호 (lib/improve/signal.js · GET /todos/:id)', () => {
  test('F-IM-07 담당자가 작업 항목을 처음 열면 human_checked 한 번, 다른 사람은 남기지 않음', async ({ db, as, cleanup }) => {
    const me = await as('im-signal'), other = await as('im-signal-other')
    const inst = `rt_signal_${RUN}.${Date.now()}`
    const todo = crypto.randomUUID()
    cleanup(async () => {
      await db.q('delete from events where todo_id=$1', [todo])
      await db.q('delete from todolist_status_history where todo_id=$1', [todo])
      await db.q('delete from notifications where url=$1', [`/todolist/${todo}`])
      await db.q('delete from todolist where id=$1', [todo])
      await db.q('delete from bpm_proc_inst where proc_inst_id=$1', [inst])
    })
    await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, tenant_id, current_activity_ids) values ($1,'회귀 신호','rt_signal','RUNNING',$2,'{a1}')`, [inst, db.tenant])
    await db.q(`insert into todolist (id, user_id, username, proc_inst_id, proc_def_id, activity_id, activity_name, status, tenant_id) values ($1,$2,'회귀','${inst}','rt_signal','a1','검토','IN_PROGRESS',$3)`, [todo, me.id, db.tenant])
    await other.get(`/todos/${todo}`)
    await me.get(`/todos/${todo}`)
    await me.get(`/todos/${todo}`)
    await expect.poll(async () => (await db.q(`select count(*)::int as n from events where todo_id=$1 and event_type='human_checked'`, [todo]))[0].n).toBe(1)
  })
})
