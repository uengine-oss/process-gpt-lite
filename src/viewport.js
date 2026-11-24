// Phone-width layout (hark's mobile app): one column, 홈 / 채팅 / 프로젝트 as tabs.
import { ref, computed } from 'vue'

const check = () => window.innerWidth <= 760
export const narrow = ref(check())
// the window's width, and what a docked messenger takes from the page beside it (components/team/Messenger.vue, src/messengerDock.js)
export const viewW = ref(window.innerWidth)
export const pageInset = ref(0)
export const pageW = computed(() => viewW.value - pageInset.value)
window.addEventListener('resize', () => { narrow.value = check(); viewW.value = window.innerWidth })
