// The 「채팅」 tab's clicks (components/TopBar.vue): one counter for every top bar — the first click can move to another page whose top
// bar is a new one, and the second click lands there (src/threadList.js createTaps).
import { createTaps } from './threadList.js'

export const chatTaps = createTaps()
