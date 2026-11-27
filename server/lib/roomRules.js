// 방 규칙(spec pgpt-pro_room-rules): "이 방에 내가 주는 링크는 그 사이트에서 이렇게 해 줘". 한 프로젝트 방의 약속이다.
// 사람이 "주면 돼"라고 정한 것이므로 묻지 않고 실행하고, 그래서 방 맨 위에 늘 보이며 끌 수 있다.
//
// 말의 뜻은 모델이 읽는다(2026-11-21, 사용자 지시: 정규식·낱말 목록·사이트 이름을 코드에 두지 않는다).
//   · 방 판정(readRoom): 프로젝트 방의 메시지는 다른 지름길보다 먼저 lib/judge.js 에 한 번 묻는다 —
//     규칙을 정하는 말(set_rule)인가, 규칙의 대상으로 준 것(run_rule, 규칙이 있을 때만)인가, 그 밖(other)인가. 0.7 이상만 따른다.
//   · 받아 적기(ruleAction): 할 일 한 문장과, 그 일을 하는 브라우저 스킬(lib/browserSkills.js 목록의 이름·설명만 보고 고른 것).
// 쓰는 구조적 신호는 이 방의 규칙이 있는가, 첨부 파일이 있는가, 이 사람의 브라우저 작업이 이 방에서 돌거나 방금 끝났는가다.
// 작업이 있으면 판정은 그 작업(제목 · 하는 단계 · 기다리는 것, 끝난 모양 · 끝맺은 말)도 읽고, 「그 작업에게 어떻게 하라는 말」(steer)을
// 고를 수 있다. 그런 때 규칙을 정하는 말은 더 높은 기준(0.85)에서만 따른다(2026-11-25 녹화: 작업에 준 지시가 방의 규칙을 덮어썼다).
// 프로젝트 계획(lib/projectNote.js, 2026-11-27): 판정은 계획의 목적 · 지킬 것도 읽고, 「이 프로젝트의 방향 · 지킬 것을 더하거나 고치는 말」(plan —
// 계획에 넣기)을 고를 수 있다. 규칙 · 목적을 통째로 바꾸는 말(set_rule)과 갈라, 세부 지시가 방의 일을 덮어쓰지 않게 한다. 질문과 보기의 글은
// 스킬 project-plan(skills/project-plan/rules.json 의 room — 회사마다 고쳐 쓴다)에 있다.
//
// 규칙은 따로 테이블을 두지 않고, 규칙을 받아 적은 그 방의 안내 메시지(content.roomRule {said, action, skill, runs})에 둔다.
// 운영 DB 에 SQL 을 따로 돌리지 않아도 되고, 방을 지우면 규칙도 함께 사라진다. 방마다 마지막 규칙 하나만 쓴다.
import { config } from '../config.js'
import { q } from './supa.js'
import { L } from './lang.js'
import { chatJson } from './llm.js'
import { judge } from './judge.js'
import { browserSkill, browserSkillCatalog } from './browserSkills.js'
import { planSkill, roomTexts, noteText, skillLabel } from './projectNote.js'

export const RULE_BAR = 0.7
// a rule set while a browser task of this person runs here or just ended: that sure only
export const RULE_BAR_BUSY = 0.85
const cap = (t, n = 400) => String(t || '').trim().slice(0, n)
const names = (files) => files.map((f) => f?.name).filter(Boolean).join(', ')

// ---- 방 판정 ----
// texts: the question and the option labels (skill project-plan, lib/projectNote.js roomTexts) — the bundled ones when none are given
export const ROOM_QUESTION = (texts = roomTexts()) => texts.question
// run_rule is offered only when the room has a rule, steer only when a browser task of the person runs here or just ended, plan when the
// room is read with its project plan (lib/agent.js — every project room)
export const roomOptions = (rule, { tasks = false, plan = false, texts = roomTexts() } = {}) => [
  { key: 'set_rule', label: texts.options.set_rule },
  ...(plan ? [{ key: 'plan', label: texts.options.plan }] : []),
  ...(rule ? [{ key: 'run_rule', label: texts.options.run_rule }] : []),
  ...(tasks ? [{ key: 'steer', label: texts.options.steer }] : []),
  { key: 'other', label: texts.options.other },
]
// the plan's purpose and what it keeps to, as the judge reads them ('' when the room has none)
export function planState(note) {
  if (!note || (!note.intent && !note.constraints?.length)) return L('이 프로젝트에는 아직 계획이 없다.', 'This project has no plan yet.')
  return [L(`이 프로젝트의 계획 — 목적: ${cap(note.intent) || '(없음)'}`, `This project's plan — purpose: ${cap(note.intent) || '(none)'}`),
    ...(note.constraints?.length ? [L(`지킬 것: ${note.constraints.map((x) => cap(x.text, 160)).join(' / ')}`, `Keep to: ${note.constraints.map((x) => cap(x.text, 160)).join(' / ')}`)] : []),
  ].join('\n')
}
// tasks: the person's browser tasks in this room, as lines (lib/browserQueue.js taskContext) — '' when none
// plan: the project's note (lib/projectNote.js) when the room is read with it — undefined leaves the plan out
export function roomState({ rule, text, files = [], tasks = '', plan }) {
  return [
    ...(plan !== undefined ? [planState(plan)] : []),
    rule ? L(`이 방의 규칙(링크나 파일을 받으면 할 일): ${cap(rule.action)}`, `This room's rule (what to do with a link or file put here): ${cap(rule.action)}`)
      : L('이 방에는 아직 규칙이 없다.', 'This room has no rule yet.'),
    ...(tasks ? [tasks] : []),
    L(`사용자가 이번에 보낸 메시지: ${cap(text, 800)}`, `The message the person just sent: ${cap(text, 800)}`),
    files.length ? L(`이 메시지에 첨부한 파일: ${files.length}개 (${names(files)})`, `Files attached to this message: ${files.length} (${names(files)})`)
      : L('이 메시지에 첨부한 파일: 없음', 'Files attached to this message: none'),
  ].join('\n')
}
// the judge's probabilities → 'set_rule' | 'plan' | 'run_rule' | 'steer' | 'other' (only an option it was offered, only at the bar — set_rule
// at the higher one while a task is busy here)
export function roomPick(probabilities, { rule = null, bar = RULE_BAR, tasks = false, plan = false } = {}) {
  const p = probabilities || {}
  const best = roomOptions(rule, { tasks, plan }).map((o) => o.key).filter((k) => k !== 'other').sort((a, b) => (p[b] ?? 0) - (p[a] ?? 0))[0]
  const need = best === 'set_rule' && tasks ? Math.max(bar, RULE_BAR_BUSY) : bar
  return best && (p[best] ?? 0) >= need ? best : 'other'
}
// → { pick, probabilities, via, ms } — a judge that cannot answer leaves the message to the usual paths
// plan: the project's note — given (an object or null), the judge reads it and may pick plan
export async function readRoom({ rule = null, text, files = [], tasks = '', plan }) {
  const t0 = Date.now()
  const busy = !!tasks
  const withPlan = plan !== undefined
  try {
    const texts = roomTexts(await planSkill().catch(() => null))
    const r = await judge({ state: roomState({ rule, text, files, tasks, plan }), question: ROOM_QUESTION(texts), options: roomOptions(rule, { tasks: busy, plan: withPlan, texts }) })
    return { pick: roomPick(r?.probabilities, { rule, tasks: busy, plan: withPlan }), probabilities: r?.probabilities || {}, via: r?.via || '', ms: Date.now() - t0 }
  } catch (e) {
    return { pick: 'other', probabilities: {}, via: 'none', ms: Date.now() - t0, error: e.message }
  }
}

// ---- 받아 적기 ----
// What the rule does, as the assistant writes it down, and the browser skill that does it on its site.
// Only the skills' names and descriptions are shown (progressive disclosure); the model picks one or none.
// (the recording of 2026-11-21: the service the person named was dropped from the written-down work, and the room's
// links went to something else — so the prompt says, in general terms, to keep what they named)
export function ruleActionPrompt(catalog = browserSkillCatalog()) {
  return L(`사용자가 앞으로 이 방에 올라오는 링크나 파일로 할 일을 정했다. 그 일을 비서가 받아 적은 한 문장과, 그 일을 서버 브라우저에서 할 스킬을 JSON 으로만 답한다.
- action: "이 링크나 파일로 …한다" 꼴의 한 문장. 사용자가 이름을 댄 서비스·사이트·도구는 빼거나 다른 것으로 바꾸지 말고 그대로 남긴다. 받아쓰기라 이름의 철자가 어긋났으면 그 서비스의 바른 이름으로 적는다.
- skill: 아래 브라우저 스킬 가운데 그 일을 하는 스킬의 이름(목록에 적힌 그대로). 맞는 스킬이 없거나 사이트에서 할 일이 아니면 "".
- 이 프로젝트의 계획이나 최근 대화가 함께 오면, 할 일과 스킬은 이 한 문장만이 아니라 그 대화에서 읽는다: 앞서 이름을 댄 서비스를 이 문장이 빼먹었으면 그 서비스로 적는다. 계획은 배경이고, 정한 말이 할 일을 정한다.
브라우저 스킬:
${catalog || '(없음)'}
형식: {"action": "…", "skill": "<스킬 이름 또는 빈 문자열>"}`,
  `The person set what to do with the links or files put in this room from now on. Answer only in JSON with one sentence the assistant writes down for it, and the skill that does it in the server's browser.
- action: one sentence, "With this link or file, …". Keep every service, site or tool the person named: never drop it or swap it for another. It was dictated, so where a name is misspelled, write the service's proper name.
- skill: the name (exactly as listed) of the browser skill below that does this work. "" when none fits or the work is not done on a site.
- When this project's plan or the recent conversation comes with it, read the action and the skill from that conversation, not from this one sentence: when the sentence leaves out a service named earlier, write that service. The plan is background; what the person said decides the action.
Browser skills:
${catalog || '(none)'}
Format: {"action": "…", "skill": "<skill name or empty string>"}`)
}
// ruleAction(text), or ruleAction({text, note, recent}): with the project's plan (lib/projectNote.js) and the room's recent messages as lines,
// the action and the skill are read from the conversation, not from one message (design turnplan §4.3 — a rule set with a sentence that does
// not name the service named earlier)
export async function ruleAction(arg) {
  const { text, note = null, recent = [] } = typeof arg === 'string' ? { text: arg } : (arg || {})
  const ctx = [note ? noteText(note) : '', recent.length ? `${L('최근 대화(오래된 것부터)', 'Recent conversation (oldest first)')}:\n${recent.join('\n')}` : ''].filter(Boolean).join('\n\n')
  const said = ctx ? `${L('정한 말', 'What the person said')}: ${cap(text)}\n\n${ctx}` : cap(text)
  const j = await chatJson(ruleActionPrompt(), said, { model: config.llm.fastModel, temperature: 0, maxTokens: 1500, effort: 'low', timeoutMs: 30_000 })
    .catch((e) => { console.warn('[room rule] action', e.message); return null })
  const skill = typeof j?.skill === 'string' && browserSkill(j.skill.trim()) ? j.skill.trim() : ''
  return { action: (typeof j?.action === 'string' && cap(j.action)) || cap(text), skill }
}

// What a run of the rule is asked to do: the rule's work, then what the person gave, as they gave it
// (a link is in their own words; nothing is pulled out of them). The project's plan is never part of it: a browser task gets the plan as
// background apart from its goal, a delegated run as every project turn does (review PR #105 #1)
export function roomGoal(action, text, files = []) {
  return [cap(action),
    L(`사용자가 이 방에 준 것: ${cap(text, 2000)}`, `What the person put in this room: ${cap(text, 2000)}`),
    files.length ? L(`첨부 파일: ${names(files)}`, `Attached files: ${names(files)}`) : '',
  ].filter(Boolean).join('\n')
}

// ---- 저장 ----
// The rule a message set reads as {id: message id, said, action, skill, runs}
// (label: the skill's name as people know it — the rule bar shows 「서버 브라우저: <label>」, or 「에이전트가 처리」 with no skill: design §4.4)
const asRule = (row) => (row ? { id: row.id, said: row.content.roomRule.said, action: row.content.roomRule.action, skill: row.content.roomRule.skill || '',
  label: row.content.roomRule.skill ? skillLabel(row.content.roomRule.skill) || row.content.roomRule.skill : '', runs: Number(row.content.roomRule.runs) || 0, at: row.created_at } : null)
export async function ruleOf(userId, threadId) {
  const [row] = await q(`select m.id, m.content, m.created_at from pro_messages m join pro_threads t on t.id = m.thread_id
    where m.thread_id=$1 and t.user_id=$2 and jsonb_typeof(m.content->'roomRule') = 'object' and coalesce(m.content->'roomRule'->>'off', '') = ''
    order by m.created_at desc limit 1`, [threadId, userId])
  return asRule(row)
}
// → {said, action, skill} when this message sets a rule (the caller posts the message that holds it), or null
export async function readRoomRule(user, threadId, text, files = []) {
  const rule = await ruleOf(user.id, threadId).catch(() => null)
  if ((await readRoom({ rule, text, files })).pick !== 'set_rule') return null
  return { said: cap(text), ...(await ruleAction(text)) }
}
// 규칙을 바꿀까요? (2026-11-25 녹화: 이미 규칙이 있는 방에서 작업에 준 지시가 규칙을 말없이 덮어썼다) — 규칙이 있는 방에서 새 규칙을 정하는
// 말은 확인 카드(content.ruleConfirm {said, now, next, skill, state})로 묻는다. 「바꾸기」는 그 카드가 새 규칙을 갖고(ruleOf 는 가장 새
// 규칙을 읽는다), 「이번 작업에만 적용」은 규칙을 그대로 두고 그 말을 작업에 준다(lib/agent.js onceTurn). → { message, said } 또는 null
// threadId: the room the card is asked about from (a card of another room is not settled from here). The card is settled once — whoever
// presses first (the update itself checks it is still pending); 「바꾸기」 turns the room's other rules off, so the card pressed is the rule
// even when a newer rule came meanwhile (2026-11-25 review).
export async function settleRuleConfirm(userId, messageId, choice, { threadId = null } = {}) {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id = m.thread_id
    where m.id=$1 and t.user_id=$2 and jsonb_typeof(m.content->'ruleConfirm') = 'object' and ($3::uuid is null or m.thread_id = $3::uuid)`, [messageId, userId, threadId])
  if (!m) return null
  const rc = m.content.ruleConfirm
  const patch = choice === 'replace'
    ? { ruleConfirm: { ...rc, state: 'replaced' }, roomRule: { said: rc.said, action: rc.next, skill: rc.skill || '', runs: 0 } }
    : { ruleConfirm: { ...rc, state: 'once' } }
  const [u] = await q(`update pro_messages set content = content || $2::jsonb where id=$1 and content->'ruleConfirm'->>'state' = 'pending' returning *`, [m.id, JSON.stringify(patch)])
  if (!u) {
    const [now] = await q('select * from pro_messages where id=$1', [m.id])
    return { message: now || m, said: rc.said, already: true }
  }
  if (choice === 'replace') {
    await q(`update pro_messages set content = jsonb_set(content, '{roomRule,off}', 'true'::jsonb) where thread_id=$1 and id <> $2
      and jsonb_typeof(content->'roomRule') = 'object' and coalesce(content->'roomRule'->>'off', '') = ''`, [m.thread_id, m.id])
  }
  return { message: u, said: rc.said }
}
// The rule's skill, picked on the rule bar (PUT /api/threads/:id/rule {skill}): a browser skill's name, or '' for the agent — a structured
// field, so a wrong pick is fixed without saying the rule again (design §4.4). → the rule, or null (no rule here, or not this person's)
export async function setRuleSkill(userId, threadId, skill) {
  const name = String(skill ?? '').trim()
  if (name && !browserSkill(name)) throw Object.assign(new Error(L('해당 브라우저 스킬이 없어요.', 'There is no such browser skill.')), { status: 400 })
  const rule = await ruleOf(userId, threadId)
  if (!rule) return null
  await q(`update pro_messages set content = jsonb_set(content, '{roomRule,skill}', to_jsonb($2::text)) where id=$1`, [rule.id, name])
  return ruleOf(userId, threadId)
}
export const ranRule = (id) => q(`update pro_messages set content = jsonb_set(content, '{roomRule,runs}', to_jsonb(coalesce((content->'roomRule'->>'runs')::int, 0) + 1)) where id=$1`, [id])
export async function removeRule(userId, threadId) {
  const rows = await q(`update pro_messages m set content = jsonb_set(m.content, '{roomRule,off}', 'true'::jsonb) from pro_threads t
    where t.id = m.thread_id and m.thread_id=$1 and t.user_id=$2 and jsonb_typeof(m.content->'roomRule') = 'object' and coalesce(m.content->'roomRule'->>'off', '') = '' returning m.id`, [threadId, userId])
  return { removed: rows.length }
}
