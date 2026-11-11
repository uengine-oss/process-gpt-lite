// The admin's conversation about one recommendation (2026-11-10): ask why these cases are one process,
// confirm a step 필수 or 옵션, move a case to the process it belongs to, take or leave the new cases
// waiting as the proposal.
//
// The same split as the improve talk (agent.js improveTurn): the facts are computed here from what is
// stored (brief) — the category and who set it, each step's count, the draft from the counts and what the
// admin confirmed, the cases and the required steps they skipped, the proposal. The model only reads the
// admin's words into one `change` call or explains those facts. The change is run by service.js, and what
// changed is said in a fixed sentence, never in the model's words. Without a model the facts are said
// in a fixed shape and nothing is changed.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { chat } from '../llm.js'
import { L, isEn } from '../lang.js'
import * as M from './service.js'
import { findCases, findStep, findSuggestion } from './boundary.js'
import { josa } from '../improve/focus.js'

const T = () => config.tenantId
const KIND = { required: () => L('필수', 'required'), optional: () => L('옵션', 'optional'), choice: () => L('택일', 'one of a choice'), absent: () => L('정의에 없음', 'not in the definition') }

// the definition in one line: '요청 메일 접수 → [견적서 작성 → 견적서 검토(옵션) | 제안서 작성] → 고객 회신'
export function flowLine(items = []) {
  const one = (it) => {
    if (it.step) return `${it.step.activity}${it.step.decided?.kind === 'optional' ? L('(옵션)', ' (optional)') : ''}`
    return `[${it.branches.map((b) => (b.items.length ? flowLine(b.items) : L('건너뜀', 'skip'))).join(' | ')}]`
  }
  return items.map(one).join(' → ')
}
// '재무 검토'를 · 옵션으로 · '교육 일정표'로 — the particle follows the word, not the quote mark
const quoted = (w, pair) => `'${w}'${josa(w, pair).slice(String(w).length)}`
const as = (w) => josa(w, '으로/로')
const STATUS = { suggested: () => L('추천', 'recommended'), registered: () => L('정식 등록', 'registered'), held: () => L('보류', 'on hold') }

export async function history(me, id) {
  if (!(await M.isAdmin(me))) throw Object.assign(new Error(L('관리자만 볼 수 있어요.', 'Only an administrator can see this.')), { status: 403 })
  return q('select id, role, text, change, created_at from pro_mining_talk where tenant_id=$1 and suggestion_id=$2 order by created_at', [T(), id])
}

// the facts the answer is made of — numbers come only from here
export function brief(s) {
  const n = s.pattern.case_count || 0
  const byWho = (s.cases || []).reduce((o, c) => { const k = c.category_by || 'ai'; o[k] = (o[k] || 0) + 1; return o }, {})
  return {
    name: s.name,
    status: STATUS[s.status]?.() || s.status,
    category: s.pattern.category || '',
    category_set_by: { judged: byWho.ai || 0, admin: byWho.admin || 0 },
    case_count: n,
    rule: L('단계를 거친 사례가 전체의 절반을 넘으면 필수 초안, 아니면 옵션 초안. 관리자가 확정한 단계는 빈도로 바뀌지 않음',
      'A step in more than half of the cases is a required draft, otherwise optional. A step the admin confirmed is not changed by the counts'),
    // in_definition: what the process definition (BPMN) says now; cases/counts_say: the evidence from the cases
    definition_flow: s.flow ? flowLine(s.flow) : '',
    // branches nobody has decided: 정식 등록 waits for them (skip: when it is skipped, or 필수; when: when the
    // branch is taken; redo: when the step is done again). draft: what the cases' requests suggest and how many
    // cases it sorted right — the admin may take it as it is
    to_decide: (s.undecided || []).map((x) => ({ step: x.step,
      need: x.need === 'skip' ? L('언제 건너뛰는지(또는 필수)', 'when it is skipped (or required)') : x.need === 'redo' ? L('언제 다시 하는지', 'when it is done again') : L('언제 이 갈래로 가는지', 'when this branch is taken'),
      draft: x.draft || L('없음', 'none'), ...(x.draft ? { draft_fits: L(`사례 ${x.total}건 중 ${x.matched}건`, `${x.matched} of ${x.total} cases`) } : {}),
      ...(x.alternatives?.length ? { instead_of: x.alternatives } : {}) })),
    definition: s.status === 'registered' ? L('정식 등록된 프로세스 정의(BPMN)', 'the registered process definition (BPMN)') : L('정식 등록하면 저장될 프로세스 정의(BPMN)', 'the process definition (BPMN) 정식 등록 will save'),
    steps: (s.decided || []).map((x) => ({ step: x.activity, cases: `${x.cases}/${x.total}`, counts_say: KIND[x.draft](),
      in_definition: KIND[x.kind]?.() || x.kind, ...(x.skip_when ? { skipped_when: x.skip_when } : {}),
      ...(x.kind === 'choice' ? { taken_when: x.when, instead_of: x.alternatives } : {}),
      ...(x.redo_when ? { done_again_when: x.redo_when } : {}),
      set_by: x.by === 'admin' ? L('관리자 확정', 'admin') : x.by === 'cases' ? L(`업무 흐름 (사례 ${x.sorted}건 맞음)`, `the work (${x.sorted} cases fit)`) : L('마이닝 초안', 'mining draft') })),
    variants: (s.pattern.variants || []).map((v) => ({ order: v.trace.join(' → '), cases: v.count })),
    cases: (s.cases || []).map((c) => ({ subject: c.subject, customer: c.customer, category: c.category, category_set_by: c.category_by === 'admin' ? L('관리자', 'admin') : L('판단', 'judged'),
      steps: c.steps.map((e) => e.activity).join(' → '), skipped_required: c.missing })),
    proposal: s.proposal ? {
      new_cases: s.proposal.case_count,
      cases: (s.proposal.cases || []).map((c) => ({ subject: c.subject, customer: c.customer, steps: c.steps.map((e) => e.activity).join(' → '), skipped_required: c.missing })),
      new_steps: s.proposal.new_steps,
      counts_with_them: s.proposal.frequency,
      draft_would_change: (s.proposal.draft_changes || []).map((d) => ({ step: d.activity, counts_say: KIND[d.draft](), in_definition: KIND[d.holds](), set_by: d.by === 'admin' ? L('관리자 확정', 'admin') : L('빈도 초안', 'draft from counts') })),
    } : null,
    other_processes: (s.others || []).map((o) => ({ name: o.name, status: STATUS[o.status]?.() || o.status, category: o.category })),
    cases_in_no_process: (s.unplaced || []).map((c) => ({ subject: c.subject, customer: c.customer, category: c.category, category_set_by: c.category_by === 'admin' ? L('관리자', 'admin') : L('판단', 'judged') })),
  }
}

const TOOL = {
  type: 'function',
  function: {
    name: 'change',
    description: 'The administrator tells you to change this recommendation: confirm steps as required/optional, move cases to another process (or say a case is other work), or take/leave the new cases in the proposal. Only what they clearly asked for.',
    parameters: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'object', properties: {
          step: { type: 'string', description: 'step name as in facts.steps' },
          kind: { type: 'string', enum: ['required', 'optional', 'choice', 'loop'], description: 'required = every path passes it; optional = it can be skipped (an exclusive gateway in the BPMN); choice = the condition on which a branch of a choice (facts.to_decide need "when") is taken; loop = the condition on which the step is done again (facts.to_decide need "redo")' },
          skip_when: { type: 'string', description: 'optional: WHEN the step is skipped; choice: WHEN its branch is taken; loop: WHEN the step is done again — in the admin\'s own words (e.g. "견적 합계가 5천만 원 미만이면"). Leave empty if the admin did not say it — never invent it' },
          accept_draft: { type: 'boolean', description: 'true when the admin says to go with the draft condition shown in facts.to_decide (e.g. "초안대로 해", "그대로 진행")' },
        }, required: ['step', 'kind'] } },
        moves: { type: 'array', items: { type: 'object', properties: {
          case: { type: 'string', description: 'the case: its subject or customer as in facts.cases, facts.proposal.cases or facts.cases_in_no_process' },
          to: { type: 'string', description: 'name of the process it belongs to: facts.name to bring it into this one, or one of facts.other_processes' },
          category: { type: 'string', description: 'only when it belongs to no process: the kind of work it is' },
        }, required: ['case'] } },
        proposal: { type: 'string', enum: ['accept', 'reject'], description: 'accept = the new cases go into this process; reject = they are not this process' },
      },
    },
  },
}
const PROMPT = `당신은 프로세스 마이닝 추천을 관리자와 함께 확인하는 도우미입니다. facts 는 이 추천에 대해 저장된 값과 계산 결과입니다.
- 관리자가 묻기만 하면 도구 없이 facts 의 숫자와 이름으로만 답하세요. 숫자를 지어내지 마세요. 해요체로 짧게, 근거부터 말하세요.
- 도구는 마지막 메시지가 무엇을 바꾸라고 할 때만 부르세요. 앞선 대화의 지시는 이미 처리됐으니 다시 실행하지 마세요. 묻는 말(왜, 뭐가, 알려줘)에는 도구를 부르지 마세요.
- 관리자가 단계를 필수·옵션으로 정하라거나, 사례를 다른 프로세스로 옮기라거나, 새 사례를 넣거나 넣지 말라고 하면 change 도구를 한 번 부르세요. 관리자가 분명히 말한 것만 넣으세요.
- 필수·옵션·택일은 BPMN 의 뜻입니다. 필수 = 어느 경로로도 반드시 지나는 단계, 옵션 = 아무것도 하지 않고 넘어가는 길(배타 게이트웨이의 빈 갈래)이 있는 단계, 택일 = 배타 게이트웨이의 갈래 중 하나라 다른 갈래의 단계와 둘 중 하나를 하는 단계(빠질 수는 없음). facts.definition_flow 가 정의의 순서와 갈래이고([A | B] 는 택일), facts.steps 의 in_definition 이 지금 정의가 말하는 것입니다. cases·counts_say 는 사례에서 본 근거일 뿐입니다.
- 택일 단계는 필수·옵션으로 바꿀 수 없습니다(갈래를 바꾸는 것은 구조 수정). 관리자가 그렇게 말하면 change 도구로 넘기면 서버가 이유를 답합니다. 택일 갈래의 조건(언제 그 갈래로 가는지)은 kind 'choice' 와 skip_when 으로, 반복 판정의 조건(언제 다시 하는지)은 kind 'loop' 과 skip_when 으로 정합니다.
- 분기의 모든 흐름에는 조건이 있습니다. 기본 흐름은 없습니다. 한 흐름의 조건이 정해지면 다른 흐름은 그 반대("다음에 해당하지 않으면: …")가 됩니다. 조건은 업무 흐름(사례의 요청·문서가 모든 사례를 실제 간 흐름대로 가름)에서 정해지거나 관리자가 정합니다. 업무 흐름으로 정한 조건은 set_by 에 몇 건 중 몇 건이 맞았는지 있습니다.
- facts.to_decide 는 아직 정해지지 않은 분기입니다. 초안은 사례의 요청·문서에서 찾은 기준이고 draft_fits 가 맞은 건수입니다. 이것이 남아 있으면 정식 등록할 수 없습니다. 관리자가 "초안대로"·"그대로 진행"이라고 하면 그 단계마다 accept_draft: true 로 change 를 부르세요(초안이 '없음'이면 초안대로 할 수 없으니 조건이나 필수를 물으세요). 관리자가 정할 것을 물으면 to_decide 를 단계마다 초안과 함께 알려 주세요.
- facts 의 키 이름(영어 낱말)을 답에 쓰지 마세요. 화면의 말로 바꿔 말하세요.
- 옵션으로 정할 때 skip_when 에는 관리자가 말한 "언제 건너뛰는지"만 넣으세요. 관리자가 말하지 않았으면 비워 두세요. 지어내지 마세요. 앞 대화에서 시스템이 조건을 물었고 관리자가 이번에 조건만 답했다면, 그 단계를 옵션으로 정하고 그 답을 skip_when 에 넣으세요.
- 관리자가 사례를 이 프로세스로 넣거나 빼라고 하면, 이미 들어 있는지 스스로 판단하지 말고 change.moves 로 넘기세요. 같은 제목의 사례가 여럿이어도 서버가 아직 이 프로세스에 없는 사례만 골라 옮기고, 이미 있으면 그렇다고 답합니다.
- 무엇을 바꾸라는 것인지 가릴 수 없으면 도구 없이 되물으세요.
- 용어는 화면의 말만 쓰세요: 프로세스, 사례, 단계, 추천, 정식 등록, 보류, 필수 단계, 옵션 단계, 업무 범주, 제안, 빈도 초안, 관리자 확정. '카테고리'·'핵심 단계'·'케이스'라고 하지 마세요.`
const PROMPT_EN = `You help an administrator review a process mining recommendation. \`facts\` are the stored values and computed results for it.
- If they only ask, answer without tools, using only the numbers and names in facts. Never invent numbers. Short plain sentences, evidence first.
- Call the tool only when the LAST message asks for a change. Earlier instructions in the conversation are already done: never run them again. A question (why, what, tell me) never calls the tool.
- If they tell you to make a step required/optional, move a case to another process, or take/leave the new cases, call the change tool once with only what they clearly asked.
- Required/optional/choice mean what they mean in BPMN: required = every path passes the step; optional = a branch goes on without doing anything (an empty branch of an exclusive gateway); choice = one branch of an exclusive gateway, done instead of the other branch's step (never left out). facts.definition_flow is the definition's order and branches ([A | B] is a choice); facts.steps.in_definition is what the definition says now; the counts are only evidence.
- A choice step can't be made required or optional (changing branches changes the structure). If the admin asks, pass it to the change tool and the server says why. A choice branch's condition (when it is taken) is set with kind 'choice' and skip_when; a loop check's (when the step is done again) with kind 'loop' and skip_when.
- Every flow of a split has a condition; there is no default flow. Once one flow's condition is set, the other flow takes its opposite ("When this does not hold: …"). A condition comes from the work (the cases' requests and documents sorted every case the way it went) or from the admin; set_by says how many cases a condition from the work fit.
- facts.to_decide are the branches not decided yet; a draft is what the cases' requests and documents suggest, draft_fits how many cases it sorted right; registration waits for them. If the admin says to go with the draft ("as drafted", "go ahead"), call change with accept_draft: true for each (a draft of 'none' can't be taken: ask for the condition or required). If asked what is left to decide, list to_decide with each draft.
- Never use the key names in facts in your answer; say it in the screen's words.
- For optional, skip_when is only WHEN the admin said it is skipped. If they did not say, leave it empty — never invent it. If the system asked for the condition and the admin now answers with just the condition, make that step optional with their answer as skip_when.
- When the admin asks to bring cases into this process or take them out, do not decide yourself whether they are already in: pass them in change.moves. Even when several cases share a subject, the server moves only those not in this process yet, and says so if they already are.
- If you cannot tell what to change, ask back without tools.`

// the facts in a fixed shape (no model, or the model said nothing)
function plain(b) {
  const lines = [L(`'${b.name}'(${b.status})은 업무 범주 '${b.category}'로 묶인 사례 ${b.case_count}건이에요. 범주는 판단 ${b.category_set_by.judged}건, 관리자 ${b.category_set_by.admin}건이 정했어요.`,
    `'${b.name}' (${b.status}) is ${b.case_count} cases grouped as '${b.category}'. ${b.category_set_by.judged} were judged, ${b.category_set_by.admin} set by an admin.`)]
  if (b.definition_flow) lines.push(b.definition_flow)
  for (const x of b.steps) lines.push(`- ${x.step}: ${x.cases} · ${x.in_definition} (${x.set_by}${x.set_by.includes(L('빈도', 'counts')) ? '' : L(`, 빈도로는 ${x.counts_say}`, `, counts say ${x.counts_say}`)})`)
  if (b.proposal) lines.push(L(`새 사례 ${b.proposal.new_cases}건이 제안으로 와 있어요.`, `${b.proposal.new_cases} new case(s) are waiting as a proposal.`))
  return lines.join('\n')
}

// The condition must come from what the admin has just said — not from an earlier turn (the admin may have
// changed their mind since) and not from the model. Most of its words have to be in the latest message.
export function saidNow(condition, words) {
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, '')
  const parts = String(condition || '').split(/[\s,·]+/).map((w) => norm(w).replace(/(이면|면|이|가|을|를|은|는|에|의|으로|로)$/, '')).filter((w) => w.length >= 2)
  if (!parts.length) return false
  const said = norm(words)
  return parts.filter((w) => said.includes(w)).length * 10 >= parts.length * 6
}

// run what the model read from the admin's words; every line said back is fixed text
async function apply(me, s, call, words = '') {
  const said = []
  const done = []
  const stepNames = (s.decided || []).map((x) => x.activity)
  for (const x of call.steps || []) {
    const step = findStep(x.step, stepNames)
    if (!step) { said.push(L(`'${x.step}' 단계를 이 추천에서 하나로 가리지 못했어요. 단계: ${stepNames.join(', ')}`, `I couldn't tell which step '${x.step}' is. Steps: ${stepNames.join(', ')}`)); continue }
    // the draft as it is, when the admin said to go with it (to_decide: what mining wrote)
    const draft = (s.undecided || []).find((u) => u.step === step)?.draft || ''
    const skipWhen = x.accept_draft && draft ? draft : saidNow(x.skip_when, words) ? String(x.skip_when || '').trim() : ''
    // a choice's branch is not the admin's word's to change (the server says why); optional in BPMN = a way
    // around the task, when it is taken is the admin's to say
    const now = (s.decided || []).find((d) => d.activity === step)
    if (x.kind === 'choice' && !skipWhen && now?.kind === 'choice') {
      said.push(L(`언제 ${quoted(step, '으로/로')} 가나요? 조건을 알려 주세요.${draft ? ` 사례에서 찾은 초안은 "${draft}"예요. 초안대로 하려면 "초안대로"라고 해 주세요.` : ''} 다른 갈래에는 그 반대 조건이 붙어요.`,
        `When does the work go to '${step}'? Tell me the condition.${draft ? ` The draft from the cases is "${draft}" — say "as drafted" to keep it.` : ''} The other branch gets the opposite condition.`))
      continue
    }
    if (x.kind === 'loop' && !skipWhen) {
      said.push(L(`언제 ${quoted(step, '을/를')} 다시 하나요? 조건을 알려 주세요. 앞으로 가는 흐름에는 그 반대 조건이 붙어요.`,
        `When is '${step}' done again? Tell me the condition. The way forward gets the opposite condition.`))
      continue
    }
    if (x.kind === 'optional' && !skipWhen && now?.kind !== 'choice') {
      said.push(L(`${quoted(step, '을/를')} 언제 건너뛰나요? 조건을 알려 주세요. 예: "견적 합계가 5천만 원 미만이면". 프로세스 정의에는 '${step}' 앞에 배타 게이트웨이로 들어가, 조건이 맞으면 건너뛰고 아니면 ${quoted(step, '으로/로')} 가요.`,
        `When is '${step}' skipped? Tell me the condition, e.g. "when the quote total is under 50M". It goes into the process definition as an exclusive gateway before '${step}': skipped when the condition holds, otherwise it runs.`))
      continue
    }
    let r
    try { r = await M.setStep(me, s.id, step, x.kind, skipWhen) } catch (e) { if (e.status === 409 || e.status === 400) { said.push(e.message); continue } throw e }
    done.push({ type: 'step', ...r })
    const where = r.registered
      ? L(`정식 등록된 프로세스 정의를 새 버전 v${r.version} 로 저장했어요. 다음 메일부터 이 정의로 실행돼요.`, `Saved the registered process definition as version v${r.version}; the next mail runs it.`)
      : L('정식 등록할 때 이 정의로 저장돼요.', 'It is saved this way when you register the process.')
    if (r.kind === 'choice') {
      said.push(L(`${quoted(step, '으로/로')} 가는 조건을 확정했어요: "${r.when}". 다른 갈래에는 그 반대 조건이 붙었어요. ${where}`, `The branch to '${step}' is now taken "${r.when}"; the other branch takes the opposite. ${where}`))
      continue
    }
    if (r.kind === 'loop') {
      said.push(L(`${quoted(step, '을/를')} 다시 하는 조건을 확정했어요: "${r.redo_when}". 앞으로 가는 흐름에는 그 반대 조건이 붙었어요. ${where}`, `'${step}' is now done again "${r.redo_when}"; the way forward takes the opposite. ${where}`))
      continue
    }
    said.push(r.kind === 'optional'
      ? L(`${quoted(step, '을/를')} 옵션으로 확정했어요. 정의에서 '${step}' 앞에 배타 게이트웨이가 생겼어요: "${r.skip_when}" 건너뛰고, 그 반대 조건이면 ${quoted(step, '으로/로')} 가요. ${where} (사례 ${r.cases}/${r.total}건이 거친 단계예요.)`,
        `'${step}' is now optional. The definition has an exclusive gateway before it: skipped "${r.skip_when}", otherwise it runs. ${where} (${r.cases} of ${r.total} cases went through it.)`)
      : L(`${quoted(step, '을/를')} 필수로 확정했어요. 정의에서 ${quoted(step, '을/를')} 건너뛰는 길이 없어요. ${where}`,
        `'${step}' is now required: no path goes around it in the definition. ${where}`))
  }
  // (a case may be named by its subject, which several cases can share: the ones not yet in this process come first)
  const pool = [...(s.proposal?.cases || []), ...(s.unplaced || []), ...(s.cases || [])]
  for (const m of call.moves || []) {
    const here = (s.cases || []).map((x) => x.case_id)
    const into = m.to ? findSuggestion(m.to, [{ id: s.id, name: s.name, pattern: s.pattern }, ...(s.others || [])]) : null
    if (m.to && !into && !m.category) { said.push(L(`'${m.to}' 프로세스를 찾지 못했어요. 프로세스: ${(s.others || []).map((o) => o.name).join(', ') || '없음'}`, `I couldn't find the process '${m.to}'. Processes: ${(s.others || []).map((o) => o.name).join(', ') || 'none'}`)); continue }
    // bringing cases in: among those not here yet; anything else: among all it could mean
    const hit = findCases(m.case, into?.id === s.id ? pool.filter((x) => !here.includes(x.case_id)) : pool)
    // the same words fit cases that differ: ask back rather than guess
    const alike = hit.every((c) => c.subject === hit[0]?.subject && c.customer === hit[0]?.customer)
    if (!hit.length || !alike) { said.push(L(`'${m.case}' 사례를 가리지 못했어요. 사례 제목이나 고객 이름으로 알려 주세요.`, `I couldn't tell which case '${m.case}' is. Give its subject or customer.`)); continue }
    const moved = []
    for (const c of hit) {
      if (into && here.includes(c.case_id) && into.id === s.id) continue
      try { moved.push(await M.moveCase(me, c.case_id, { toId: into?.id || null, category: m.category || '' })) } catch (e) { if (e.status !== 400) throw e }
    }
    if (!moved.length) { said.push(L(`'${hit[0].subject}' 사례는 이미 ${into ? `'${into.name}'에` : '그 자리에'} 있어요. 바꾼 것은 없어요.`, `'${hit[0].subject}' is already ${into ? `in '${into.name}'` : 'there'}. Nothing changed.`)); continue }
    const r = moved[0]
    const many = moved.length > 1 ? L(` ${moved.length}건`, ` (${moved.length} cases)`) : ''
    done.push(...moved.map((x) => ({ type: 'move', ...x })))
    said.push(into
      ? L(`'${r.subject}' 사례${many}를 ${r.from ? `'${r.from}'에서 ` : ''}${quoted(r.to, '으로/로')} 옮겼어요. 업무 범주는 '${r.category}'(관리자 지정)예요. 다음 찾기부터 그대로 지켜지고, 같은 일을 요청한 다음 사례도 이 범주로 판단해요.`,
        `Moved '${r.subject}'${many}${r.from ? ` from '${r.from}'` : ''} to '${r.to}'. Its kind of work is now '${r.category}' (set by an admin). Later searches keep it there, and the next mail asking for the same work is judged by it.`)
      : L(`'${r.subject}' 사례${many}를 ${r.from ? `'${r.from}'에서 뺐어요` : '어느 프로세스에도 넣지 않았어요'}. 업무 범주는 '${r.category}'(관리자 지정)예요. 다시 이 프로세스로 들어오지 않아요.`,
        `Took '${r.subject}'${many} out of ${r.from ? `'${r.from}'` : 'every process'}. Its kind of work is now '${r.category}' (set by an admin). It will not come back to this process.`))
  }
  if (call.proposal) {
    if (!s.proposal?.case_ids?.length) said.push(L('지금은 반영할 제안이 없어요.', 'There is no proposal right now.'))
    else {
      const r = await M.decideProposal(me, s.id, call.proposal === 'accept')
      done.push({ type: 'proposal', ...r })
      said.push(r.accepted
        ? L(`새 사례 ${r.case_count}건을 '${r.name}'의 근거에 넣었어요. 확정한 필수·옵션은 그대로예요.`, `Added the ${r.case_count} new case(s) to '${r.name}'. The confirmed required/optional steps stay as they are.`)
        : L(`새 사례 ${r.case_count}건을 '${r.name}'에 넣지 않았어요. 이 사례들은 다시 이 프로세스로 제안되지 않아요.`, `Left the ${r.case_count} new case(s) out of '${r.name}'. They will not be proposed for it again.`))
    }
  }
  return { said, done }
}

export async function say(me, id, text) {
  if (!(await M.isAdmin(me))) throw Object.assign(new Error(L('관리자만 바꿀 수 있어요.', 'Only an administrator can change this.')), { status: 403 })
  const words = String(text || '').trim().slice(0, 2000)
  if (!words) throw Object.assign(new Error(L('내용을 입력해 주세요.', 'Type a message.')), { status: 400 })
  const s = await M.get(id)
  if (!s) throw Object.assign(new Error(L('추천을 찾지 못했어요.', "I couldn't find that recommendation.")), { status: 404 })
  await q('insert into pro_mining_talk (tenant_id, suggestion_id, user_id, role, text) values ($1,$2,$3,$4,$5)', [T(), id, String(me.id), 'admin', words])
  const b = brief(s)
  const past = (await q(`select role, text from pro_mining_talk where tenant_id=$1 and suggestion_id=$2 order by created_at desc limit 9`, [T(), id])).reverse().slice(0, -1)
  let reply = ''
  let change = null
  try {
    const r = await chat({
      model: config.llm.fastModel, temperature: 0, tools: [TOOL], signal: AbortSignal.timeout(Number(process.env.PRO_MINING_TALK_MS || 30000)),
      messages: [
        { role: 'system', content: `${isEn() ? PROMPT_EN : PROMPT}\n\nfacts:\n${JSON.stringify(b)}` },
        ...past.map((m) => ({ role: m.role === 'admin' ? 'user' : 'assistant', content: m.text })),
        { role: 'user', content: words },
      ],
    })
    const call = r.tool_calls?.find((c) => c.function?.name === 'change')
    if (call) {
      const args = JSON.parse(call.function.arguments || '{}')
      const out = await apply(me, s, args, words)
      reply = out.said.join('\n')
      change = out.done.length ? out.done : null
      // the next search keeps what was confirmed; the page shows it at once
      if (change) await M.scan().catch((e) => console.warn('[mining] talk scan', e.message))
    } else reply = String(r.content || '').trim()
  } catch (e) {
    if (e.status) throw e
    console.warn('[mining] talk', e.message)
  }
  if (!reply) reply = plain(b)
  const [m] = await q('insert into pro_mining_talk (tenant_id, suggestion_id, user_id, role, text, change) values ($1,$2,$3,$4,$5,$6) returning id, role, text, change, created_at',
    [T(), id, String(me.id), 'agent', reply, change ? JSON.stringify(change) : null])
  return { message: m, suggestion: await M.get(id) }
}
