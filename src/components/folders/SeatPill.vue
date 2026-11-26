<script setup>
// Where a variation's working copy is — its seat (server lib/folders/seats.js, spec variation-seats). Everyone who sees the variation sees
// the same words: 보관 중 · 서버 작업실에서 · <who> · 서버 에이전트가 작업 중 · <who>의 PC 에서 · <its name> · PC 꺼짐 … · 넘기는 중… —
// never a path or a computer's id. compact: one short line (a list row, a phone). here: this very computer holds it (the desktop app's
// working copy — src/desktopSeats.js): 「이 PC 에서」 with the app's own counts.
import { computed } from 'vue'
import FIcon from './FIcon.vue'
import { seatText } from '../../foldersApi.js'

const props = defineProps({ seat: Object, compact: Boolean, dark: Boolean, here: { type: Object, default: null } })
const t = computed(() => seatText(props.seat, { here: props.here }))
const title = computed(() => [...t.value.parts, props.seat?.recall ? `돌려 달라는 요청 · ${props.seat.recall.by?.name || ''}` : ''].filter(Boolean).join(' · '))
</script>

<template>
  <span class="seat" :class="[t.tone, { compact, dark }]" :title="title" data-test="seat-pill">
    <span v-if="t.tone === 'moving'" class="spin" /><FIcon v-else :name="t.icon" :size="compact ? 12 : 13" />
    <template v-for="(p, i) in (compact ? t.parts.slice(0, 2) : t.parts)" :key="i"><span v-if="i" class="dot">·</span><span class="pt" :data-no-i18n="i === 1 && ['server', 'device'].includes(t.tone) && !here ? '' : null">{{ p }}</span></template>
    <span v-if="seat?.recall && !compact" class="rc">돌려 달라는 요청</span>
  </span>
</template>

<style scoped>
.seat { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 10px; border-radius: 12px; font-size: 12px; font-weight: 500; white-space: nowrap; max-width: 100%; overflow: hidden;
  background: var(--button-bg); color: var(--text-secondary); }
.seat svg { flex: none; }
.pt { overflow: hidden; text-overflow: ellipsis; }
.dot { opacity: .5; }
.seat.server { background: rgba(161 208 255 / .2); color: var(--color-info); }
/* (the light theme's sky behind it: a deeper violet, readable on the glass — f-wl-11 screenshots) */
.seat.device { background: rgba(123 92 214 / .2); color: #5a3dc0; }
.seat.agent { background: rgba(255 160 60 / .16); color: #d98a2c; }
.seat.moving { background: rgba(255 160 60 / .16); color: #d98a2c; }
.seat.none { color: var(--text-tertiary); }
.seat.compact { height: 20px; padding: 0 8px; font-size: 11px; gap: 4px; }
.rc { margin-left: 2px; padding: 0 6px; height: 16px; border-radius: 8px; display: inline-flex; align-items: center; font-size: 10.5px; background: #e0613f; color: #fff; }
.spin { width: 10px; height: 10px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; flex: none; }
/* the dark theme: brighter words on a stronger tint (the light theme's tints are too faint on dark glass) */
:root[data-theme="dark"] .seat:not(.dark) { background: rgba(18 22 36 / .62); color: #d6d9e0; }
:root[data-theme="dark"] .seat.server:not(.dark) { background: rgba(18 30 62 / .7); color: #b9d8ff; }
:root[data-theme="dark"] .seat.device:not(.dark) { background: rgba(36 24 66 / .7); color: #d6c8ff; }
:root[data-theme="dark"] .seat.agent:not(.dark), :root[data-theme="dark"] .seat.moving:not(.dark) { background: rgba(60 36 12 / .7); color: #ffc98a; }
:root[data-theme="dark"] .seat.none:not(.dark) { color: #b4b8c2; }
/* the workroom's dark header */
.seat.dark { background: #23263a; color: #aeb8d8; border: 1px solid #343a63; }
.seat.dark.server { color: #8ab4ff; } .seat.dark.device { color: #c3a8ff; } .seat.dark.agent, .seat.dark.moving { color: #f5a524; } .seat.dark.none { color: #8a909c; }
</style>
