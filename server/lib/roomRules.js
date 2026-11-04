// 방 규칙(spec pgpt-pro_room-rules): "앞으로 이 방에 붙여넣는 링크나 파일은 바로 NotebookLM 슬라이드와 팟캐스트로". 한 프로젝트 방의 약속이다.
// 후행 습관(lib/followups.js)과 달리 사람이 "곧바로"라고 말한 것이므로 묻지 않고 실행하고, 그래서 방 맨 위에 늘 보이며 끌 수 있다.
// 말을 읽는 것은 모델(첫 토큰 확률)이고, 이번 메시지가 "올린 것"인지는 규칙이 정한다.
import { config } from '../config.js'
import { q } from './supa.js'
import { L } from './lang.js'
import { chatJson } from './llm.js'
import { oddsOf } from './decide.js'

export const RULE_BAR = 0.7
export const LEFT_WORDS_MAX = 30
const T = () => config.tenantId
const URLS = /https?:\/\/[^\s)'"<>]+/gi
const cap = (t, n = 400) => String(t || '').trim().slice(0, n)

// only words like these are worth a model read
const ROOM_WORDS = /(앞으로|이제부터|다음부터|from now on).*(이\s*방|여기|이\s*프로젝트|붙여\s*넣|올리|링크|url|첨부|파일|this room|here|link|file)|(이\s*방|여기에|this room).*(앞으로|이제부터|올리면|붙여\s*넣으면|from now on)/i
export const maybeRoomRule = (text) => ROOM_WORDS.test(String(text || '')) && String(text).length <= 400

// Is this message something handed in, rather than something said? A link with few words around it, or a file.
export function roomInput(text, files = []) {
  const urls = [...new Set(String(text || '').match(URLS) || [])]
  const left = String(text || '').replace(URLS, '').trim()
  if (files.length && left.length <= LEFT_WORDS_MAX) return { urls, files, words: left }
  if (urls.length && left.length <= LEFT_WORDS_MAX) return { urls, files, words: left }
  return null
}
export function roomGoal(action, input) {
  const items = [...input.urls.map((u) => L(`링크: ${u}`, `Link: ${u}`)), ...input.files.map((f) => L(`첨부 파일: ${f.name}`, `Attached file: ${f.name}`))]
  return [cap(action), ...items, input.words ? L(`덧붙인 말: ${input.words}`, `The person added: ${input.words}`) : ''].filter(Boolean).join('\n')
}

export const ROOM_QUESTION = () => L('이 말은 무엇인가?', 'What is this message?')
export const ROOM_OPTIONS = () => [
  { key: 'rule', label: L('앞으로 이 방에 올라오는 링크나 파일로 무엇을 할지 정하는 말이다', 'It sets what to do with the links or files put in this room from now on') },
  { key: 'not', label: L('지금 한 번 시키는 일이거나, 일반적인 말투·취향이거나, 정해진 시각의 예약이거나, 질문이다', 'One piece of work now, a general style preference, a schedule at set times, or a question') },
]
export const roomState = (text) => L(`프로젝트 방에서 사용자가 한 말: ${cap(text)}`, `What the person said in a project room: ${cap(text)}`)

export async function ruleAction(text) {
  const j = await chatJson(
    L('사용자가 앞으로 이 방에 올라오는 링크나 파일로 할 일을 정했다. "노트북 lm"은 구글 NotebookLM 이다. 그 일을 비서가 받아 적은 한 문장으로 JSON 으로만 답한다: {"action": "이 링크나 파일로 …한다"}', 'The person set what to do with the links or files put in this room from now on. Answer only in JSON, one sentence: {"action": "With this link or file, …"}'),
    cap(text), { model: config.llm.fastModel, temperature: 0, think: false }).catch(() => null)
  return String(j?.action || '').trim() ? cap(j.action) : cap(text)
}

export const ruleOf = async (userId, threadId) => (await q('select * from pro_room_rules where thread_id=$1 and user_id=$2', [threadId, userId]))[0] || null
// → the rule just set, or null when this message does not set one
export async function readRoomRule(user, threadId, text) {
  if (!maybeRoomRule(text)) return null
  const r = await oddsOf(roomState(text), ROOM_QUESTION(), ROOM_OPTIONS())
  if (!r || r.choice !== 'rule' || r.confidence < RULE_BAR) return null
  const action = await ruleAction(text)
  const [row] = await q(`insert into pro_room_rules(tenant_id,user_id,thread_id,said,action) values ($1,$2,$3,$4,$5)
    on conflict (thread_id) do update set said=excluded.said, action=excluded.action, runs=0, created_at=now() returning *`, [T(), user.id, threadId, cap(text), action])
  return row
}
export const ranRule = (id) => q('update pro_room_rules set runs=runs+1 where id=$1', [id])
export async function removeRule(userId, threadId) {
  const rows = await q('delete from pro_room_rules where thread_id=$1 and user_id=$2 returning id', [threadId, userId])
  return { removed: rows.length }
}
