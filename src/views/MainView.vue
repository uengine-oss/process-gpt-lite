<script setup>
import { computed, onMounted, ref, watch, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import HomeDock from '../components/HomeDock.vue'
import ProjectList from '../components/ProjectList.vue'
import ChatColumn from '../components/ChatColumn.vue'
import SearchOverlay from '../components/SearchOverlay.vue'
import HandoffView from '../components/HandoffView.vue'
import OfficeSheet from '../components/OfficeSheet.vue'
import MailConnect from '../components/MailConnect.vue'
import SettingsSheet from '../components/SettingsSheet.vue'
import Typewriter from '../components/Typewriter.vue'
import InstanceHeader from '../components/InstanceHeader.vue'
import ConversationBar from '../components/ConversationBar.vue'
import ArtifactStack from '../components/ArtifactStack.vue'
import Composer from '../components/Composer.vue'
import { narrow } from '../viewport.js'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { useSky } from '../stores/sky.js'

const app = useApp()
const sky = useSky()
const route = useRoute()
const router = useRouter()
const ready = ref(false)
const connecting = ref(false)
const wide = ref(window.innerWidth > 1000)
const onResize = () => { wide.value = window.innerWidth > 1000 }

const settings = computed(() => !!route.meta.settings)
const leftOpen = computed(() => wide.value && (app.mode === 'project' || app.dockOpen))
// Phone: Home is a full-width tab with the composer under it; Projects shows its list first.
const mobileHome = computed(() => narrow.value && app.mode === 'chat' && app.dockOpen)
const mobileList = computed(() => narrow.value && app.mode === 'project' && !route.params.id && !route.params.instId)
function sendFromHome(text) {
  if (!app.panelMode) app.dockOpen = false
  onSend(text)
}
const newProject = computed(() => app.mode === 'project' && !route.params.id && !route.params.instId)
const instMode = computed(() => !!route.params.instId)
let poll

const clock = computed(() => {
  const d = sky.clock
  return {
    day: d.toLocaleDateString('ko-KR', { weekday: 'short' }),
    date: d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }),
    time: d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }),
  }
})

async function syncRoute() {
  app.mode = route.meta.mode || 'chat'
  if (!ready.value) return
  clearInterval(poll)
  if (!route.params.instId) app.instance = null
  app.convFilter = app.mode === 'chat' && route.params.cid ? decodeURIComponent(route.params.cid) : null
  if (app.mode === 'chat') app.activeId = app.mainThread.id
  else if (route.params.instId) {
    await app.openInstance(route.params.instId)
    // agents advance instances in the background; keep the timeline fresh while it runs
    poll = setInterval(() => app.instance?.inst.status === 'RUNNING' && app.refreshInstance(), 5000)
  } else if (route.params.id) await app.open(route.params.id)
  else app.activeId = null
}
watch(() => route.fullPath, syncRoute)

onMounted(async () => {
  window.addEventListener('resize', onResize)
  await app.boot()
  ready.value = true
  await syncRoute()
  if (!app.me.profile?.onboarded_at) {
    if (!app.me.profile?.birth) return router.replace('/welcome/age')
    app.dockOpen = false
    api('/onboard/intro', { method: 'POST' })
  }
  if (app.me.profile?.place == null && sky.place) api('/profile', { method: 'POST', body: { lat: sky.place.lat, lon: sky.place.lon, place: sky.place.place } })
})
onBeforeUnmount(() => { window.removeEventListener('resize', onResize); clearInterval(poll) })

async function onSend(text) {
  if (app.panelMode) return app.createPanel(text)
  if (newProject.value) {
    await app.newProject(text)
    return router.replace(`/projects/${app.activeId}`)
  }
  if (instMode.value && app.instance) {
    // questions on an instance page carry its state so the agent can answer about it
    const i = app.instance
    const ctx = `[프로세스 인스턴스: ${i.inst.proc_inst_name} / ${i.def?.name} / 상태 ${i.inst.status}]\n단계: ${i.steps.map((s) => `${s.name}(${s.state})`).join(', ')}\n산출물: ${i.artifacts.map((a) => a.field || a.name).join(', ')}`
    return app.send(text, app.activeId, ctx)
  }
  app.send(text)
}
function onConnect() {
  connecting.value = true
}
</script>

<template>
  <div class="main" :style="{ '--chat-center': leftOpen ? 'calc(420px + (100% - 420px) / 2)' : '50%' }">
    <Transition name="fade"><TopBar v-if="!settings" /></Transition>

    <div class="content" :class="{ away: settings }">
      <Transition name="fade">
        <HomeDock v-if="ready && app.mode === 'chat' && (leftOpen || mobileHome)" :class="{ mobile: narrow }" />
      </Transition>
      <Transition name="fade">
        <ProjectList v-if="ready && app.mode === 'project' && (wide || mobileList)" :class="{ mobile: narrow }" />
      </Transition>

      <Transition name="fade">
        <div v-if="app.mode === 'chat' && !app.dockOpen && !narrow" class="clock">
          <div>{{ clock.day }}</div><div>{{ clock.date }}</div><div>{{ clock.time }}</div>
        </div>
      </Transition>

      <div class="center" :class="{ shifted: leftOpen }">
        <ChatColumn v-if="ready && !mobileHome && (app.activeId || newProject)" :key="app.activeId || 'new'"
          :placeholder="newProject ? '새 프로젝트에서 할 일을 적어 주세요' : instMode ? '이 프로세스에 대해 물어보기' : app.convFilter ? '이 대화에 이어서 묻기' : 'process gpt에 메시지 보내기'"
          :empty-text="newProject ? '' : ''" :keep-top="instMode" @send="onSend" @connect="onConnect">
          <template v-if="instMode && app.instance" #header><InstanceHeader :data="app.instance" @refresh="app.refreshInstance()" /></template>
          <template v-else-if="app.mode === 'chat' && app.activeId === app.mainThread?.id" #header><ConversationBar /></template>
        </ChatColumn>
        <!-- inside one conversation, the files it produced float in a stack (Dock-style) -->
        <ArtifactStack v-if="ready && app.mode === 'chat' && app.convFilter && !mobileHome && !app.officeDoc" />
        <div v-if="newProject && !narrow" class="np serif">
          <Typewriter text="프로젝트는 장기적인 작업과 경험을 정리하기 위한 공간입니다." :cps="18" />
        </div>
        <div v-if="ready && mobileHome" class="mfoot">
          <Composer :placeholder="app.panelMode ? '만들 패널을 설명해 주세요' : 'process gpt에 메시지 보내기'" @send="sendFromHome" />
        </div>
      </div>
    </div>

    <Transition name="fade"><SettingsSheet v-if="settings && ready" /></Transition>
    <Transition name="fade"><SearchOverlay v-if="app.searchOpen" /></Transition>
    <HandoffView v-if="app.handoff" />
    <Transition name="fade"><OfficeSheet v-if="app.officeDoc" /></Transition>
    <MailConnect v-if="connecting" @close="connecting = false" />
  </div>
</template>

<style scoped>
.main { position: absolute; inset: 0; overflow: clip; }
.content { position: absolute; inset: 0; transition: filter .5s, opacity .5s, transform .5s; }
.content.away { filter: blur(20px); opacity: 0; transform: scale(.98); pointer-events: none; }
.center { position: absolute; top: 0; bottom: 0; left: 0; right: 0; transition: left .6s var(--spring); }
.center.shifted { left: 420px; }
.clock { position: absolute; left: 32px; bottom: 40px; font-size: 44px; line-height: 1.12; letter-spacing: -0.03em; font-weight: 500; color: var(--text-primary); z-index: 7; pointer-events: none; }
.mfoot { position: absolute; z-index: 6; left: 16px; right: 16px; bottom: 24px; }
.np { position: absolute; left: 50%; top: 40%; translate: -50% -50%; width: min(560px, 80%); font-size: clamp(26px, 3vw, 40px); line-height: 1.3; color: var(--text-primary); pointer-events: none; font-weight: 300; }
</style>
