// 방 규칙(spec pgpt-pro_room-rules): "이 방에 내가 주는 링크는 그 사이트에서 이렇게 해 줘". 한 프로젝트 방의 약속이다.
// 사람이 "주면 돼"라고 정한 것이므로 묻지 않고 실행하고, 그래서 방 맨 위에 늘 보이며 끌 수 있다.
//
// 말의 뜻은 모델이 읽는다(2026-11-21, 사용자 지시: 정규식·낱말 목록·사이트 이름을 코드에 두지 않는다).
//   · 방 판정(readRoom): 프로젝트 방의 메시지는 다른 지름길보다 먼저 lib/judge.js 에 한 번 묻는다 —
//     규칙을 정하는 말(set_rule)인가, 규칙의 대상으로 준 것(run_rule, 규칙이 있을 때만)인가, 그 밖(other)인가. 0.7 이상만 따른다.
//   · 받아 적기(ruleAction): 할 일 한 문장과, 그 일을 하는 브라우저 스킬(lib/browserSkills.js 목록의 이름·설명만 보고 고른 것).
// 쓰는 구조적 신호는 이 방의 규칙이 있는가, 첨부 파일이 있는가뿐이다.
//
// 규칙은 따로 테이블을 두지 않고, 규칙을 받아 적은 그 방의 안내 메시지(content.roomRule {said, action, skill, runs})에 둔다.
// 운영 DB 에 SQL 을 따로 돌리지 않아도 되고, 방을 지우면 규칙도 함께 사라진다. 방마다 마지막 규칙 하나만 쓴다.
import { config } from '../config.js'
import { q } from './supa.js'
import { L } from './lang.js'
import { chatJson } from './llm.js'
import { judge } from './judge.js'
import { browserSkill, browserSkillCatalog } from './browserSkills.js'

export const RULE_BAR = 0.7
const cap = (t, n = 400) => String(t || '').trim().slice(0, n)
const names = (files) => files.map((f) => f?.name).filter(Boolean).join(', ')

// ---- 방 판정 ----
export const ROOM_QUESTION = () => L('이 프로젝트 방에서, 사용자가 이번에 보낸 메시지는 무엇인가?', 'In this project room, what is the message the person just sent?')
// run_rule is offered only when the room has a rule
export const roomOptions = (rule) => [
  { key: 'set_rule', label: L('앞으로 이 방에 줄(올릴) 링크나 파일로 무엇을 할지 정하는 말이다', 'It sets what to do from now on with the links or files the person will put in this room') },
  ...(rule ? [{ key: 'run_rule', label: L('이 방의 규칙대로 처리하라고 건넨 것이다(규칙의 대상인 링크나 파일)', 'It hands over something for this room\'s rule to work on (a link or file the rule is for)') }] : []),
  { key: 'other', label: L('그 밖의 말이다: 지금 한 번 시키는 일, 질문, 답하는 말투·취향, 정해진 시각의 예약, 앞의 일을 바로잡는 말', 'Anything else: one piece of work for now, a question, a style preference, a schedule at set times, or a correction of earlier work') },
]
export function roomState({ rule, text, files = [] }) {
  return [
    rule ? L(`이 방의 규칙(링크나 파일을 받으면 할 일): ${cap(rule.action)}`, `This room's rule (what to do with a link or file put here): ${cap(rule.action)}`)
      : L('이 방에는 아직 규칙이 없다.', 'This room has no rule yet.'),
    L(`사용자가 이번에 보낸 메시지: ${cap(text, 800)}`, `The message the person just sent: ${cap(text, 800)}`),
    files.length ? L(`이 메시지에 첨부한 파일: ${files.length}개 (${names(files)})`, `Files attached to this message: ${files.length} (${names(files)})`)
      : L('이 메시지에 첨부한 파일: 없음', 'Files attached to this message: none'),
  ].join('\n')
}
// the judge's probabilities → 'set_rule' | 'run_rule' | 'other' (only an option it was offered, only at the bar)
export function roomPick(probabilities, { rule = null, bar = RULE_BAR } = {}) {
  const p = probabilities || {}
  const best = roomOptions(rule).map((o) => o.key).filter((k) => k !== 'other').sort((a, b) => (p[b] ?? 0) - (p[a] ?? 0))[0]
  return best && (p[best] ?? 0) >= bar ? best : 'other'
}
// → { pick, probabilities, via, ms } — a judge that cannot answer leaves the message to the usual paths
export async function readRoom({ rule = null, text, files = [] }) {
  const t0 = Date.now()
  try {
    const r = await judge({ state: roomState({ rule, text, files }), question: ROOM_QUESTION(), options: roomOptions(rule) })
    return { pick: roomPick(r?.probabilities, { rule }), probabilities: r?.probabilities || {}, via: r?.via || '', ms: Date.now() - t0 }
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
브라우저 스킬:
${catalog || '(없음)'}
형식: {"action": "…", "skill": "<스킬 이름 또는 빈 문자열>"}`,
  `The person set what to do with the links or files put in this room from now on. Answer only in JSON with one sentence the assistant writes down for it, and the skill that does it in the server's browser.
- action: one sentence, "With this link or file, …". Keep every service, site or tool the person named: never drop it or swap it for another. It was dictated, so where a name is misspelled, write the service's proper name.
- skill: the name (exactly as listed) of the browser skill below that does this work. "" when none fits or the work is not done on a site.
Browser skills:
${catalog || '(none)'}
Format: {"action": "…", "skill": "<skill name or empty string>"}`)
}
export async function ruleAction(text) {
  const j = await chatJson(ruleActionPrompt(), cap(text), { model: config.llm.fastModel, temperature: 0, maxTokens: 1500, effort: 'low', timeoutMs: 30_000 })
    .catch((e) => { console.warn('[room rule] action', e.message); return null })
  const skill = typeof j?.skill === 'string' && browserSkill(j.skill.trim()) ? j.skill.trim() : ''
  return { action: (typeof j?.action === 'string' && cap(j.action)) || cap(text), skill }
}

// What a run of the rule is asked to do: the rule's work, then what the person gave, as they gave it
// (a link is in their own words; nothing is pulled out of them)
export function roomGoal(action, text, files = []) {
  return [cap(action),
    L(`사용자가 이 방에 준 것: ${cap(text, 2000)}`, `What the person put in this room: ${cap(text, 2000)}`),
    files.length ? L(`첨부 파일: ${names(files)}`, `Attached files: ${names(files)}`) : '',
  ].filter(Boolean).join('\n')
}

// ---- 저장 ----
// The rule a message set reads as {id: message id, said, action, skill, runs}
const asRule = (row) => (row ? { id: row.id, said: row.content.roomRule.said, action: row.content.roomRule.action, skill: row.content.roomRule.skill || '', runs: Number(row.content.roomRule.runs) || 0, at: row.created_at } : null)
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
export const ranRule = (id) => q(`update pro_messages set content = jsonb_set(content, '{roomRule,runs}', to_jsonb(coalesce((content->'roomRule'->>'runs')::int, 0) + 1)) where id=$1`, [id])
export async function removeRule(userId, threadId) {
  const rows = await q(`update pro_messages m set content = jsonb_set(m.content, '{roomRule,off}', 'true'::jsonb) from pro_threads t
    where t.id = m.thread_id and m.thread_id=$1 and t.user_id=$2 and jsonb_typeof(m.content->'roomRule') = 'object' and coalesce(m.content->'roomRule'->>'off', '') = '' returning m.id`, [threadId, userId])
  return { removed: rows.length }
}
