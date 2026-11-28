// 「길게 누르면 …」 — said once on a phone (2026-11-28: the actions under answers and file cards moved into their menus — 「화면이 정신없으니
// 하단의 공유, 프로젝트로 등록, 폴더 정리 등 모든 것들 콘텍스트 메뉴로. 모바일에선 길게 누를때」). The hint sits under the newest answer or
// file card that has a menu (Message.vue claims it as it is drawn) and is remembered as seen the moment it is on screen: never again in
// this browser — and, where the browser keeps nothing (private mode, storage refused), not again until the page is loaded anew.
// A computer has no hint: the ⋯ shows by the bubble under the pointer.
import { reactive } from 'vue'

const KEY = 'pgl-hold-hint'
function read() { try { return localStorage.getItem(KEY) === '1' } catch { return false } }
function write() { try { localStorage.setItem(KEY, '1') } catch { /* this page load only */ } }
// a phone: touch, no hover (a computer's ⋯ shows instead)
export const touchOnly = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches

export const holdHint = reactive({ host: null, seen: read(), closed: false })

// a message that has a menu, drawn: the newest one drawn hosts the hint, until it has been on screen
export function claimHint(id) {
  if (holdHint.seen || holdHint.closed || !touchOnly()) return
  holdHint.host = id
}
// on screen: seen — kept until closed (✕, or a long press opens a menu), never shown on a later load
export function sawHint() {
  if (holdHint.seen) return
  holdHint.seen = true
  write()
}
export function closeHint() { holdHint.closed = true; holdHint.host = null; sawHint() }
