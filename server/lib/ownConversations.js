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
// The ids are derived, not stored (no new column): the screen derives the same ones for messages stored before this (src/convOf.js).
import crypto from 'node:crypto'
import { L } from './lang.js'

const hex = (id) => String(id || '').replace(/-/g, '').toLowerCase()
export const scheduleConversationId = (scheduleId) => `sched-${hex(scheduleId)}`
export const briefConversationId = (userId) => `brief-${hex(userId)}`
// a mail's drafts: one conversation per mail of a person (a mail id is not a uuid — Gmail's, IMAP's, the demo box's)
export const mailConversationId = (userId, mailId) => `mail-${crypto.createHash('sha1').update(`${userId}:${mailId}`).digest('hex').slice(0, 24)}`

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

// listed in the chat's 대화 (context_threads): said — what the row's line shows as its request, answer — its latest answer
export async function listOwn(userId, c, said, answer = '') {
  if (!c?.conversationId) return
  const { fileConversation } = await import('./agent.js')
  const text = String(said || c.title || '').trim() || c.conversationId
  await fileConversation({ id: userId }, { conversationId: c.conversationId, title: c.title || text.slice(0, 60), kind: c.kind || 'conversation' }, text, answer)
}
