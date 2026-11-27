// What an AI answer's 「프로젝트로 시작」 does — the answer's button (Message.vue) and its 공유 sheet (AnswerShareSheet.vue) alike
// (spec chat-to-project, server lib/chatProject.js): the confirm card under the chat — the one still open for this answer, or a new one —
// brought into view. Nothing is made before the card's 「만들기」.
import { nextTick } from 'vue'

// an answer worth acting on: the agent's text or document answer with words in it (structure: a short acknowledgement — 「네, 처리할게요.」 —
// shows no buttons, its message menu still has them)
export const ANSWER_MIN_CHARS = 80
export function isAnswer(m) {
  return !!m?.id && m.role === 'agent' && (m.kind === 'text' || m.kind === 'doc') && !!String(m.content?.text || '').trim() && !m.content?.stopped && !m.content?.note
}
export const showsActions = (m) => isAnswer(m) && (m.kind === 'doc' || String(m.content.text).trim().length >= ANSWER_MIN_CHARS)

export function openOffer(app, msg) {
  return (app.messages[msg.thread_id] || []).find((m) => m.kind === 'project_offer' && m.content?.state === 'offered' && m.content?.source?.answer?.messageId === msg.id) || null
}
export async function startProjectFrom(app, msg) {
  const offer = openOffer(app, msg) || (await app.projectOffer(msg.id)).offer
  const list = (app.messages[msg.thread_id] ||= [])
  // (the card comes live as well — 'message'; put in here at once when the event is slower)
  if (offer && !list.some((m) => m.id === offer.id)) list.push(offer)
  await nextTick()
  if (offer) document.querySelector(`.row[data-id="${offer.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  return offer
}
