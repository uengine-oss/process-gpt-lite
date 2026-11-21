// Which way each case went at a split, and what tells the ways apart (2026-11-11, openspec design 결정 9).
//
// A condition from the work: the cases that passed a split each took one flow. The model is shown each
// flow's cases — their request (mail subject, body, the documents asked for) and the documents made before
// the split, never after it: the engine judges the condition at the split, from what the work holds by
// then — and asked for what sets the flows apart. A second call, which does not know which way any case
// went, sorts every case by those conditions. Only when it sorts every case onto the flow it took, and
// every flow has a case, is the condition the work's (by 'cases'); otherwise it is a draft with how many it
// sorted right, and the admin decides (shape.js undecided). A loop check is left to the admin: a case that
// did a step again went on in the end too, so cases do not split between its two flows.
import { chatJson } from '../llm.js'
import { L } from '../lang.js'
import { splitsOf } from './shape.js'

const outsOf = (def, id) => (def.sequences || []).filter((s) => s.source === id)
function reach(def, from) {
  const seen = new Set([from]), todo = [from]
  while (todo.length) for (const s of outsOf(def, todo.pop())) if (!seen.has(s.target)) { seen.add(s.target); todo.push(s.target) }
  return seen
}
const nameOf = (def, id) => (def.activities || []).find((a) => a.id === id)?.name || ''
const idOf = (def, name) => (def.activities || []).find((a) => a.name === name)?.id || null

/**
 * traces: { caseId: [step names, in order] } →
 *   [{ gateway, kind, step, flows: [{ seq, target, label, cases }], ambiguous }]
 * A case passed a split when it did the task before it (any case, right after the start) and was not
 * caught on two ways at a split before it. It went down a flow when it did a task of that flow; the empty
 * flow is the one of a case that did none of the others'. Caught on two flows: left out (ambiguous).
 */
export function branchCases(def, traces) {
  const out = []
  const unsure = new Map() // split gateway → cases caught on two of its flows
  const splits = splitsOf(def)
  for (const sp of splits) {
    const before = (sp.kind === 'loop' ? sp.step : taskBeforeName(def, sp.gateway))
    const enclosing = splits.filter((x) => x !== sp && reach(def, x.gateway).has(sp.gateway) && !reach(def, sp.gateway).has(x.gateway))
    const passed = Object.entries(traces).filter(([id, t]) => (!before || t.includes(before)) && !enclosing.some((x) => unsure.get(x.gateway)?.has(id)))
    const label = (f) => f.first || (f.empty ? L('건너뜀', 'Skip') : '')
    if (sp.kind === 'loop') {
      out.push({ gateway: sp.gateway, kind: 'loop', step: sp.step, ambiguous: [],
        flows: sp.flows.map((f) => ({ seq: f.seq, target: f.target, label: label(f), cases: passed.filter(([, t]) => (f.redo ? t.filter((x) => x === sp.step).length > 1 : true)).map(([id]) => id) })) })
      continue
    }
    const hits = (t, f) => f.tasks.some((x) => t.includes(x))
    const flows = sp.flows.map((f) => ({ seq: f.seq, target: f.target, label: label(f), cases: [] }))
    const ambiguous = []
    for (const [id, t] of passed) {
      const on = sp.flows.filter((f) => !f.empty && hits(t, f))
      if (on.length > 1) { ambiguous.push(id); continue }
      const f = on[0] || sp.flows.find((x) => x.empty)
      if (f) flows[sp.flows.indexOf(f)].cases.push(id)
    }
    unsure.set(sp.gateway, new Set(ambiguous))
    out.push({ gateway: sp.gateway, kind: sp.kind, step: sp.step, flows, ambiguous })
  }
  return out
}
function taskBeforeName(def, id) {
  const seen = new Set([id]), todo = [id]
  while (todo.length) {
    const n = todo.shift()
    for (const s of (def.sequences || []).filter((x) => x.target === n)) {
      if (seen.has(s.source)) continue
      const name = nameOf(def, s.source)
      if (name) return name
      seen.add(s.source); todo.push(s.source)
    }
  }
  return ''
}

/** the steps of a case recorded before a split (tasks from which the split is reached): what the engine has by then */
export function materialsBefore(def, gatewayId, steps) {
  const ok = new Set((def.activities || []).filter((a) => reach(def, a.id).has(gatewayId) && !reach(def, gatewayId).has(a.id)).map((a) => a.name))
  return (steps || []).filter((s) => ok.has(s.activity))
}

/**
 * The work's condition for one split, or a draft.
 *   kind: 'optional' | 'choice' | 'loop'
 *   flows: [{ seq, label, cases }]   (branchCases)
 *   materials: { caseId: what the case held at the split }
 *   ask(kind, input): 'find' → { conditions: { label: text } }, 'check' → { assign: { caseId: 'A' | 'B' … | 'none' } }
 *   named: the flows to find a condition for (the ones the admin would be asked about: shape.js undecided);
 *   by default every flow but the one most cases took (for an optional step: the one into it). The flows not
 *   named take the complement.
 * → { grounded, conditions: { seq: text } | null, matched, total }
 */
export async function deriveSplit({ kind, flows, materials, named: only = null, ask = askModel }) {
  const total = flows.reduce((n, f) => n + f.cases.length, 0)
  const none = { grounded: false, conditions: null, matched: 0, total }
  if (kind === 'loop' || !total || flows.length < 2) return none
  const base = kind === 'optional' ? flows.find((f) => f.cases.length && f.label && !isSkip(f)) || maxBy(flows) : maxBy(flows)
  const named = only ? flows.filter((f) => only.includes(f.seq)) : flows.filter((f) => f !== base)
  if (!named.length || named.length === flows.length) return none
  const of = (ids) => ids.map((id) => ({ id, ...(materials[id] || {}) }))
  const found = await ask('find', { branches: flows.map((f) => ({ label: f.label, cases: of(f.cases) })), name: named.map((f) => f.label) }).catch(() => null)
  const conds = found?.conditions || {}
  if (!named.every((f) => String(conds[f.label] || '').trim())) return none
  const letters = Object.fromEntries(named.map((f, i) => [f.seq, String.fromCharCode(65 + i)]))
  const check = await ask('check', {
    conditions: Object.fromEntries(named.map((f) => [letters[f.seq], String(conds[f.label]).trim()])),
    cases: of(flows.flatMap((f) => f.cases)),
  }).catch(() => null)
  const assign = check?.assign || {}
  let matched = 0
  for (const f of flows) for (const id of f.cases) if ((assign[id] || 'none') === (letters[f.seq] || 'none')) matched++
  const conditions = Object.fromEntries(named.map((f) => [f.seq, String(conds[f.label]).trim()]))
  return { grounded: matched === total && flows.every((f) => f.cases.length), conditions, matched, total }
}
const maxBy = (flows) => flows.reduce((m, f) => (f.cases.length > m.cases.length ? f : m), flows[0])
const isSkip = (f) => f.label === '건너뜀' || f.label === 'Skip'

const FIND = `프로세스의 한 분기에서 업무들이 서로 다른 흐름으로 갔습니다. branches 에 흐름마다 그 흐름으로 간 업무가 있습니다.
업무마다 고객의 요청(메일 제목·본문·요청한 문서)과 분기 전에 만든 문서만 있습니다.
무엇이 흐름을 갈랐는지 찾아, name 에 있는 흐름마다 그 흐름으로 가는 조건을 한 문장으로 쓰세요.
JSON {"conditions": {"<흐름>": "<조건>"}} 으로 답하세요.
- 조건은 업무가 분기 시점에 가진 것(요청 내용·요청 문서·앞 단계 문서)으로 판단할 수 있어야 합니다. 예: "고객이 메일에서 <어떤 문서>를 요청했으면"
- 흐름의 이름(단계 이름)을 조건으로 바꾸지 마세요. "이번 일에 '<단계 이름>'이 필요하면"은 조건이 아닙니다
- 업무들 사이에 가를 만한 차이가 보이지 않으면 {"conditions": {}} 로 답하세요. 지어내지 마세요`
const FIND_EN = `At one split of a process, pieces of work went different ways. \`branches\` lists, per way, the work that went there.
Each piece has only the customer's request (mail subject, body, the documents asked for) and the documents made before the split.
Find what set the ways apart and write, for each way in \`name\`, the condition for going that way, in one sentence.
Answer with JSON {"conditions": {"<way>": "<condition>"}}.
- A condition must be judged from what the work holds at the split (the request, the documents asked for, earlier documents). E.g. "the customer asked for <a document> in the mail"
- Never turn the way's name (a step name) into the condition. "This work needs '<step name>'" is not a condition
- If nothing sets them apart, answer {"conditions": {}}. Do not invent one`
const CHECK = `업무마다 아래 조건 중 어느 것에 맞는지 고르세요. 맞는 것이 없으면 "none" 입니다.
JSON {"assign": {"<업무 id>": "<조건 글자 또는 none>"}} 으로 모든 업무에 답하세요.
업무에는 고객의 요청과 분기 전에 만든 문서만 있습니다. 그것만으로 판단하세요.`
const CHECK_EN = `For each piece of work, pick which of the conditions it meets, or "none".
Answer with JSON {"assign": {"<work id>": "<condition letter or none>"}} for every piece.
Each piece has only the customer's request and the documents made before the split. Judge from those alone.`

// ---------- 반대쪽 조건: 같은 뜻을 업무 말로 ----------
// The flow left on a two-way split takes the opposite of the other's condition. Written as the admin would
// say it ("견적 합계가 5천만 원 이상이면", not "다음에 해당하지 않으면: 견적 합계가 5천만 원 미만이면"); the
// same measure and the same numbers — nothing added. A sentence with a number the condition does not have,
// or no different from it, is not taken: the wrapped form (shape.js notHolds) stays.
const OPP = `아래 조건이 맞지 않는 경우를 조건 한 문장으로 쓰세요. JSON {"opposite": "<조건>"} 으로 답하세요.
- 같은 기준과 같은 숫자만 쓰세요. 새 조건·숫자·사실을 더하지 마세요
- 부정을 겹치지 말고 바로 읽히게 쓰세요. 예: "<금액 항목>이 <기준 금액> 미만이면" → "<금액 항목>이 <기준 금액> 이상이면", "고객이 <문서>를 요청하지 않았으면" → "고객이 <문서>를 요청했으면"
- 조건과 같은 말투로 "~면"으로 끝내세요`
const OPP_EN = `Write, as one condition, the case where the condition below does not hold. Answer with JSON {"opposite": "<condition>"}.
- Use the same measure and the same numbers only. Add no new condition, number or fact
- No double negatives; make it read at once. E.g. "<an amount> is under <a limit>" → "<an amount> is <the limit> or more"`
const numbers = (t) => (String(t || '').replace(/,/g, '').match(/\d+(?:\.\d+)?\s*(?:천|만|억|조)*/g) || []).map((x) => x.replace(/\s+/g, ''))
/** the opposite says nothing the condition does not: no number it lacks, and not the same sentence */
export function sameFacts(cond, opposite) {
  const o = String(opposite || '').trim()
  if (!o || o === String(cond || '').trim()) return false
  const have = new Set(numbers(cond))
  return numbers(o).every((n) => have.has(n))
}
/** the opposite of a condition in plain words, or null (then the wrapped form stays) */
export async function writeOpposite(cond, ask = (input) => chatJson(L(OPP, OPP_EN), JSON.stringify(input))) {
  const c = String(cond || '').trim()
  if (!c) return null
  const r = await ask({ condition: c }).catch(() => null)
  const o = String(r?.opposite || '').trim()
  return sameFacts(c, o) ? o : null
}

async function askModel(kind, input) {
  return chatJson(kind === 'find' ? L(FIND, FIND_EN) : L(CHECK, CHECK_EN), JSON.stringify(input))
}

export { idOf }
