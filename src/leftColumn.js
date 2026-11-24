// The left column (Home's dock, the chat's thread list, the project and routine lists) beside a document open beside the page
// (2026-11-24 사용자, a ~2000px window: 「프로젝트에서 산출물을 열어보면 이렇게 목록과 대화내용이 겹쳐진다.」 — spec
// openspec/specs/chat-artifacts 「문서가 페이지 옆에 열려 있어도 왼쪽 칸 · 채팅 · 문서는 겹치지 않는다」). The document panel
// (components/OfficeSheet.vue) takes the page's right part; the chat recentred in what was left of it from the window's left edge,
// on top of a list still there. The rule, with no screen in it (views/MainView.vue carries it out):
//   column — the column (420px) beside the chat: there is no document, or the page holds the column, the chat (512px with 40px of
//            air each side — src/artifactScope.js CHAT_MIN) and the document side by side
//   folded — a document is open and they do not fit: the list is put away and the chat has the whole room left of the document; a
//            button in the top bar beside Home (≡ 프로젝트 · 루틴 · 대화) brings it back. No rail takes the chat's width: at 1280px the
//            chat beside a document has 384px, beside a docked messenger less
//   over   — that button pressed (or the thread list asked for meanwhile), and Home whenever it is open there (its own round button
//            is its toggle): the column over the chat on a panel of its own, from the left edge to the document's room, until a row is
//            picked, Esc, or a click elsewhere
//   none   — no column wanted here (a narrow page: the lists are pages of their own, components/*List.vue `mobile`)
import { CHAT_MIN } from './artifactScope.js'

export const LEFT_W = 420
// the column laid over the chat: this far from the page's left edge
export const OVER_X = 12
// the top bar's button for a folded list: its name (aria) and its short label
export const LEFT_LABEL = { home: 'Home', threads: '대화 목록', projects: '프로젝트 목록', routines: '루틴 목록' }
export const LEFT_SHORT = { home: 'Home', threads: '대화', projects: '프로젝트', routines: '루틴' }

// docW: the document panel's width while it is open beside the page (0: none)
export const fitsBeside = ({ pageW, docW = 0 }) => !docW || Number(pageW) - Number(docW) - LEFT_W >= CHAT_MIN

// kind: 'home' | 'threads' | 'projects' | 'routines' (null: none wanted); peek: the folded list's button is pressed
export function leftColumnPlace({ kind = null, pageW = 0, docW = 0, peek = false } = {}) {
  if (!kind) return 'none'
  if (fitsBeside({ pageW, docW })) return 'column'
  return kind === 'home' || peek ? 'over' : 'folded'
}

// how far from the page's left edge the chat column starts
export const leftEdge = (place) => (place === 'column' ? LEFT_W : 0)

// the column over the chat: from OVER_X to where the document panel's room starts (the panel keeps 16px inside it), at most the
// column's own width less the margin
export const overWidth = ({ pageW, docW = 0 }) => Math.max(0, Math.min(LEFT_W - OVER_X, Number(pageW) - Number(docW) - OVER_X))
