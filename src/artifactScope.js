// The files a chat made (2026-11-24 사용자: 「프로젝트나 채팅에서 생성된 산출물들은 맥 다운로드 영역처럼 산출물 목록 펼쳐 보기 기능이
// 있었는데.. 지금 안 나타나는 듯?」 · 「우측 영역이 많이 남아돌기에 산출물 목록들이 쭉 보이고 클릭하면 이음오피스로 보일 수 있을 것임」 —
// spec openspec/specs/chat-thread-list 「산출물」). The pieces with no screen in them: which files the view on screen has (the whole chat,
// one conversation of it, a project's room), the list's search, and where they show — a list in the right column when the page has
// room beside the chat, its thin rail when folded, the Dock-style pile (components/ArtifactStack.vue) when it has not, nothing while a
// document is open.

// what the view is: the whole main chat, one conversation of it (/chat/c/:cid), a project's room, one sub-topic of a project
// (/projects/:id/t/:tid — src/projectTopics.js) — anything else has no files here
export function artifactScope({ mode, activeId, mainId, convFilter, topicFilter = null, projectIds = [] }) {
  if (!activeId) return null
  if (mode === 'chat' && activeId === mainId) return convFilter ? 'conv' : 'chat'
  if (mode === 'project' && projectIds.includes(activeId)) return topicFilter ? 'topic' : 'project'
  return null
}

const at = (m) => { const t = new Date(m?.created_at).getTime(); return Number.isFinite(t) ? t : -Infinity }
// The view's files, newest first: file messages with a name; in the main chat each knows its conversation (convOf: message id →
// conversation id, titles: conversation id → title); one conversation's view keeps only its own — and so does one sub-topic's view of
// a project (convOf: message id → sub-topic, convFilter: the sub-topic)
export function artifactItems({ scope, messages = [], convOf = {}, convFilter = null, titles = {} }) {
  if (!scope) return []
  const files = messages.map((m, i) => [m, i]).filter(([m]) => m?.kind === 'file' && m.content?.name)
  const out = []
  for (const [m, i] of files) {
    const conv = scope === 'project' ? null : convOf[m.id] || null
    if ((scope === 'conv' || scope === 'topic') && conv !== convFilter) continue
    out.push({ msg: m, conv, convTitle: conv ? titles[conv] || '' : '', i })
  }
  return out.sort((a, b) => at(b.msg) - at(a.msg) || b.i - a.i).map(({ i, ...x }) => x)
}

// the list's search box: the file's name and the conversation it came from (plain text, for finding a row)
export function filterArtifacts(items, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return [...(items || [])]
  return (items || []).filter((x) => { const h = `${x.msg?.content?.name || ''}\n${x.convTitle || ''}`.toLowerCase(); return words.every((w) => h.includes(w)) })
}

export const CAPTION = { chat: '채팅의 산출물', conv: '이 대화의 산출물', project: '이 프로젝트의 산출물', topic: '이 주제의 산출물' }

// The right column: 300px for the list, 64px folded to a rail. The chat column (512px) keeps 40px of air on each side — so beside
// Home's column (420px) the list needs a page of 1312px, without it 892px (and the wide layout starts above 1000px). A page with
// less room (a narrower window, a docked messenger taking its column) gets the pile; a phone always does.
export const LIST_W = 300
export const RAIL_W = 64
export const CHAT_MIN = 512 + 2 * 40
export function artifactLayout({ pageW, leftW = 0, wide = true, docOpen = false, folded = false, count = 0 }) {
  if (!count || docOpen) return 'none'
  if (!wide) return 'pile'
  if (Number(pageW) - leftW - LIST_W >= CHAT_MIN) return folded ? 'rail' : 'list'
  return 'pile'
}
export const sideWidth = (layout) => (layout === 'list' ? LIST_W : layout === 'rail' ? RAIL_W : 0)

// Where the pile sits, from the composer's box (ChatColumn measures it): beside the composer when the space right of it holds the
// pile with air around it, else above the composer's right end — clear of a notice over it too (38px, 12px over it; the progress
// pill is on the composer's own row now, inside footTop) — so it never covers what is typed. A phone's pile is smaller.
export const PILE = 64
export const PILE_SMALL = 48
export function pilePlace({ gutter = 0, footTop = 84, small = false }) {
  const size = small ? PILE_SMALL : PILE
  if (!small && gutter >= size + 48) return { mode: 'beside', size, right: Math.round((gutter - size) / 2), bottom: 30 }
  return { mode: 'above', size, right: Math.max(16, Math.round(gutter)), bottom: Math.round(footTop + 12 + 38 + 10) }
}

// the list folded to its rail: this browser only; a private window that refuses storage just forgets
export const FOLD_KEY = 'pgl-artifact-list'
const store = (s) => { try { return s === undefined ? globalThis.localStorage : s } catch { return null } }
export function readFolded(storage) {
  try { return store(storage)?.getItem(FOLD_KEY) === 'rail' } catch { return false }
}
export function saveFolded(folded, storage) {
  try { store(storage)?.setItem(FOLD_KEY, folded ? 'rail' : 'list') } catch { /* private window */ }
}
