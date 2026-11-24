// 단계 입력 화면(lib/stepUi) 시연 자료: 한 사람의 「지도에서 바로」 건 하나를 사람 단계(견적 검토)에 세워 두고, 그 할 일 카드를 그 사람의
// 메인 채팅에 둔다. 엔진이 쓰는 모양 그대로(pro_po_cases · bpm_proc_inst 한 행 · 앞 단계 하나 끝남 · 사람 단계 열림 · pro_case_steps)이고,
// 지도(Ontological)는 쓰지 않는다. 화면은 서버의 모델(server/.env PRO_LLM_*)로 지금 만들어 둔다(--lazy: 카드를 열 때 만든다).
//   node scripts/seed-step-ui-demo.mjs --email <계정> [--task 견적 검토|출장비 정산 승인] [--draft] [--lazy] [--tenant localhost]
//   node scripts/seed-step-ui-demo.mjs --email <계정> --remove      이 시드가 넣은 건만 지움(request.seed = 'step-ui-demo')
// 계정은 이 테넌트에 이미 있는 사람(users.email). 회사 · 사람 이름은 지어낸 것이다.
process.env.DOTENV_CONFIG_QUIET = 'true'
import crypto from 'node:crypto'

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const has = (k) => process.argv.includes(k)
const email = arg('--email')
const tenant = arg('--tenant', process.env.PRO_TENANT_ID || 'localhost')
if (!email) { console.error('usage: node scripts/seed-step-ui-demo.mjs --email <account> [--task …] [--draft] [--lazy] [--remove]'); process.exit(1) }
process.env.PRO_TENANT_ID = tenant
const { q, pool } = await import('../lib/supa.js')
const { withTenant } = await import('../lib/tenant.js')
const SEED = 'step-ui-demo'

const [me] = await q('select id::text as id, coalesce(nullif(username,\'\'), email) as name from users where email=$1 and tenant_id=$2', [email, tenant])
if (!me) { console.error(`no user ${email} in tenant ${tenant}`); process.exit(1) }

async function remove() {
  const cs = await q(`select id::text as id, instances from pro_po_cases where tenant_id=$1 and started_by=$2 and request->>'seed'=$3`, [tenant, me.id, SEED])
  for (const c of cs) {
    const inst = c.instances[0]
    const todos = (await q('select id::text as id from todolist where proc_inst_id=$1', [inst])).map((t) => t.id)
    await q('delete from pro_step_ui where proc_inst_id=$1', [inst])
    await q('delete from pro_case_steps where case_id=$1', [c.id])
    await q(`delete from pro_messages where kind='todo' and content->>'todoId' = any($1)`, [todos])
    await q('delete from todolist where proc_inst_id=$1', [inst])
    await q('delete from bpm_proc_inst where proc_inst_id=$1', [inst])
    await q('delete from pro_threads where ref=$1', [inst])
    await q('delete from pro_po_cases where id=$1', [c.id])
  }
  return cs.length
}

const TASKS = {
  '견적 검토': {
    request: { subject: '한빛상사 2층 교육장 인테리어 견적 요청', body: '40석 교육장 인테리어 견적을 부탁드립니다. 다음 달 10일까지 완료를 원합니다.', customer: '한빛상사', sender: '윤태호 <yoon@hanbit.example.test>' },
    before: { task: '견적서 작성', result: '설계비 3,000,000원 · 시공비 23,070,000원 · 합계 26,070,000원 · 유효기간 30일' },
    act: { role: '영업', description: '고객에게 보낼 견적의 금액 · 납기 · 조건을 확인하고 진행 여부를 정한다', instruction: '단가표와 맞지 않으면 금액을 조정하고 까닭을 남긴다',
      outputs: ['검토 결과', '확정 금액', '납기'], checkpoints: ['단가표와 대조', '할인율 20% 이하'] },
    draft: { title: '견적 검토 초안', summary: '설계비 조정 후 진행 권함', result: '단가표 기준으로 설계비가 50만 원 높아요. 설계비를 2,500,000원으로 조정하고 납기는 그대로 진행하기를 권해요.' },
  },
  '출장비 정산 승인': {
    request: { subject: '[정산] 부산 고객사 방문 출장비', body: '11월 18~19일 부산 출장 교통비 118,400원, 숙박 89,000원, 식비 54,000원 정산 요청드립니다.', customer: '', sender: '서하린 <seo@example.test>' },
    before: { task: '정산 요청 접수', result: '출장 2일 · 합계 261,400원 · 영수증 3장' },
    act: { role: '팀장', description: '팀원의 출장비 정산 요청을 보고 승인하거나 반려한다', instruction: '영수증 합계와 규정 한도(1일 15만 원)를 확인한다',
      outputs: ['승인 여부', '승인 금액', '의견'], checkpoints: ['영수증 첨부 확인', '규정 한도 이내'] },
  },
}

await withTenant(tenant, async () => {
  const gone = await remove()
  if (has('--remove')) { console.log(`removed ${gone} seeded case(s) of ${email}`); return }
  const name = arg('--task', '견적 검토')
  const T = TASKS[name]
  if (!T) throw new Error(`unknown --task ${name} (${Object.keys(TASKS).join(', ')})`)
  const actId = (task) => `t_${crypto.createHash('sha1').update(String(task)).digest('hex').slice(0, 10)}`
  const instId = `onto-map.${crypto.randomUUID()}`
  const request = { ...T.request, seed: SEED }
  const [c] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, engine, request, run_mode, bindings)
                       values ($1,'process:step-ui-demo',$2,$3,$4,$5,'map',$6,'hotl','[]') returning id::text as id`,
  [tenant, T.before.task, me.id, { kind: 'mail', subject: request.subject, from: request.sender }, [instId], request])
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, participants, current_activity_ids, updated_at)
           values ($1,$2,null,$3,'RUNNING',(now() at time zone 'Asia/Seoul'),$4,'{}',now())`, [instId, `${name} · ${request.subject}`.slice(0, 120), tenant, [me.id]])
  const prev = actId(T.before.task)
  await q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, output, start_date, end_date)
           values (gen_random_uuid(),$1,$2,$3,$3,$4,$5,'DONE',$6,(now() at time zone 'Asia/Seoul') - interval '1 hour',(now() at time zone 'Asia/Seoul') - interval '50 minutes')`,
  [tenant, me.id, instId, prev, T.before.task, { [`onto-map_${prev}_form`]: { result: T.before.result } }])
  const aid = actId(name), formId = `onto-map_${aid}_form`
  const draft = has('--draft') && T.draft ? { [formId]: T.draft } : null
  const [t] = await q(`insert into todolist (id, tenant_id, user_id, username, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, tool, description, start_date, draft)
                       values (gen_random_uuid(),$1,$2,$3,$4,$4,$5,$6,'TODO',$7,$8,(now() at time zone 'Asia/Seoul'),$9) returning id::text as id`,
  [tenant, me.id, me.name, instId, aid, name, `formHandler:${formId}`, T.act.description, draft])
  const act = { id: aid, name, tool: `formHandler:${formId}`, skills: [], runner: 'person', agentMode: 'none', ...T.act }
  await q(`insert into pro_case_steps (tenant_id, case_id, proc_inst_id, todo_id, task, kind, mode, state, act, via) values ($1,$2,$3,$4,$5,'person','hotl','auto',$6,$7)`,
    [tenant, c.id, instId, t.id, name, act, { how: 'single', from: T.before.task, why: '이 흐름의 다음 단계예요' }])
  // the step opens for its person as the engine opens it: the card in their chat, the screen made now (unless --lazy)
  await q(`update todolist set status='IN_PROGRESS' where id=$1`, [t.id])
  const { mainThread, addMessage } = await import('../lib/store.js')
  const th = await mainThread(me.id)
  await addMessage(me.id, th.id, 'agent', 'todo', { todoId: t.id, name })
  console.log(`case ${c.id} · instance ${instId} · work item ${t.id} (${name}) for ${email}`)
  if (!has('--lazy')) {
    const U = await import('../lib/stepUi/index.js')
    const t0 = Date.now()
    const state = await U.soon(t.id)
    const [r] = await q('select status, tries, errors from pro_step_ui where todo_id=$1', [t.id])
    console.log(`screen: ${state} (${r?.tries ?? 0} tries, ${Date.now() - t0}ms)${r?.errors ? ` — ${JSON.stringify(r.errors).slice(0, 300)}` : ''}`)
  }
})
await pool.end()
process.exit(0)
