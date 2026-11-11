<script setup>
// Another app opened beside the current screen (lite.openApp): a sheet from the right, over everything.
import { computed } from 'vue'
import AppFrame from './AppFrame.vue'
import { useApps } from '../stores/apps.js'
import { isEnglish } from '../i18n/lang.js'

const apps = useApps()
const m = computed(() => apps.sheet && apps.byId(apps.sheet.id))
</script>

<template>
  <Transition name="sheet">
    <div v-if="m" class="scrim" @click.self="apps.close()">
      <div class="sheet glass" data-test="app-sheet">
        <div class="bar"><span>{{ m.icon }} {{ isEnglish ? m.name.en : m.name.ko }}</span><button class="x press" aria-label="닫기" @click="apps.close()">✕</button></div>
        <AppFrame :key="m.id + JSON.stringify(apps.sheet.params)" :manifest="m" :folder="apps.sheet.folder" :params="apps.sheet.params" />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: 80; background: rgba(0 0 0 / .18); display: flex; justify-content: flex-end; }
.sheet { width: min(860px, 96vw); height: 100%; border-radius: 22px 0 0 22px; display: flex; flex-direction: column; overflow: hidden; --regular-bg: var(--regular-solid-bg); }
.bar { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; font-size: 15px; font-weight: 600; border-bottom: 1px solid var(--separator, rgba(0 0 0 / .08)); }
.x { width: 30px; height: 30px; border-radius: 99px; background: var(--cell-bg); }
.sheet :deep(.app-frame) { flex: 1; min-height: 0; }
.sheet-enter-active, .sheet-leave-active { transition: opacity .25s; }
.sheet-enter-active .sheet, .sheet-leave-active .sheet { transition: transform .3s var(--spring, ease); }
.sheet-enter-from, .sheet-leave-to { opacity: 0; }
.sheet-enter-from .sheet, .sheet-leave-to .sheet { transform: translateX(40px); }
</style>
