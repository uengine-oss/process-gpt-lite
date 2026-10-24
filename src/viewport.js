// Phone-width layout (hark's mobile app): one column, 홈 / 채팅 / 프로젝트 as tabs.
import { ref } from 'vue'

const check = () => window.innerWidth <= 760
export const narrow = ref(check())
window.addEventListener('resize', () => { narrow.value = check() })
