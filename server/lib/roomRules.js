// 방 규칙(spec pgpt-pro_room-rules): "이 방에 내가 주는 링크는 NotebookLM 으로 슬라이드와 팟캐스트로". 한 프로젝트 방의 약속이다.
// 사람이 "주면 돼"라고 정한 것이므로 묻지 않고 실행하고, 그래서 방 맨 위에 늘 보이며 끌 수 있다.
// 말을 읽는 것은 모델(판정 lib/judge.js)이고, 이번 메시지가 "올린 것"인지는 규칙이 정한다.
//
// 규칙은 따로 테이블을 두지 않고, 규칙을 받아 적은 그 방의 안내 메시지(content.roomRule)에 둔다(2026-11-21).
// 운영 DB 에 SQL 을 따로 돌리지 않아도 되고, 방을 지우면 규칙도 함께 사라진다. 방마다 마지막 규칙 하나만 쓴다.
import { config } from '../config.js'
import { q } from './supa.js'
import { L } from './lang.js'
import { chatJson } from './llm.js'
import { judge } from './judge.js'
import { isNotebookJob } from './browserGuides.js'

export const RULE_BAR = 0.7
export const LEFT_WORDS_MAX = 30
const URLS = /https?:\/\/[^\s)'"<>]+/gi
const cap = (t, n = 400) => String(t || '').trim().slice(0, n)

// only words like these are worth a model read:
//   "앞으로 이 방에 올리는 링크는 …", "이 방에서 내가 주는 url이 있으면 …", "여기에 링크 보내면 …"
const ROOM_WORDS = new RegExp([
  /(앞으로|이제부터|다음부터|from now on).*(이\s*방|여기|이\s*프로젝트|붙여\s*넣|올리|링크|url|첨부|파일|this room|here|link|file)/.source,
  /(이\s*방|여기에|this room).*(앞으로|이제부터|올리면|붙여\s*넣으면|from now on)/.source,
  /(이\s*방|여기|이\s*프로젝트).{0,20}(주는|올리는|붙이는|보내는|넣는|던지는|준|올린|보낸)\s*(url|링크|주소|파일|영상|문서|자료)/.source,
  /(url|링크|주소|파일)\s*(을|를|이|가)?\s*(주면|올리면|보내면|붙이면|넣으면|던지면|있으면|오면)/.source,
  /(any|every|each)\s+(link|url|file)s?\s+(i|you)\s+(send|post|put|share|drop)/.source,
].join('|'), 'i')
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
  { key: 'rule', label: L('앞으로 이 방에 올라오는(주는) 링크나 파일로 무엇을 할지 정하는 말이다', 'It sets what to do with the links or files put in this room from now on') },
  { key: 'not', label: L('지금 한 번 시키는 일이거나, 일반적인 말투·취향이거나, 정해진 시각의 예약이거나, 질문이다', 'One piece of work now, a general style preference, a schedule at set times, or a question') },
]
export const roomState = (text) => L(`프로젝트 방에서 사용자가 한 말: ${cap(text)}`, `What the person said in a project room: ${cap(text)}`)

// What the rule does, as the assistant writes it down. The service the person named stays in it:
// "노트북 lm으로" must not turn into "PowerPoint 를 만든다" (recording 2026-11-21).
export async function ruleAction(text) {
  const j = await chatJson(
    L('사용자가 앞으로 이 방에 올라오는 링크나 파일로 할 일을 정했다. "노트북 lm"·"노트북엘엠"은 구글 NotebookLM 이고, "NotebookLM"이라고 적는다. 사용자가 이름을 댄 서비스·도구는 그대로 넣는다. 그 일을 비서가 받아 적은 한 문장으로 JSON 으로만 답한다: {"action": "이 링크나 파일로 …한다"}',
      'The person set what to do with the links or files put in this room from now on. Keep any service or tool they named. Answer only in JSON, one sentence: {"action": "With this link or file, …"}'),
    cap(text), { model: config.llm.fastModel, temperature: 0, think: false }).catch(() => null)
  return String(j?.action || '').trim() ? keepNamed(text, cap(j.action)) : cap(text)
}
// A service the person named that the written-down action left out is put back: the room's guide and
// its 안내 문구 both read the action ("…슬라이드를 만든다" alone sent the room's links to PowerPoint)
const NAMED = [[isNotebookJob, 'NotebookLM']]
// (the model also misspells what it heard: "노트북엘엠으로" came back "노트북엘름으로", recording check 2026-11-21)
const MISHEARD = [[isNotebookJob, /노트북\s*(엘|앨|el)\S*?(?=으로|에서|로|을|를|의|에|과|와|\s|$)/i, 'NotebookLM']]
export function keepNamed(said, action) {
  for (const [is, re, name] of MISHEARD) if (is(said) && !is(action)) action = String(action).replace(re, name)
  const left = NAMED.filter(([is]) => is(said) && !is(action)).map(([, name]) => name)
  return left.length ? `${String(action).replace(/[.。]\s*$/, '')} (${L(`${left.join(', ')} 에서`, `in ${left.join(', ')}`)})` : action
}

// The rule a message set reads as {id: message id, said, action, runs}
const asRule = (row) => (row ? { id: row.id, said: row.content.roomRule.said, action: row.content.roomRule.action, runs: Number(row.content.roomRule.runs) || 0, at: row.created_at } : null)
export async function ruleOf(userId, threadId) {
  const [row] = await q(`select m.id, m.content, m.created_at from pro_messages m join pro_threads t on t.id = m.thread_id
    where m.thread_id=$1 and t.user_id=$2 and jsonb_typeof(m.content->'roomRule') = 'object' and coalesce(m.content->'roomRule'->>'off', '') = ''
    order by m.created_at desc limit 1`, [threadId, userId])
  return asRule(row)
}
// → {said, action} when this message sets a rule (the caller posts the message that holds it), or null
export async function readRoomRule(user, threadId, text) {
  if (!maybeRoomRule(text)) return null
  const r = await judge({ state: roomState(text), question: ROOM_QUESTION(), options: ROOM_OPTIONS() })
  if ((r?.probabilities?.rule ?? 0) < RULE_BAR) return null
  return { said: cap(text), action: await ruleAction(text) }
}
export const ranRule = (id) => q(`update pro_messages set content = jsonb_set(content, '{roomRule,runs}', to_jsonb(coalesce((content->'roomRule'->>'runs')::int, 0) + 1)) where id=$1`, [id])
export async function removeRule(userId, threadId) {
  const rows = await q(`update pro_messages m set content = jsonb_set(m.content, '{roomRule,off}', 'true'::jsonb) from pro_threads t
    where t.id = m.thread_id and m.thread_id=$1 and t.user_id=$2 and jsonb_typeof(m.content->'roomRule') = 'object' and coalesce(m.content->'roomRule'->>'off', '') = '' returning m.id`, [threadId, userId])
  return { removed: rows.length }
}
