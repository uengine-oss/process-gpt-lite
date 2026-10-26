// 팀·역할·알림·프로세스 — 역할 담당자에게 단계 배정, 알림은 process-gpt notifications 그대로, Home 카드에서 바로 결정,
// 대화 중 팀원에게 요청(mention). 프로세스 정의·BPMN·시작·진행은 process-gpt 엔진(completion)으로.
// (spec pgpt-pro_role-based-notifications · 영상 개요 youtu.be/wrPlOhwYPcw, 프로세스 youtu.be/19Ap3J_XLHs)
import { test, expect, uniq } from '../../lib/fixtures.js'
import { retireInstance } from '../../lib/seed.js'

const DEF = 'doc_ai_draft_approval' // 기안 요청(요청자) → 기안 작성(기안자) → 결재(결재자), all human steps

test.describe('팀과 역할', () => {
  test('F-TM-01 팀원 추가·목록·빼기, 잘못된 이메일 400, 자기 자신은 못 뺌', async ({ as }) => {
    const a = await as('tm-owner')
    const mate = await as('tm-mate')
    expect((await a.post('/team', { email: 'not-an-email' })).status).toBe(400)
    const add = await a.post('/team', { email: mate.email, name: '회귀 동료' })
    expect(add.status).toBe(200)
    expect((await a.get('/team')).body.some((m) => m.id === mate.id)).toBe(true)
    expect((await a.del(`/team/${a.id}`)).status).toBe(400)
    expect((await a.del(`/team/${mate.id}`)).status).toBe(200)
    expect((await a.get('/team')).body.some((m) => m.id === mate.id)).toBe(false)
  })

  test('F-TM-02 역할 목록(프로세스 정의의 사람 역할)과 프로세스별 담당자 지정·해제', async ({ as, cleanup }) => {
    const a = await as('tm-owner'), mate = await as('tm-mate')
    const cat = (await a.get('/roles/catalog')).body
    expect(cat.find((r) => r.role === '기안자')?.processes.length).toBeGreaterThan(0)
    // the catalog is capped (most-used roles first) so a tenant with many definitions still answers
    expect(cat.length).toBeLessThanOrEqual(300)
    for (let i = 1; i < cat.length; i++) expect(cat[i - 1].processes.length).toBeGreaterThanOrEqual(cat[i].processes.length)
    cleanup(() => a.put('/roles', { defId: DEF, role: '기안자', userId: null }))
    expect((await a.put('/roles', { defId: DEF, role: '기안자', userId: mate.id })).status).toBe(200)
    const list = (await a.get(`/roles?defId=${DEF}`)).body
    expect(list.find((r) => r.proc_def_id === DEF && r.role === '기안자')?.user_id).toBe(mate.id)
    expect((await a.put('/roles', { defId: DEF })).status).toBe(400)
    await a.put('/roles', { defId: DEF, role: '기안자', userId: null })
    expect((await a.get(`/roles?defId=${DEF}`)).body.some((r) => r.proc_def_id === DEF && r.role === '기안자')).toBe(false)
  })

  test('F-TM-03 대화 중 팀원에게 요청(mention) → 그 사람 Home 에 카드, 누르면 채팅으로', async ({ as, lib }) => {
    const a = await as('tm-owner'), mate = await as('tm-mate')
    const notify = await lib('lib/notify.js')
    const title = uniq('회귀 요청')
    await notify.notifyMember({ id: a.id, email: a.email }, { id: mate.id }, { title, text: '이번 주 보고서 검토 부탁해요' })
    let n
    await expect.poll(async () => { n = (await mate.get('/notifications')).body.find((x) => x.title === title); return !!n }).toBe(true)
    expect(n).toMatchObject({ type: 'mention', text: '이번 주 보고서 검토 부탁해요' })
    expect((await a.get('/notifications')).body.some((x) => x.title === title)).toBe(false)
    expect((await a.post(`/notifications/${n.id}/act`)).status, '남의 알림은 404').toBe(404)
    expect((await mate.post(`/notifications/${n.id}/act`)).body).toMatchObject({ opened: true })
    expect((await mate.get('/notifications')).body.some((x) => x.title === title)).toBe(false)
  })
})

test.describe('프로세스 (process-gpt 엔진)', () => {
  test('F-PR-01 정의 목록·상세(단계·폼)·BPMN XML', async ({ as }) => {
    const a = await as('tm-owner')
    const defs = (await a.get('/processes')).body
    expect(defs.some((d) => d.id === DEF)).toBe(true)
    const d = (await a.get(`/processes/${DEF}`)).body
    expect(d.steps.map((s) => s.name)).toEqual(expect.arrayContaining(['기안 요청', '기안 작성', '결재']))
    const x = await a.get(`/processes/${DEF}/bpmn`)
    expect(x.status).toBe(200)
    expect(x.text).toContain('bpmn')
    expect((await a.get('/processes/no-such-process-rt')).status).toBe(404)
  })

  test('F-PR-02 역할 담당자에게만 단계가 가고(Home 카드), 담당자가 없는 역할은 시작한 사람에게 — 끝까지 진행', async ({ as, db, cleanup }) => {
    test.setTimeout(300_000)
    const a = await as('tm-owner'), mate = await as('tm-mate')
    cleanup(() => a.put('/roles', { defId: DEF, role: '기안자', userId: null }))
    expect((await a.put('/roles', { defId: DEF, role: '기안자', userId: mate.id })).status).toBe(200)
    const st = await a.post(`/processes/${DEF}/start`, { values: {} }, { timeout: 180_000 })
    expect(st.status, st.text).toBe(200)
    const inst = st.body.instId
    cleanup(() => retireInstance(inst))
    // 기안 작성 → the role's holder: her todo and her Home card; not the starter's
    let todo
    await expect.poll(async () => { todo = (await mate.get('/todos')).body.find((t) => t.proc_inst_id === inst); return !!todo }, { timeout: 120_000, intervals: [3000] }).toBe(true)
    expect(todo.activity_name || todo.name).toContain('기안 작성')
    await expect.poll(async () => (await mate.get('/notifications')).body.some((n) => n.todoId === todo.id), { timeout: 60_000, intervals: [3000] }).toBe(true)
    expect((await a.get('/notifications')).body.some((n) => n.todoId === todo.id)).toBe(false)
    expect((await a.get('/todos')).body.some((t) => t.id === todo.id)).toBe(false)
    const sub = await mate.post(`/todos/${todo.id}/submit`, { values: {} }, { timeout: 180_000 })
    expect(sub.status, sub.text).toBe(200)
    // 결재: nobody holds the role in 팀·역할 → the spec: the one who started it takes it
    // (this definition also names a default endpoint for 결재자 — the spec says the starter)
    let next
    // process-gpt pre-creates the next work item as TODO; wait until the engine has finished 기안 작성
    // and moved on, or the approval is submitted while the draft step is still being processed
    await expect.poll(async () => {
      [next] = await db.q(`select t.id, t.user_id from todolist t join bpm_proc_inst i on i.proc_inst_id=t.proc_inst_id
                           where t.proc_inst_id=$1 and t.activity_id='approve_draft'
                             and (t.status = 'IN_PROGRESS' or 'approve_draft' = any(i.current_activity_ids))
                             and exists (select 1 from todolist d where d.id=$2 and d.status='DONE')`, [inst, todo.id])
      return !!next
    }, { timeout: 120_000, intervals: [3000] }).toBe(true)
    expect(next.user_id, '결재 단계 담당자 (todolist.user_id)').toContain(a.id)
    expect((await a.post(`/todos/${next.id}/submit`, { values: {} }, { timeout: 180_000 })).status).toBe(200)
    await expect.poll(async () => (await a.get(`/instances/${encodeURIComponent(inst)}`)).body.inst?.status, { timeout: 120_000, intervals: [3000] }).toMatch(/COMPLETED|DONE/i)
  })
})

test.describe('프로세스 스피너 (에이전트가 실제로 일할 때만)', () => {
  test('F-PR-04 사람 단계를 기다리는 인스턴스는 "담당자 확인 대기"(스피너 없음), 에이전트가 잡고 있을 때만 "에이전트 작업 중" 스피너', async ({ as, pageAs, cleanup }) => {
    test.setTimeout(300_000)
    const page = await pageAs('sp-owner')
    const a = page.user, mate = await as('sp-mate')
    await a.get('/team'); await mate.get('/team')
    cleanup(() => a.put('/roles', { defId: DEF, role: '기안자', userId: null }))
    expect((await a.put('/roles', { defId: DEF, role: '기안자', userId: mate.id })).status).toBe(200)
    const st = await a.post(`/processes/${DEF}/start`, { values: {} }, { timeout: 180_000 })
    expect(st.status, st.text).toBe(200)
    const inst = st.body.instId
    cleanup(() => retireInstance(inst))
    let row
    await expect.poll(async () => { row = (await a.get('/instances')).body.find((i) => i.proc_inst_id === inst); return !!row?.human_waiting }, { timeout: 120_000, intervals: [3000] }).toBe(true)
    expect(row).toMatchObject({ status: 'RUNNING', agent_running: false, needs_me: false })
    expect((await a.get(`/instances/${encodeURIComponent(inst)}`)).body.steps.some((s) => s.running)).toBe(false)
    await page.goto('/projects')
    const item = page.locator('.plist .item.proc', { hasText: row.proc_inst_name || row.def_name }).first()
    await expect(item.locator('.badge.still')).toContainText('담당자 확인 대기')
    await expect(item.locator('.spin')).toHaveCount(0)
    // the same instance while a worker holds an agent step (what polling/cli-agent claim looks like)
    await page.route('**/api/instances', async (route) => {
      const r = await route.fetch()
      const list = (await r.json()).map((i) => (i.proc_inst_id === inst ? { ...i, agent_running: true } : i))
      await route.fulfill({ response: r, json: list })
    })
    await page.reload()
    await expect(item.locator('.spin')).toHaveCount(1)
    await expect(item).toContainText('에이전트 작업 중')
    expect(page.errors).toEqual([])
  })
})
