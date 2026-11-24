<script setup>
// The messenger's place, picked from a menu (the way without dragging: keyboard, touch): 떠 있게 두기 · 오른쪽에 붙이기 ·
// 왼쪽에 붙이기 · 문서 패널에 넣기 (src/messengerDock.js). In the messenger's header; hidden where there is no docking (phones).
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'

const props = defineProps({ dock: { type: String, default: 'float' } })
const emit = defineEmits(['pick'])
const OPTS = [
  { id: 'float', icon: 'float', label: '떠 있게 두기', hint: '페이지 위에 떠 있어요' },
  { id: 'right', icon: 'dockr', label: '오른쪽에 붙이기', hint: '페이지와 나란히 써요' },
  { id: 'left', icon: 'dockl', label: '왼쪽에 붙이기', hint: '페이지와 나란히 써요' },
  { id: 'panel', icon: 'dockp', label: '문서 패널에 넣기', hint: '연 문서 옆에서 대화해요' },
]
const open = ref(false)
const el = ref(null)
const icon = computed(() => OPTS.find((o) => o.id === props.dock)?.icon || 'float')
function pick(id) { open.value = false; emit('pick', id) }
const outside = (e) => { if (open.value && !el.value?.contains(e.target)) open.value = false }
// Esc closes the menu first (the messenger's own Esc waits for the next press)
const onKey = (e) => { if (open.value && e.key === 'Escape') { e.stopImmediatePropagation(); open.value = false } }
onMounted(() => { document.addEventListener('pointerdown', outside, true); window.addEventListener('keydown', onKey, true) })
onBeforeUnmount(() => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('keydown', onKey, true) })
</script>

<template>
  <div ref="el" class="dkw">
    <button class="dkb press" :class="{ on: open }" aria-label="메시지 위치" aria-haspopup="menu" :aria-expanded="open" title="메시지 위치 — 머리를 끌어 옮겨도 돼요"
      data-test="dock-button" @click="open = !open"><Icon :name="icon" :size="17" /></button>
    <div v-if="open" class="dkmenu glass" role="menu" aria-label="메시지 위치" data-test="dock-menu">
      <button v-for="o in OPTS" :key="o.id" role="menuitemradio" :aria-checked="dock === o.id" class="dko press" :class="{ on: dock === o.id }" :data-dock="o.id" @click="pick(o.id)">
        <Icon :name="o.icon" :size="18" /><span class="dt"><b>{{ o.label }}</b><small>{{ o.hint }}</small></span><Icon v-if="dock === o.id" name="check" :size="15" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.dkw { position: relative; flex: none; }
.dkb { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; color: var(--text-secondary); }
.dkb:hover, .dkb.on { color: var(--text-primary); background: rgba(127, 127, 127, .14); }
.dkmenu { position: absolute; z-index: 20; top: calc(100% + 6px); right: -36px; width: 236px; padding: 6px; border-radius: 16px; box-shadow: 0 12px 40px rgba(0, 0, 0, .22); display: flex; flex-direction: column; gap: 2px; }
.dko { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: 11px; text-align: left; color: var(--text-primary); }
.dko:hover { background: rgba(127, 127, 127, .12); }
.dko.on { background: rgba(42, 120, 214, .14); }
.dko .dt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.dko b { font-size: 13.5px; font-weight: 500; }
.dko small { font-size: 11.5px; color: var(--text-secondary); }
</style>
