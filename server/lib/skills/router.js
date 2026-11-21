// The chat router (design 2.3–2.4, plan C): one call reads every offered action skill's name and
// description, the agent's skills and the facts (names only), and answers with one function — an
// action skill with its confirmation sentence (ack), `delegate`, or `ask`. An inline skill comes with
// its arguments; a staged one shows its ack first, then a second call reads that skill's SKILL.md body
// and the facts in detail and fills the rest. What a message means is decided here by the model, from
// the skills' descriptions; the code checks the arguments against the facts' ids and nothing else.
import { config } from '../../config.js'
import { chat } from '../llm.js'
import { L, isEn, locale } from '../lang.js'
import { actionSkills } from './registry.js'
import { checkArgs, toolParameters } from './schema.js'
import { CONDITIONS, enumsOf, factLines, turnLines, labelOf } from './facts.js'

const RULES = `너는 Process GPT Lite 채팅의 라우터야. 사용자의 마지막 메시지를 보고 함수를 하나만 부른다.
- 행동 스킬 함수: 이 서버가 바로 하는 일. 함수 설명에 쓰는 때와 쓰지 않는 때가 적혀 있다. 아래 「사실」에 있는 id 만 인자로 쓴다.
- delegate: 그 밖의 모든 일 — 질문에 답하기, 글·메일·문서·파일 만들기, 찾아보기와 분석, 연결된 서비스 조회, 그림·도면·소리·영상, 스킬 만들기와 다듬기, 열린 문서 고치기, 잡담. 에이전트가 「에이전트 스킬」로 처리한다. 어느 행동 스킬에도 딱 맞지 않으면 delegate.
- ask: 대상을 고르는 행동(ask 의 skill 목록)을 하려는데 「사실」에 있는 대상 가운데 둘 이상이 똑같이 그럴듯할 때만 되묻는다. 시각·내용·값처럼 빠진 정보는 묻지 않는다 — 행동 스킬이 채우거나 에이전트가 스스로 묻는다.
행동 스킬은 그 행동이 요청의 끝일 때만 쓴다. 행동의 결과를 읽고 글·문서·메일을 더 만들어야 하는 요청이면 delegate.
ack 는 사용자에게 바로 보이는 해요체 한 문장: 무엇을 할지 말한다(끝났다고 말하지 않고, 실행 시각은 말하지 않는다).`
const RULES_EN = `You are the router of the Process GPT Lite chat. Read the user's last message and call exactly one function.
- Action skill functions: things this server does right away. Each description says when to use it and when not. Use only ids listed under "Facts" as arguments.
- delegate: everything else — answering questions, writing text, mail, documents and files, looking things up and analysis, reading connected services, pictures, drawings, sound and video, making and refining skills, editing the open document, small talk. The agent does it with its "agent skills". When no action skill fits exactly, delegate.
- ask: only when you are about to do an action that picks a target (the skills listed in ask) and two or more targets listed under "Facts" are equally plausible. Never ask for missing details such as a time, wording or values — the action skill fills them in or the agent asks itself.
Use an action skill only when that action is the whole request. When its result has to be read to write more text, a document or a mail, delegate.
ack is one short English sentence the user sees at once, first person: what you will do (never that it is done, never the run time).`

const ACK = () => ({ type: 'string', description: L('사용자에게 보일 해요체 확인 한 문장', 'One short English sentence to the user, first person, saying what you will do') })
// arguments a person reads are written in their language (x-lang in a schema)
const describeArg = (k, d, spec) => (spec['x-lang'] && isEn() ? `${d} (in English)` : d)

const stage1Args = (s) => (s.metadata.disclosure === 'inline' ? null : [].concat(s.metadata.stage1_args || []))
const needsStage2 = (s, args) => {
  if (s.metadata.disclosure !== 'staged') return false
  const cond = s.metadata.stage2_if
  if (!cond) return true
  return Object.entries(cond).every(([k, vals]) => [].concat(vals).includes(args[k]))
}

function delegateTool(facts) {
  const names = [...facts.agentSkills.map((k) => k.name), ...facts.mySkills.map((k) => k.name)]
  return { type: 'function', function: {
    name: 'delegate',
    description: L('위 행동 스킬이 아닌 일을 에이전트에게 넘긴다.', 'Hand the request to the agent (anything that is not one of the action skills).'),
    parameters: { type: 'object', properties: names.length ? { skill: { type: 'string', enum: [...new Set(names)], description: L('이 일에 쓸 에이전트 스킬이나 내 스킬이 분명하면 그 이름', 'the agent skill or my skill this needs, when it is clear') } } : {}, required: [] },
  } }
}
// ask: which of the facts' targets an action is for — offered only for the actions that have a target to
// pick (metadata.choose_if_missing), so a question about anything else is not the router's to ask
const askable = (skills) => skills.filter((s) => s.metadata.choose_if_missing)
function askTool(skills, enums) {
  const list = askable(skills)
  return { type: 'function', function: {
    name: 'ask',
    description: L('되묻기: 아래 행동 하나를 하려는데 사실에 있는 대상 둘 이상이 똑같이 그럴듯하고, 잘못 고르면 사람에게 나가거나 업무 절차가 시작될 때만. 빠진 정보를 묻는 데는 쓰지 않는다.',
      'Ask back: only when you are about to do one of these actions and two or more targets listed in the facts are equally plausible, and a wrong pick would reach a person or start a process. Not for missing details.'),
    parameters: { type: 'object', properties: {
      skill: { type: 'string', enum: list.map((s) => s.name), description: L('하려는 행동', 'the action you are about to do') },
      question: { type: 'string', description: L('해요체 질문 한 문장', 'one short English question') },
      options: { type: 'array', items: { type: 'string', enum: [...new Set(list.flatMap((s) => enums[s.schema.properties[s.metadata.choose_if_missing]['x-enum-from']] || []))] }, description: L('고를 대상의 id', 'ids of the targets to choose from') },
      args: { type: 'object', description: L('그 행동의 다른 인자(이미 알 수 있는 것만)', 'the action\'s other arguments, as far as they are known') },
    }, required: ['skill', 'question'] },
  } }
}
function skillTool(s, enums, { only, withAck = true } = {}) {
  return { type: 'function', function: {
    name: s.tool, description: s.description,
    parameters: toolParameters(s.schema, enums, { only, extra: withAck ? { ack: ACK() } : {}, extraRequired: withAck ? ['ack'] : [], describe: describeArg }),
  } }
}

const nowText = (now) => now.toLocaleString(locale(), { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', hour: 'numeric', minute: '2-digit' })

export function offered(facts, skills = actionSkills()) {
  return skills.filter((s) => (CONDITIONS[s.metadata.available_when || 'always'] || (() => false))(facts))
}

// the first stage's system prompt: the fixed rules first (the same every turn, so a prompt cache can
// hold it), then the facts, then the time
export function stage1Prompt(facts, skills, now) {
  const names = [...new Set([...skills.flatMap((s) => [].concat(s.metadata.facts || [])), 'agent_skills', 'my_skills'])]
  const lines = [...factLines(facts, names), ...turnLines(facts)]
  return `${L(RULES, RULES_EN)}\n\n## ${L('사실', 'Facts')}\n${lines.join('\n')}\n\n${L('지금 시각', 'Current time')}: ${nowText(now)}`
}

function parseCall(msg) {
  const call = msg?.tool_calls?.[0]
  if (!call) return null
  let args = {}
  try { args = JSON.parse(call.function.arguments || '{}') } catch { args = {} }
  return { name: call.function.name, args: args && typeof args === 'object' ? args : {} }
}

// the router's ask, as choices: each one the action with one of the targets (the facts' ids it named, or
// every candidate when it named fewer than two); an ask about an action without targets is not one
function askOf(call, skills, facts, enums) {
  const s = askable(skills).find((x) => x.name === call.args.skill)
  if (!s) return null
  const question = String(call.args.question || '').trim() || L('어느 것으로 할까요?', 'Which one?')
  const key = s.metadata.choose_if_missing
  const from = s.schema.properties[key]['x-enum-from']
  const known = enums[from] || []
  const other = call.args.args && typeof call.args.args === 'object' ? checkArgs(s.schema, call.args.args, enums).args : {}
  delete other[key]
  let ids = [...new Set((Array.isArray(call.args.options) ? call.args.options : []).filter((x) => known.includes(x)))]
  // one target named: nothing to choose between — the action with it
  if (ids.length === 1) return { one: { skill: s.name, args: { ...other, [key]: ids[0] } } }
  if (!ids.length) ids = from === 'schedules' ? facts.schedules.filter((x) => !x.paused).map((x) => x.id) : from === 'members' ? facts.team.map((x) => x.name) : known
  if (ids.length === 1) return { one: { skill: s.name, args: { ...other, [key]: ids[0] } } }
  if (ids.length < 2) return null
  return { skill: s.name, question, choices: ids.slice(0, 6).map((id) => ({ label: labelOf(facts, from, id), skill: s.name, args: { ...other, [key]: id } })) }
}

// the server's own ask when an id the skill needs is missing: the candidates from the facts, each one a
// choice that runs the skill with it
function chooseFrom(s, args, facts, enums) {
  const m = s.metadata
  const key = m.choose_if_missing
  if (!key || args[key] !== undefined) return null
  if (m.choose_when && !Object.entries(m.choose_when).every(([k, vals]) => [].concat(vals).includes(args[k]))) return null
  const from = s.schema.properties[key]['x-enum-from']
  const pool = from === 'schedules' ? facts.schedules.filter((x) => !x.paused).map((x) => x.id) : from === 'members' ? facts.team.map((x) => x.name) : enums[from] || []
  if (pool.length === 1) return { fill: { [key]: pool[0] } }
  if (pool.length < 2) return null
  return {
    ask: {
      question: L('어느 것으로 할까요?', 'Which one?'),
      choices: pool.slice(0, 6).map((id) => ({ label: labelOf(facts, from, id), skill: s.name, args: { ...args, [key]: id } })),
    },
  }
}

async function stage2({ s, messages, facts, enums, chosen, problems, llm, model, now, effort }) {
  let detail = facts
  if ([].concat(s.metadata.facts || []).includes('processes') && facts.more?.processes) {
    detail = { ...facts, processes: await facts.more.processes().catch(() => facts.processes) }
  }
  const system = [
    L('너는 라우터의 두 번째 단계야. 아래 스킬 문서를 읽고 그 함수의 인자를 채운다. 대상이 둘 이상 그럴듯하고 잘못 고르면 곤란하면 ask 를 부른다.',
      'You are the second stage of the router. Read the skill document below and fill in its function\'s arguments. If more than one target is plausible and a wrong pick would matter, call ask.'),
    `# ${s.name}\n${s.body}`,
    `## ${L('사실', 'Facts')}\n${[...factLines(detail, [].concat(s.metadata.facts || []), { detail: true }), ...turnLines(facts)].join('\n')}`,
    chosen && Object.keys(chosen).length ? `${L('앞 단계에서 정한 인자', 'Arguments chosen at the first stage')}: ${JSON.stringify(chosen)}` : '',
    problems?.length ? `${L('앞 단계 인자의 문제', 'Problems with the first stage\'s arguments')}: ${problems.join('; ')}` : '',
    `${L('지금 시각', 'Current time')}: ${nowText(now)}`,
  ].filter(Boolean).join('\n\n')
  const msg = await llm({ model, temperature: 0, toolChoice: 'required', ...(effort ? { effort } : {}),
    tools: [skillTool(s, enums, { withAck: false }), ...(askable([s]).length ? [askTool([s], enums)] : [])],
    messages: [{ role: 'system', content: system }, ...messages] })
  return parseCall(msg)
}

// decision: { route: 'skill' | 'delegate' | 'ask', skill, args, ack, question, choices, stage2, timings }
// effort: the router model's reasoning (reasoning_effort). The choice is one function from short
// descriptions, measured without reasoning (server/eval): 'none' unless PRO_ROUTER_EFFORT says otherwise
// ('' sends none at all; a model that refuses the argument has it dropped — lib/llm.js)
const EFFORT = process.env.PRO_ROUTER_EFFORT ?? 'none'
export async function decide({ messages, facts, skills = actionSkills(), llm = chat, model = config.llm.fastModel, onAck, now = new Date(), effort = EFFORT || undefined }) {
  const avail = offered(facts, skills)
  const enums = enumsOf(facts)
  const tools = [...avail.map((s) => skillTool(s, enums, { only: stage1Args(s) })), delegateTool(facts), ...(askable(avail).length ? [askTool(avail, enums)] : [])]
  const t0 = Date.now()
  const timings = {}
  const first = parseCall(await llm({ model, temperature: 0, toolChoice: 'required', tools, ...(effort ? { effort } : {}),
    messages: [{ role: 'system', content: stage1Prompt(facts, avail, now) }, ...messages] }))
  timings.stage1 = Date.now() - t0
  const base = { timings, stage2: false }
  if (!first || first.name === 'delegate') {
    const k = first?.args?.skill
    return { ...base, route: 'delegate', skill: [...enums.agent_skills, ...enums.my_skills].includes(k) ? k : null }
  }
  if (first.name === 'ask') {
    const a = askOf(first, avail, facts, enums)
    if (a && !a.one) return { ...base, route: 'ask', ...a }
    // nothing to choose between: the action itself, with what the ask already knew
    const named = avail.find((x) => x.name === (a?.one?.skill || first.args.skill))
    if (!named) return { ...base, route: 'delegate', skill: null }
    first.name = named.tool
    first.args = { ...(a?.one?.args || first.args.args || {}), ack: '' }
  }
  const s = avail.find((x) => x.tool === first.name)
  if (!s) return { ...base, route: 'delegate', skill: null }
  const ack = String(first.args.ack || '').trim()
  let r = checkArgs(s.schema, first.args, enums, { only: stage1Args(s) })
  let args = r.args
  let ackShown = false
  const show = async () => { if (!ackShown && ack) { ackShown = true; timings.ack = Date.now() - t0; await onAck?.(ack) } }
  // arguments that are not right (an id not in the facts, a required one left out — other than the target
  // the server asks for itself), or a staged skill: its body is read (stage 2)
  const retry = !r.ok && !r.errors.every((e) => e.endsWith('missing') && e.startsWith(`${s.metadata.choose_if_missing}:`))
  if (needsStage2(s, args) || retry) {
    if (s.metadata.disclosure === 'staged') await show()
    const t1 = Date.now()
    const second = await stage2({ s, messages, facts, enums, chosen: args, problems: retry ? r.errors : [], llm, model, now, effort }).catch((e) => { console.warn('[router] stage 2', e.message); return null })
    timings.stage2 = Date.now() - t1
    base.stage2 = true
    const a2 = second?.name === 'ask' ? askOf({ args: { ...second.args, skill: s.name, args: { ...args, ...(second.args.args || {}) } } }, [s], facts, enums) : null
    if (a2 && !a2.one) return { ...base, route: 'ask', ack: ackShown ? ack : '', ackShown, ...a2 }
    if (a2?.one) {
      r = checkArgs(s.schema, a2.one.args, enums)
      args = r.args
    } else if (second?.name === s.tool) {
      r = checkArgs(s.schema, { ...second.args, ...args }, enums)
      args = r.args
    } else r = checkArgs(s.schema, args, enums)
  } else if (s.metadata.disclosure === 'staged') r = checkArgs(s.schema, args, enums)
  const pick = chooseFrom(s, args, facts, enums)
  if (pick?.fill) { Object.assign(args, pick.fill); r = checkArgs(s.schema, args, enums) }
  if (pick?.ask) return { ...base, route: 'ask', skill: s.name, ack: ackShown ? ack : '', ackShown, ...pick.ask }
  // a required argument still missing after the skill's body was read: the agent's turn
  const missing = (s.schema.required || []).filter((k) => args[k] === undefined && k !== s.metadata.choose_if_missing)
  if (missing.length) return { ...base, route: 'delegate', skill: null, ack: ackShown ? ack : '', ackShown, unfilled: { skill: s.name, missing } }
  return { ...base, route: 'skill', skill: s.name, args, ack, ackShown, ok: r.ok, errors: r.errors }
}

// a choice from an ask (stored with its message): run its skill when its arguments are still right now
export function choiceDecision(choice, facts, skills = actionSkills()) {
  const s = choice?.skill ? skills.find((x) => x.name === choice.skill) : null
  if (!s || !offered(facts, skills).includes(s)) return null
  const r = checkArgs(s.schema, choice.args || {}, enumsOf(facts))
  return r.ok ? { route: 'skill', skill: s.name, args: r.args, ack: '', ackShown: false, ok: true, errors: [], timings: {}, stage2: false } : null
}
