<script setup>
// 공유 폴더 화면 전용 아이콘(공용 Icon.vue 는 건드리지 않는다)
defineProps({ name: String, size: { type: Number, default: 18 } })
const P = {
  folder: 'M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  branch: 'M6 4v10M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 10c0 4-6 3-12 6',
  merge: 'M7 4v16M7 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM17 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM7 8c0 5 10 3 10 8',
  handover: 'M4 12h12M12 6l6 6-6 6M20 5v14',
  upload: 'M12 16V4M7 9l5-5 5 5M5 20h14',
  agent: 'M8 9h8v8H8zM12 5v4M10 13h.01M14 13h.01M5 13H3M21 13h-2',
  index: 'M5 5h14M5 10h14M5 15h8M17 18a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM19 17.5l2 2',
  history: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v3h3M12 8v4l3 2',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5H5V6h5',
  chat: 'M5 5h14v10H9l-4 4z',
  people: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19a6 6 0 0 1 12 0M16 5.5a3 3 0 0 1 0 5.5M18 14a6 6 0 0 1 3 5',
  // a computer (champion folders: 「내 PC 폴더 올리기」, a folder this PC uploads)
  pc: 'M4.5 6h15v9.5h-15zM2.5 19h19M10 15.5v3.5M14 15.5v3.5',
  // a variation put away (보관 중 — its seat is nowhere: only its branch)
  archive: 'M4 5h16v4H4zM5.5 9v10h13V9M10 13h4',
  // the agent assets (스킬 · 명령 · 지침)
  kit: 'M5 7h14v12H5zM9 7V5h6v2M5 12h14M11 12v2h2v-2',
  // a reference slot (참조): it points elsewhere ↗ · one this person cannot read · one whose original is gone or taken · its menu
  ref: 'M8 16 16 8M9.5 8H16v6.5',
  lock: 'M7.5 11V8.5a4.5 4.5 0 0 1 9 0V11M6 11h12v9H6zM12 14.5v2',
  warn: 'M12 4.5 21 19.5H3zM12 10v4.5M12 17.2v.1',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
}
</script>
<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="P[name]" /></svg>
</template>
