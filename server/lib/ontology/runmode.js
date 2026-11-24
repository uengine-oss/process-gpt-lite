// 실행 방식(사람이 지켜봄 HOTL · 단계마다 사람이 정함 HITL): 찾은 프로세스의 건이 돌 때 사람이 어디서 끼는가. 따로 쓰는 실행 정책은
// 없다 — 모두 지도에서 읽는다(다듬기의 단계 분류 · AI 후보의 「사람이 꼭」 · 관문 고정 · 일 정의 · 그 일의 기록).
//
// 방식은 따로 고르지 않는다 — 프로세스의 단계(지도의 관찰 · 제안 · 자동, Process.status)가 시작과 진행을 함께 정한다(modeOfStage):
//   관찰(paused): 건이 시작되지 않고 묻지도 않는다. 제안(suggested): 시작을 묻고, 시작한 뒤에는 단계마다 사람이 정함(hitl).
//   자동(adopted): 저절로 시작하고(손으로 · 채팅 · 파일로 연 건은 시작만 묻는다), 사람이 지켜봄(hotl).
// 건은 시작할 때의 방식을 지닌다(pro_po_cases.run_mode, sql/045 — run.js startCase · mapengine.js startMapCase 가 적는다): 단계를
// 나중에 바꿔도 돌던 건은 그대로고 새 건부터 바뀐다. 이 열 전에 시작한 건(run_mode 없음)은 단계가 열릴 때마다 프로세스의 단계로 읽는다.
// 예전에 따로 고르던 방식(pro_run_modes · pro_run_settings.default_mode)은 더 읽지 않는다 — 표와 행은 지우지 않고 둔다.
//
// 관문(gateStep): 건의 단계가 열릴 때마다 — 에이전트가 할 단계 · 사람 단계의 초안은 단계 일꾼(run.js tick)이 집을 때, 사람 단계는
// 건 훑기(sweepCases)가 볼 때 — 건의 방식(caseMode) · 단계의 종류 · 건의 멈춤을 읽어 「저절로 진행」 또는 「사람을 기다림」을 정한다.
//
//   사람이 지켜봄(hotl, 자동 단계): 일이 오면 저절로 — 에이전트 단계는 스스로 하고, 사람 단계는 그 사람의 할 일로 넘어간다(인계).
//     멈춰 묻는 곳: 사람이 책임지기로 한 단계(responsible)를 에이전트가 하게 됐을 때, 되돌릴 수 없는 단계(irreversible: 회사 밖으로
//     나가는 일 — 따로 「묻지 않고 진행(auto)」으로 정하지 않았으면). 되돌릴 수 없는 단계는 나갈 것을 초안으로 먼저 만들고 묻는다.
//   단계마다 사람이 정함(hitl, 제안 단계): 단계마다 건의 주인에게 「다음은 X예요 — 진행할까요?」(갈림길이면 갈림길 조건과 함께) — 진행 · 다른 갈래 ·
//     멈추기. 사람 단계는 정할 때까지 그 사람의 할 일 목록에 보이지 않는다(hold_item).
//   멈추기: 에이전트가 다음 단계를 잡지 않는다(사람은 자기 단계를 할 수 있다). 이어 가기: 멈춤 때문에 기다리던 단계를 다시 본다.
//   이 단계로 되감기: 이 건이 닿았던 단계로(run.js moveCase — 지금 인스턴스를 닫고 그 일부터 새 스냅샷, 앞 결과는 기록으로 남음).
//
// 바꾼 것(단계 규칙 · 멈춤 · 이어 감 · 단계마다 정한 것 · 되감기)은 결정 원장(review.js ledger)에 — 프로세스의 단계는
// routes/ontology.js(ontology.promote · ontology.demote). 표는 sql/041 · 045.
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import { cypher } from './store.js'
import { emit } from '../bus.js'
import { mainThread, addMessage, updateMessage } from '../store.js'
import { rules as skillRules } from './discovery.js'
import { ledger } from './review.js'
import { parseDefinition } from './taskdef.js'
import { END } from './stats.js'
import { procGraph, getCase, moveCase, ORCH } from './run.js'
import * as SR from './steprule.js'
import { findBinding, bindingsView } from './bindings.js'
import { filesOf } from './stepfiles.js'

const T = () => config.tenantId
const err = (status, message) => Object.assign(new Error(message), { status })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const iso = () => new Date().toISOString()
const pct = (p) => `${Math.round((p || 0) * 100)}%`
// 로 · 으로 by the last syllable (ㄹ takes 로)
const ro = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); const f = c >= 0xac00 && c <= 0xd7a3 ? (c - 0xac00) % 28 : 0; return f && f !== 8 ? '으로' : '로' }
export const MODES = ['hotl', 'hitl']
export const MODE_KO = { hotl: '사람이 지켜봄', hitl: '단계마다 사람이 정함' }
// the ladder's stages (지도의 관찰 · 제안 · 자동) and the one that gives each mode
export const STAGE_KO = { paused: '관찰', suggested: '제안', adopted: '자동' }
export const STAGE_OF_MODE = { hotl: 'adopted', hitl: 'suggested' }
export const WHY_KO = { responsible: '책임 단계', irreversible: '되돌릴 수 없는 단계', hitl: '단계마다 확인', paused: '멈춤', ask: '늘 묻는 단계', optional: '해도 되고 안 해도 되는 단계', unbound: '맡을 사람 정하기' }
const GATE_PIN = '다듬기: 꼭 하는 관문'
const INTAKE = '요청 접수'

// ---------- what a step is (pure) ----------
// 사람이 책임지는 단계: the organisation decided a person answers for it. cls: the step's class in 다듬기 ({class, decided}) · human: the AI
// candidates' reasons a person must do it ([{key, name, why}]) · pinnedGate: pinned on the map as a gate · runner: the task
// definition's runner when the task has one. A class a person decided is the organisation's word — an AI's reason does not overrule it.
export function responsibleOf({ cls = null, human = [], pinnedGate = false, runner = null } = {}) {
  const why = []
  const c = cls?.class
  if (cls?.decided) {
    if (c === 'gate') why.push('다듬기에서 「꼭 하는 관문」으로 정했어요')
    if (c === 'human') why.push('다듬기에서 「사람이 꼭」으로 정했어요')
    if (runner === 'person') why.push('일 정의에서 사람이 하기로 했어요')
    return { on: why.length > 0, why }
  }
  if (c === 'gate') why.push('다듬기의 AI 제안: 꼭 하는 관문')
  if (c === 'human') why.push('다듬기의 AI 제안: 사람이 꼭')
  for (const h of human || []) why.push(`사람이 꼭 해야 하는 까닭: ${h.name || h.key}${h.why ? ` — ${h.why}` : ''}`)
  if (pinnedGate) why.push('관문으로 고정된 일이에요')
  if (runner === 'person') why.push('일 정의에서 사람이 하기로 했어요')
  return { on: why.length > 0, why }
}

// 되돌릴 수 없는 단계(rules.runMode.irreversible), rule first and no model: the task definition says so (irreversible: true |
// sends: outside — or irreversible: false, 「되돌릴 수 있음」으로 못 박음), else its records (the company's own mails · messages of this work that
// had a recipient: any share of them to an outside role at or above outwardShare — even one record, an outward send counts; minRecords
// of them mostly inside settle it as inside), else a word in its name that sends something out (회신 · 발송 · 제출 …).
export function irreversibleOf({ name = '', front = {}, records = null } = {}, R = {}) {
  const I = R.irreversible || R
  if (front.irreversible === true || ['outside', 'external', '밖', '회사 밖'].includes(clean(front.sends))) return { on: true, by: 'definition', why: '일 정의에 회사 밖으로 보낸다고 적혀 있어요' }
  if (front.irreversible === false) return { on: false, by: 'definition', why: '일 정의에 되돌릴 수 있다고 적혀 있어요' }
  const sent = records?.sent || 0, out = records?.outside || 0
  const to = (records?.to || []).join(' · ') || '바깥 역할'
  if (out > 0 && out / sent >= (I.outwardShare ?? 0.6)) return { on: true, by: 'records', why: `회사가 보낸 기록 ${sent}건 중 ${out}건이 회사 밖(${to})으로 갔어요` }
  if (sent >= (I.minRecords ?? 2)) return { on: false, by: 'records', why: `회사가 보낸 기록 ${sent}건 중 회사 밖으로 간 것은 ${out}건이에요` }
  const w = (I.words || []).find((x) => String(name).includes(x))
  if (w) return { on: true, by: 'words', why: `일 이름에 「${w}」 — 회사 밖으로 나가는 일이에요` }
  return { on: false, by: 'default', why: '회사 안에서 끝나는 일이에요' }
}

// The gate's decision for one step as it comes. kind: agent (the agent does it) · draft (the agent drafts a person's step) · person
// (a person's own step). approved: a person already said 「진행」 for this step. policy: the step's own rule (auto · ask).
// requirement: what the step is for this case (steprule.js — required · optional · null). need: an optional step's reading of
// whether this case needs it (P(yes); null: not measured) against band {skipBelow, runAbove} (rules.stepRules.need). A required step
// is never skipped here and changes nothing else (who does it and whether to ask stay as they were).
//   → {act: run | wait | person | skip, why: [...], draftFirst?: true (draft what would go out, then wait), hold?: true (keep it off the
//      person's list until then)}
export function decideStep({ mode = 'hotl', kind = 'agent', responsible = false, irreversible = false, policy = null, paused = false, approved = false, requirement = null, need = null, band = {} } = {}) {
  const opt = requirement === 'optional'
  const needed = need == null ? 'unsure' : need < (band.skipBelow ?? 0.25) ? 'no' : need >= (band.runAbove ?? 0.6) ? 'yes' : 'unsure'
  if (kind === 'person') {
    if (approved) return { act: 'person', why: [] }
    if (mode === 'hitl') return { act: 'wait', why: opt ? ['hitl', 'optional'] : ['hitl'], hold: true }
    if (opt && needed === 'no') return { act: 'skip', why: ['optional'] }
    if (opt && needed === 'unsure') return { act: 'wait', why: ['optional'], hold: true }
    return { act: 'person', why: [] }
  }
  if (paused) return { act: 'wait', why: ['paused'] }
  if (approved) return { act: 'run', why: [] }
  if (opt && mode !== 'hitl' && needed === 'no') return { act: 'skip', why: ['optional'] }
  if (kind === 'draft') {
    if (mode === 'hitl') return { act: 'wait', why: opt ? ['hitl', 'optional'] : ['hitl'], hold: true }
    return opt && needed === 'unsure' ? { act: 'wait', why: ['optional'], hold: true } : { act: 'run', why: [] }
  }
  const why = []
  if (responsible) why.push('responsible')
  const outward = irreversible && policy !== 'auto'
  if (outward) why.push('irreversible')
  if (mode === 'hitl') why.push('hitl')
  if (policy === 'ask') why.push('ask')
  if (opt && (mode === 'hitl' || needed === 'unsure')) why.push('optional')
  if (!why.length) return { act: 'run', why: [] }
  // one question for the step: what would go out is drafted first, and the person decides on it
  if (outward) return { act: 'run', why, draftFirst: true }
  return { act: 'wait', why }
}

// 이 단계로 되감기: to a step this case already reached (done, or the one at hand) — not 요청 접수, not a step it never reached (that is
// 「다른 일로 옮기기」). What lies from it on is done again (the earlier outputs stay as history); a step from it on that already sent
// something outside cannot call it back: the rewind needs the person to say so (confirm), and going through that step again sends again.
// steps: this case's steps in the order they came [{task, state, sent}]
// (a step skipped as not needed — steprule.js — was reached too: rewinding to it does it this time)
const REACHED = ['done', 'running', 'waiting', 'person', 'skipped']
export function rewindCheck(target, steps = []) {
  if (!target || target === INTAKE) return { ok: false, why: '요청 접수로는 되감을 수 없어요.' }
  let at = -1
  steps.forEach((s, i) => { if (s.task === target && REACHED.includes(s.state)) at = i })
  if (at < 0) return { ok: false, why: '이 건이 아직 닿지 않은 일이에요 — 「다른 일로 옮기기」를 쓰세요.' }
  const from = steps.slice(at)
  const lost = [...new Set(from.filter((s) => s.sent).map((s) => s.task))]
  const redo = [...new Set(from.filter((s) => s.state === 'done' || s.state === 'skipped').map((s) => s.task))]
  return { ok: true, confirm: lost.length > 0, lost, redo }
}

// 「다음은 X예요」의 근거: the way from the step before into this one, and the other ways out of that step.
// outs: the snapshot's ways out of `from` [{to, p}] · conds: Map to → {cond, confidence} (conditions.js) · engineWhy: the engine's own reason
export function proposalOf({ from, to, outs = [], conds = new Map(), engineWhy = '' }) {
  const me = outs.find((o) => o.to === to)
  const c = conds.get(to)
  const split = outs.length > 1
  const why = clean(engineWhy) || (c?.cond && c.confidence !== 'low' ? c.cond : '') || (me ? (split ? `지난 건의 ${pct(me.p)}가 이쪽으로 갔어요` : '이 흐름의 다음 단계예요') : '이 흐름의 다음 단계예요')
  return { from, to, p: me?.p ?? null, cond: c?.cond || '', confidence: c?.confidence || null, why, split,
    others: outs.filter((o) => o.to !== to && o.to !== END).map((o) => ({ to: o.to, p: o.p, cond: conds.get(o.to)?.cond || '' })), end: outs.some((o) => o.to === END) }
}

// one line per reason, as the owner reads it (step: the gate's row — an optional step's reading of this case)
export function whyLines(why = [], facts = null, step = null) {
  return why.map((w) => {
    if (w === 'responsible') return `${WHY_KO.responsible} — ${facts?.responsible?.why?.[0] || '사람이 책임지기로 한 단계예요'}`
    if (w === 'irreversible') return `${WHY_KO.irreversible} — ${facts?.irreversible?.why || '회사 밖으로 나가는 일이에요'}`
    if (w === 'hitl') return '「제안」 단계의 건이라 단계마다 사람이 정해요'
    if (w === 'ask') return '이 단계는 늘 물어보기로 정했어요'
    if (w === 'paused') return '건이 멈춰 있어요'
    // (mapengine.js: the step's role has nobody yet — several people hold it, or none — bindings.js)
    if (w === 'unbound') {
      const r = step?.role || step?.act?.role || '이 역할'
      const c = String(r).slice(-1).charCodeAt(0), f = c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28
      return step?.binding?.from === 'several' ? `「${r}」${f ? '을' : '를'} 맡은 사람이 여러 명이에요 — 이 건은 누가 할지 골라 주세요` : `「${r}」${f ? '을' : '를'} 맡을 사람이 없어요 — 누가 할지 골라 주세요`
    }
    if (w === 'optional') return `${WHY_KO.optional} — ${SR.needText(step?.need) || step?.matched?.line || '건마다 할지 정해요'}`
    return w
  })
}

// a step's state in the run view, from its work item and its gate
export function stepState(t, g) {
  if (!t) return 'next'
  if (g?.state === 'skipped') return 'skipped'
  const s = String(t.status || '')
  if (['DONE', 'SUBMITTED'].includes(s)) return 'done'
  if (s === 'CANCELLED') return 'closed'
  if (g?.state === 'waiting') return 'waiting'
  if (s === 'IN_PROGRESS') {
    // the agent could not do it (run.js tick): the step stays open, the case does not go on until a person rewinds to it
    if (t.agent_orch && String(t.draft_status || '') === 'FAILED') return 'failed'
    if (t.agent_orch && String(t.draft_status || '') === 'STARTED') return 'running'
    return String(t.agent_mode || '').toUpperCase() === 'COMPLETE' ? 'running' : 'person'
  }
  return 'next'
}

// ---------- the mode: the process's stage decides it, the case keeps the one of its start ----------
// 제안(suggested) → 단계마다 사람이 정함(hitl), 자동(adopted) → 사람이 지켜봄(hotl); 관찰(paused) starts nothing — a case that is
// there anyway (a stage read when none could be: no process, a read that failed) asks at every step, the safe side.
export const modeOfStage = (status) => (status === 'adopted' ? 'hotl' : 'hitl')
// (pure) a case's mode: the one it took at its start (pro_po_cases.run_mode), else — a case started before sql/045 — the stage read
// now. Nothing else counts: what the old toggle left in pro_run_modes · pro_run_settings.default_mode is not read anywhere.
export function caseModeOf(runMode, stage) {
  return MODES.includes(runMode) ? { mode: runMode, from: 'case' } : { mode: modeOfStage(stage), from: 'stage', stage: stage || null }
}
// a process's stage as the map has it now (null: no such process, or it could not be read)
export async function stageOf(procKey) {
  if (!procKey) return null
  const [r] = await cypher('MATCH (b:Process {key:$key}) RETURN b.status AS status', { key: procKey }).catch(() => [])
  return r?.status || null
}
// a case's mode at this step (gateStep · runView · mapengine.js): view is the case's procGraph when the caller has it (its proc.status
// is the stage — for a case run from a map pinned to its start, the stage of that day); without it the stage is read now
export async function caseMode(c, view = null) {
  if (MODES.includes(c?.run_mode)) return caseModeOf(c.run_mode)
  return caseModeOf(null, view?.proc ? view.proc.status : await stageOf(c?.bundle || c?.proc))
}
// a process's mode for a case that would start now: the stage's (kept for callers that ask by process; a case asks caseMode)
export async function modeOf(procKey) {
  const stage = await stageOf(procKey)
  return { mode: modeOfStage(stage), from: 'stage', stage }
}
// every process's mode as its stage gives it (GET /ontology/run-mode — there is no setting of its own any more)
export async function modesView() {
  const rows = await cypher('MATCH (b:Process) RETURN b.key AS key, b.status AS status').catch(() => [])
  const live = rows.filter((r) => r.key && r.status !== 'gone')
  return { from: 'stage', byStage: { suggested: 'hitl', adopted: 'hotl' }, stages: Object.fromEntries(live.map((r) => [r.key, r.status || null])),
    modes: Object.fromEntries(live.map((r) => [r.key, modeOfStage(r.status)])), names: MODE_KO, stageNames: STAGE_KO }
}

// one step's own rule in a process: auto (an outward step that need not ask) · ask (always ask) · null (as the map says)
export async function setStepPolicy(me, procKey, task, policy) {
  if (policy !== null && !['auto', 'ask'].includes(policy)) throw err(400, 'policy 는 auto · ask 이거나 비워 두세요.')
  const view = await procGraph(procKey)
  if (!view.tasks.has(task)) throw err(404, '이 프로세스에 그 단계가 없어요.')
  if (policy) await q(`insert into pro_run_step_rules (tenant_id, proc_key, task, policy, by_user, at) values ($1,$2,$3,$4,$5,now())
                       on conflict (tenant_id, proc_key, task) do update set policy=excluded.policy, by_user=excluded.by_user, at=now()`, [T(), procKey, task, policy, me.email || String(me.id)])
  else await q(`delete from pro_run_step_rules where tenant_id=$1 and proc_key=$2 and task=$3`, [T(), procKey, task])
  await ledger(me, 'ontology.run.steprule', `「${view.proc.name}」의 「${task}」: ${policy === 'auto' ? '묻지 않고 진행' : policy === 'ask' ? '늘 묻기' : '지도대로'}`, { process: procKey, task, policy })
  return { key: procKey, task, policy }
}

// ---------- the facts of each step (read now, from the map) ----------
// the company's own records of each work that went to someone: how many, and how many to an outside role (what came in from
// outside is not the company sending)
async function outwardRecords(tasks, outside) {
  if (!tasks.length) return new Map()
  const raws = await q(`select raw, task from pro_onto_labels where tenant_id=$1 and task = any($2)`, [T(), tasks]).catch(() => [])
  const toTask = new Map([...tasks.map((t) => [t, t]), ...raws.map((r) => [r.raw, r.task])])
  const rows = await q(`select activity_label, from_role, to_role from pro_mail_history where tenant_id=$1 and activity_label = any($2) and coalesce(to_role,'') <> ''`, [T(), [...toTask.keys()]]).catch(() => [])
  const out = new Map()
  for (const r of rows) {
    if (outside.has(r.from_role)) continue
    const t = toTask.get(r.activity_label)
    const x = out.get(t) || { sent: 0, outside: 0, to: [] }
    x.sent++
    if (outside.has(r.to_role)) { x.outside++; if (!x.to.includes(r.to_role)) x.to.push(r.to_role) }
    out.set(t, x)
  }
  return out
}

// a step's facts in a process. 꼭 · 선택 and the class come from the edge settings (edgecond.js, edge-step-condition): `edges` lists the ways
// into the step with their settings; `rule` · `cls` · `responsible` here are the process-wide view (any way in) — a case reads its own way in
// (gateStep → caseStepSettings). settingsAt: a bpm case's snapshot time (the settings it was made with); without it, now.
export async function stepFacts(procKey, { view, validAt, settingsAt } = {}) {
  view ||= await procGraph(procKey, { validAt, settingsAt })
  const R = (await skillRules()).runMode || {}
  const tasks = [...view.tasks.values()]
  const origins = [...new Set(tasks.map((t) => t.origin || t.key))]
  const EC = await import('./edgecond.js')
  const settings = await EC.edgeConditionsOf(procKey, { asOf: settingsAt }).catch(() => new Map())
  const entries = EC.entryEdgesOf(view)
  const cands = new Map((await q(`select task, human from pro_ai_candidates where tenant_id=$1 and task = any($2)`, [T(), origins]).catch(() => [])).map((x) => [x.task, x.human || []]))
  const rules = new Map((await q(`select task, policy from pro_run_step_rules where tenant_id=$1 and proc_key=$2`, [T(), procKey]).catch(() => [])).map((x) => [x.task, x.policy]))
  const outside = new Set((view.all?.roles || []).filter((r) => r.outside).flatMap((r) => [r.key, r.name]).filter(Boolean))
  const records = await outwardRecords(origins, outside)
  const out = new Map()
  for (const t of tasks) {
    const o = t.origin || t.key
    const { front } = parseDefinition(t.definition_md || '')
    const runner = t.definition_md ? (front.runner === 'agent' ? 'agent' : 'person') : null
    const edges = entries.filter((e) => e.step === t.key).map((e) => ({ edge: e, setting: settings.get(EC.edgeKey(e.event, e.task)) || null }))
    const cls = EC.classOfEdges(edges)
    // process-wide: the first way in that is or may be 꼭, else the first with a setting (a case reads its own way — gateStep)
    const set = (edges.find((x) => EC.mayRequire(x.setting)) || edges.find((x) => x.setting?.requirement || x.setting?.rules?.length))?.setting || null
    const human = cands.get(o) || [], pinnedGate = !!t.pinned && t.pin_reason === GATE_PIN
    out.set(t.key, { task: t.key, origin: o, role: t.role || '', runner, cls: cls ? { class: cls.class, decided: !!cls.decided } : null, policy: rules.get(t.key) || null,
      responsible: responsibleOf({ cls, human, pinnedGate, runner }), duty: { human, pinnedGate, runner },
      irreversible: irreversibleOf({ name: t.key, front, records: records.get(o) }, R), edges,
      rule: set ? { requirement: set.requirement, rules: set.rules } : null, what: clean(front.description || t.description || '') || (t.role ? `${t.role}의 일` : '') })
  }
  return out
}

// ---------- cases ----------
export const kindOf = (row) => (String(row.agent_mode || '').toUpperCase() === 'DRAFT' ? 'draft' : row.agent_orch ? 'agent' : 'person')
export async function caseOfInstance(instId) {
  const [c] = await q(`select *, bundle as proc from pro_po_cases where tenant_id=$1 and $2 = any(instances) limit 1`, [T(), instId])
  return c || null
}
async function pausedOf(caseId) {
  const [r] = await q(`select paused from pro_case_runs where case_id=$1`, [caseId]).catch(() => [])
  return !!r?.paused
}
// what the case's steps made so far, in order, across its instances (a rewound case's later steps read the earlier ones)
export async function earlierOfCase(c) {
  const rows = c.instances?.length ? await q(`select activity_name, activity_id, output from todolist where proc_inst_id = any($1) and status::text in ('DONE','SUBMITTED') and activity_id <> 'intake' and output is not null order by end_date nulls last, updated_at`, [c.instances]) : []
  // a person's step's files (stepfiles.js — given in its form or in chat) with their text: what the later steps read of them
  const SF = await import('./stepfiles.js')
  return Promise.all(rows.map(async (r) => {
    const v = Object.values(r.output || {}).find((x) => x && typeof x === 'object') || {}
    const files = SF.filesOf(v)
    return { task: r.activity_name, text: v.result || v.summary || v.assumptions || '', title: v.title || '', ...(files.length ? { files: await SF.withText(files) } : {}) }
  }))
}
async function isAdmin(me) { return (await import('./service.js')).isAdmin(me) }
async function mayControl(me, c) {
  if (String(c.started_by) === String(me.id) || (await isAdmin(me))) return
  throw err(403, '이 건을 맡은 사람이나 관리자만 할 수 있어요.')
}

// the ways out of `from` as the snapshot takes them (the same rule as run.js unfold)
function waysOut(view, from) {
  const th = view?.proc?.theta ?? 0.05
  const pinned = (k) => !!view?.tasks.get(k)?.pinned
  return (view?.edges || []).filter((e) => e.from === from && e.status !== 'retired' && (e.p >= th || e.pinned || e.decided || (e.to !== END && pinned(e.to)))).map((e) => ({ to: e.to, p: e.p || 0 }))
}
// a map case's step that no way of the map led to (mapengine.js via.how entry · moved · rewound): what is true of it — the request
// chose it (its odds are in the reason), or a person moved or rewound the case to it. No 「…에서」(from) and no other branches.
export function mapStartProposal(task, via = {}) {
  const how = via.how
  const why = how === 'rewound' ? `사람이 「${task}」${ro(task)} 되감았어요 — 이 단계부터 다시 해요`
    : how === 'moved' ? (clean(via.why) && via.why !== '사람이 이 단계로 옮겼어요' ? clean(via.why) : `사람이 「${task}」${ro(task)} 옮겼어요 — 이 단계부터 해요`)
      : clean(via.why) || `이 건은 「${task}」부터 해요`
  return { from: '', to: task, p: null, cond: '', confidence: null, why, split: false, others: [], end: false, how }
}
// via: how a case run from the map came to this step (mapengine.js — the step it came from and the map's reason)
async function proposalFor(c, row, view, via = null) {
  // a map case has no 요청 접수 step: its first step comes from the request, a moved or rewound step from the person who moved it (not
  // from the start's odds — the waiting box said 「요청 접수에서 되감은 단계에서 이어서 해요 · 83%」)
  if (via && ['entry', 'moved', 'rewound'].includes(via.how)) return mapStartProposal(row.activity_name, via)
  const [prev] = via ? [] : await q(`select activity_name, activity_id from todolist where proc_inst_id=$1 and status::text in ('DONE','SUBMITTED') and id <> $2 order by end_date desc nulls last, updated_at desc limit 1`, [row.proc_inst_id, row.id])
  const from = via ? (['entry', 'moved', 'rewound'].includes(via.how) ? INTAKE : via.from || INTAKE) : !prev || prev.activity_id === 'intake' ? INTAKE : prev.activity_name
  if (from === INTAKE) {
    const o = c.entry_odds || null
    const moved = (c.history || []).filter((h) => ['moved', 'rewound'].includes(h.state)).at(-1)
    const why = moved && moved.task === row.activity_name ? `${moved.state === 'rewound' ? '되감은' : '옮긴'} 단계에서 이어서 해요` : o?.p != null && row.activity_name === c.entry_task ? `이 요청은 「${row.activity_name}」부터 하면 돼요(시작 일 ${pct(o.p)})` : `이 건은 「${row.activity_name}」부터 해요`
    return { from, to: row.activity_name, p: o?.p ?? null, cond: '', confidence: null, why, split: (o?.options || []).length > 1,
      others: (o?.options || []).filter((x) => x.task !== row.activity_name && view?.tasks.has(x.task)).map((x) => ({ to: x.task, p: x.p, cond: '' })), end: false }
  }
  const origin = view?.tasks.get(from)?.origin || from
  const rows = await q(`select to_task, cond, confidence from pro_branch_conditions where tenant_id=$1 and from_task=$2`, [T(), origin]).catch(() => [])
  const conds = new Map(rows.map((r) => [r.to_task, { cond: r.cond, confidence: r.confidence }]))
  const [g] = via ? [] : await q(`select data from events where proc_inst_id=$1 and event_type::text='gateway_decision' order by timestamp desc limit 1`, [row.proc_inst_id]).catch(() => [])
  const ev = (g?.data?.evaluations || []).find((e) => e.selected)
  const p = proposalOf({ from, to: row.activity_name, outs: waysOut(view, from), conds, engineWhy: via ? via.why || '' : (ev?.reason || ev?.explanation || '').slice(0, 200) })
  // two steps done side by side (and the one after both) are not one way out of several: there is no other branch to pick
  return via && ['parallel', 'join'].includes(via.how) ? { ...p, split: false, others: [] } : p
}

async function holderOf(todoId) {
  const [t] = await q(`select user_id, agent_orch::text as agent_orch, agent_mode::text as agent_mode from todolist where id=$1`, [todoId])
  if (!t) return null
  if (t.agent_orch && String(t.agent_mode || '').toUpperCase() === 'COMPLETE') return { agent: true, name: '업무 에이전트' }
  const ids = String(t.user_id || '').split(',').map((x) => x.trim()).filter(Boolean)
  const people = ids.length ? await q(`select username, email from users where tenant_id=$1 and id::text = any($2) and not coalesce(is_agent,false)`, [T(), ids]) : []
  return { agent: false, names: people.map((p) => p.username || p.email), draft: !!t.agent_orch }
}

// a map case's step waiting for its role's person to be chosen (mapengine.js holdUnbound): the same card, the role's people to pick from
export const askOwnerFor = (c, s) => askOwner(c, s)
async function askOwner(c, s, { facts = null, preview = null } = {}) {
  const owner = c.started_by
  if (!owner) return null
  const t = await mainThread(owner)
  const msg = await addMessage(owner, t.id, 'agent', 'onto-step', { state: 'ask', caseId: c.id, stepId: s.id, todoId: s.todo_id, task: s.task, kind: s.kind, mode: s.mode,
    why: s.why || [], whyText: whyLines(s.why || [], facts, s), reversible: s.reversible, proposal: s.proposal || null, holder: await holderOf(s.todo_id),
    preview: preview || s.preview || null, subject: c.trigger?.subject || '', from: c.trigger?.from || '',
    // 꼭 · 선택(steprule.js): what the step is for this case and why (a rule that matched, with its evidence)
    requirement: s.requirement || null, reqLine: s.matched?.line || '', matched: s.matched?.matched || null, need: s.need || null,
    ...(s.binding ? { role: s.role || s.binding.role, binding: s.binding } : {}) })
  await q(`update pro_case_steps set message_id=$2 where id=$1`, [s.id, msg.id])
  return msg
}

// a person moved or rewound the case to this step (its new instance starts there): an optional step is then done, not read
async function movedHere(c, row) {
  const last = (c.history || []).filter((h) => ['moved', 'rewound'].includes(h.state)).at(-1)
  if (!last || last.task !== row.activity_name || row.proc_inst_id !== c.instances?.at(-1)) return ''
  const [before] = await q(`select 1 from pro_case_steps where proc_inst_id=$1 and task=$2 and todo_id <> $3 limit 1`, [row.proc_inst_id, row.activity_name, row.id])
  return before ? '' : last.state === 'rewound' ? '사람이 이 단계로 되감아서 해요' : '사람이 이 단계로 옮겨서 해요'
}

// The gate (see the top). Returns {act: run | wait | person | skip, why, draftFirst?, facts}. A step that waits: the agent's work item
// is left alone (draft_status HUMAN_ASKED — the step pool never hands it out again until a person decides) and the owner is asked
// (not for a pause: the person who paused is watching). A step that is skipped (an optional one this case does not need) is ended
// as skipped here (steprule.js skipStep) — the step worker does not run it.
export async function gateStep(row) {
  const c = await caseOfInstance(row.proc_inst_id)
  if (!c) return { act: 'run' }
  const kind = kindOf(row)
  const [have] = await q(`select * from pro_case_steps where todo_id=$1`, [row.id])
  if (have?.state === 'waiting') return { act: 'wait', why: have.why }
  if (have?.state === 'skipped') return { act: 'skip', why: have.why, done: true }
  // a case run from the map pinned to the map of its start reads that map here too (mapengine.js); the edge settings: a map case reads
  // them now, a bpm case those its instance's snapshot was made with (edge-step-condition)
  const validAt = (await import('./mapengine.js')).mapTimeOf(c)
  const settingsAt = c.engine === 'map' ? undefined : snapshotTimeOf(c, row.proc_inst_id)
  const view = await procGraph(c.bundle, { validAt, settingsAt }).catch(() => null)
  const facts0 = view ? (await stepFacts(c.bundle, { view, validAt, settingsAt })).get(row.activity_name) || null : null
  // this case's way into the step (after the step that ended before it, or its start) and what is set on it
  const EC = await import('./edgecond.js')
  const prev = c.engine === 'map' && have?.via?.from ? have.via.from : (await earlierOfCase(c).catch(() => [])).filter((x) => x.task).at(-1)?.task || null
  const ways = view ? await EC.caseStepSettings(c, view, row.activity_name, { prev, asOf: settingsAt }).catch(() => []) : []
  const wayCls = EC.classOfEdges(ways)
  const facts = facts0 && { ...facts0, ways, cls: wayCls ? { class: wayCls.class, decided: !!wayCls.decided } : null,
    responsible: responsibleOf({ cls: wayCls, ...facts0.duty }) }
  // the case's mode: the one of its start, or (a case from before sql/045) its process's stage — changing the stage changes new cases only
  const { mode } = await caseMode(c, view)
  const paused = await pausedOf(c.id)
  const approved = have?.state === 'go'
  // (a map case's step made by a move or a rewind says so on its own row — the case keeps one instance, so movedHere cannot tell)
  const via = c.engine === 'map' ? have?.via || null : null
  const forced = via?.how === 'rewound' ? '사람이 이 단계로 되감아서 해요' : via?.how === 'moved' ? '사람이 이 단계로 옮겨서 해요' : via ? '' : await movedHere(c, row).catch(() => '')
  // 꼭 · 선택(steprule.js): what this step is for this case — its rules read against the case, an optional step's need of it; kept
  // as it was when a person said 「진행」. Nothing is read while the agent would wait for the pause anyway.
  // (several ways in — e.g. two results of the step before — : each is read, and one that comes out 꼭 makes the step 꼭)
  const req = approved ? (have.requirement ? { requirement: have.requirement, ...(have.matched || {}), need: have.need } : null)
    : await readWays(c, row.activity_name, ways, { what: facts?.what, forced, read: !(paused && kind !== 'person') })
      .catch((e) => { console.warn('[runmode] requirement', e.message); return null })
  const band = (await skillRules()).stepRules?.need || {}
  const d = decideStep({ mode, kind, responsible: !!facts?.responsible.on, irreversible: !!facts?.irreversible.on, policy: facts?.policy || null, paused, approved,
    requirement: req?.requirement || null, need: req?.need?.p ?? null, band })
  const proposal = await proposalFor(c, row, view, via).catch(() => null)
  const state = d.act === 'wait' ? 'waiting' : approved ? 'go' : 'auto'
  const matched = req ? { from: req.from, base: req.base, matched: req.matched, checked: req.checked, amount: req.amount, amountFrom: req.amountFrom, line: req.line, edge: req.edge || null } : null
  const [s] = await q(`insert into pro_case_steps (tenant_id, case_id, proc_inst_id, todo_id, task, kind, mode, state, why, reversible, hold_item, proposal, requirement, matched, need)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                       on conflict (todo_id) do update set mode=excluded.mode, state=excluded.state, why=excluded.why, reversible=excluded.reversible,
                         hold_item=excluded.hold_item, proposal=excluded.proposal, requirement=excluded.requirement, matched=excluded.matched, need=excluded.need, updated_at=now() returning *`,
  [T(), c.id, row.proc_inst_id, row.id, row.activity_name, kind, mode, state, approved ? have.why || [] : d.why, !facts?.irreversible.on, !!d.hold, approved ? have.proposal || proposal : proposal,
    req?.requirement || null, matched, req?.need || null])
  // 해도 되고 안 해도 되는 단계가 이 건에는 필요 없어 보이면: 까닭을 남기고 건너뛴다(엔진이 스스로 다음으로)
  if (d.act === 'skip') {
    try {
      await SR.skipStep({ c, todoId: row.id, stepId: s.id, reason: SR.skipReason(req), by: 'agent', me: await SR.ownerOf(c) })
      return { ...d, stepId: s.id, caseId: c.id, facts }
    } catch (e) {
      // could not end it as skipped: the step is done as it comes (safer than leaving it)
      console.warn(`[runmode] ${row.activity_name}: 건너뛰지 못해 그대로 진행`, e.message)
      return { act: kind === 'person' ? 'person' : 'run', why: [], stepId: s.id, caseId: c.id, facts }
    }
  }
  if (d.act === 'wait') {
    if (kind !== 'person') await q(`update todolist set draft_status='HUMAN_ASKED', consumer=null where id=$1`, [row.id])
    if (!d.why.every((w) => w === 'paused')) await askOwner(c, s, { facts })
    console.log(`[runmode] ${row.activity_name}: 기다림(${d.why.join(',')}) · ${mode}`)
  } else console.log(`[runmode] ${row.activity_name}: ${d.draftFirst ? '초안 먼저' : approved ? '사람이 정해 진행' : d.act === 'person' ? '사람 차례' : '저절로'} · ${mode}`)
  emit(c.started_by, 'ontology', { caseId: c.id, step: s.id, state: s.state })
  return { ...d, stepId: s.id, caseId: c.id, facts }
}

// a bpm case's instance: when its snapshot was made — the case's start for its first instance, the move or rewind that opened a later one
export function snapshotTimeOf(c, instId) {
  const i = (c.instances || []).indexOf(instId)
  const opened = (c.history || []).filter((h) => h.state === 'moved' || h.state === 'rewound')
  const at = i > 0 ? opened[i - 1]?.at : null
  const t = at || c.created_at
  return t ? new Date(t).toISOString() : undefined
}
// 꼭 · 선택 of a step for this case from its ways in ([{edge, setting}], edgecond.js caseStepSettings): every way with a setting is read
// (steprule.js forStep — rules against the case); a 꼭 one wins, else the first read. → forStep's answer + edge {event, task} | null
async function readWays(c, task, ways, { what = '', forced = '', read = true } = {}) {
  let first = null
  for (const w of ways) {
    const s = w.setting
    if (!s || (!s.requirement && !s.rules?.length)) continue
    const r = await SR.forStep(c, task, { set: { requirement: s.requirement, rules: s.rules }, what }, { forced, read })
    if (!r) continue
    const x = { ...r, edge: { event: w.edge.event, task: w.edge.task } }
    if (r.requirement === 'required') return x
    first ||= x
  }
  return first
}

// a person's step of a running case (no agent on it) as it opens — the agent steps and drafts come through the step worker
export async function gatePersonSteps() {
  const rows = await q(`select t.* from todolist t join pro_po_cases c on c.tenant_id=$1 and c.status='running' and t.proc_inst_id = c.instances[array_length(c.instances, 1)]
                        where t.tenant_id=$1 and t.status='IN_PROGRESS' and t.agent_orch is null and t.activity_id <> 'intake' and t.updated_at > now() - interval '1 hour'
                          and not exists (select 1 from pro_case_steps s where s.todo_id = t.id) order by t.start_date limit 10`, [T()])
  for (const r of rows) await gateStep(r).catch((e) => console.warn('[runmode] person step', e.message))
}

// 되돌릴 수 없는 단계: the agent made what would go out — kept as the step's draft, and the step waits for a person (decide)
export async function holdForSend(row, payload, gate = {}) {
  const v = Object.values(payload)[0] || {}
  const file = v.document || v.quote || v.proposal || null
  const preview = { to: v.mail?.to || '', subject: v.mail?.subject || v.title || '', text: String(v.mail?.body || v.result || '').slice(0, 2000), summary: v.summary || '', file: file?.url ? { name: file.name, url: file.url } : null }
  await q(`update todolist set draft=$2, draft_status='HUMAN_ASKED', consumer=null where id=$1`, [row.id, payload])
  const [s] = await q(`update pro_case_steps set state='waiting', why=$2, preview=$3, updated_at=now() where todo_id=$1 returning *`, [row.id, gate.why || ['irreversible'], preview])
  const c = await caseOfInstance(row.proc_inst_id)
  if (c && s) await askOwner(c, s, { facts: gate.facts, preview })
  console.log(`[runmode] ${row.activity_name}: 초안을 만들고 기다림(${(gate.why || []).join(',')})`)
  if (c) emit(c.started_by, 'ontology', { caseId: c.id, step: s?.id, state: 'waiting' })
}

// a waiting step goes on: an agent's work item back to the step pool (the gate looks again), a person's step onto their list
async function releaseStep(s, { reason = '' } = {}) {
  await q(`update pro_case_steps set state='released', hold_item=false, updated_at=now() where id=$1`, [s.id])
  if (s.kind !== 'person') await q(`update todolist set draft_status=null, consumer=null where id=$1 and draft_status='HUMAN_ASKED' and draft is null`, [s.todo_id])
  else await tellPerson(s.todo_id)
  const c = await getCase(s.case_id).catch(() => null)
  if (s.message_id && c?.started_by) await updateMessage(c.started_by, s.message_id, { state: 'released', note: reason }).catch(() => {})
}
// a person's step that was kept off their list is there now (a case run from the map: its work item opens only now — mapengine.js)
async function tellPerson(todoId) {
  const [t] = await q(`select user_id, proc_inst_id from todolist where id=$1`, [todoId])
  const M = await import('./mapengine.js')
  if (M.isMapInst(t?.proc_inst_id)) return M.toPerson(todoId)
  for (const id of String(t?.user_id || '').split(',').map((x) => x.trim()).filter(Boolean)) emit(id, 'notifications', {})
}

async function setPaused(me, c, paused) {
  await q(`insert into pro_case_runs (case_id, tenant_id, paused, paused_by, paused_at, updated_at) values ($1,$2,$3,$4,$5,now())
           on conflict (case_id) do update set paused=excluded.paused, paused_by=excluded.paused_by, paused_at=excluded.paused_at, updated_at=now()`, [c.id, T(), paused, me.id, paused ? new Date() : null])
}

// ---------- a person decides ----------
// on a waiting step: go (진행 — an outward step's draft is what goes out: this build only records it, sends nothing) · other (다른 갈래:
// the case moves to that step) · stop (멈추기: the case is paused, the step keeps waiting; 이어 가기 asks again) · skip (건너뛰기: a step
// set as 해도 되고 안 해도 되는 단계 ends as skipped and the engine goes on — steprule.js). A 꼭 하는 단계 passed by skip or another branch
// only says so ({confirm}) until the person confirms with a reason (kept in the ledger).
export async function decide(me, stepId, { action, to = '', confirm = false, reason = '' } = {}) {
  if (!['go', 'stop', 'other', 'skip'].includes(action)) throw err(400, 'action 은 go · stop · other · skip 이에요.')
  const [s] = await q(`select * from pro_case_steps where id=$1 and tenant_id=$2`, [stepId, T()]).catch(() => [])
  if (!s) throw err(404, '그 단계를 찾지 못했어요.')
  const c = await getCase(s.case_id)
  await mayControl(me, c)
  if (s.state !== 'waiting') throw err(409, '이미 정해진 단계예요.')
  // (a step whose role has nobody yet goes on when someone is chosen — mapengine.js setBinding)
  if ((s.why || []).includes('unbound') && action !== 'stop') throw err(409, '먼저 이 단계를 맡을 사람을 골라 주세요.')
  const [todo] = await q(`select id, status::text as status, draft, draft_status::text as draft_status, user_id, proc_inst_id from todolist where id=$1`, [s.todo_id])
  if (!todo || ['DONE', 'CANCELLED', 'SUBMITTED'].includes(todo.status)) throw err(409, '그 단계는 이미 닫혔어요.')
  const said = clean(reason).slice(0, 300)
  const passing = (action === 'skip' || action === 'other') && s.requirement === 'required'
  if (passing && !(confirm && said)) return { confirm: true, required: true, task: s.task, action, to: to || null, line: s.matched?.line || '꼭 하는 단계예요', step: s.id }
  if (action === 'skip' && !passing && s.requirement !== 'optional') throw err(400, '이 단계는 건너뛸 수 있게 정한 단계가 아니에요 — 지도에서 단계를 눌러 「해도 되고 안 해도 되는 단계」로 정할 수 있어요.')
  let out = {}
  if (action === 'skip') {
    if (await pausedOf(c.id)) throw err(409, '건이 멈춰 있어요 — 먼저 「이어 가기」를 눌러 주세요.')
    await SR.skipStep({ c, todoId: s.todo_id, stepId: s.id, reason: said || '사람이 이 건에는 하지 않기로 했어요', by: me.email || String(me.id), me })
    await q(`update pro_case_steps set decision='skip', decided_by=$2, decided_at=now(), updated_at=now() where id=$1`, [s.id, me.id])
    out = { skipped: true }
  } else if (action === 'stop') {
    await setPaused(me, c, true)
    await q(`update pro_case_steps set decision='stop', decided_by=$2, decided_at=now(), updated_at=now() where id=$1`, [s.id, me.id])
    out = { paused: true }
  } else {
    if (await pausedOf(c.id)) throw err(409, '건이 멈춰 있어요 — 먼저 「이어 가기」를 눌러 주세요.')
    if (action === 'other') {
      if (!(s.proposal?.others || []).some((o) => o.to === to)) throw err(400, '고를 수 있는 다른 갈래가 아니에요.')
      await q(`update pro_case_steps set state='moved', decision='other', decided_by=$2, decided_at=now(), hold_item=false, updated_at=now() where id=$1`, [s.id, me.id])
      const r = await moveCase(me, c.id, { task: to, reason: `사람이 다른 갈래(「${to}」)를 골랐어요` })
      out = { moved: to, instId: r.instId }
    } else if ((s.why || []).includes('irreversible') && todo.draft) {
      const formId = Object.keys(todo.draft)[0]
      const v = todo.draft[formId] || {}
      const sent = { to: v.mail?.to || s.preview?.to || '', subject: v.mail?.subject || s.preview?.subject || '', body: String(v.mail?.body || v.result || '').slice(0, 6000),
        at: iso(), by: me.email || String(me.id), stub: true, note: '이 판은 실제로 보내지 않아요 — 보냈을 내용만 건에 남겨요' }
      const payload = { [formId]: { ...v, sent } }
      // (a case run from the map ends the step here and the map says what comes next — mapengine.js finishItem; no engine to hand it to)
      const M = await import('./mapengine.js')
      if (M.isMapInst(todo.proc_inst_id)) await M.finishItem(s.todo_id, payload)
      else {
        const { error } = await admin.rpc('save_task_result', { p_todo_id: s.todo_id, p_payload: payload, p_final: true })
        if (error) throw new Error('save_task_result: ' + error.message)
      }
      const W = await import('../mining/worker.js')
      await W.events([
        { job_id: `send-${s.id}`, todo_id: s.todo_id, proc_inst_id: todo.proc_inst_id, crew_type: 'result', event_type: 'task_completed', data: payload },
        { job_id: 'CREW_FINISHED', todo_id: s.todo_id, proc_inst_id: todo.proc_inst_id, crew_type: 'crew', event_type: 'crew_completed', data: 'Task completed successfully' },
      ])
      await q(`update pro_case_steps set state='go', decision='go', decided_by=$2, decided_at=now(), sent=$3, updated_at=now() where id=$1`, [s.id, me.id, sent])
      await q(`update pro_po_cases set history = history || $2::jsonb, updated_at=now() where id=$1`, [c.id, JSON.stringify([{ task: s.task, state: 'would-send', at: sent.at, to: sent.to, subject: sent.subject }])])
      console.log(`[runmode] ${s.task}: 보낸 것으로 기록만(실제로 보내지 않음)`)
      out = { sent }
    } else {
      await q(`update pro_case_steps set state='go', decision='go', decided_by=$2, decided_at=now(), hold_item=false, updated_at=now() where id=$1`, [s.id, me.id])
      if (s.kind !== 'person') await q(`update todolist set draft_status=null, consumer=null where id=$1 and draft_status='HUMAN_ASKED'`, [s.todo_id])
      else await tellPerson(s.todo_id)
      out = { going: true }
    }
  }
  const what = action === 'go' ? (out.sent ? '보내기(기록만)' : '진행') : action === 'stop' ? '멈추기' : action === 'skip' ? '건너뛰기' : `다른 갈래 「${to}」`
  await ledger(me, 'ontology.run.step', `${c.trigger?.subject || '건'} · 「${s.task}」 ${what}`, { case: c.id, step: s.id, task: s.task, action, to: to || null, why: s.why, ...(said ? { reason: said } : {}) })
  if (passing) await ledger(me, 'ontology.run.pass', `${c.trigger?.subject || '건'} · 꼭 하는 단계 「${s.task}」${action === 'skip' ? ' 건너뛰기' : ` 대신 「${to}」`}`, { case: c.id, step: s.id, task: s.task, action, to: to || null, reason: said, via: 'step' })
  if (s.message_id) await updateMessage(c.started_by, s.message_id, { state: 'answered', answer: { action, to: to || null, at: iso(), by: me.email || '', sent: !!out.sent, ...(said ? { reason: said } : {}) } }).catch(() => {})
  emit(c.started_by, 'ontology', { caseId: c.id, step: s.id, state: action })
  return { ...out, step: s.id, run: await runView(me, c.id) }
}

export async function pauseCase(me, caseId) {
  const c = await getCase(caseId)
  await mayControl(me, c)
  if (c.status !== 'running') throw err(409, '진행 중인 건만 멈출 수 있어요.')
  await setPaused(me, c, true)
  await ledger(me, 'ontology.run.pause', `${c.trigger?.subject || '건'} · 멈추기`, { case: c.id })
  emit(c.started_by, 'ontology', { caseId: c.id, paused: true })
  return runView(me, caseId)
}

// 이어 가기: the steps that waited for the pause are looked at again (they may ask now); a step the owner stopped at is asked again
export async function resumeCase(me, caseId) {
  const c = await getCase(caseId)
  await mayControl(me, c)
  await setPaused(me, c, false)
  await ledger(me, 'ontology.run.resume', `${c.trigger?.subject || '건'} · 이어 가기`, { case: c.id })
  const waiting = await q(`select * from pro_case_steps where case_id=$1 and state='waiting'`, [c.id])
  for (const s of waiting) {
    if ((s.why || []).includes('paused')) await releaseStep(s, { reason: '이어 갔어요' })
    else if (s.decision === 'stop') {
      const [n] = await q(`update pro_case_steps set decision=null, decided_by=null, decided_at=null, updated_at=now() where id=$1 returning *`, [s.id])
      await askOwner(c, n, { facts: (await stepFacts(c.bundle).catch(() => new Map())).get(s.task) })
    }
  }
  emit(c.started_by, 'ontology', { caseId: c.id, paused: false })
  return runView(me, caseId)
}

// 이 단계로 되감기 (rewindCheck): without confirm, a rewind that would pass a step that already sent something outside only says so
export async function rewindCase(me, caseId, { task, confirm = false } = {}) {
  const c = await getCase(caseId)
  await mayControl(me, c)
  const v = await runView(me, caseId)
  const ck = rewindCheck(task, v.steps)
  if (!ck.ok) throw err(400, ck.why)
  if (ck.confirm && !confirm) return { confirm: true, lost: ck.lost, redo: ck.redo, task }
  if (await pausedOf(c.id)) throw err(409, '건이 멈춰 있어요 — 먼저 「이어 가기」를 눌러 주세요.')
  for (const s of await q(`select * from pro_case_steps where case_id=$1 and state='waiting'`, [c.id])) {
    await q(`update pro_case_steps set state='moved', hold_item=false, updated_at=now() where id=$1`, [s.id])
    if (s.message_id) await updateMessage(c.started_by, s.message_id, { state: 'moved', note: `「${task}」${ro(task)} 되감았어요` }).catch(() => {})
  }
  const r = await moveCase(me, c.id, { task, reason: '이 단계로 되감기', state: 'rewound', learn: false })
  await ledger(me, 'ontology.run.rewind', `${c.trigger?.subject || '건'} · 「${task}」${ro(task)} 되감기`, { case: c.id, task, lost: ck.lost, redo: ck.redo, instId: r.instId })
  emit(c.started_by, 'ontology', { caseId: c.id, rewound: task })
  return { rewound: task, lost: ck.lost, redo: ck.redo, instId: r.instId, run: await runView(me, caseId) }
}

// the steps of a list kept off people's lists for now (home · 할 일: notify.js · processes.js)
export async function heldTodos(ids) {
  if (!ids?.length) return new Set()
  const rows = await q(`select todo_id::text as id from pro_case_steps where tenant_id=$1 and state in ('waiting','planned') and hold_item and todo_id::text = any($2)`, [T(), ids.map(String)]).catch(() => [])
  return new Set(rows.map((r) => r.id))
}

// ---------- the run view (지켜보기) ----------
// every step the case reached or will reach in its current snapshot, oldest instance first: done · running (the agent) · person (a
// person's turn) · waiting (for whom and why) · next · closed (a move closed it), who holds it (the agent, or the role and its people),
// whether it can be undone, what it made or would send; the case's mode, pause and what a rewind to each reached step would mean
export async function runView(me, caseId) {
  const c = await getCase(caseId)
  const validAt = (await import('./mapengine.js')).mapTimeOf(c)
  const view = await procGraph(c.proc, { validAt }).catch(() => null)
  const facts = view ? await stepFacts(c.proc, { view, validAt }).catch(() => new Map()) : new Map()
  // the case's mode (from: case — taken at its start · stage — a case from before sql/045, read from the stage) and the process's stage
  // now (the map's ladder: a case that started in another stage keeps going as it started)
  const { mode, from } = await caseMode(c, view)
  const stageNow = validAt || !view?.proc ? await stageOf(c.proc) : view.proc.status || null
  const paused = await pausedOf(c.id)
  const gates = await q(`select * from pro_case_steps where case_id=$1 order by created_at`, [c.id]).catch(() => [])
  const byTodo = new Map(gates.map((g) => [String(g.todo_id), g]))
  const todos = c.instances.length ? await q(`select id::text as id, proc_inst_id, activity_id, activity_name, status::text as status, user_id, agent_orch::text as agent_orch, agent_mode::text as agent_mode,
      draft_status::text as draft_status, log, output, draft, start_date, end_date, updated_at from todolist where proc_inst_id = any($1) order by start_date nulls last, updated_at`, [c.instances]) : []
  const ids = [...new Set(todos.flatMap((t) => String(t.user_id || '').split(',').map((x) => x.trim()).filter(Boolean)))]
  const users = new Map((ids.length ? await q(`select id::text as id, username, email, coalesce(is_agent,false) as is_agent from users where tenant_id=$1 and id::text = any($2)`, [T(), ids]) : []).map((u) => [u.id, u]))
  const defs = new Map()
  for (const i of c.instancesInfo) if (!defs.has(i.proc_def_id)) { const [d] = await q(`select definition from proc_def where id=$1 and tenant_id=$2`, [i.proc_def_id, T()]); defs.set(i.proc_def_id, d?.definition || {}) }
  const firstVal = (o) => Object.values(o || {}).find((x) => x && typeof x === 'object') || {}
  const meIds = [String(me?.id || ''), String(me?.email || '')].filter(Boolean)
  // one step as the run view shows it: a = its activity (the snapshot's, or a map case's act), t = its work item (null: not yet), g = its gate's row
  const stepOf = (a, t, inst, current) => {
    const g = t ? byTodo.get(t.id) : null
    const f = facts.get(a.name) || null
    const agentStep = a.agentMode === 'complete' || (t?.agent_orch && String(t.agent_mode || '').toUpperCase() === 'COMPLETE')
    const holders = String(t?.user_id || '').split(',').map((x) => x.trim()).filter(Boolean)
    const people = holders.map((x) => users.get(x)).filter((u) => u && !u.is_agent).map((u) => u.username || u.email)
    const v = firstVal(t?.output), d = firstVal(t?.draft)
    const state = stepState(t, g)
    return {
      task: a.name, inst, current, todoId: t?.id || null, stepId: g?.id || null, state, at: t?.end_date || t?.updated_at || null,
      // the viewer's own turn: the step's work item is open and theirs (a comma list — a draft step lists the agent, then the person), not
      // waiting for the owner nor being drafted — the case view shows its form there (OntoCaseRun → TodoCard, POST /todos/:id/submit)
      mine: state === 'person' && holders.some((x) => meIds.includes(x)),
      kind: g?.kind || (agentStep ? 'agent' : a.agentMode === 'draft' ? 'draft' : 'person'),
      holder: agentStep ? { agent: true, name: '업무 에이전트', role: a.role } : { agent: false, role: a.role || '', names: people, draft: a.agentMode === 'draft' },
      reversible: g ? g.reversible : !f?.irreversible?.on, reversibleWhy: f?.irreversible?.why || '', responsible: f?.responsible?.on || false, responsibleWhy: f?.responsible?.why || [],
      policy: f?.policy || null, why: g?.state === 'waiting' ? g.why : [], whyText: g?.state === 'waiting' ? whyLines(g.why, f, (g.why || []).includes('unbound') ? { ...g, binding: findBinding(c.bindings, g.act?.role) } : g) : [], gate: g?.state || null, mode: g?.mode || null,
      // 꼭 · 선택(steprule.js): what this case read for the step (before it came: the step's own setting), the rule that matched, a skip
      requirement: g ? g.requirement || null : f?.rule?.requirement || null, reqLine: g?.matched?.line || '', matched: g?.matched?.matched || null, need: g?.need || null,
      hasRules: !!f?.rule?.rules?.length, skipped: g?.state === 'skipped' ? g.skip || { reason: '' } : null,
      failure: state === 'failed' ? clean(t?.log || '') || '에이전트가 이 단계를 하지 못했어요' : null,
      proposal: g?.proposal || null, preview: g?.state === 'waiting' ? g.preview || null : null, decision: g?.decision || null, sent: g?.sent ? { to: g.sent.to, subject: g.sent.subject, at: g.sent.at, stub: true } : null,
      result: clean(v.summary || v.title || v.result || d.summary || '').slice(0, 160) || null, hasDraft: !!Object.keys(d).length,
      // the files the person handed in with the step (its form's file field or chat — stepfiles.js)
      files: filesOf(v).map((x) => ({ name: x.name, url: x.url })), filesVia: filesOf(v).length ? (v.via === 'chat' ? 'chat' : 'form') : null,
      // a map case: how the map decided this step and which map it read (mapengine.js)
      ...(g?.via ? { via: { how: g.via.how, from: g.via.from || null, why: g.via.why || '', p: g.via.p ?? null }, mapAt: g.map_at || null } : {}),
    }
  }
  const steps = []
  if (c.engine === 'map') {
    // one instance: its work items in the order they were made; before the last move or rewind is the earlier run (shown folded, as a
    // snapshot case's closed instances are); after the open steps, what the map would do next (the most common way — nothing is made yet)
    const moved = (c.history || []).filter((h) => ['moved', 'rewound'].includes(h.state)).at(-1)
    const since = moved ? new Date(moved.at).getTime() - 1000 : 0
    const inst = c.instances[0]
    const made = todos.filter((t) => byTodo.has(t.id)).sort((a, b) => new Date(byTodo.get(a.id).created_at) - new Date(byTodo.get(b.id).created_at))
    for (const t of made) {
      const g = byTodo.get(t.id)
      steps.push(stepOf({ ...(g.act || {}), name: t.activity_name, id: t.activity_id }, t, inst, new Date(g.created_at).getTime() >= since))
    }
    if (c.status === 'running' && view) {
      const M = await import('./mapengine.js')
      for (const k of M.likelyNext(view, made.filter((t) => !['DONE', 'CANCELLED'].includes(t.status)).map((t) => t.activity_name))) {
        const f = facts.get(k)
        steps.push(stepOf({ name: k, role: f?.runner === 'agent' ? '업무 에이전트' : f?.role || '', agentMode: f?.runner === 'agent' ? 'complete' : 'none' }, null, inst, true))
      }
    }
  }
  for (const inst of c.engine === 'map' ? [] : c.instances) {
    const info = c.instancesInfo.find((i) => i.proc_inst_id === inst)
    const acts = (defs.get(info?.proc_def_id)?.activities || []).filter((a) => a.id !== 'intake')
    const current = inst === c.instances.at(-1)
    for (const a of acts) {
      const t = todos.filter((x) => x.proc_inst_id === inst && x.activity_id === a.id).at(-1) || null
      if (!t && !current) continue
      steps.push(stepOf(a, t, inst, current))
    }
  }
  const reached = [...new Set(steps.filter((s) => REACHED.includes(s.state)).map((s) => s.task))]
  const rewind = reached.map((k) => ({ task: k, ...rewindCheck(k, steps) })).filter((x) => x.ok).map(({ task, confirm, lost, redo }) => ({ task, confirm, lost, redo }))
  const mine = String(c.started_by) === String(me.id) || (await isAdmin(me).catch(() => false))
  const waitingFor = steps.find((s) => s.current && s.state === 'waiting')
  return { caseId: c.id, proc: c.proc, procName: view?.proc?.name || '', status: c.status, mode, modeFrom: from, modeName: MODE_KO[mode], modeStage: STAGE_OF_MODE[mode],
    stage: stageNow, stageName: STAGE_KO[stageNow] || '', paused, refined: !!view?.refined,
    engine: c.engine || 'bpm', mapPin: c.map_pin || null, instances: c.instances.length, bindings: bindingsView(c.bindings || []),
    subject: c.trigger?.subject || '', from: c.trigger?.from || '', steps, history: c.history || [], rewind,
    waiting: waitingFor ? { task: waitingFor.task, stepId: waitingFor.stepId, why: waitingFor.why, whyText: waitingFor.whyText } : null,
    controls: { mine, pause: mine && c.status === 'running' && !paused, resume: mine && paused } }
}

export { ORCH }
