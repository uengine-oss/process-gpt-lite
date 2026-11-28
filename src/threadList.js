// 채팅의 대화 목록(2026-11-24 사용자 요청: 「채팅을 더블클릭하면 프로젝트에서의 목록처럼 왼편에 묶음 처리된 쓰레드 목록이 쭉 나와서
// 필터링됨」 — spec openspec/specs/chat-thread-list). The pieces with no screen in them: the rows' order and their search (plain text,
// for finding a row — not judging what a request means), the row's line and time, whether the list was left open, and the 「채팅」 tab
// that answers a click at once and a double click with the list.

// newest first (a row with no time last); ties keep the order they came in
export function sortThreads(list) {
  const at = (c) => { const t = new Date(c?.updated_at).getTime(); return Number.isFinite(t) ? t : -Infinity }
  return [...(list || [])].map((c, i) => [c, i]).sort((a, b) => at(b[0]) - at(a[0]) || a[1] - b[1]).map(([c]) => c)
}

// the summary's labels (context-router writes 「최근 요청: …\n최근 답: …」; the server reads them in English for an English screen)
const LABEL = /^(최근 요청|최근 답|Latest request|Latest answer):\s*/
// the last request, from the summary's first line
export const lastRequest = (summary) => String(summary || '').split('\n')[0].replace(LABEL, '').trim()

// the row's one line: the digest's gist and the last request (either alone when the other is missing)
export function threadLine(c) {
  const req = lastRequest(c?.summary)
  const gist = String(c?.gist || '').trim()
  return gist && req && gist !== req ? `${gist} · ${req}` : gist || req
}

// what the search box looks through: the title, the gist and the whole summary (request and answer)
const haystack = (c) => [c?.title, c?.gist, String(c?.summary || '').replace(/^(최근 요청|최근 답|Latest request|Latest answer):/gm, '')].join('\n').toLowerCase()
// every word typed must be somewhere in it; an empty box keeps every row
export function filterThreads(list, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...(list || [])]
  return (list || []).filter((c) => { const h = haystack(c); return words.every((w) => h.includes(w)) })
}

// 「N분 전 · N시간 전 · 날짜」 — the same words as the conversation bar (components/ConversationBar.vue)
export function whenText(t, now = Date.now()) {
  const d = new Date(t)
  if (!Number.isFinite(d.getTime())) return ''
  const mins = Math.round((now - d) / 60000)
  return mins < 60 ? `${Math.max(1, mins)}분 전` : mins < 1440 ? `${Math.round(mins / 60)}시간 전` : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}

// whether the list was left open: this browser only (a convenience, not a setting); a private window that refuses storage just forgets
export const OPEN_KEY = 'pgl-chat-thread-list'
const store = (s) => { try { return s === undefined ? globalThis.localStorage : s } catch { return null } }
export function readListOpen(storage) {
  try { return store(storage)?.getItem(OPEN_KEY) === '1' } catch { return false }
}
export function saveListOpen(open, storage) {
  try { store(storage)?.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* private window: forgotten on reload */ }
}

// A tab that answers a click at once and a double click with something else. The first click is never held back (no waiting to see
// whether a second one comes). The clicks of one burst are counted: by the browser's own count (`detail`) for a mouse, and for a touch
// or a key also by time (a click within `gap` ms of the one before — a browser that counts no taps). The second click of a burst runs
// the double instead of the single action again; the dblclick event that follows it, or a third click, runs nothing (a dblclick
// alone — its clicks unseen — runs the double). single() returns what double() needs to know about the screen before the first click
// (the first click may already have changed it). One per tab, kept outside the component: the first click can move to another page
// whose top bar is a new one.
export function createTaps({ gap = 400, now = () => Date.now() } = {}) {
  let last = -Infinity
  let count = 0
  let fired = false
  let memo
  const fire = (double) => {
    if (fired) return 'ignored'
    fired = true
    const was = memo
    memo = undefined
    double(was)
    return 'double'
  }
  return {
    click(e, { single, double }) {
      const t = now()
      const near = t - last < gap
      last = t
      const d = Number(e?.detail) || 0
      const n = d >= 2 ? d : e?.pointerType !== 'mouse' && near ? count + 1 : 1
      count = n
      // a burst whose first click this tab did not see (it landed on the page before) starts afresh
      if (n === 1 || !near) fired = false
      if (n === 1) { memo = single(); return 'single' }
      return n === 2 ? fire(double) : 'ignored'
    },
    dblclick(e, { double }) { return fire(double) },
  }
}

// 「프로젝트로 옮기기」 from the list's row (components/ThreadList.vue — spec thread-to-project): not a standing conversation whose runs keep
// arriving in the chat — a scheduled task's, the briefs' (server lib/conversationMove.js STANDING) — nor an empty one
export const STANDING = ['schedule', 'brief']
export const movable = (c) => !!c && !STANDING.includes(c.kind) && Number(c.count) > 0
