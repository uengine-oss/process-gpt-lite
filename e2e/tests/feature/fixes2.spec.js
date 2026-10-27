// 튜토리얼 작성 중 찾은 결함 수정 (docs/tutorial-findings.md, 2026-10-27) — 프로세스 엔진·정의, 마이닝 기록,
// 미션·예약, 패널 앱·작업실·스킬 검증. 모델 없이 고정 데이터로 확인한다(F-FX2-01 만 process-gpt 엔진을 씀).
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { test, expect, RUN, uniq } from '../../lib/fixtures.js'
import { makeApp } from '../../lib/panel.js'
import { removeFolder, retireInstance } from '../../lib/seed.js'
import { WORKSPACE } from '../../lib/env.js'

// a small human-only process, saved with process-gpt's own save path (save_contract): 요청 작성 (the start
// form) → 검토 → 확인 in v1; v2 replaces 확인 by 승인
function contract(pid, second) {
  const form = (id, name) => `<section>\n  <row-layout name="${pid}_${id}_form" alias="${name}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><text-field name='note' alias='메모' type='text' disabled='false' readonly='false' v-model="slotProps.modelValue['note']"></text-field></div></div></row-layout>\n</section>`
  const act = (id, name) => ({ elementType: 'Activity', id, name, role: '담당자', type: 'UserActivity', tool: `formHandler:${pid}_${id}_form`, duration: 1, inputData: [], outputData: [], checkpoints: [], agentMode: 'none', description: name })
  return {
    type: 'process-definition-result',
    processDefinition: {
      processDefinitionId: pid, processDefinitionName: `회귀 버전 고정 ${RUN}`, isHorizontal: true, data: [], description: '회귀 시험 — 버전 고정',
      roles: [{ name: '담당자', endpoint: '', default: '', resolutionRule: '', origin: 'created' }],
      elements: [
        { elementType: 'Event', id: 'start', name: '시작', role: '담당자', type: 'StartEvent' },
        act('ask', '요청 작성'), act('review', '검토'), act(second.id, second.name),
        { elementType: 'Event', id: 'end', name: '끝', role: '담당자', type: 'EndEvent' },
        { elementType: 'Sequence', id: 's1', source: 'start', target: 'ask' },
        { elementType: 'Sequence', id: 's2', source: 'ask', target: 'review' },
        { elementType: 'Sequence', id: 's3', source: 'review', target: second.id },
        { elementType: 'Sequence', id: 's4', source: second.id, target: 'end' },
      ],
    },
    forms: [['ask', '요청 작성'], ['review', '검토'], [second.id, second.name]].map(([id, name]) => ({ activity_id: id, form_id: `${pid}_${id}_form`, html: form(id, name) })),
    agents: [], skills: [],
  }
}

async function dropFromProcMap(db, id) {
  const [cfg] = await db.q(`select value from configuration where key='proc_map' and tenant_id=$1`, [db.tenant])
  if (!cfg?.value?.mega_proc_list) return
  for (const mg of cfg.value.mega_proc_list) for (const mj of mg.major_proc_list || []) mj.sub_proc_list = (mj.sub_proc_list || []).filter((x) => x.id !== id)
  await db.q(`update configuration set value=$2 where key='proc_map' and tenant_id=$1`, [db.tenant, cfg.value])
}
async function dropDefinition(db, id) {
  const insts = (await db.q('select proc_inst_id from bpm_proc_inst where proc_def_id=$1', [id])).map((r) => r.proc_inst_id)
  for (const t of ['events', 'todolist_status_history', 'todolist']) await db.q(`delete from ${t} where proc_inst_id = any($1)`, [insts]).catch(() => {})
  await db.q('delete from notifications where url = any($1)', [insts.map((i) => `/projects/p/${encodeURIComponent(i)}`)]).catch(() => {})
  await db.q('delete from bpm_proc_inst where proc_def_id=$1', [id])
  await db.q('delete from proc_def_version where proc_def_id=$1', [id])
  await db.q('delete from form_def where proc_def_id=$1', [id])
  await db.q('delete from proc_def where id=$1', [id])
  await dropFromProcMap(db, id)
}

test.describe('튜토리얼 결함 수정 2 — 프로세스 엔진·정의', () => {
  test('F-FX2-01 진행 중인 인스턴스는 시작한 버전으로 끝까지, 새 인스턴스는 새 버전으로 (completion 버전 고정)', async ({ as, db, lib, cleanup }) => {
    test.setTimeout(420_000)
    const a = await as('fx2-pin')
    const DEF = `rt_fx2_pin_${RUN}`.toLowerCase()
    cleanup(() => dropDefinition(db, DEF))
    const { saveGenerated } = await lib('lib/generated.js')
    // v1 as process-gpt saves it: proc_def + a released proc_def_version row (the improve feature does the same)
    const save = async (version, second) => {
      await saveGenerated(contract(DEF, second))
      const [d] = await db.q('select bpmn, definition from proc_def where id=$1', [DEF])
      await db.q(`insert into proc_def_version (arcv_id, proc_def_id, version, version_tag, "timeStamp", snapshot, definition, message, tenant_id, is_draft)
                  values ($1,$2,$3,'major',now(),$4,$5,$6,$7,false)`, [`${DEF}_${version}`, DEF, version, d.bpmn, d.definition, `회귀 v${version}`, db.tenant])
    }
    await save('1.0', { id: 'check', name: '확인' })
    const old = (await a.post(`/processes/${DEF}/start`, { values: { note: '버전 1 로 시작' } }))
    expect(old.status, old.text).toBe(200)
    const A = old.body.instId
    cleanup(() => retireInstance(A))
    const versionOf = async (i) => (await db.q('select proc_def_version from bpm_proc_inst where proc_inst_id=$1', [i]))[0]?.proc_def_version
    await expect.poll(() => versionOf(A), { timeout: 60_000 }).toBe(`${DEF}_1.0`)
    // the next version is saved while A waits on its first step
    await save('2.0', { id: 'approve', name: '승인' })
    // A waits on 검토 (the start form 요청 작성 was submitted when it started)
    const working = async (i) => (await db.q(`select id::text as id, activity_id from todolist where proc_inst_id=$1 and status::text='IN_PROGRESS'`, [i]))
    let review
    await expect.poll(async () => (review = (await working(A)).find((t) => t.activity_id === 'review')?.id), { timeout: 120_000, intervals: [2000] }).toBeTruthy()
    expect((await a.post(`/todos/${review}/submit`, { values: { note: '검토함' } })).status).toBe(200)
    // A goes on with v1's next step (확인), not v2's (승인), and keeps its stamp
    await expect.poll(async () => (await working(A)).map((t) => t.activity_id).join(','), { timeout: 180_000, intervals: [3000] }).toBe('check')
    expect((await db.q(`select 1 from todolist where proc_inst_id=$1 and activity_id='approve'`, [A])).length, 'v2 의 승인 단계는 생기지 않음').toBe(0)
    expect(await versionOf(A)).toBe(`${DEF}_1.0`)
    // a new instance runs the latest version
    const neu = await a.post(`/processes/${DEF}/start`, { values: { note: '버전 2 로 시작' } })
    expect(neu.status, neu.text).toBe(200)
    cleanup(() => retireInstance(neu.body.instId))
    await expect.poll(() => versionOf(neu.body.instId), { timeout: 60_000 }).toBe(`${DEF}_2.0`)
  })

  test('F-FX2-02 대화로 만든 프로세스 저장: 작업 폴더(/.bpmn/…)의 폼·에이전트까지 저장, 저장된 카드의 「흐름 보기」가 펼쳐짐', async ({ pageAs, db, cleanup }) => {
    test.skip(!fss.existsSync(WORKSPACE), `deepagents 작업 공간 없음: ${WORKSPACE}`)
    test.setTimeout(180_000)
    const page = await pageAs('fx2-owner')
    const a = page.user
    // the folder bpmn-process-generation-skill leaves: definition, one .form per user activity, agents/<slug>.json
    const room = `rt-fx2-gen-${RUN}`
    const dir = path.join(WORKSPACE, '.bpmn', room, 'process-rt')
    cleanup(() => fs.rm(path.join(WORKSPACE, '.bpmn', room), { recursive: true, force: true }))
    await fs.mkdir(path.join(dir, 'forms'), { recursive: true })
    await fs.mkdir(path.join(dir, 'agents'), { recursive: true })
    const slug = `rt-fx2-agent-${RUN}`
    const agentName = `회귀 초안 에이전트 ${RUN}`
    const els = [
      { elementType: 'Event', id: 'start_event', name: '시작', role: '요청자', type: 'StartEvent' },
      { elementType: 'Activity', id: 'write_request', name: '요청 작성', role: '요청자', type: 'UserActivity', agentMode: 'none', duration: 1, inputData: [], outputData: [], checkpoints: [] },
      { elementType: 'Activity', id: 'draft_answer', name: '답변 초안', role: '초안 에이전트', type: 'UserActivity', agent: slug, agentMode: 'complete', orchestration: 'deepagents', duration: 1, inputData: [], outputData: [], checkpoints: [] },
      { elementType: 'Activity', id: 'review_answer', name: '답변 검토', role: '요청자', type: 'UserActivity', agentMode: 'none', duration: 1, inputData: [], outputData: [], checkpoints: [] },
      { elementType: 'Event', id: 'end_event', name: '끝', role: '요청자', type: 'EndEvent' },
      { elementType: 'Sequence', id: 'seq_1', source: 'start_event', target: 'write_request' },
      { elementType: 'Sequence', id: 'seq_2', source: 'write_request', target: 'draft_answer' },
      { elementType: 'Sequence', id: 'seq_3', source: 'draft_answer', target: 'review_answer' },
      { elementType: 'Sequence', id: 'seq_4', source: 'review_answer', target: 'end_event' },
    ]
    const pd = { processDefinitionId: 'rt-draft', processDefinitionName: `회귀 생성 저장 ${RUN}`, description: '회귀 시험', data: [],
      roles: [{ name: '요청자', endpoint: '', default: '', resolutionRule: '' }, { name: '초안 에이전트', endpoint: slug, default: slug, resolutionRule: '' }], elements: els }
    await fs.writeFile(path.join(dir, 'process-definition.json'), JSON.stringify(pd))
    for (const [id, name] of [['write_request', '요청 작성'], ['draft_answer', '답변 초안'], ['review_answer', '답변 검토']]) {
      await fs.writeFile(path.join(dir, 'forms', `${id}.form`), `<section><row-layout name="${id}_form" alias="${name}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><textarea-field name='content' alias='${name}' disabled='false' readonly='false' v-model="slotProps.modelValue['content']"></textarea-field></div></div></row-layout></section>`)
    }
    await fs.writeFile(path.join(dir, 'agents', `${slug}.json`), JSON.stringify({ id: slug, name: agentName, role: '요청에 답변 초안을 쓴다', goal: '초안 1건', persona: '간결하게 쓴다' }))
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ skills: [], agents: [{ id: slug, activity_ids: ['draft_answer'] }], dmn: [] }))
    // the card as the chat made it: the streamed contract had no forms (as in the tutorial), workDir as deepagents reports it
    const th = await db.mainThreadId(a.id)
    const [m] = await db.addMessages(th, [{ role: 'agent', kind: 'process_draft', content: { contract: { type: 'process-definition-result', processDefinition: pd, forms: [], agents: [], skills: [] }, workDir: `/.bpmn/${room}/process-rt/`, state: 'draft' } }])
    let defId = null
    cleanup(async () => {
      await db.q('delete from pro_messages where id=$1', [m.id])
      if (defId) await dropDefinition(db, defId)
      await db.q(`delete from users where tenant_id=$1 and is_agent and username=$2`, [db.tenant, agentName])
    })
    await page.goto('/chat')
    const draft = page.locator('.draft').filter({ hasText: `회귀 생성 저장 ${RUN}` })
    await expect(draft).toBeVisible({ timeout: 20_000 })
    await draft.getByRole('button', { name: '프로세스로 저장' }).click()
    await expect.poll(async () => (await db.q('select content from pro_messages where id=$1', [m.id]))[0].content.state, { timeout: 120_000 }).toBe('saved')
    const saved = (await db.q('select content from pro_messages where id=$1', [m.id]))[0].content.saved
    defId = saved.proc_def_id
    expect(saved.forms_saved, JSON.stringify(saved)).toBeGreaterThanOrEqual(3)
    expect(saved.agents_created).toHaveLength(1)
    const [agent] = await db.q('select id::text as id from users where tenant_id=$1 and is_agent and username=$2', [db.tenant, agentName])
    expect(agent).toBeTruthy()
    // the definition points at the agent user, not at the slug
    const [d] = await db.q('select definition from proc_def where id=$1', [defId])
    expect(JSON.stringify(d.definition)).toContain(agent.id)
    expect(JSON.stringify(d.definition)).not.toContain(`"${slug}"`)
    // the saved card: its flow toggles (closes, opens again and comes into view)
    const card = page.locator('.proc').filter({ hasText: `회귀 생성 저장 ${RUN}` }).last()
    const btn = card.locator('.flow-btn')
    await expect(btn).toBeVisible({ timeout: 20_000 })
    if ((await btn.textContent()).includes('접기')) await btn.click()
    await expect(card.locator('.flow')).toHaveCount(0)
    await btn.click()
    await expect(card.locator('.flow')).toBeVisible()
    await expect(card.locator('.flow')).toBeInViewport()
    expect(page.errors).toEqual([])
  })

  test('F-FX2-03 마이닝 정식 등록 계약: 병렬 게이트웨이는 gateWayType 까지, 그린 BPMN 도 parallelGateway', async ({ db, lib, cleanup }) => {
    test.setTimeout(120_000)
    const { buildContract } = await lib('lib/mining/service.js')
    const { saveGenerated } = await lib('lib/generated.js')
    const pid = `rt_fx2_mined_${RUN}`.toLowerCase()
    cleanup(() => dropDefinition(db, pid))
    const definition = {
      roles: [{ name: '영업 담당' }],
      events: [{ id: 'start', type: 'startEvent' }, { id: 'end', type: 'endEvent' }],
      activities: [{ id: 'a', name: '요청 메일 접수' }, { id: 'b', name: '평면도 작성' }, { id: 'c', name: '견적서 작성' }, { id: 'd', name: '고객 회신' }],
      gateways: [{ id: 'g_split', type: 'parallelGateway' }, { id: 'g_join', type: 'parallelGateway' }, { id: 'g_x', type: 'exclusiveGateway' }],
      sequences: [['start', 'a'], ['a', 'g_split'], ['g_split', 'b'], ['g_split', 'c'], ['b', 'g_join'], ['c', 'g_join'], ['g_join', 'g_x'], ['g_x', 'd'], ['d', 'end']].map(([source, target], i) => ({ id: `s${i}`, source, target })),
    }
    const c = buildContract({ process_id: pid, name: `회귀 마이닝 등록 ${RUN}`, summary: '', definition, pattern: { case_count: 4, event_count: 16 } })
    const gws = c.processDefinition.elements.filter((e) => e.elementType === 'Gateway')
    expect(gws.find((g) => g.id === 'g_split')).toMatchObject({ type: 'ParallelGateway', gateWayType: 'bpmn:parallelGateway' })
    expect(gws.find((g) => g.id === 'g_x')).toMatchObject({ type: 'ExclusiveGateway', gateWayType: 'bpmn:exclusiveGateway' })
    await saveGenerated(c)
    const [d] = await db.q('select bpmn from proc_def where id=$1', [pid])
    expect((d.bpmn.match(/<bpmn:parallelGateway\b/g) || []).length).toBe(2)
    expect((d.bpmn.match(/<bpmn:exclusiveGateway\b/g) || []).length).toBe(1)
  })

  test('F-FX2-04 에이전트 단계가 잠깐의 오류로 실패하면 다시 줄 세우고, 영구 오류는 시작한 사람에게 알림 + 「다시 시도」', async ({ as, db, lib, cleanup }) => {
    const a = await as('fx2-fail'), other = await as('fx2-other')
    const R = await lib('lib/stepRetry.js')
    // a running instance whose agent step failed; the agent kind no worker serves, so nothing picks it up for real
    const DEF = `rt_fx2_fail_${RUN}`.toLowerCase()
    const inst = `${DEF}.${crypto.randomUUID()}`
    const def = { activities: [{ id: 'ask', name: '요청', role: '요청자', type: 'userTask' }, { id: 'work', name: '에이전트 작업', role: '에이전트', type: 'userTask', agentMode: 'complete', orchestration: 'rt-none' }],
      events: [{ id: 'start', type: 'startEvent' }, { id: 'end', type: 'endEvent' }], gateways: [], roles: [{ name: '요청자' }, { name: '에이전트' }],
      sequences: [{ id: 's1', source: 'start', target: 'ask' }, { id: 's2', source: 'ask', target: 'work' }, { id: 's3', source: 'work', target: 'end' }] }
    cleanup(() => dropDefinition(db, DEF))
    cleanup(() => db.q('delete from pro_step_retries where proc_inst_id=$1', [inst]))
    await db.q(`insert into proc_def (id, name, definition, type, tenant_id, isdeleted) values ($1,$2,$3,'bpmn',$4,false)`, [DEF, `회귀 실패 단계 ${RUN}`, def, db.tenant])
    await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, current_activity_ids, participants, tenant_id, start_date)
                values ($1,$2,$3,'RUNNING',$4,$5,$6,now())`, [inst, `회귀 실패 단계 ${RUN}`, DEF, ['work'], [a.id], db.tenant])
    const ask = crypto.randomUUID(), work = crypto.randomUUID()
    await db.q(`insert into todolist (id, user_id, proc_inst_id, proc_def_id, activity_id, activity_name, status, tenant_id, start_date, root_proc_inst_id)
                values ($1,$2,$3,$4,'ask','요청','DONE',$5, now() - interval '10 minutes', $3)`, [ask, a.email, inst, DEF, db.tenant])
    await db.q(`insert into todolist (id, user_id, proc_inst_id, proc_def_id, activity_id, activity_name, status, tenant_id, start_date, agent_mode, agent_orch, draft_status, root_proc_inst_id)
                values ($1,'rt-agent',$2,$3,'work','에이전트 작업','IN_PROGRESS',$4, now() - interval '5 minutes','COMPLETE','rt-none','FAILED',$2)`, [work, inst, DEF, db.tenant])
    const fail = async (raw) => {
      await db.q(`insert into events (id, job_id, todo_id, proc_inst_id, crew_type, event_type, data, timestamp, tenant_id) values ($1,'TASK_ERROR',$2,$3,'agent','error',$4,now(),$5)`,
        [crypto.randomUUID(), work, inst, { name: '시스템 오류 알림', friendly: '데이터베이스가 잠시 응답하지 않았어요.', raw_error: raw }, db.tenant])
      await db.q(`update todolist set draft_status='FAILED' where id=$1`, [work])
    }
    const later = new Date(Date.now() + 3600_000)
    // passing error (the database in recovery mode): queued again as new agent work
    await fail('OperationalError: the database system is in recovery mode')
    expect(await R.sweep({ now: later, instId: inst })).toEqual([{ id: work, retried: 1 }])
    let [t] = await db.q('select draft_status::text as ds, draft from todolist where id=$1', [work])
    expect(t.ds).toBeNull()
    // the instance page and list show the failed step
    await fail('KeyError: activity_id')
    const page = (await a.get(`/instances/${encodeURIComponent(inst)}`)).body
    const step = page.steps.find((s) => s.id === 'work')
    expect(step).toMatchObject({ failed: true })
    expect(step.failure.error).toBeTruthy()
    expect((await a.get('/instances')).body.find((i) => i.proc_inst_id === inst)?.agent_failed).toBe(true)
    // a lasting error: no automatic retry, the starter hears about it
    expect(await R.sweep({ now: later, instId: inst })).toEqual([{ id: work, gaveUp: true }])
    expect((await db.q('select draft_status::text as ds from todolist where id=$1', [work]))[0].ds).toBe('FAILED')
    const n = (await a.get('/notifications')).body.find((x) => x.type === 'agent_failed' && x.url === `/projects/p/${encodeURIComponent(inst)}`)
    expect(n?.title).toContain('에이전트 작업')
    // 다시 시도: someone else 403, the owner queues it
    expect((await other.post(`/todos/${work}/retry`)).status).toBe(403)
    const r = await a.post(`/todos/${work}/retry`)
    expect(r.status, r.text).toBe(200)
    ;[t] = await db.q('select draft_status::text as ds from todolist where id=$1', [work])
    expect(t.ds).toBeNull()
    expect((await a.get('/notifications')).body.some((x) => x.type === 'agent_failed' && x.url === `/projects/p/${encodeURIComponent(inst)}`)).toBe(false)
    expect((await a.post(`/todos/${work}/retry`)).status, '실패 상태가 아니면 409').toBe(409)
  })
})

test.describe('튜토리얼 결함 수정 2 — 마이닝 기록', () => {
  test('F-FX2-05 팀 공유는 받는 사람의 역할·공유 메모로 단계 이름, 회신 뒤 공유는 사례에 넣지 않음, 같은 사례는 추천 하나', async ({ as, db, lib, cleanup }) => {
    const me = await as('fx2-owner'), designer = await as('fx2-designer'), plain = await as('fx2-plain')
    const rec = await lib('lib/mining/recorder.js')
    const svc = await lib('lib/mining/service.js')
    const mail = { id: `rt-fx2-${RUN}`, subject: `회귀 설계 요청 ${RUN}` }
    const caseId = rec.caseOf(mail.id)
    const file = `회귀-${RUN}-평면도.dxf`
    const role = `디자이너`
    const roleDef = `rt_fx2_role_${RUN}`.toLowerCase()
    cleanup(async () => {
      await db.q('delete from handover_events where tenant_id=$1 and case_id=$2', [db.tenant, caseId])
      await db.q('delete from pro_mining_cases where case_id=$1', [caseId])
      await db.q('delete from pro_role_assignments where tenant_id=$1 and proc_def_id=$2', [db.tenant, roleDef])
    })
    await db.q(`insert into pro_role_assignments(tenant_id,proc_def_id,role,user_id,updated_by) values ($1,$2,$3,$4,$4)`, [db.tenant, roleDef, role, designer.id])
    await rec.openCase({ userId: me.id, mail, customer: '회귀 고객', files: [file] })
    await rec.recordStep(caseId, '요청 메일 접수', { to: { id: me.id, name: '회귀 영업' } })
    // a designer (role 디자이너) → 디자인 검토; someone without a role, asked about the amounts → 재무 검토
    await rec.recordShare({ id: me.id }, [{ name: file }], [{ id: designer.id, name: '회귀 디자이너' }], '도면 봐 주세요')
    await rec.recordShare({ id: me.id }, [{ name: file }], [{ id: plain.id, name: '회귀 동료' }], '견적 금액과 부가세 확인 부탁해요')
    await rec.recordReply({ id: me.id, email: me.email }, { source: { mail_id: mail.id } })
    // after the reply: a share is not part of the case
    await rec.recordShare({ id: me.id }, [{ name: file }], [{ id: plain.id, name: '회귀 동료' }], '견적 금액 다시 봐 주세요')
    const evs = await db.q(`select norm_activity_label as l, to_role from handover_events where tenant_id=$1 and case_id=$2 order by occurred_at`, [db.tenant, caseId])
    expect(evs.map((e) => e.l)).toEqual(['요청 메일 접수', '디자인 검토', '재무 검토', '고객 회신'])
    expect(evs[1].to_role).toBe(role)
    // a group found again with more cases is the recommendation those cases already make
    const sid = crypto.randomUUID()
    cleanup(() => db.q('delete from pro_mining_suggestions where id=$1', [sid]))
    const cases = ['a', 'b', 'c', 'd'].map((x) => `rt-fx2:${RUN}:${x}`)
    await db.q(`insert into pro_mining_suggestions (id, tenant_id, pattern_key, process_id, name, pattern, status) values ($1,$2,$3,$4,$5,$6,'registered')`,
      [sid, db.tenant, `rt-fx2-${RUN}`, `mined_rt_fx2_${RUN}`, `회귀 추천 ${RUN}`, { case_ids: cases, case_count: 4, main_variant: [] }])
    expect(await svc.sameSuggestion({ key: `rt-fx2-other-${RUN}`, case_ids: [...cases, `rt-fx2:${RUN}:e`, `rt-fx2:${RUN}:f`] })).toMatchObject({ id: sid, status: 'registered' })
    expect(await svc.sameSuggestion({ key: `rt-fx2-new-${RUN}`, case_ids: [`rt-fx2:${RUN}:x`, `rt-fx2:${RUN}:y`, `rt-fx2:${RUN}:z`, cases[0]] })).toBeNull()
  })
})

test.describe('튜토리얼 결함 수정 2 — 미션·예약', () => {
  test('F-FX2-06 실패한 예약 실행은 실행 기록·채팅·Home 에 보인다', async ({ as, db, lib, cleanup }) => {
    const a = await as('fx2-sched')
    const M = await lib('lib/missions.js')
    const [s] = await db.q(`insert into pro_schedules (user_id, name, cron, prompt, process_id, params, notify) values ($1,$2,'0 9 * * *','회귀',$3,'{}','always') returning id`,
      [a.id, `회귀 예약 ${RUN}`, `rt-fx2-no-such-process-${RUN}`])
    cleanup(async () => {
      await db.q('delete from pro_mission_runs where schedule_id=$1', [s.id])
      await db.q('delete from pro_schedules where id=$1', [s.id])
      await db.q(`delete from notifications where url=$1`, [`/settings/schedules?open=${s.id}`])
    })
    const run = await M.runMission(s.id, 'manual')
    expect(run.status).toBe('failed')
    const runs = (await a.get(`/missions/${s.id}/runs`)).body
    expect(runs[0]).toMatchObject({ status: 'failed' })
    const n = (await a.get('/notifications')).body.find((x) => x.type === 'mission_failed' && x.url === `/settings/schedules?open=${s.id}`)
    expect(n?.title).toContain(`회귀 예약 ${RUN}`)
    const th = await db.mainThreadId(a.id)
    const said = await db.q(`select content->>'text' as t from pro_messages where thread_id=$1 and kind='text' and created_at > now() - interval '2 minutes' order by created_at desc limit 3`, [th])
    expect(said.some((m) => /예약 실행이 실패했어요/.test(m.t))).toBe(true)
    // a paused task is not run by its schedule, only by hand
    await db.q('update pro_schedules set paused=true where id=$1', [s.id])
    expect(await M.runMission(s.id, 'cron')).toBeNull()
  })
})

test.describe('튜토리얼 결함 수정 2 — 패널 앱·작업실·스킬 검증', () => {
  const QUOTES = {
    title: `회귀 견적 현황판 ${RUN}`, icon: '📋',
    fields: [{ key: 'customer', label: '고객사', type: 'text', required: true }, { key: 'amount', label: '견적 금액', type: 'number', required: true },
      { key: 'stage', label: '단계', type: 'choice', choices: ['견적', '수주'] }],
    views: { list: { title: 'customer', subtitle: ['customer', 'stage'], value: 'amount', valueSuffix: '원' },
      summary: [{ label: '견적 합계', agg: 'sum', field: 'amount', suffix: '원' }, { label: '수주 건수', agg: 'count_where', field: 'stage', eq: '수주', suffix: '건' }, { label: '전체', agg: 'count', suffix: '건' }] },
  }

  test('F-FX2-07 패널: "3,800만 원" 같은 한국어 금액이 들어가고, 큰 합계가 옆 타일로 넘치지 않음(폭 1280)', async ({ pageAs, lib, db, cleanup }) => {
    const page = await pageAs('fx2-owner', { viewport: { width: 1280, height: 800 } })
    const o = page.user
    const { app } = await makeApp(lib, o, QUOTES).then((x) => { cleanup(() => x.cleanup(db)); return x })
    const add = await o.post(`/panel-apps/${app.id}/rows`, { values: { 고객사: '해솔베이커리', 견적금액: '3,800만 원', 단계: '견적' } })
    expect(add.status, add.text).toBe(200)
    expect(add.body.row.amount).toBe(38000000)
    expect((await o.post(`/panel-apps/${app.id}/rows`, { values: { customer: '달빛커피', amount: '6,775만 6천원', stage: '견적' } })).body.row.amount).toBe(67756000)
    await page.goto('/chat')
    const card = page.locator('.dock .pa').filter({ hasText: app.title }).first()
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card.locator('.sum')).toContainText('105,756,000')
    const boxes = await card.locator('.sum .cell').evaluateAll((cells) => cells.map((c) => {
      const v = c.querySelector('.v'), r = c.getBoundingClientRect(), b = v.getBoundingClientRect()
      return { cell: [r.left, r.right], v: [b.left, b.right], overflow: v.scrollWidth - v.clientWidth }
    }))
    for (const b of boxes) {
      expect(b.v[1], JSON.stringify(boxes)).toBeLessThanOrEqual(b.cell[1] + 0.5)
      expect(b.overflow).toBeLessThanOrEqual(1)
    }
    expect(page.errors).toEqual([])
  })

  test('F-FX2-08 대화 폴더 밖 /workspace/<이름> 파일 카드: 누르면 열림(저장소 사본), 남의 카드·작업 공간 밖 경로는 거절', async ({ pageAs, as, db, cleanup }) => {
    test.skip(!fss.existsSync(WORKSPACE), `deepagents 작업 공간 없음: ${WORKSPACE}`)
    const page = await pageAs('fx2-owner')
    const a = page.user, other = await as('fx2-other')
    const name = `rt-fx2-${RUN}.txt`
    await fs.writeFile(path.join(WORKSPACE, name), `회귀 메모 ${RUN}\n`)
    cleanup(() => fs.rm(path.join(WORKSPACE, name), { force: true }))
    const th = await db.mainThreadId(a.id)
    const [m, bad] = await db.addMessages(th, [
      { role: 'agent', kind: 'file', content: { name, path: `/workspace/${name}` } },
      { role: 'agent', kind: 'file', content: { name: 'passwd', path: '/workspace/../../etc/passwd' } },
    ])
    cleanup(() => db.q('delete from pro_messages where id = any($1)', [[m.id, bad.id]]))
    expect((await other.post(`/messages/${m.id}/open-file`)).status, '남의 카드').toBe(404)
    expect((await a.post(`/messages/${bad.id}/open-file`)).status, '작업 공간 밖').toBe(400)
    await page.goto('/chat')
    const fileCard = page.locator('.fmeta').filter({ hasText: name }).first()
    await expect(fileCard).toBeVisible({ timeout: 20_000 })
    await expect(fileCard).toContainText('눌러서 열기')
    const [popup] = await Promise.all([page.context().waitForEvent('page', { timeout: 20_000 }), fileCard.click()])
    await popup.waitForURL(/\/storage\/v1\/object\/public\/files\//, { timeout: 20_000 })
    const c = (await db.q('select content from pro_messages where id=$1', [m.id]))[0].content
    expect(c.url).toBe(popup.url())
    const got = await fetch(c.url)
    expect(got.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await got.text()).toContain(`회귀 메모 ${RUN}`)
    await expect(fileCard).toContainText('열기')
  })

  test('F-FX2-09 스킬 변형 검증: 시간 안에 끝나지 않은(서버 재시작 등) 검증은 실패로 닫히고 다시 검증할 수 있음', async ({ as, db, lib, cleanup }) => {
    const o = await as('fx2-owner')
    const f = await o.post('/folders', { name: uniq('회귀 검증'), description: '회귀 시험 폴더' })
    expect(f.status, f.text).toBe(200)
    cleanup(() => removeFolder(db, f.body.slug))
    const v = await o.post(`/folders/${f.body.slug}/variations`, { title: '회귀 변형' })
    expect(v.status, v.text).toBe(200)
    const [folder] = await db.q('select id from pro_folders where slug=$1', [f.body.slug])
    const [row] = await db.q(`insert into pro_skill_verifications (folder_id, variation_id, mode, status, created_by, created_at) values ($1,$2,'local','running',$3, now() - interval '40 minutes') returning id`,
      [folder.id, v.body.id, o.id])
    const SK = await lib('lib/folders/skills.js')
    const r = await SK.latestVerification({ id: v.body.id })
    expect(r).toMatchObject({ id: row.id, status: 'failed' })
    expect(r.error).toMatch(/다시 검증/)
    // a fresh one is left alone
    const [fresh] = await db.q(`insert into pro_skill_verifications (folder_id, variation_id, mode, status, created_by) values ($1,$2,'local','running',$3) returning id`, [folder.id, v.body.id, o.id])
    expect((await SK.latestVerification({ id: v.body.id }))).toMatchObject({ id: fresh.id, status: 'running' })
  })
})
