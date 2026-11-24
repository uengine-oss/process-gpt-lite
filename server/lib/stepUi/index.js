// 단계 입력 화면(스펙 step-ui-a2ui): 「지도에서 바로」 도는 건(ontology/mapengine.js)의 사람 단계에, 그 단계에 맞는 입력 화면을 모델이
// A2UI v1.0 으로 만들어 준다. 엔진 · 일 정의 · 값의 약속은 그대로다:
//   - 언제 만드나: 사람 단계가 그 사람에게 열릴 때(mapengine.js toPerson), 에이전트가 초안을 다 썼을 때(run.js — 초안을 첫 값으로), 그리고
//     그 전에 누가 할 일을 열면 그때(todoView — 만드는 동안은 「만드는 중」). 엔진은 기다리지 않는다(부르고 잊는다).
//   - 무엇을 보고: 일 정의(설명 · 지시 · 남길 것 · 점검 항목) · 요청 · 앞 단계 결과 · 초안, 맡은 사람의 언어로(lang.js asUser).
//   - 어디에: pro_step_ui(sql/053) — 할 일 하나에 화면 하나. 양식 정의(form_def)가 아니다: 그 건 · 그 단계에서 한 번 쓰는 화면이다.
//   - 낼 때: 저장한 화면에 대고 다시 본다(values.js) — 맡은 사람만, 화면에 있는 버튼 · 키 · 꼴 · 검사. 값은 지금처럼 {<formId>: 값}, 그 옆에
//     다음 단계가 읽는 result(라벨: 값)와 무엇을 눌렀는지(a2ui).
//   - 못 만들면(꺼짐 · 모델 오류 · 검사에 두 번 걸림 · 비밀을 묻는 화면): 지금의 글 한 칸(결과) 그대로.
import crypto from 'node:crypto'
import { q } from '../supa.js'
import { config } from '../../config.js'
import { rules as skillRules } from '../ontology/discovery.js'
import { CATALOG_ID } from './catalogInfo.js'
import { checkAction } from './validate.js'
import { readSubmit, resultText } from './values.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
// (mapengine.js MAP_PREFIX — not imported: mapengine imports this module)
const isMapInst = (id) => String(id || '').startsWith('onto-map.')
const CLOSED = ['DONE', 'SUBMITTED', 'CANCELLED']

// the skill's switch and limits; PRO_STEP_UI=off|on wins (an install that wants none, a test that wants it)
export async function settings() {
  const R = (await skillRules().catch(() => ({}))).stepUi || {}
  const env = String(process.env.PRO_STEP_UI || '').trim().toLowerCase()
  return { ...R, enabled: env === 'off' ? false : env === 'on' ? true : R.enabled !== false }
}

// a person's step of a map case (a draft step too: the agent drafts, the person hands it in) — not an agent's own step
export function eligible(t) {
  if (!t || !isMapInst(t.proc_inst_id)) return false
  return !t.agent_orch || String(t.agent_mode || '').toUpperCase() === 'DRAFT'
}
export const surfaceIdOf = (todoId) => `step_${String(todoId).replace(/[^0-9a-f]/gi, '')}`
const formIdOf = (t, act) => (String(act?.tool || '').startsWith('formHandler:') ? act.tool.slice(12) : `${t.activity_id}_form`)
const isDraftStep = (t) => String(t.agent_mode || '').toUpperCase() === 'DRAFT'
// the agent's draft for this step (run.js writes {result, title, summary} under the form id)
function draftOf(t, formId) {
  const d = t.draft?.[formId] || null
  return d && typeof d === 'object' && Object.keys(d).length ? d : null
}
const basisOf = (draft) => (draft ? crypto.createHash('sha1').update(JSON.stringify([draft.result || '', draft.title || '', draft.summary || ''])).digest('hex').slice(0, 16) : '')
// the person the step is for (a draft step lists the agent first)
function personOf(t, act) {
  return String(t.user_id || '').split(',').map((x) => x.trim()).filter((x) => x && x !== act?.agent)[0] || null
}
const staleAfter = (R) => Math.round(((R.timeoutMs || 45000) * (1 + (R.retries ?? 1))) / 1000) + 30

async function stepOf(t) {
  const [s] = await q(`select s.act, s.case_id, c.request, c.trigger, c.instances from pro_case_steps s left join pro_po_cases c on c.id = s.case_id where s.todo_id=$1`, [t.id])
  return s || null
}
const cut = (s, n) => String(s || '').slice(0, n)

// what the model sees (input of prompts/step-ui.md)
export async function inputOf(t, s, act, draft, R, lang) {
  const C = R.inputChars || {}
  const req = s?.request || {}
  const { earlierOfCase } = await import('../ontology/runmode.js')
  const earlier = s?.instances?.length ? await earlierOfCase({ instances: s.instances }).catch(() => []) : []
  return {
    lang,
    today: new Date().toISOString().slice(0, 10),
    step: t.activity_name,
    role: act.role || '',
    definition: { description: cut(act.description, 1500), instruction: cut(act.instruction, 1500), outputs: act.outputs || [], checkpoints: act.checkpoints || [] },
    request: { subject: cut(req.subject || s?.trigger?.subject, 300), body: cut(req.body, C.request ?? 1500), from: cut(req.sender || s?.trigger?.from, 200), customer: cut(req.customer, 200) },
    earlier: earlier.slice(-(C.earlierSteps ?? 5)).map((e) => ({ step: e.task, title: cut(e.title, 160), text: cut(e.text, C.earlier ?? 600) })),
    ...(draft ? { draft: { title: cut(draft.title, 200), summary: cut(draft.summary, 400), text: cut(draft.result, C.draft ?? 3000) } } : {}),
  }
}

// Make (or make again) the screen of a work item. → 'ready' | 'fallback' | 'making' (someone else is on it) | null (not for this step)
export async function ensure(todoId, { redo = false, chatFn, odds } = {}) {
  const R = await settings()
  if (!R.enabled) return null
  const [t] = await q('select * from todolist where id=$1', [todoId])
  if (!t || !eligible(t) || CLOSED.includes(String(t.status))) return null
  const s = await stepOf(t)
  const act = s?.act || {}
  const formId = formIdOf(t, act)
  const draft = draftOf(t, formId)
  const basis = basisOf(draft)
  const person = personOf(t, act)
  if (!person) return null
  // claim the row: a new one, or one that is not being made now (or was left half-made by a server that stopped)
  const [claimed] = await q(`insert into pro_step_ui (todo_id, tenant_id, proc_inst_id, status, catalog_id, basis, updated_at) values ($1,$2,$3,'making',$4,$5,now())
                             on conflict (todo_id) do update set status='making', basis=excluded.basis, errors=null, updated_at=now()
                               where pro_step_ui.status <> 'making' and ($6 or pro_step_ui.basis is distinct from excluded.basis or pro_step_ui.status <> 'ready')
                                  or pro_step_ui.updated_at < now() - make_interval(secs => $7)
                             returning todo_id`, [t.id, T(), t.proc_inst_id, CATALOG_ID, basis, !!redo, staleAfter(R)])
  if (!claimed) {
    const [have] = await q('select status from pro_step_ui where todo_id=$1', [t.id])
    return have?.status || null
  }
  const { asUser, langOf } = await import('../lang.js')
  const lang = await langOf(person)
  try {
    const input = await inputOf(t, s, act, draft, R, lang)
    const { makeSurface } = await import('./generate.js')
    const judge = odds || (R.secretCheck === false ? null : (await import('../decide.js')).oddsOf)
    const out = await asUser(person, () => makeSurface(input, { surfaceId: surfaceIdOf(t.id), R, ...(chatFn ? { chatFn } : {}), odds: judge }))
    const status = out.msg ? 'ready' : 'fallback'
    await q(`update pro_step_ui set status=$2, surface=$3, lang=$4, model=$5, tries=$6, ms=$7, errors=$8, updated_at=now() where todo_id=$1`,
      [t.id, status, out.msg, lang, out.model || null, out.tries || 0, out.ms || null, out.errors?.length ? JSON.stringify(out.errors) : null])
    console.log(`[step-ui] 「${t.activity_name}」 ${status === 'ready' ? `화면 · 칸 ${out.inputs} · 버튼 ${out.buttons}` : `글 한 칸으로(${(out.errors || []).join(' / ').slice(0, 200)})`} — ${out.tries}번 · ${out.ms}ms`)
    return status
  } catch (e) {
    await q(`update pro_step_ui set status='fallback', errors=$2, updated_at=now() where todo_id=$1`, [t.id, JSON.stringify([e.message.slice(0, 300)])]).catch(() => {})
    console.warn('[step-ui]', t.activity_name, e.message)
    return 'fallback'
  }
}

// One at a time per work item on this server, without holding the caller (the engine, a page) — the promise is for tests
const inflight = new Map()
export function soon(todoId, opts = {}) {
  const id = String(todoId || '')
  if (!id) return Promise.resolve(null)
  if (inflight.has(id) && !opts.redo) return inflight.get(id)
  const p = (inflight.get(id) || Promise.resolve()).catch(() => {}).then(() => ensure(id, opts))
    .catch((e) => { console.warn('[step-ui]', e.message); return null })
    .finally(() => { if (inflight.get(id) === p) inflight.delete(id) })
  inflight.set(id, p)
  return p
}

// What the work item's view carries about its screen (mapengine.js todoView → GET /todos/:id):
//   {ui, uiState: 'ready', uiLang, uiValues (handed in)} · {uiState: 'making', uiWait} · {uiState: 'fallback'} · {} (no screen for this step)
export async function viewFor(t, { formId } = {}) {
  if (!eligible(t)) return {}
  const [row] = await q('select status, surface, lang, basis, updated_at, extract(epoch from now() - updated_at)::int as age from pro_step_ui where todo_id=$1', [t.id])
  const closed = CLOSED.includes(String(t.status))
  const s = closed ? null : await stepOf(t)
  const fid = formId || formIdOf(t, s?.act || {})
  if (closed) return row?.status === 'ready' ? { ui: row.surface, uiState: 'ready', uiLang: row.lang, uiValues: t.output?.[fid] || null } : {}
  const R = await settings()
  if (!R.enabled) return row?.status === 'ready' ? { ui: row.surface, uiState: 'ready', uiLang: row.lang } : {}
  if (String(t.status) !== 'IN_PROGRESS') return {}
  const wait = R.waitSeconds ?? 60
  const draft = draftOf(t, fid)
  if (row?.status === 'ready') {
    // the agent's draft came (or changed) after the screen was made: made again with it as the first values
    if (row.basis !== basisOf(draft)) { soon(t.id, { redo: true }); return { uiState: 'making', uiWait: wait } }
    return { ui: row.surface, uiState: 'ready', uiLang: row.lang }
  }
  if (row?.status === 'fallback') return { uiState: 'fallback' }
  if (row?.status === 'making' && row.age < staleAfter(R)) return { uiState: 'making', uiWait: wait }
  // a draft step whose draft is not written yet: made when the agent saves it (run.js) — the classic field until then
  if (isDraftStep(t) && !draft) return {}
  soon(t.id)
  return { uiState: 'making', uiWait: wait }
}

// Only the person the step is for hands it in through its screen
export function assertAssignee(me, todo) {
  const ids = String(todo.user_id || '').split(',').map((x) => x.trim()).filter(Boolean)
  if (!me || !(ids.includes(String(me.id)) || (me.email && ids.includes(me.email)))) throw err(403, '이 단계를 맡은 사람만 낼 수 있어요.')
}

// A hand-in through the screen (engine.js submitTodo, body.a2ui = the A2UI action): read against the stored screen → the payload to
// store ({<formId>: values + result + a2ui}); null when the body carries no A2UI action (the classic field, unchanged)
export async function payloadFor({ me, todo, formId, values, a2ui }) {
  if (!a2ui) return null
  if (!eligible(todo)) throw err(400, '이 단계는 입력 화면으로 내지 않아요.')
  assertAssignee(me, todo)
  const [row] = await q(`select surface, lang from pro_step_ui where todo_id=$1 and status='ready'`, [todo.id])
  if (!row?.surface) throw err(409, '이 단계의 입력 화면이 바뀌었어요 — 다시 열어 주세요.')
  const action = a2ui.action && typeof a2ui.action === 'object' ? a2ui.action : a2ui
  const shape = checkAction({ version: '1.0', action })
  if (!shape.ok) throw err(400, `보낸 동작의 꼴이 맞지 않아요(${shape.errors[0] || ''}).`)
  const R = await settings()
  const read = readSubmit(row.surface, { values, action }, { maxValueChars: R.maxValueChars || 8000 })
  return {
    [formId]: {
      ...read.values,
      result: resultText(row.surface, read.values, read.button, row.lang),
      a2ui: { surfaceId: row.surface.createSurface.surfaceId, event: read.button.name, button: read.button.label, sourceComponentId: read.button.id, at: new Date().toISOString() },
    },
  }
}
