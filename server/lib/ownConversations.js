// Conversations of their own for what arrives in the main chat without the person typing it (2026-11-25, production screenshot: the
// conversation 「글씨가 표의 윗부분에 붙어있다. 중앙정렬」 held a 모닝 브리프, a mail chip and two runs of the routine 「주식 5일 누적 5%
// 급등락 감시」 — user: 「엉뚱한 쓰레드에 스케쥴 업무가 붙어서 분류되어있다 … 스케쥴 업무들은 자신의 쓰레드가 분리될 기본적인 것들임」;
// spec openspec/specs/chat-thread-list 「예약 작업과 브리프는 자기 대화에」).
//   · a scheduled task: one conversation per task (sched-<task id>) — its runs continue one deepagents history (lib/missions.js)
//   · the mail briefs (모닝 · 오후 · 이브닝) and the mailbox's own lines: one conversation per person (brief-<person id>)
//   · a mail's work (the drafts made from it, a reply sent or an event added from its Home card): the conversation its follow-up made
//     (lib/mailFollow.js), else its drafts' conversation, else the brief's
// Every such message carries its conversation as `context: {conversationId, action: 'aside', kind}` (the one that names it also its
// title): the chat files it there (src/convOf.js) and the conversation the person is in stays where it was — on the server too (a
// pinned background turn never moves pro_threads.conversation_id: lib/agent.js delegate). The conversation is listed in the chat's
// 대화 like any other (context_threads through fileConversation), with its kind for the list's icon (components/ThreadList.vue).
// The ids are derived, not stored (no new column), and not guessable (review 11-25 #1): deepagents keeps a history and a workspace by the
// conversation id alone, so an id made of a person's or a task's id would let a teammate who knows it run on that history. Each is an
// HMAC under a key only the server holds (its service key with a label of its own), the same for the same task or person every time —
// a key that changes moves these conversations to new ids (the old rows stay, with their messages). A conversation id a page sends is
// taken only when it is the sender's own (ownsConversation).
import crypto from 'node:crypto'
import { config } from '../config.js'
import { q } from './supa.js'
import { L } from './lang.js'

const LABEL = 'pgpt-lite/own-conversation-id/v1'
function idKey() {
  if (!config.serviceKey) throw new Error('no server key to name own conversations with')
  return crypto.createHmac('sha256', String(config.serviceKey)).update(LABEL).digest()
}
const tag = (s) => crypto.createHmac('sha256', idKey()).update(s).digest('hex').slice(0, 24)
export const scheduleConversationId = (scheduleId) => `sched-${tag(`schedule:${String(scheduleId).toLowerCase()}`)}`
export const briefConversationId = (userId, tenant = config.tenantId) => `brief-${tag(`brief:${tenant}:${String(userId).toLowerCase()}`)}`
// a mail's drafts: one conversation per mail of a person (a mail id is not a uuid — Gmail's, IMAP's, the demo box's)
export const mailConversationId = (userId, mailId) => `mail-${tag(`mail:${String(userId).toLowerCase()}:${mailId}`)}`
// a scheduled task's runs: the agent's history starts afresh every RUNS runs (review 11-25 #2 — an hourly watcher's one history grew
// by a run an hour, to about 170k input tokens a run), while the chat keeps the task's one conversation; the run is told the result it
// shared last (lib/missions.js), so 「변동 없음」 does not need the long history
export const scheduleRuns = () => Math.max(1, Number(process.env.PRO_SCHEDULE_HISTORY_RUNS) || 12)
export const scheduleAgentConversation = (listed, runNo) => `${listed}-r${Math.floor(Math.max(0, Number(runNo) - 1) / scheduleRuns())}`

export const scheduleConversation = (s) => ({ conversationId: scheduleConversationId(s.id), title: String(s.name || '').slice(0, 120), kind: 'schedule' })
export const briefConversation = (userId) => ({ conversationId: briefConversationId(userId), title: L('브리프', 'Briefs'), kind: 'brief' })

// the conversation a mail's line goes to: the newest follow-up run's (lib/mailFollow.js — 이 회사 알아보기 …), else the conversation its
// drafts were made in (source.conv, lib/mail.js draftFromMail), else the brief's. An instance's mail never comes here (its lines go to
// the instance's own conversation).
export function mailConversation(card, userId) {
  const runs = Object.values(card?.source?.follow?.runs || {}).filter((r) => r?.conv)
  const run = runs.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0]
  if (run) return { conversationId: String(run.conv), title: String(run.title || ''), kind: 'conversation' }
  const own = card?.source?.conv
  if (own?.id) return { conversationId: String(own.id), title: String(own.title || ''), kind: 'mail' }
  return briefConversation(userId)
}

// what a message filed there carries; `named`: the one that names the conversation (its divider) — the others carry no title, so no
// 「↳ …」 label is drawn over each of them (components/Message.vue draws one only for a context with a title)
export function aside(c, { named = false } = {}) {
  if (!c?.conversationId) return {}
  return { context: { conversationId: c.conversationId, action: 'aside', ...(c.kind ? { kind: c.kind } : {}), ...(named && c.title ? { title: c.title } : {}) } }
}
// the pin a background agent turn takes (lib/agent.js delegate({pin, background: true}))
export const pinOf = (c) => ({ conversationId: c.conversationId, title: c.title, ...(c.kind ? { kind: c.kind } : {}) })

// A conversation id the page sent (a view narrowed to it, 멈추기 in it) is taken only when it is this person's: a row of theirs in
// context_threads, a message in one of their own threads that went to it, or one of their threads standing in it. → {kind} | null
// (kind: what the row says — 'schedule' · 'brief' · 'mail' for a conversation of its own)
export async function ownsConversation(userId, conv) {
  const id = String(conv || '')
  if (!userId || !id || id.length > 200) return null
  const [row] = await q('select kind from context_threads where tenant_id=$1 and user_id=$2 and conversation_id=$3', [config.tenantId, String(userId), id])
  if (row) return { kind: row.kind || 'conversation' }
  const [hit] = await q(`select 1 from pro_threads t where t.user_id::text=$1 and t.conversation_id=$2
                         union all
                         select 1 from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id::text=$1
                           and (m.content->>'conv'=$2 or m.content->'conv'->>'id'=$2 or m.content->'context'->>'conversationId'=$2) limit 1`, [String(userId), id])
  return hit ? { kind: 'conversation' } : null
}

// What a conversation of its own holds that the agent never saw (review 11-25 #8): its brief, a skill run's result, a timer card, a
// failure line exist only here — a turn the person sends into it gets the last few of them before what they said (as the teammate
// suggestion's work state does — lib/team/suggest.js workState). '' when there is nothing.
export async function ownExcerpt(userId, threadId, conv, { lines = 6 } = {}) {
  const rows = await q(`select m.role, m.kind, m.content from pro_messages m join pro_threads t on t.id=m.thread_id
                        where m.thread_id=$1 and t.user_id::text=$2 and m.content->'context'->>'action'='aside' and m.content->'context'->>'conversationId'=$3
                        order by m.created_at desc limit $4`, [threadId, String(userId), String(conv), lines * 2])
  const said = rows.reverse().map((r) => {
    const c = r.content || {}
    if (r.kind === 'divider') return c.text ? `— ${String(c.text).slice(0, 80)} —` : ''
    if (r.kind === 'file') return c.name ? L(`파일: ${c.name}`, `File: ${c.name}`) : ''
    const t = String(c.text || c.title || c.summary || c.mail?.subject || '').replace(/\s+/g, ' ').trim()
    return t ? t.slice(0, 220) : ''
  }).filter(Boolean).slice(-lines)
  return said.length ? L(`(이 대화에 앞서 올라온 내용 — 예약 실행 · 브리프 등, 에이전트 기록에는 없는 것:\n${said.join('\n')})`,
    `(What came into this conversation before — scheduled runs, briefs and the like, not in the agent's own history:\n${said.join('\n')})`) : ''
}

// listed in the chat's 대화 (context_threads): said — what the row's line shows as its request, answer — its latest answer
export async function listOwn(userId, c, said, answer = '') {
  if (!c?.conversationId) return
  const { fileConversation } = await import('./agent.js')
  const text = String(said || c.title || '').trim() || c.conversationId
  await fileConversation({ id: userId }, { conversationId: c.conversationId, title: c.title || text.slice(0, 60), kind: c.kind || 'conversation' }, text, answer)
}
