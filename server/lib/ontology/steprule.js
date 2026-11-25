// 단계의 꼭 · 선택을 읽고 적용하는 곳: 조직이 약속한 단계(꼭 하는 단계 — 품질)와 건에 따라 해도 되고 안 해도 되는 단계(선택), 사안에 따라
// (금액 · 글로 쓴 조건) 바뀌는 규칙. 정하는 곳은 사건 보기의 간선 하나다(edgecond.js 간선 설정, edge-step-condition — 프로세스 × 이벤트 → 태스크
// 간선마다). 예전의 단계 단위 설정(sql/042 pro_step_requirements · 지도의 「단계 규칙」)은 간선 설정으로 옮겼고 더 읽지 않는다.
//   꼭(required): 그 간선의 앞 일에서 스냅샷이 늘 그 일로 가고(procGraph → withRequirements), 에이전트가 건너뛰지 않는다. 사람이 지나치려
//     하면(다른 갈래 · 다른 일로 옮기기 · 건너뛰기) 알리고 까닭을 받아 원장에 남긴다. 꼭은 「사람이 해야 함」이 아니다 — 누가 하는지는
//     지도 · 일 정의대로(책임 단계는 runmode.js responsibleOf 가 따로 본다).
//   선택(optional): 단계가 열릴 때(runmode.js gateStep) — 사람이 지켜봄이면 이 건에 필요한지(요청 · 앞 단계가 만든 것 · 단계 설명, 첫 토큰
//     확률)를 읽어 낮으면 까닭을 남기고 건너뛰고, 애매하면 주인에게 「건너뛸까요?」; 단계마다 사람이 정함이면 늘 진행 · 건너뛰기를 묻는다.
//   지도대로(정하지 않음): 지금까지처럼.
//   사안에 따라: 위에서부터 맞는 첫 규칙 — 금액(건의 값에서, 모델 없이 · 금액이 없으면 맞지 않음) · 글로 쓴 조건(건을 읽어 확률,
//     rules.stepRules.textMatch 이상이면 맞음). 맞는 규칙이 없으면 단계의 기본 정책. 무엇이 맞았는지는 건의 단계 행(pro_case_steps.matched)에.
// 건너뛰기(skipStep): 그 단계의 할 일을 「건너뜀」 결과로 끝내 엔진이 스스로 다음으로 간다 — 에이전트 단계는 save_task_result(최종) + 단계
// 일꾼이 내는 것과 같은 사건, 사람 단계(초안 포함)는 사람이 내는 길(engine.js submitTodo). 문턱 · 묻는 말은 스킬 규칙 stepRules.
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import { emit } from '../bus.js'
import { oddsOf } from '../decide.js'
import { chatJson } from '../llm.js'
import { addMessage } from '../store.js'
import { rules as skillRules } from './discovery.js'
import { ledger } from './review.js'
import { END } from './stats.js'
import { fileLine } from './fileread.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const iso = () => new Date().toISOString()
const pct = (p) => `${Math.round((p || 0) * 100)}%`
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
const fin = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0 }
const eul = (w) => (fin(w) ? '을' : '를')

export const REQS = ['required', 'optional']
export const REQ_KO = { required: '꼭 하는 단계', optional: '해도 되고 안 해도 되는 단계' }
export const REQ_SHORT = { required: '꼭', optional: '선택' }
export const OPS = { '>=': '이상', '>': '초과', '<=': '이하', '<': '미만' }
const SYM = { '>=': '≥', '>': '>', '<=': '≤', '<': '<' }
const NOT = { '>=': '<', '>': '≤', '<=': '>', '<': '≥' }
export const REQ_PIN = '꼭 하는 단계'
const SUGGEST = { gate: 'required', skipped: 'required', drop: 'optional' }

// ---------- pure ----------
// 1,200만원 · 1억 2,000만원 · 3,500원
export function won(n) {
  const v = Math.round(Number(n))
  if (!Number.isFinite(v)) return ''
  const f = (x) => new Intl.NumberFormat('ko-KR').format(x)
  if (v >= 1e8 && v % 1e4 === 0) { const e = Math.floor(v / 1e8), m = (v % 1e8) / 1e4; return `${f(e)}억${m ? ` ${f(m)}만` : ''}원` }
  if (v >= 1e4 && v % 1e4 === 0) return `${f(v / 1e4)}만원`
  return `${f(v)}원`
}

// one rule as a person wrote it → {when: {field: 'amount', op, value} | {text}, then} (null when it cannot be read)
export function normRule(x) {
  const then = REQS.includes(x?.then) ? x.then : null
  if (!then) return null
  const w = x?.when || {}
  if (w.field === 'amount' || (w.op !== undefined && w.text === undefined)) {
    const op = OPS[w.op] ? w.op : null
    const value = Number(String(w.value ?? '').replace(/[,\s원]/g, ''))
    if (!op || String(w.value ?? '').trim() === '' || !Number.isFinite(value) || value < 0) return null
    return { when: { field: 'amount', op, value }, then }
  }
  const text = clean(w.text).slice(0, 200)
  return text ? { when: { text }, then } : null
}
export const whenText = (when) => (when?.field === 'amount' ? `금액 ${won(when.value)} ${OPS[when.op]}` : `「${when?.text || ''}」`)
export const ruleText = (r) => `${whenText(r.when)} → ${REQ_SHORT[r.then]}`

// an amount rule against the case's amount (no model): no amount → it does not match, and says so
export function amountMatch(when, amount) {
  if (amount == null || !Number.isFinite(Number(amount))) return { match: null, text: '이 건에는 금액이 없어요' }
  const a = Number(amount), v = when.value
  const ok = when.op === '>=' ? a >= v : when.op === '>' ? a > v : when.op === '<=' ? a <= v : a < v
  return { match: ok, text: `금액 ${won(a)} ${ok ? SYM[when.op] : NOT[when.op]} ${won(v)}` }
}

// The step's requirement for this case: the first rule that matches, else its own. amount: the case's amount (null: none) ·
// odds[i]: a text rule's reading {p, measured} (null: could not be read; undefined: not read yet → {pending: i}, the caller reads
// it and asks again — text rules are read only up to the first match). → {requirement, from: rule | base | null, matched, checked}
export function pickRequirement({ requirement: base = null, rules = [] } = {}, { amount = null, odds = [] } = {}, R = {}) {
  const th = R.textMatch ?? 0.6
  const checked = []
  for (const [i, r] of (rules || []).entries()) {
    if (r.when?.field === 'amount') {
      const m = amountMatch(r.when, amount)
      checked.push({ i, kind: 'amount', match: m.match, text: m.text, then: r.then })
      if (m.match) return { requirement: r.then, from: 'rule', matched: { i, kind: 'amount', then: r.then, rule: ruleText(r), text: m.text, amount: Number(amount) }, checked }
      continue
    }
    const o = odds[i]
    if (o === undefined) return { pending: i, checked }
    const p = o?.p ?? null
    const match = p == null ? null : p >= th
    const text = p == null ? `${whenText(r.when)} — 읽지 못했어요` : `${whenText(r.when)} ${o.measured === false ? '(모델이 고름)' : pct(p)}`
    checked.push({ i, kind: 'text', match, p, measured: o?.measured ?? null, text, then: r.then })
    if (match) return { requirement: r.then, from: 'rule', matched: { i, kind: 'text', then: r.then, rule: ruleText(r), cond: r.when.text, text, p, measured: o?.measured ?? null }, checked }
  }
  return { requirement: base || null, from: base ? 'base' : null, matched: null, checked }
}

// one line for the run view and the ask card: 「이 건은 금액 1,200만원 ≥ 1,000만원이라 꼭 하는 단계예요」
export function reqLine(res) {
  if (!res) return ''
  const m = res.matched
  if (m?.kind === 'amount') return `이 건은 ${m.text}이라 ${REQ_KO[m.then]}예요`
  if (m?.kind === 'text') return `이 건은 「${m.cond}」에 해당해서(${m.measured === false ? '모델이 고름' : pct(m.p)}) ${REQ_KO[m.then]}예요`
  const missed = (res.checked || []).filter((c) => c.match === null).map((c) => c.kind === 'amount' ? '이 건에는 금액이 없어 금액 규칙은 맞지 않았어요' : `${c.text}`)
  const tail = missed.length ? ` (${missed.join(' · ')})` : ''
  if (res.requirement) return `${REQ_KO[res.requirement]}예요${res.checked?.length ? ' — 맞는 규칙이 없어 기본대로' : ''}${tail}`
  return res.checked?.length ? `맞는 규칙이 없어 지도대로 해요${tail}` : ''
}

// the AI's suggestion, no new model call: 다듬기 ② 단계 가르기 — a class a person decided there, else the AI's own reading — when the
// class says one; else a pinned step (꼭); else what this process's past cases did at the step (through: throughOf, rules.stepRules.fromCases):
// almost every case went through it → 꼭, many went around it → 선택. A suggestion only — nothing is stored.
export function suggestionOf(cls, R = {}, { pinned = false, pinReason = '', through = null } = {}) {
  const map = R.suggest || SUGGEST
  const c = cls ? (cls.decided ? cls : cls.ai || cls) : null
  const requirement = map[c?.class]
  if (requirement) return { requirement, class: c.class, why: c.why || '', by: cls.decided && cls.by === 'person' ? 'person' : 'ai' }
  if (pinned) return { requirement: 'required', from: 'pinned', why: `지도에서 고정한 단계예요${clean(pinReason) ? `(${clean(pinReason)})` : ''} — 건마다 늘 이 단계를 지나가요`, by: 'ai' }
  const S = { minCases: 5, requiredAt: 0.9, optionalFrom: 0.2, optionalTo: 0.8, ...(R.fromCases || {}) }
  if (!through || !(through.n >= S.minCases)) return null
  const { m, n } = through, share = m / n
  if (share >= S.requiredAt) return { requirement: 'required', from: 'cases', m, n, why: `지난 건 ${n}건 중 ${m}건이 이 단계를 거쳤어요`, by: 'ai' }
  if (share >= S.optionalFrom && share <= S.optionalTo) return { requirement: 'optional', from: 'cases', m, n, why: `지난 건 ${n}건 중 ${m}건만 이 단계를 거쳤어요 — ${n - m}건은 이 단계 없이 지나갔어요`, by: 'ai' }
  return null
}
// how many of this process's past cases went through the step (the HAS_TASK membership: n of them, share of the process's cases —
// build.js structureOf) → {m, n}. Trusted only when it agrees with the process as the map shows it: the step is on its list and
// n / share is its number of cases (a membership left from an earlier count says nothing — null)
export function throughOf(proc, rel, key) {
  if (!proc || !rel || !(proc.tasks || []).includes(key)) return null
  const m = Number(rel.n), share = Number(rel.share), n = Number(proc.cases)
  if (!Number.isFinite(m) || !(share > 0) || !(n > 0) || Math.abs(m / share - n) > 0.5 || m > n) return null
  return { m, n }
}

// the most likely way from `from` to `to` (the steps before `to`, `from` first); null when there is none
export function pathBetween(edges, from, to) {
  if (!from || !to || from === to) return null
  const dist = new Map([[from, 0]]), prev = new Map(), todo = new Set([from]), seen = new Set()
  while (todo.size) {
    const x = [...todo].sort((a, b) => dist.get(a) - dist.get(b))[0]
    todo.delete(x); seen.add(x)
    if (x === to) break
    for (const e of edges.filter((y) => y.from === x && y.to !== END && y.status !== 'retired')) {
      const p = e.decided || e.pinned ? Math.max(e.p || 0, 0.5) : Math.max(e.p || 0, 1e-3)
      const d = dist.get(x) - Math.log(p)
      if (!seen.has(e.to) && d < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, d); prev.set(e.to, x); todo.add(e.to) }
    }
  }
  if (!prev.has(to)) return null
  const path = []
  for (let x = prev.get(to); x !== undefined; x = prev.get(x)) path.unshift(x)
  return path
}
// the 꼭 steps a move from `from` to `to` would pass without doing them
export function passedRequired({ edges = [], from, to, done = [], required = [] } = {}) {
  const path = pathBetween(edges, from, to)
  if (!path) return []
  const d = new Set(done), r = new Set(required)
  return path.filter((k) => r.has(k) && !d.has(k))
}

// what the person reads for a step's setting (the side panel)
export function settingLines({ requirement = null, rules = [] } = {}) {
  const out = []
  if (requirement === 'required') out.push('꼭 하는 단계예요 — 이 프로세스의 건은 늘 이 단계를 지나고, 에이전트가 건너뛰지 않아요.', '사람이 지나치려 하면 까닭을 묻고 기록해요. 누가 하는지는 그대로예요(지도 · 일 정의대로).')
  else if (requirement === 'optional') out.push('해도 되고 안 해도 되는 단계예요 — 사람이 지켜봄이면 건마다 필요한지 보고, 필요 없어 보이면 까닭을 남기고 건너뛰어요. 애매하면 물어요.', '단계마다 사람이 정함이면 늘 진행 · 건너뛰기를 물어요.')
  else out.push('지도대로 해요 — 찾은 흐름대로 지나가요.')
  if (rules?.length) {
    out.push(`사안에 따라(위에서부터 맞는 첫 규칙): ${rules.map((r, i) => `${i + 1}. ${ruleText(r)}`).join(' · ')}`)
    out.push(requirement ? `맞는 규칙이 없으면 ${REQ_KO[requirement]}예요.` : '맞는 규칙이 없으면 지도대로 해요.')
    if (rules.some((r) => r.then === 'required')) out.push('「꼭」이 될 수 있는 단계라 스냅샷이 늘 지나가요 — 그 건에서 선택이면 단계가 열릴 때 건너뛸 수 있어요.')
  }
  return out
}

// run.js procGraph: the view with this process's 꼭 on it — read from the edge settings (edgecond.js, edge-step-condition), as of
// settingsAt (a bpm case's snapshot) or now; no table yet, or an error: the view as it was
export async function withRequirements(view, procKey, { settingsAt } = {}) {
  try {
    const EC = await import('./edgecond.js')
    return EC.edgeRequiredView(view, await EC.edgeConditionsOf(procKey, { asOf: settingsAt }))
  } catch { return view }
}

// the case's amount: the latest a step of it stated (a quote's total), else the request's own (「합계 1,240만 원」) — null when none
export async function caseAmount(c) {
  const rows = c.instances?.length ? await q(`select activity_id, activity_name, output from todolist where proc_inst_id = any($1) and status::text in ('DONE','SUBMITTED') and output is not null order by end_date desc nulls last, updated_at desc`, [c.instances]) : []
  for (const r of rows) {
    if (r.activity_id === 'intake') continue
    for (const v of Object.values(r.output || {})) {
      if (!v || typeof v !== 'object' || v.skipped || v.amount == null) continue
      const n = Number(String(v.amount).replace(/[,\s원]/g, ''))
      if (Number.isFinite(n) && n > 0) return { amount: n, from: `「${r.activity_name}」` }
    }
  }
  const { caseIntake } = await import('./run.js')
  const intake = await caseIntake(c)
  const { amountOf } = await import('./history.js')
  const n = amountOf(`${intake.subject || c.trigger?.subject || ''}\n${intake.body || ''}`)
  return n ? { amount: n, from: '요청' } : { amount: null, from: null }
}

// what the case is about, for a yes/no reading: its request and what the earlier steps made
export async function caseState(c, chars = 1500) {
  const { caseIntake } = await import('./run.js')
  const intake = await caseIntake(c)
  const earlier = await (await import('./runmode.js')).earlierOfCase(c).catch(() => [])
  return [
    '회사에 들어온 요청', `제목: ${String(intake.subject || c.trigger?.subject || '').slice(0, 200)}`, `내용: ${String(intake.body || '').slice(0, chars)}`,
    ...(earlier.length ? ['앞 단계에서 한 것:', ...earlier.slice(-4).flatMap((x) => [`- ${x.task}: ${clean(x.text).slice(0, 300)}`,
      // the files a person handed in with the step, as their text reads (stepfiles.js)
      ...(x.files || []).map((f) => fileLine(f, 500))])] : []),
  ].join('\n')
}
// P(yes) by first-token odds; the model's plain answer when it gives none (marked: measured false), like run.js chooseEntry
export async function readYes(state, question, R = {}) {
  const opts = [{ key: 'yes', label: R.options?.yes || '예, 그렇다' }, { key: 'no', label: R.options?.no || '아니요, 그렇지 않다' }]
  const r = await oddsOf(state, question, opts).catch(() => null)
  if (r?.probabilities?.yes != null) return { p: +r.probabilities.yes.toFixed(3), measured: true }
  const j = await chatJson('JSON {"yes": true|false} 로만 답하세요.', JSON.stringify({ case: state, question }), { temperature: 0 }).catch(() => null)
  if (typeof j?.yes === 'boolean') return { p: j.yes ? 0.7 : 0.3, measured: false }
  return { p: null, measured: false }
}

// The step's requirement for this case (runmode.js gateStep): its rules read against the case, and — an optional step — whether this
// case needs it. set: the step's own setting {requirement, rules} · what: the step's description · forced: a person moved or rewound
// the case to this step (it is done, not read) · read: false while the case is paused (nothing is read until it goes on)
export async function forStep(c, task, { set = null, what = '' } = {}, { forced = '', read = true } = {}) {
  if (!set || (!set.requirement && !set.rules?.length)) return null
  const R = (await skillRules()).stepRules || {}
  const amt = set.rules.some((r) => r.when.field === 'amount') ? await caseAmount(c).catch(() => ({ amount: null, from: null })) : { amount: null, from: null }
  let state = null
  const stateOf = async () => (state ??= await caseState(c, R.textChars || 1500))
  const odds = []
  let res
  for (;;) {
    res = pickRequirement(set, { amount: amt.amount, odds }, R)
    if (!('pending' in res)) break
    odds[res.pending] = read ? await readYes(await stateOf(), fill(R.questions?.rule || '이 건은 다음 경우에 해당하나? 「{text}」', { text: set.rules[res.pending].when.text }), R) : null
  }
  let need = null
  if (res.requirement === 'optional') {
    if (forced) need = { p: 1, forced: true, why: forced }
    else if (read) need = await readYes(await stateOf(), fill(R.questions?.need || '이 건을 끝까지 처리하려면 회사가 「{task}」({what}) 단계를 해야 하나?', { task, what: clean(what).slice(0, 200) || '이 단계의 일' }), R)
  }
  return { requirement: res.requirement, base: set.requirement || null, from: res.from, matched: res.matched, checked: res.checked, amount: amt.amount, amountFrom: amt.from, need, line: reqLine(res) }
}
export const needText = (need) => (!need ? '' : need.forced ? need.why || '사람이 이 단계로 옮겨서 해요' : need.p == null ? '이 건에 필요한지 읽지 못했어요' : `이 건에 필요할 확률 ${need.measured === false ? '(모델이 고름) ' : ''}${pct(need.p)}`)
export const skipReason = (req) => `이 건에는 하지 않아도 돼 보여요(${needText(req?.need)})${req?.matched ? ` — ${req.line}` : ''}`

// ---------- skipping a step in the engine ----------
// its work item ends with a 「건너뜀」 result (under the step's own form) and the engine goes on by itself; the gate's row says skipped,
// the case's history has it, and a person's step is gone from their list (a finished item is off it). by: 'agent' or who skipped it ·
// me: whose name a person's step is submitted under (the person who skipped it, or the case's owner for the agent)
export async function skipStep({ c, todoId, stepId, reason, by = 'agent', me }) {
  const [t] = await q(`select id, tenant_id, proc_inst_id, proc_def_id, activity_id, activity_name, status::text as status, agent_mode::text as agent_mode from todolist where id=$1`, [todoId])
  if (!t || ['DONE', 'SUBMITTED', 'CANCELLED'].includes(t.status)) throw err(409, '그 단계는 이미 닫혔어요.')
  const at = iso()
  const values = { skipped: true, reason, by, at, result: `건너뜀 — ${reason}`, summary: '건너뜀' }
  const M = await import('./mapengine.js')
  // a case run from the map (mapengine.js): the step ends here, as skipped, and the map says what comes next — no engine to hand it to
  const map = M.isMapInst(t.proc_inst_id)
  if (map) {
    const act = await (await import('./run.js')).actOf(t)
    const formId = String(act.tool || '').startsWith('formHandler:') ? act.tool.slice(12) : `${t.activity_id}_form`
    // (the gate's row says skipped first: the next step's decision reads this one as skipped)
    if (stepId) await q(`update pro_case_steps set state='skipped', skip=$2, hold_item=false, updated_at=now() where id=$1`, [stepId, { reason, by, at }])
    await M.finishItem(t.id, { [formId]: values })
  } else if (String(t.agent_mode || '').toUpperCase() === 'COMPLETE') {
    const [a] = await q(`select a as act from proc_def, jsonb_array_elements(definition->'activities') a where id=$1 and tenant_id=$2 and a->>'id'=$3`, [t.proc_def_id, t.tenant_id, t.activity_id])
    const tool = a?.act?.tool || ''
    const formId = tool.startsWith('formHandler:') ? tool.slice(12) : `${t.activity_id}_form`
    const payload = { [formId]: values }
    const { error } = await admin.rpc('save_task_result', { p_todo_id: t.id, p_payload: payload, p_final: true })
    if (error) throw new Error('save_task_result: ' + error.message)
    const W = await import('../mining/worker.js')
    const { ORCH } = await import('./run.js')
    await W.events([
      { job_id: `skip-${stepId || t.id}`, todo_id: t.id, proc_inst_id: t.proc_inst_id, crew_type: ORCH, event_type: 'task_started', data: { goal: `${t.activity_name} — 건너뜀`, name: '업무 에이전트', role: t.activity_name } },
      { job_id: `skip-${stepId || t.id}`, todo_id: t.id, proc_inst_id: t.proc_inst_id, crew_type: 'result', event_type: 'task_completed', data: payload },
      { job_id: 'CREW_FINISHED', todo_id: t.id, proc_inst_id: t.proc_inst_id, crew_type: 'crew', event_type: 'crew_completed', data: 'Task completed successfully' },
    ])
  } else {
    // a person's step (or its draft): submitted the way a person submits one — process-gpt's save path (save_task_result only drafts it)
    const { submitTodo } = await import('../engine.js')
    await submitTodo({ me, todoId: t.id, values })
  }
  if (stepId) await q(`update pro_case_steps set state='skipped', skip=$2, hold_item=false, updated_at=now() where id=$1`, [stepId, { reason, by, at }])
  await q(`update pro_po_cases set history = history || $2::jsonb, updated_at=now() where id=$1`, [c.id, JSON.stringify([{ task: t.activity_name, state: 'skipped', step: true, at, reason, by }])])
  if (by === 'agent' && c.started_by) {
    const W = await import('../mining/worker.js')
    const threadId = await W.instanceThread(c.started_by, t.proc_inst_id).catch(() => null)
    if (threadId) await addMessage(c.started_by, threadId, 'agent', 'text', { text: `업무 에이전트 · ${t.activity_name}: 건너뛰었어요 — ${reason}` }).catch(() => {})
  }
  console.log(`[steprule] ${t.activity_name}: 건너뜀(${by}) — ${reason}`)
  if (c.started_by) { emit(c.started_by, 'ontology', { caseId: c.id, step: stepId, state: 'skipped' }); emit(c.started_by, 'process', { instId: t.proc_inst_id, type: 'changed' }) }
  return { skipped: true, at }
}
// the case's owner, for a person's step the agent skips
export async function ownerOf(c) {
  const [p] = await q('select email from pro_profile where user_id=$1', [c.started_by]).catch(() => [])
  return { id: c.started_by, email: p?.email || '' }
}

// ---------- a person passing a 꼭 step: 「다른 일로 옮기기」 ----------
// the 꼭 steps (for this case: its rules read) on the way from where the case is to `task` that it has not done. Without confirm and a
// reason it only says so ({confirm, required}); with them the pass is in the ledger and the move goes on (null).
export async function guardMove(me, caseId, { task, confirm = false, reason = '' } = {}) {
  const { getCase, procGraph } = await import('./run.js')
  const c = await getCase(caseId)
  const EC = await import('./edgecond.js')
  const settings = await EC.edgeConditionsOf(c.proc).catch(() => new Map())
  if (![...settings.values()].some(EC.mayRequire)) return null
  const view = await procGraph(c.proc).catch(() => null)
  if (!view?.tasks.has(task)) return null
  const RM = await import('./runmode.js')
  const run = await RM.runView(me, caseId)
  const cur = run.steps.filter((s) => s.current)
  const done = cur.filter((s) => ['done', 'skipped'].includes(s.state)).map((s) => s.task)
  if (done.includes(task)) return null // back to a step it did: nothing is passed
  const at = cur.find((s) => ['running', 'waiting', 'person'].includes(s.state))?.task || done.at(-1) || c.entry_task
  const facts = await RM.stepFacts(c.proc, { view }).catch(() => new Map())
  // each step on the way is read by the way the case would come into it (edge settings: after the step before it on the way)
  const full = pathBetween(view.edges, at, task) || []
  const entries = EC.entryEdgesOf(view)
  const passed = []
  for (let i = 0; i < full.length; i++) {
    const k = full[i]
    if (done.includes(k)) continue
    const prev = i > 0 ? full[i - 1] : done.at(-1) || null
    const ways = EC.caseEntryEdges(view, entries, { task: k, prev, start: EC.startEventOf(c.trigger) })
    for (const w of ways) {
      const s = settings.get(EC.edgeKey(w.event, w.task))
      if (!EC.mayRequire(s)) continue
      const r = await forStep(c, k, { set: { requirement: s.requirement, rules: s.rules }, what: facts.get(k)?.what || '' }, { read: true }).catch(() => null)
      if (r?.requirement === 'required') { passed.push({ task: k, line: r.line || '꼭 하는 단계예요' }); break }
    }
  }
  if (!passed.length) return null
  const why = clean(reason).slice(0, 300)
  if (!confirm || !why) return { confirm: true, required: passed, task }
  await ledger(me, 'ontology.run.pass', `${c.trigger?.subject || '건'} · 꼭 하는 단계 「${passed.map((x) => x.task).join('」 · 「')}」${eul(passed.at(-1).task)} 지나 「${task}」로`, { case: c.id, task, passed: passed.map((x) => x.task), reason: why, via: 'move' })
  return null
}
