<script setup>
defineProps({ name: String, size: { type: Number, default: 20 } })
const P = {
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
  up: 'M12 19V6M6 11.5 12 5.5l6 6',
  // a download (내려받기)
  down: 'M12 4v12M6 10.5l6 6 6-6M5 20h14',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-2',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  list: 'M4 7h16M4 12h11M4 17h7',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13M10 11v6M14 11v6',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5 20 20',
  doc: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5',
  alert: 'M12 4 2.8 19.5h18.4zM12 10v4.5M12 17v.01',
  expand: 'M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7',
  shrink: 'M4 14h6v6M20 10h-6V4M10 14l-7 7M14 10l7-7',
  sun: 'M12 7.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
  cloud: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 11a3.5 3.5 0 0 0 1 7z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  clip: 'M16.5 7.5 9 15a2.1 2.1 0 0 0 3 3l7.6-7.6a4.2 4.2 0 0 0-6-6L5.9 12.1a6.3 6.3 0 0 0 9 9l6.6-6.6',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  team: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.2a6.5 6.5 0 0 1 3.5 5.8',
  panel: 'M4 5h16v14H4zM4 10h16',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  card: 'M3 6h18v12H3zM3 10h18M7 15h4',
  key: 'M14.5 9.5a4 4 0 1 1-3.4 6.1L4 22.7V20h2v-2h2l2.1-2.1A4 4 0 0 1 14.5 9.5z',
  mail: 'M4 6.5h16v11H4zM4.5 7l7.5 6 7.5-6',
  // a speech bubble (채팅에서 이어서 — the mail sheet's row)
  chat: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-8l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  // a handle that is dragged (the mail sheet's head)
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  plan: 'M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-12.4 4.4L3 15.5a1.5 1.5 0 0 1 2.2-2L8 16',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  folder: 'M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5V17a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17z',
  // where the team messenger sits (components/team/DockMenu.vue): floating, a column at the right or left, in the document panel
  float: 'M3.5 5h17v14h-17zM10 9h8v7h-8z',
  dockr: 'M3.5 5h17v14h-17zM14.5 5v14',
  dockl: 'M3.5 5h17v14h-17zM9.5 5v14',
  dockp: 'M3.5 5h17v14h-17zM9 5v14M15 5v14M11.5 9h1.5M11.5 12h1.5',
  // a camera (the profile picture's change badge, Settings)
  // a room's reactions (components/team/ReactionBar · ReactionChips): drawn like the rest, not the device's colour emoji (2026-11-26
  // 「아이콘들 디자인이 너무 전체 톤이 어울리지 않은듯」)
  'rx-like': 'M7.5 10.5v9.2M7.5 10.5H5a1 1 0 0 0-1 1v7.2a1 1 0 0 0 1 1h2.5M7.5 10.5l3.4-6.1a1.7 1.7 0 0 1 3.1 1.3L13.2 9.6h4.9a2 2 0 0 1 2 2.4l-1.2 6.1a2 2 0 0 1-2 1.6H7.5',
  'rx-check': 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM8.2 12.3l2.6 2.6 5-5.3',
  'rx-love': 'M12 19.6s-7.6-4.5-7.6-10.1A4.1 4.1 0 0 1 12 7.2a4.1 4.1 0 0 1 7.6 2.3c0 5.6-7.6 10.1-7.6 10.1z',
  'rx-laugh': 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM8 13.1h8a4 4 0 0 1-8 0zM7.8 10l1.5-1.3 1.5 1.3M13.2 10l1.5-1.3 1.5 1.3',
  'rx-wow': 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM12 17.3a1.7 2.1 0 1 0 0-4.2 1.7 2.1 0 0 0 0 4.2zM9.1 9.7h.01M14.9 9.7h.01',
  'rx-thanks': 'M12 3.9c-1.6 1.2-2.9 3.4-3.2 6l-.7 5.1-2.5 2.6 3.2 3.1 3.2-3.4V3.9zM12 3.9c1.6 1.2 2.9 3.4 3.2 6l.7 5.1 2.5 2.6-3.2 3.1-3.2-3.4',
  // a face with a smile (a message's 「반응」 — components/team/Messenger.vue)
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.2a4.5 4.5 0 0 0 7 0M9.2 9.6h.01M14.8 9.6h.01',
  // a cog (a room's 「설정」)
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 13.5l1.6 1.2-1.8 3.1-1.9-.7a7.5 7.5 0 0 1-2.2 1.3l-.3 2h-3.6l-.3-2a7.5 7.5 0 0 1-2.2-1.3l-1.9.7-1.8-3.1 1.6-1.2a7.6 7.6 0 0 1 0-3l-1.6-1.2 1.8-3.1 1.9.7a7.5 7.5 0 0 1 2.2-1.3l.3-2h3.6l.3 2a7.5 7.5 0 0 1 2.2 1.3l1.9-.7 1.8 3.1-1.6 1.2a7.6 7.6 0 0 1 0 3z',
  camera: 'M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.5-2h5.4l1.5 2h2.3A1.5 1.5 0 0 1 20 8.5V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18zM12 16.2a3.4 3.4 0 1 0 0-6.8 3.4 3.4 0 0 0 0 6.8z',
}
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="P[name]" />
  </svg>
</template>
