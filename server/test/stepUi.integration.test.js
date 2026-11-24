// 단계 입력 화면(lib/stepUi, 스펙 step-ui-a2ui) — 실제 DB · 실제 Express 라우트(routes/process.js, 로그인만 대역) · 가짜 모델 서버.
// 「지도에서 바로」 도는 건의 행(pro_po_cases · bpm_proc_inst · todolist · pro_case_steps)을 엔진이 쓰는 모양으로 넣고:
//   - 사람 단계가 열리면(mapengine.toPerson) 화면을 만들어 둔다 → GET /todos/:id 에 form 옆 ui → 맡은 사람만 낸다(남은 403) → 서버가 다시
//     보고(400) → 값은 {<formId>: 값 + result + a2ui} → 다음 단계가 읽는 앞 단계 글(earlierOfCase)에 result
//   - 모델이 엉뚱한 화면을 두 번 → 글 한 칸(fallback), 그 단계는 지금처럼 낸다
//   - 먼저 열면 그때 만든다(making → ready) · 꺼 두면 없다 · 초안 단계는 초안이 온 뒤 그것을 첫 값으로 · 맡은 사람의 언어로
//   - 비밀을 묻는 화면이라고 판정 모델이 읽으면 쓰지 않는다
// 지도(Ontological)는 쓰지 않는다 — 낸 뒤 다음 단계를 정하는 일은 지도가 없어 멈추고(로그에 남음), 이 시험은 그 앞까지 본다.
// Run: node --test test/stepUi.integration.test.js  (needs the local Supabase)
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

process.env.DOTENV_CONFIG_QUIET = 'true'
process.env.PRO_BACKGROUND = '0'
process.env.PRO_TENANT_ID = 'localhost'
delete process.env.PRO_TENANT_FROM_HEADER
// nothing shared is reached: no agents, no router, no map store, a fake model on this test's own port
process.env.PRO_DEEPAGENTS_URL = 'http://127.0.0.1:9'
process.env.PRO_CONTEXT_ROUTER_URL = ''
process.env.PRO_MEMENTO_URL = 'http://127.0.0.1:9'
process.env.PRO_ONTOLOGY_BOLT_URL = ''
process.env.PRO_STEP_UI = 'on'
const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'step-ui-review.json'), 'utf8'))

// the fake model: a step-ui prompt gets the fixture screen (the draft's text as the opinion's first value), or a broken one; a judge's
// first-token read says 「A」(no secret) unless told otherwise
const fake = { mode: 'good', secret: false, inputs: [], systems: [], calls: 0 }
const llm = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    fake.calls++
    const b = JSON.parse(body || '{}')
    res.writeHead(200, { 'content-type': 'application/json' })
    if (b.logprobs) {
      const letter = fake.secret ? 'B' : 'A', other = letter === 'A' ? 'B' : 'A'
      return res.end(JSON.stringify({ choices: [{ message: { content: letter }, logprobs: { content: [{ token: letter, logprob: Math.log(0.95), top_logprobs: [{ token: letter, logprob: Math.log(0.95) }, { token: other, logprob: Math.log(0.05) }] }] } }] }))
    }
    const system = String(b.messages?.[0]?.content || '')
    let content = '{}'
    if (system.includes('입력 화면을 만듭니다')) {
      const input = JSON.parse(b.messages[1].content)
      fake.inputs.push(input); fake.systems.push(system)
      const screen = structuredClone(FIXTURE)
      if (input.draft?.text) screen.createSurface.dataModel.form.opinion = input.draft.text
      content = fake.mode === 'good' ? JSON.stringify(screen) : JSON.stringify({ version: '1.0', createSurface: { surfaceId: 'x', components: [{ id: 'root', component: 'Image', url: 'https://example.com/a.png' }] } })
    }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
  })
})
await new Promise((ok) => llm.listen(0, '127.0.0.1', ok))
process.env.PRO_LLM_BASE_URL = `http://127.0.0.1:${llm.address().port}/v1`
process.env.PRO_LLM_API_KEY = 'test'
process.env.PRO_LLM_MODEL = 'fake-ui'
process.env.PRO_LLM_FAST_MODEL = 'fake-ui'

const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_step_ui limit 1').then(() => true).catch(() => false)
const U = await import('../lib/stepUi/index.js')
const M = await import('../lib/ontology/mapengine.js')
const RM = await import('../lib/ontology/runmode.js')

const users = [], cases = [], closers = []
after(async () => {
  for (const c of closers) c()
  for (const c of cases) {
    await q('delete from pro_step_ui where proc_inst_id=$1', [c.instId]).catch(() => {})
    await q('delete from pro_case_steps where case_id=$1', [c.id]).catch(() => {})
    await q('delete from todolist where proc_inst_id=$1', [c.instId]).catch(() => {})
    await q('delete from bpm_proc_inst where proc_inst_id=$1', [c.instId]).catch(() => {})
    await q('delete from pro_po_cases where id=$1', [c.id]).catch(() => {})
  }
  for (const u of users) {
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch(() => {})
    await q('delete from pro_threads where user_id=$1', [u.id]).catch(() => {})
    await q('delete from notifications where user_id=$1 or user_id=$2', [u.id, u.email]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [u.id]).catch(() => {})
    await q('delete from users where id=$1', [u.id]).catch(() => {})
  }
  await pool.end()
  llm.close()
})

async function person(name, lang = 'ko') {
  const id = crypto.randomUUID()
  const u = { id, email: `stepui-${id.slice(0, 8)}@example.test`, name }
  users.push(u)
  await q(`insert into users (id, email, username, tenant_id) values ($1,$2,$3,'localhost')`, [id, u.email, name])
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [id, name, u.email])
  if (lang !== 'ko') await q('update pro_profile set lang=$2 where user_id=$1', [id, lang])
  return u
}

const actId = (task) => `t_${crypto.createHash('sha1').update(String(task)).digest('hex').slice(0, 10)}`
// a map case with one finished step (요청 정리) and a person's step (견적 검토) as mapengine.createItem makes them
async function mapCase(owner, { kind = 'person', status = 'TODO', draft = null, task = '견적 검토' } = {}) {
  const instId = `onto-map.${crypto.randomUUID()}`
  const request = { subject: '한빛상사 교육장 인테리어 견적 요청', body: '2층 교육장(40석) 인테리어 견적을 부탁드립니다. 다음 달 10일까지 완료가 목표예요.', customer: '한빛상사', sender: '윤태호 <yoon@hanbit.example.test>' }
  const [c] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, instances, engine, request, run_mode, bindings)
                       values ('localhost','process:stepui-test','요청 정리',$1,$2,$3,'map',$4,'hotl','[]') returning id::text as id`,
  [owner.id, { kind: 'mail', subject: request.subject, from: request.sender }, [instId], request])
  cases.push({ id: c.id, instId })
  await q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, tenant_id, status, start_date, participants, current_activity_ids, updated_at)
           values ($1,$2,null,'localhost','RUNNING',now(),$3,'{}',now())`, [instId, `견적 · ${request.subject}`, [owner.id]])
  const prev = actId('요청 정리')
  await q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, output, start_date, end_date)
           values (gen_random_uuid(),'localhost',$1,$2,$2,$3,'요청 정리','DONE',$4, now() - interval '1 hour', now() - interval '50 minutes')`,
  [owner.id, instId, prev, { [`onto-map_${prev}_form`]: { result: '고객 한빛상사 · 2층 교육장 40석 · 예산 2,600만 원 안 · 납기 다음 달 10일' } }])
  const aid = actId(task), formId = `onto-map_${aid}_form`
  const agent = kind === 'draft' ? crypto.randomUUID() : null
  const [t] = await q(`insert into todolist (id, tenant_id, user_id, username, proc_inst_id, root_proc_inst_id, activity_id, activity_name, status, tool, description, start_date, agent_mode, agent_orch, draft)
                       values (gen_random_uuid(),'localhost',$1,$2,$3,$3,$4,$5,$6::todo_status,$7,$8,now(),$9::agent_mode,$10,$11) returning id::text as id`,
  [[agent, owner.id].filter(Boolean).join(','), owner.name, instId, aid, task, status, `formHandler:${formId}`, '견적 금액과 납기를 확인해 진행 여부를 정한다',
    kind === 'draft' ? 'DRAFT' : null, kind === 'draft' ? 'test-orch' : null, draft ? { [formId]: draft } : null])
  const act = { id: aid, name: task, role: '영업', tool: `formHandler:${formId}`, skills: [], checkpoints: ['단가표와 맞춰 보기'], outputs: ['검토 결과', '확정 금액', '납기'],
    description: '견적 금액과 납기를 확인해 진행 여부를 정한다', instruction: '단가표와 맞지 않으면 금액을 조정한다', runner: kind === 'draft' ? 'draft' : 'person', ...(agent ? { agent, agentMode: 'draft' } : { agentMode: 'none' }) }
  await q(`insert into pro_case_steps (tenant_id, case_id, proc_inst_id, todo_id, task, kind, mode, state, act) values ('localhost',$1,$2,$3,$4,$5,'hotl','auto',$6)`, [c.id, instId, t.id, task, kind, act])
  return { caseId: c.id, instId, todoId: t.id, formId, task }
}

// the process routes as the server mounts them, signed in by a header (the real sign-in is not under test)
let base = null
async function server() {
  if (base) return base
  const express = (await import('express')).default
  const { processRoutes } = await import('../routes/process.js')
  const app = express()
  app.use(express.json({ limit: '2mb' }))
  const auth = (req, res, next) => {
    const u = users.find((x) => x.id === req.headers['x-test-user'])
    if (!u) return res.status(401).json({ error: 'unauthorized' })
    req.user = { ...u }; req.session = { access_token: 'test' }; next()
  }
  app.use('/api', processRoutes(auth))
  const s = await new Promise((ok) => { const x = app.listen(0, '127.0.0.1', () => ok(x)) })
  closers.push(() => s.close())
  base = `http://127.0.0.1:${s.address().port}/api`
  return base
}
async function call(u, method, p, body) {
  const r = await fetch(`${await server()}${p}`, { method, headers: { 'x-test-user': u.id, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: r.status, body: json, text }
}
const row = async (todoId) => (await q('select * from pro_step_ui where todo_id=$1', [todoId]))[0]
const todo = async (todoId) => (await q('select status::text as status, output, user_id from todolist where id=$1', [todoId]))[0]
async function until(what, fn, ms = 20000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`시간 초과: ${what}`)
    await new Promise((r) => setTimeout(r, 150))
  }
}
const actionOf = (ui, name = 'submit') => {
  const b = ui.createSurface.components.find((c) => c.component === 'Button' && c.action?.event?.name === name)
  return { name, surfaceId: ui.createSurface.surfaceId, sourceComponentId: b.id, timestamp: new Date().toISOString(), context: {} }
}

test('사람 단계가 열리면 화면을 만들어 두고 → GET 에 form 옆 ui → 맡은 사람만 · 서버가 다시 보고 → 값 + result → 다음 단계가 읽는다', { skip: !db }, async () => {
  fake.mode = 'good'; fake.secret = false
  const yoon = await person('윤태호'), seo = await person('서하린')
  const s = await mapCase(yoon)
  const before = fake.inputs.length
  // the step opens for its person (the gate let it): the screen is made without holding the engine
  const opened = await M.toPerson(s.todoId)
  assert.equal(opened.id, s.todoId)
  await until('화면', async () => (await row(s.todoId))?.status === 'ready')
  const r = await row(s.todoId)
  assert.equal(r.surface.createSurface.surfaceId, `step_${s.todoId.replace(/-/g, '')}`)
  assert.equal(r.catalog_id, 'https://process-gpt.io/a2ui/catalogs/lite-step/v1/catalog.json')
  assert.equal(r.lang, 'ko')
  assert.equal(r.tries, 1)
  // what the model saw: the step, its definition, the request, the earlier step's result, the person's language
  const input = fake.inputs[before]
  assert.equal(input.lang, 'ko')
  assert.equal(input.step, '견적 검토')
  assert.deepEqual(input.definition.outputs, ['검토 결과', '확정 금액', '납기'])
  assert.deepEqual(input.definition.checkpoints, ['단가표와 맞춰 보기'])
  assert.match(input.request.subject, /한빛상사/)
  assert.match(input.earlier[0].text, /예산 2,600만 원/)
  assert.equal(input.draft, undefined)
  // the work item: the classic form still there, the screen next to it
  const g = await call(yoon, 'GET', `/todos/${s.todoId}`)
  assert.equal(g.status, 200, g.text)
  assert.equal(g.body.uiState, 'ready')
  assert.equal(g.body.ui.createSurface.surfaceId, r.surface.createSurface.surfaceId)
  assert.deepEqual(g.body.form.fields.map((f) => f.key), ['result'])
  assert.equal(g.body.form.id, s.formId)
  const ui = g.body.ui
  const good = { decision: ['adjust'], amount: '24500000', due: '2026-12-10', checked: true, opinion: '설계비 300만 원을 250만 원으로 조정해 주세요.\n납기는 그대로예요.' }
  // someone else cannot hand it in
  const other = await call(seo, 'POST', `/todos/${s.todoId}/submit`, { values: good, a2ui: { version: '1.0', action: actionOf(ui) } })
  assert.equal(other.status, 403, other.text)
  // the server reads it again: the screen's checks, a button it does not have, a choice it does not offer, a mis-shaped action
  const empty = await call(yoon, 'POST', `/todos/${s.todoId}/submit`, { values: { ...good, decision: [] }, a2ui: { version: '1.0', action: actionOf(ui) } })
  assert.equal(empty.status, 400, empty.text)
  assert.match(empty.body.error, /검토 결과를 골라 주세요/)
  const ghost = await call(yoon, 'POST', `/todos/${s.todoId}/submit`, { values: good, a2ui: { version: '1.0', action: { ...actionOf(ui), name: 'approve_all' } } })
  assert.equal(ghost.status, 400)
  const offList = await call(yoon, 'POST', `/todos/${s.todoId}/submit`, { values: { ...good, decision: ['approve_all'] }, a2ui: { version: '1.0', action: actionOf(ui) } })
  assert.equal(offList.status, 400)
  const shapeless = await call(yoon, 'POST', `/todos/${s.todoId}/submit`, { values: good, a2ui: { version: '1.0', action: { name: 'submit' } } })
  assert.equal(shapeless.status, 400)
  assert.equal((await todo(s.todoId)).status, 'IN_PROGRESS', '걸린 제출은 단계를 닫지 않음')
  // handed in: values under the form id, the text the next steps read, what was pressed
  const ok = await call(yoon, 'POST', `/todos/${s.todoId}/submit`, { values: { ...good, injected: '<script>x</script>', result: '가짜 결과' }, a2ui: { version: '1.0', action: actionOf(ui) } })
  assert.equal(ok.status, 200, ok.text)
  const t = await todo(s.todoId)
  assert.equal(t.status, 'DONE')
  const v = t.output[s.formId]
  assert.deepEqual(Object.keys(v).sort(), ['a2ui', 'amount', 'checked', 'decision', 'due', 'opinion', 'result'])
  assert.deepEqual(v.decision, ['adjust'])
  assert.equal(v.result, '결정: 검토 결과 보내기\n검토 결과: 금액 조정 후 진행\n확정 금액(원): 24500000\n납기일: 2026-12-10\n단가표와 맞춰 봤어요: 예\n검토 의견:\n설계비 300만 원을 250만 원으로 조정해 주세요.\n납기는 그대로예요.')
  assert.equal(v.a2ui.event, 'submit')
  assert.equal(v.a2ui.button, '검토 결과 보내기')
  assert.equal(v.a2ui.surfaceId, ui.createSurface.surfaceId)
  // the next step reads it as the earlier step's text (runmode.js earlierOfCase — what draft-step · gates · rules read)
  const earlier = await RM.earlierOfCase({ instances: [s.instId] })
  assert.equal(earlier.at(-1).task, '견적 검토')
  assert.equal(earlier.at(-1).text, v.result)
  // opened again: the screen with what was handed in
  const again = await call(yoon, 'GET', `/todos/${s.todoId}`)
  assert.equal(again.body.todo.status, 'DONE')
  assert.equal(again.body.uiState, 'ready')
  assert.deepEqual(again.body.uiValues.decision, ['adjust'])
  // and it cannot be handed in twice
  const twice = await call(yoon, 'POST', `/todos/${s.todoId}/submit`, { values: good, a2ui: { version: '1.0', action: actionOf(ui) } })
  assert.equal(twice.status, 409)
  // nothing written as a form definition
  assert.equal(Number((await q(`select count(*) n from form_def where id = $1`, [s.formId]))[0].n), 0)
})

test('모델이 엉뚱한 화면을 두 번 만들면 글 한 칸 — 그 단계는 지금처럼 낸다(화면으로 내기는 409)', { skip: !db }, async () => {
  fake.mode = 'broken'; fake.secret = false
  const yoon = await person('윤태호')
  const s = await mapCase(yoon)
  const before = fake.inputs.length
  await M.toPerson(s.todoId)
  await until('글 한 칸', async () => (await row(s.todoId))?.status === 'fallback')
  const r = await row(s.todoId)
  assert.equal(r.tries, 2)
  assert.equal(r.surface, null)
  assert.ok(r.errors.some((e) => /unknown component Image/.test(e)), JSON.stringify(r.errors))
  assert.equal(fake.inputs.length - before, 2, '한 번 더 물었다')
  assert.match(fake.systems.at(-1), /입력 화면을 만듭니다/)
  const g = await call(yoon, 'GET', `/todos/${s.todoId}`)
  assert.equal(g.body.uiState, 'fallback')
  assert.equal(g.body.ui, undefined)
  assert.deepEqual(g.body.form.fields.map((f) => [f.key, f.type]), [['result', 'textarea']])
  const viaScreen = await call(yoon, 'POST', `/todos/${s.todoId}/submit`, { values: {}, a2ui: { version: '1.0', action: { name: 'submit', surfaceId: 'x', sourceComponentId: 'send', timestamp: new Date().toISOString(), context: {} } } })
  assert.equal(viaScreen.status, 409)
  const classic = await call(yoon, 'POST', `/todos/${s.todoId}/submit`, { values: { result: '금액 그대로 진행해요.' } })
  assert.equal(classic.status, 200, classic.text)
  assert.deepEqual((await todo(s.todoId)).output, { [s.formId]: { result: '금액 그대로 진행해요.' } })
})

test('먼저 열면 그때 만든다(making → ready) · 꺼 두면 화면 없음 · 맡은 사람의 언어(영어)로', { skip: !db }, async () => {
  fake.mode = 'good'; fake.secret = false
  const harin = await person('서하린', 'en')
  const s = await mapCase(harin, { status: 'IN_PROGRESS' })
  process.env.PRO_STEP_UI = 'off'
  const off = await call(harin, 'GET', `/todos/${s.todoId}`)
  assert.equal(off.body.uiState, undefined)
  assert.equal(off.body.ui, undefined)
  process.env.PRO_STEP_UI = 'on'
  const first = await call(harin, 'GET', `/todos/${s.todoId}`)
  assert.equal(first.body.uiState, 'making')
  assert.equal(first.body.uiWait, 60)
  const ready = await until('화면', async () => { const g = await call(harin, 'GET', `/todos/${s.todoId}`); return g.body.uiState === 'ready' ? g : null })
  assert.ok(ready.body.ui)
  assert.equal(fake.inputs.at(-1).lang, 'en')
  assert.match(fake.systems.at(-1), /LANGUAGE: English/)
  assert.equal((await row(s.todoId)).lang, 'en')
  // a TODO step (its gate has not let it go yet) gets no screen
  const waiting = await mapCase(harin, { status: 'TODO' })
  const w = await call(harin, 'GET', `/todos/${waiting.todoId}`)
  assert.equal(w.body.uiState, undefined)
  assert.equal(await row(waiting.todoId), undefined)
})

test('초안 단계: 초안이 오기 전엔 지금의 칸, 초안이 오면 그것을 첫 값으로 다시 만든다', { skip: !db }, async () => {
  fake.mode = 'good'; fake.secret = false
  const yoon = await person('윤태호')
  const s = await mapCase(yoon, { kind: 'draft', status: 'IN_PROGRESS' })
  const g0 = await call(yoon, 'GET', `/todos/${s.todoId}`)
  assert.equal(g0.body.uiState, undefined, '초안이 아직 없음')
  // the agent saves its draft (run.js: save_task_result, then the screen again)
  const draft = { result: '단가표 기준으로 설계비가 50만 원 높아요. 조정 후 진행을 권해요.', title: '견적 검토 초안', summary: '조정 후 진행 권함' }
  await q('update todolist set draft=$2 where id=$1', [s.todoId, { [s.formId]: draft }])
  await U.soon(s.todoId, { redo: true })
  const r = await row(s.todoId)
  assert.equal(r.status, 'ready')
  assert.equal(fake.inputs.at(-1).draft.text, draft.result)
  assert.equal(r.surface.createSurface.dataModel.form.opinion, draft.result)
  const g = await call(yoon, 'GET', `/todos/${s.todoId}`)
  assert.equal(g.body.uiState, 'ready')
  assert.equal(g.body.ui.createSurface.dataModel.form.opinion, draft.result)
  // the draft changes: made again (the view says making until then)
  await q('update todolist set draft=$2 where id=$1', [s.todoId, { [s.formId]: { ...draft, result: '다시 쓴 초안' } }])
  const g2 = await call(yoon, 'GET', `/todos/${s.todoId}`)
  assert.equal(g2.body.uiState, 'making')
  await until('다시 만든 화면', async () => (await row(s.todoId))?.surface?.createSurface?.dataModel?.form?.opinion === '다시 쓴 초안')
})

test('비밀 · 결제 정보를 묻는 화면이라고 판정 모델이 읽으면 쓰지 않는다(글 한 칸)', { skip: !db }, async () => {
  fake.mode = 'good'; fake.secret = true
  const yoon = await person('윤태호')
  const s = await mapCase(yoon)
  await M.toPerson(s.todoId)
  await until('글 한 칸', async () => (await row(s.todoId))?.status === 'fallback')
  assert.match((await row(s.todoId)).errors[0], /asks for a secret or payment data/)
  fake.secret = false
})
