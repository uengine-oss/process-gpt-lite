<script setup>
// A Lite app on a screen of its own: /apps/<id>/<folder>?… (the query goes to the app as its start)
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import AppFrame from '../apps/AppFrame.vue'
import { useApps } from '../stores/apps.js'
import { isEnglish } from '../i18n/lang.js'
import { events } from '../api.js'

const route = useRoute()
const router = useRouter()
const apps = useApps()
const ready = ref(false)
const manifest = computed(() => apps.byId(route.params.id))
const params = computed(() => Object.fromEntries(Object.entries(route.query).map(([k, v]) => [k, String(v ?? '')])))
// the app's live events come over the tab's one event stream (opened here when this is the first screen)
onMounted(async () => { events(); await apps.load(); ready.value = true })
const name = (m) => (isEnglish ? m.name.en : m.name.ko)
</script>

<template>
  <div class="page">
    <TopBar />
    <div class="body">
      <div class="head">
        <button class="back press" aria-label="뒤로" @click="router.push(`/folders/${route.params.folder}`)">‹</button>
        <template v-if="manifest"><span class="ico">{{ manifest.icon }}</span><h1>{{ name(manifest) }}</h1><span class="sub">{{ route.params.folder }}</span></template>
      </div>
      <div v-if="ready && !manifest" class="none glass">이 앱은 설치되어 있지 않아요: {{ route.params.id }}</div>
      <div v-else-if="manifest" class="frame glass">
        <AppFrame :key="manifest.id + route.params.folder" :manifest="manifest" :folder="String(route.params.folder)" :params="params" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { position: absolute; inset: 0; display: flex; flex-direction: column; }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0 20px 18px; max-width: 1480px; width: 100%; margin: 0 auto; }
.head { display: flex; align-items: center; gap: 10px; margin: 6px 0 10px; }
.head h1 { font-size: 22px; margin: 0; letter-spacing: -.02em; }
.head .sub { color: var(--text-secondary); font-size: 14px; }
.ico { font-size: 20px; }
.back { width: 32px; height: 32px; border-radius: 99px; background: var(--cell-bg); font-size: 20px; line-height: 1; }
.frame { flex: 1; min-height: 0; border-radius: 22px; overflow: hidden; }
.none { border-radius: 18px; padding: 20px; }
</style>
