<script setup>
defineProps({ name: String, size: { type: Number, default: 20 } })
const P = {
  home: 'M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3',
  up: 'M12 19V6M6 11.5 12 5.5l6 6',
  undo: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 0 12h-2',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
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
  plan: 'M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4.5a1.5 1.5 0 0 1 3 0V12M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-12.4 4.4L3 15.5a1.5 1.5 0 0 1 2.2-2L8 16',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
}
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path :d="P[name]" />
  </svg>
</template>
