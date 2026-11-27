// A project's sub-topics (2026-11-25 사용자: 「홈 채팅에서 주제를 자동 분류하듯이 하나의 프로젝트 내에서도 서브 레벨로 주제들이 자동 분류될
// 수 있어야 한다」 — spec openspec/specs/project-room 「프로젝트 안의 주제」, server lib/projectTopics.js). The pieces with no screen in them:
// which sub-topic each message of a project belongs to, the list with message counts, the address of one, and when the bar over the
// project's chat shows.
import { sortThreads } from './threadList.js'

// An agent's answer in a project carries the conversation it went to (content.conv — server lib/agent.js), and so do the cards its turn
// leaves (a file, a stop, the folder's chip); the person's message is tagged as soon as the router picks (or from the start, asked inside
// one sub-topic). A message without one goes with the conversation around it: an agent's message with the latest agent message's (a card
// written after an answer can come after the person's next message, which may be another sub-topic's — so a person's message does not
// move it), the person's message still waiting for its sub-topic with the agent message that follows it. Messages from before a project
// had sub-topics have none (null: only in 「전체」). (A card about a conversation names it as {id, title}.)
const convOfMsg = (m) => {
  const raw = m?.content?.conv
  const c = raw && typeof raw === 'object' ? raw.id : raw
  return c && !String(c).startsWith('none:') ? String(c) : null
}
export function topicOf(messages = []) {
  const out = {}
  let cur = null
  let pending = []
  for (const m of messages || []) {
    if (!m?.id) continue
    const conv = convOfMsg(m)
    // a conversation moved in from the chat (server lib/conversationMove.js): its own sub-topic, and it never takes the messages around it
    // along (a project's own lines between its old ones stay where they were)
    // — and so does a line filed aside into one (a mail's line that followed a moved conversation in: lib/store.js addMessage — PR #125 review 6)
    if (m.content?.moved || m.content?.context?.action === 'aside') { if (conv) out[m.id] = conv; continue }
    if (m.role === 'user') {
      if (conv) out[m.id] = conv
      else pending.push(m)
      continue
    }
    if (conv) cur = conv
    for (const p of pending) out[p.id] = cur
    pending = []
    out[m.id] = cur
  }
  for (const p of pending) out[p.id] = cur
  return out
}

const time = (t) => { const v = new Date(t).getTime(); return Number.isFinite(v) ? v : -Infinity }
// The project's sub-topics as the list shows them: the server's rows (title · summary · gist · turns) that have messages in this
// project, each with its message count and its latest moment (the row is written as a turn ends; a message may be newer), newest first.
// A sub-topic the chat already shows but the server has not listed yet is named by the router's call on its answer (content.context).
export function topicList(rows = [], messages = [], of = topicOf(messages)) {
  const counts = {}
  const last = {}
  for (const m of messages || []) {
    const id = of[m?.id]
    if (!id) continue
    counts[id] = (counts[id] || 0) + 1
    if (time(m.created_at) > time(last[id])) last[id] = m.created_at
  }
  const later = (a, b) => (time(b) > time(a) ? b : a)
  const known = new Set()
  const list = []
  for (const r of rows || []) {
    if (!r?.id || !counts[r.id] || known.has(r.id)) continue
    known.add(r.id)
    list.push({ ...r, count: counts[r.id], updated_at: later(r.updated_at, last[r.id]) })
  }
  for (const m of messages || []) {
    const id = convOfMsg(m)
    const c = m?.content?.context
    if (m?.role !== 'agent' || !id || known.has(id) || !counts[id] || !c?.title) continue
    known.add(id)
    list.push({ id, title: c.title, summary: '', gist: '', updated_at: last[id] || m.created_at, count: counts[id] })
  }
  return sortThreads(list)
}

// a project's view narrowed to one sub-topic, and back to the whole project
export const topicPath = (projectId, topicId) => (topicId ? `/projects/${projectId}/t/${encodeURIComponent(topicId)}` : `/projects/${projectId}`)

// The bar over the project's chat (and the rows under the project in the list) shows when there is something to choose: two sub-topics
// or more — or one is open (the way back to 「전체」)
export const topicsShown = (list, filter) => (list?.length || 0) >= 2 || !!filter
