<script setup>
// An app's screen inside the conversation (docs/robo-dlc/plan-intake.md §12-2): the assistant handed the request to
// an app — work intake — and the app's own screen is the answer, shown as a card as tall as its content. The
// same screen opens large beside the chat. A card far up the conversation is not loaded until it is scrolled to.
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import AppFrame from '../apps/AppFrame.vue'
import { useApps } from '../stores/apps.js'
import { isEnglish } from '../i18n/lang.js'

const props = defineProps({ msg: Object })
const apps = useApps()
const c = computed(() => props.msg.content || {})
const manifest = computed(() => apps.byId(c.value.app))
// (one object for as long as the message is the same: the frame is told again whenever its params change)
const params = computed(() => ({ ...(c.value.params || {}), card: '1' }))
const height = ref(190)
const seen = ref(false)
const failed = ref(false)
const el = ref(null)
let io = null
onMounted(() => {
  apps.load()
  io = new IntersectionObserver((list) => { if (list.some((e) => e.isIntersecting)) { seen.value = true; io.disconnect() } }, { rootMargin: '300px' })
  io.observe(el.value)
})
onBeforeUnmount(() => io?.disconnect())
const onSize = (s) => { if (s?.height) height.value = Math.min(Math.max(Math.ceil(s.height), 120), 1100) }
</script>

<template>
  <div ref="el" class="appcard" data-test="app-card" :data-app="c.app">
    <div class="ah">
      <span class="ic">{{ manifest?.icon }}</span>
      <b>{{ manifest ? (isEnglish ? manifest.name.en : manifest.name.ko) : c.app }}</b>
      <span v-if="c.folderName" class="of">{{ c.folderName }}</span>
      <button v-if="manifest" class="open press" data-test="app-card-open" @click="apps.open(c.app, c.folder, c.params || {})">{{ isEnglish ? 'Open large' : '크게 보기' }}</button>
    </div>
    <div v-if="manifest && seen && !failed" class="frame" :style="{ height: height + 'px' }">
      <AppFrame :manifest="manifest" :folder="c.folder" :params="params" inline @size="onSize" @error="failed = true" />
    </div>
    <p v-else-if="failed || (apps.list && !manifest)" class="gone">{{ isEnglish ? 'This screen cannot be opened here.' : '이 화면을 여기서 열 수 없어요.' }}</p>
  </div>
</template>

<style scoped>
.appcard { width: 600px; max-width: 100%; border-radius: 24px; padding: 6px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); }
.ah { display: flex; align-items: center; gap: 7px; padding: 7px 8px 7px 12px; font-size: 14px; }
.ah .of { color: var(--text-secondary); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.open { margin-left: auto; flex: none; height: 28px; padding: 0 12px; border-radius: 14px; background: var(--cell-bg); font-size: 13px; }
.frame { border-radius: 18px; overflow: hidden; transition: height .25s; position: relative; }
.gone { margin: 4px 12px 10px; color: var(--text-secondary); font-size: 14px; }
</style>
