// Connecting Google (server lib/googleConnect.js). Two ways:
//   - in the server browser (the default): the 「Google 연결」 card goes up in the main chat and its full view
//     opens with 직접 제어 already on, so the person signs in to Google there. That one sign-in connects
//     the mail and leaves the server browser signed in to Google (NotebookLM and the other Google sites).
//   - 휴대폰에서 연결: this browser goes to Google's consent screen and comes back to 설정 › 계정 — the mail
//     only (Google may refuse a sign-in in the server browser; then the card offers this).
import { api } from './api.js'
import { narrow } from './viewport.js'

// → the card's id; the caller's screen (settings, a sheet) is left for the chat
export async function connectInBrowser(app, router) {
  const r = await api('/auth/google/connect', { method: 'POST', body: { mode: 'browser', origin: location.origin } })
  if (router) await router.push('/chat')
  // a phone: the chat (where the card is) under the full view, not Home
  if (narrow.value) app.dockOpen = false
  if (!(app.messages[r.threadId] || []).some((m) => m.id === r.taskId)) await app.load(r.threadId)
  app.takeover = r.taskId
  app.handoff = r.taskId
  return r.taskId
}

export async function connectOnPhone() {
  const r = await api('/auth/google/connect', { method: 'POST', body: { mode: 'phone', origin: location.origin } })
  location.href = r.url
}
