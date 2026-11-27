// Phone-width layout (hark's mobile app): one column, 홈 / 채팅 / 프로젝트 as tabs.
import { ref, computed } from 'vue'

const check = () => window.innerWidth <= 760
export const narrow = ref(check())
// the window's width, and what a docked messenger takes from the page beside it (components/team/Messenger.vue, src/messengerDock.js)
export const viewW = ref(window.innerWidth)
export const pageInset = ref(0)
export const pageW = computed(() => viewW.value - pageInset.value)
window.addEventListener('resize', () => { narrow.value = check(); viewW.value = window.innerWidth })
// a finger rather than a mouse (a phone, a tablet): while the person types there, the composer folds what stands over its box (Composer.vue)
const coarseMq = window.matchMedia?.('(pointer: coarse)')
export const coarse = ref(!!coarseMq?.matches)
coarseMq?.addEventListener?.('change', (e) => { coarse.value = e.matches })
// The on-screen keyboard is up (PR #119 review): what is visible is well below the tallest seen at this width. Android Chrome shrinks
// only the visual viewport, the Android app's WebView and iOS the window as well — either way the visible height drops; a hardware
// keyboard drops nothing. Put away with Back or Gboard's ⌄ the box keeps its focus and no blur comes: the height coming back is the sign.
// (× scale: pinching to zoom shrinks the visual viewport's CSS height too; a new width — turned, resized — is a new baseline)
const KB_MIN = 120
const vv = window.visualViewport
const seenH = () => Math.round(vv ? vv.height * (vv.scale || 1) : window.innerHeight)
let tallW = window.innerWidth
let tallH = seenH()
export const keyboardUp = ref(false)
function onViewport() {
  const w = window.innerWidth, h = seenH()
  if (w !== tallW) { tallW = w; tallH = h } else tallH = Math.max(tallH, h)
  keyboardUp.value = tallH - h > Math.max(KB_MIN, tallH * 0.18)
}
vv?.addEventListener('resize', onViewport)
window.addEventListener('resize', onViewport)
// a page wide enough for a left column beside the chat (Home's dock, the project · routine · thread lists); narrower, a list is a page
// of its own over the chat
export const wideLayout = computed(() => pageW.value > 1000)
