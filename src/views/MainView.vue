<script setup>
import { computed, onMounted, ref, watch, onBeforeUnmount, provide } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import HomeDock from '../components/HomeDock.vue'
import ProjectList from '../components/ProjectList.vue'
import RoutineList from '../components/RoutineList.vue'
import ThreadList from '../components/ThreadList.vue'
import ChatColumn from '../components/ChatColumn.vue'
import SearchOverlay from '../components/SearchOverlay.vue'
import HandoffView from '../components/HandoffView.vue'
import MailConnect from '../components/MailConnect.vue'
import SettingsSheet from '../components/SettingsSheet.vue'
import Typewriter from '../components/Typewriter.vue'
import InstanceHeader from '../components/InstanceHeader.vue'
import ConversationBar from '../components/ConversationBar.vue'
import ProjectFolderBar from '../components/folders/ProjectFolderBar.vue'
import ArtifactStack from '../components/ArtifactStack.vue'
import ArtifactList from '../components/ArtifactList.vue'
import Composer from '../components/Composer.vue'
import Icon from '../components/Icon.vue'
import { narrow, pageW, wideLayout } from '../viewport.js'
import { leftColumnPlace, fitsBeside, leftEdge, overWidth, OVER_X, LEFT_LABEL, LEFT_SHORT } from '../leftColumn.js'
import { instanceContext } from '../components/ontology/caseView.js'
import { artifactLayout, sideWidth, pilePlace } from '../artifactScope.js'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { useSky } from '../stores/sky.js'
import { useTeam } from '../stores/team.js'

const app = useApp()
const sky = useSky()
const route = useRoute()
const router = useRouter()
const ready = ref(false)
const connecting = ref(false)
// the page's width: the window's, less a column a docked team messenger takes (src/viewport.js)
const wide = wideLayout

const settings = computed(() => !!route.meta.settings)
// 프로젝트 and 루틴 (process instances, /routines) each keep their list in the left column
const listMode = computed(() => app.mode === 'project' || app.mode === 'routine')
// 채팅: Home's dock or the chat's thread list (double-click 「채팅」 — components/ThreadList.vue); the two share the column
const leftKind = computed(() => (!wide.value ? null : app.mode === 'project' ? 'projects' : app.mode === 'routine' ? 'routines'
  : app.dockOpen ? 'home' : app.threadListShown ? 'threads' : null))
// A document open beside the page (OfficeSheet: app.docSide) takes the page's right part, --craft-side-w wide — measured here off a
// hidden box of that width, so the width is the one CSS draws (it follows the window, a docked messenger's column, the panel dock).
// The left column stays beside the chat only where the page holds the column, the chat and the document; elsewhere the list is put
// away (a button beside Home lays it over the chat until a row is picked) and Home, when opened, lies over the chat (src/leftColumn.js
// — before, the chat recentred from the window's left edge, on top of the list: 2026-11-24 「프로젝트에서 산출물을 열어보면 이렇게
// 목록과 대화내용이 겹쳐진다」)
const probe = ref(null)
const docW = ref(0)
const sideDocW = computed(() => (app.docSide ? docW.value : 0))
const peek = ref(false)
const leftPlace = computed(() => leftColumnPlace({ kind: leftKind.value, pageW: pageW.value, docW: sideDocW.value, peek: peek.value }))
const leftOpen = computed(() => leftPlace.value === 'column')
const leftShown = computed(() => leftPlace.value === 'column' || leftPlace.value === 'over')
const leftOver = computed(() => leftPlace.value === 'over')
// the top bar's button for a folded list (Home has its own round button)
const foldBtn = computed(() => (leftPlace.value === 'folded' || leftPlace.value === 'over') && leftKind.value !== 'home')
const leftVars = computed(() => ({ '--left-edge': `${leftEdge(leftPlace.value)}px`, '--over-x': `${OVER_X}px`, '--over-w': `${overWidth({ pageW: pageW.value, docW: sideDocW.value })}px` }))
const fits = computed(() => fitsBeside({ pageW: pageW.value, docW: sideDocW.value }))
// the thread list asked for (double-click 「채팅」) while there is no room beside: shown at once, over the chat
watch(() => app.threadList, (open) => { if (open && !fits.value) peek.value = true })
// a row picked (the page changes), the document opened or closed, the room changed: folded again
watch([() => route.fullPath, () => app.docSide, fits], () => { peek.value = false })
// Esc or a click elsewhere puts the column over the chat away (Home: closed, as its round button would)
function closeOver() {
  if (leftKind.value === 'home') app.dockOpen = false
  else peek.value = false
}
function peekKey(e) { if (e.key === 'Escape' && leftOver.value) closeOver() }
function peekOutside(e) { if (leftOver.value && !e.target?.closest?.('.content > .over, .lbtn, .top .home')) closeOver() }
let probeObs
onMounted(() => {
  const measure = () => { docW.value = Math.round(probe.value?.getBoundingClientRect().width || 0) }
  probeObs = new ResizeObserver(measure)
  if (probe.value) probeObs.observe(probe.value)
  measure()
  window.addEventListener('keydown', peekKey)
  window.addEventListener('pointerdown', peekOutside, true)
})
onBeforeUnmount(() => {
  probeObs?.disconnect()
  window.removeEventListener('keydown', peekKey)
  window.removeEventListener('pointerdown', peekOutside, true)
})
const dockShown = computed(() => app.mode === 'chat' && app.dockOpen && wide.value && leftShown.value)
// the thread list: the column beside the chat, or narrower (a phone) a page of its own over the chat, like the project list
const threadsShown = computed(() => ready.value && app.threadListShown)
const threadSheet = computed(() => threadsShown.value && !wide.value)
// The files this view made (the whole chat, a conversation of it, a project's room — src/artifactScope.js): a list in the right column
// where the page has room beside the chat (the chat moves over for it), its rail when folded, else the Dock-style pile by the composer;
// nothing while a document is open (the document wins — the list is back when it closes)
const artLayout = computed(() => (!ready.value || mobileHome.value || threadSheet.value || settings.value ? 'none'
  : artifactLayout({ pageW: pageW.value, leftW: leftOpen.value ? 420 : 0, wide: wide.value, docOpen: !!app.officeDoc, folded: app.artifactsFolded, count: app.artifacts.items.length })))
const artW = computed(() => sideWidth(artLayout.value))
const pileAt = (foot) => pilePlace({ gutter: foot.gutter, footTop: foot.top, small: narrow.value })
// the clock in the bottom-left corner (Home closed): only where the chat, moved over for the files' column, leaves it room
const clockFits = computed(() => (pageW.value - artW.value - 512) / 2 >= 240)
// the bar's tabs over the chat column: between the left column and the files' column when they leave the tabs room beside the bar's
// buttons (a window under ~1360px with only the left column: they overlapped)
const chatCenter = computed(() => {
  const L = leftOpen.value ? 420 : 0
  if (!artW.value) return L && pageW.value >= 1360 ? 'calc(420px + (100% - 420px) / 2)' : '50%'
  const c = L + (pageW.value - L - artW.value) / 2
  return c - 200 >= 72 && c + 200 <= pageW.value - 300 ? `${Math.round(c)}px` : '50%'
})
// Phone: Home is a full-width tab with the composer under it; Projects and Routines show their list first.
const mobileHome = computed(() => narrow.value && app.mode === 'chat' && app.dockOpen)
// 새 프로젝트 just sent: its room is being made, and the chat with the message shows meanwhile
const drafting = computed(() => !!app.draftProject && app.activeId === app.draftProject.tmp)
const mobileList = computed(() => narrow.value && listMode.value && !route.params.id && !route.params.instId && !drafting.value)
// the chat stays the same one from 새 프로젝트 through the room being made to the room: nothing blinks
// (gen: leaving that room for a fresh 새 프로젝트 gives a fresh chat)
const gen = ref(0)
const colKey = computed(() => (app.draftProject && [app.draftProject.tmp, app.draftProject.id].includes(app.activeId) ? `new-${gen.value}` : app.activeId || `new-${gen.value}`))
function sendFromHome(text, o) {
  if (!app.panelMode) app.dockOpen = false
  onSend(text, o)
}
const newProject = computed(() => app.mode === 'project' && !route.params.id)
const instMode = computed(() => !!route.params.instId)
// /routines with none picked (wide screen): a line about what a routine is beside the list
const noRoutine = computed(() => app.mode === 'routine' && !route.params.instId)
let poll

const clock = computed(() => {
  const d = sky.clock
  return {
    day: d.toLocaleDateString('ko-KR', { weekday: 'short' }),
    date: d.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' }),
    time: d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' }),
  }
})

// an instance page while its data comes: nothing of the conversation before it (2026-11-21: Home's card
// showed the main chat under 「이 프로세스에 대해 물어보기」 first, and stayed there when the load was slow)
const instLoading = ref(false)
const instError = ref('')
let routeSeq = 0
async function syncRoute() {
  const seq = ++routeSeq
  app.mode = route.meta.mode || 'chat'
  // 새 패널 만들기 belongs to 채팅: leaving it (a project, an instance) drops the mode
  if (app.mode !== 'chat') app.panelMode = false
  if (!ready.value) return
  clearInterval(poll)
  if (!route.params.instId) app.instance = null
  instError.value = ''
  instLoading.value = false
  app.convFilter = app.mode === 'chat' && route.params.cid ? decodeURIComponent(route.params.cid) : null
  if (app.draftProject && route.params.id !== app.draftProject.id) { app.draftProject = null; gen.value++ }
  if (app.mode === 'chat') app.activeId = app.mainThread.id
  else if (route.params.instId) {
    const id = String(route.params.instId)
    if (app.instance?.inst?.proc_inst_id !== id) { app.instance = null; app.activeId = null }
    instLoading.value = !app.instance
    try {
      await app.openInstance(id, () => seq === routeSeq)
    } catch (e) {
      if (seq === routeSeq) instError.value = e.message || '루틴을 열지 못했어요'
    } finally {
      if (seq === routeSeq) instLoading.value = false
    }
    if (seq !== routeSeq) return
    // (a case run from the company's process map — 지도에서 바로 — opens here too: its page draws the case's BPMN in place of a
    // definition's, InstanceHeader; the map is a link from there — 2026-11-24, the map's own drawing does not read as a flowchart)
    // agents advance instances in the background; keep the timeline fresh while it runs
    poll = setInterval(() => app.instance?.inst.status === 'RUNNING' && app.refreshInstance(), 5000)
  } else if (route.params.id) await app.open(route.params.id)
  else app.activeId = null
}
// 닫기 on an instance page: back where it was opened from (Home, a chat card, the list), else the list
function closeInstance() {
  if (window.history.state?.back) router.back()
  else router.push('/routines')
}
watch(() => route.fullPath, syncRoute)
provide('closeInstance', closeInstance)

// a browser notification clicked (src/browserNotify.js): the room, the instance page or the card's own place
const team = useTeam()
function openNotification({ detail: n }) {
  const room = /^\/chats\?id=([\w.:-]+)/.exec(String(n?.url || ''))
  const msg = /^\/pro\/team\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(String(n?.url || ''))
  if (msg) return team.openMessenger(msg[1], msg[2])
  if (room) return team.openMessenger(room[1])
  if (n?.type === 'workitem' && n.instId) return router.push(`/routines/${encodeURIComponent(n.instId)}`)
  if (/^\/(projects|routines|settings)\//.test(String(n?.url || ''))) return router.push(n.url)
  app.dockOpen = true
}
onMounted(async () => {
  window.addEventListener('pgl:open-notification', openNotification)
  // opened by a notification while the app was closed (public/sw.js: …/chat?notify=<the card>)
  if (route.query.notify) {
    try { const n = JSON.parse(String(route.query.notify)); router.replace({ query: {} }); setTimeout(() => openNotification({ detail: n }), 300) } catch { /* not ours */ }
  }
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
onBeforeUnmount(() => { window.removeEventListener('pgl:open-notification', openNotification); clearInterval(poll) })

// o.refs: files dragged onto the composer for this message (Composer.vue submit — server lib/fileRefs.js)
async function onSend(text, o = {}) {
  if (app.panelMode) return app.createPanel(text)
  app.notice = null
  const refs = o?.refs || []
  // a second message while the room is still being made: shown now, to that room once it exists
  if (drafting.value) return app.queueDraft(text, refs)
  if (newProject.value && !app.activeId) {
    // the message and "생각하는 중" are on screen at once; the address follows when the room exists
    const id = await app.newProject(text, refs)
    if (id && app.activeId === id && newProject.value) router.replace(`/projects/${id}`)
    return
  }
  // (the instance is still loading or failed: nothing to send it to yet)
  if (instMode.value && !app.instance) return
  if (instMode.value && app.instance) {
    // questions on an instance page carry its state so the agent can answer about it
    return app.send(text, app.activeId, instanceContext(app.instance), undefined, { refs })
  }
  app.send(text, undefined, undefined, undefined, { refs })
}
function onConnect() {
  connecting.value = true
}
</script>

<template>
  <!-- the bar's tabs sit over the chat column — over the page's middle when the page is too narrow for that beside the bar's
       buttons (a window under ~1360px, or a page beside a docked messenger: they overlapped) -->
  <div class="main" :style="{ '--chat-center': chatCenter, '--art-w': `${artW}px`, ...leftVars }">
    <!-- the width of a document open beside the page (--craft-side-w, components/OfficeSheet.vue), measured for the left column -->
    <div ref="probe" class="doc-probe" aria-hidden="true" />
    <Transition name="fade"><TopBar v-if="!settings" /></Transition>
    <!-- a list put away beside a document (no room for it, the chat and the document side by side): in the top bar beside Home, the
         button that lays it over the chat (the phone's ≡ is the same list) -->
    <Transition name="fade">
      <button v-if="ready && !settings && foldBtn" class="lbtn press" :class="{ on: leftOver }" :aria-label="`${LEFT_LABEL[leftKind]} ${leftOver ? '접기' : '펼치기'}`"
        :aria-expanded="leftOver ? 'true' : 'false'" :title="leftOver ? `${LEFT_LABEL[leftKind]} 접기` : `${LEFT_LABEL[leftKind]} 펼치기 · 문서를 보는 동안 접어 두었어요`"
        data-testid="left-fold" @click="peek = !peek">
        <Icon name="list" :size="18" /><span>{{ LEFT_SHORT[leftKind] }}</span>
      </button>
    </Transition>

    <div class="content" :class="{ away: settings }">
      <!-- the left column (.over: laid over the chat while a document leaves it no room beside — src/leftColumn.js) -->
      <Transition name="fade">
        <HomeDock v-if="ready && (dockShown || mobileHome)" :class="{ mobile: narrow, over: leftOver && !narrow }" />
      </Transition>
      <Transition name="fade">
        <ThreadList v-if="threadsShown && (threadSheet || leftShown)" :sheet="threadSheet" :class="{ over: leftOver && !threadSheet }" />
      </Transition>
      <Transition name="fade">
        <ProjectList v-if="ready && app.mode === 'project' && ((wide && leftShown) || mobileList)" :class="{ mobile: narrow, over: leftOver && !narrow }" />
      </Transition>
      <Transition name="fade">
        <RoutineList v-if="ready && app.mode === 'routine' && ((wide && leftShown) || mobileList)" :class="{ mobile: narrow, over: leftOver && !narrow }" />
      </Transition>
      <Transition name="fade">
        <div v-if="app.mode === 'chat' && !app.dockOpen && !threadsShown && !narrow && !app.docSide && clockFits" class="clock">
          <div>{{ clock.day }}</div><div>{{ clock.date }}</div><div>{{ clock.time }}</div>
        </div>
      </Transition>

      <Transition name="fade">
        <ArtifactList v-if="artW" :rail="artLayout === 'rail'" />
      </Transition>

      <div class="center" :class="{ rside: artW > 0, doc: app.docSide }">
        <ChatColumn v-if="ready && !mobileHome && !threadSheet && (app.activeId || newProject)" :key="colKey"
          :placeholder="newProject && !app.activeId ? '새 프로젝트에서 할 일을 적어 주세요' : instMode ? '이 프로세스에 대해 물어보기' : app.convFilter ? '이 대화에 이어서 묻기' : 'process gpt에 메시지 보내기'"
          :empty-text="newProject ? '' : ''" :keep-top="instMode" @send="onSend" @connect="onConnect">
          <template v-if="instMode && app.instance" #header><InstanceHeader :data="app.instance" @refresh="app.refreshInstance()" /></template>
          <template v-else-if="app.mode === 'chat' && app.activeId === app.mainThread?.id" #header><ConversationBar /></template>
          <template v-else-if="app.mode === 'project' && app.active?.folder?.mode === 'project'" #header><ProjectFolderBar :thread="app.active" /></template>
          <!-- the files this view made, in a Dock-style pile beside (or above) the composer where there is no room for the list -->
          <template v-if="artLayout === 'pile'" #aside="{ foot }"><ArtifactStack :place="pileAt(foot)" /></template>
        </ChatColumn>
        <div v-if="newProject && !app.activeId && !narrow" class="np serif">
          <Typewriter text="프로젝트는 장기적인 작업과 경험을 정리하기 위한 공간입니다." :cps="18" />
        </div>
        <div v-if="ready && instMode && !app.instance && (instLoading || instError)" class="iload" data-test="instance-loading">
          <template v-if="instError">
            <p>{{ instError }}</p>
            <div class="ibtns">
              <button class="pill-btn" @click="syncRoute">다시 시도</button>
              <button class="pill-btn" @click="closeInstance">닫기</button>
            </div>
          </template>
          <p v-else class="shimmer-text">루틴 여는 중…</p>
        </div>
        <div v-if="ready && noRoutine && !narrow" class="np serif">
          <Typewriter text="루틴은 정해진 절차를 따라 진행되는 일입니다." :cps="18" />
        </div>
        <div v-if="ready && mobileHome" class="mfoot">
          <Composer :placeholder="app.panelMode ? '만들 패널을 설명해 주세요' : 'process gpt에 메시지 보내기'" @send="sendFromHome" />
        </div>
      </div>
    </div>

    <Transition name="fade"><SettingsSheet v-if="settings && ready" /></Transition>
    <Transition name="fade"><SearchOverlay v-if="app.searchOpen" /></Transition>
    <HandoffView v-if="app.handoff" />
    <!-- the open document (OfficeSheet) and a mail's sheet (MailReplySheet) are on every page: App.vue -->
    <MailConnect v-if="connecting" @close="connecting = false" />
  </div>
</template>

<style scoped>
.main { position: absolute; inset: 0; overflow: clip; }
.content { position: absolute; inset: 0; transition: filter .5s, opacity .5s, transform .5s; }
.content.away { filter: blur(20px); opacity: 0; transform: scale(.98); pointer-events: none; }
/* the chat between the left column (none while it is put away beside a document — --left-edge, src/leftColumn.js) and the right side */
.center { position: absolute; top: 0; bottom: 0; left: var(--left-edge, 0px); right: 0; transition: left .6s var(--spring), right .4s var(--spring); }
/* the files' column at the right (ArtifactList): the chat recentres in what is left */
.center.rside { right: var(--art-w); }
/* a document (or an ArtCraft app) open beside the page (OfficeSheet .side): the chat recentres left of it */
.center.doc { right: var(--craft-side-w); }
.doc-probe { position: absolute; left: 0; top: 0; height: 0; width: var(--craft-side-w); visibility: hidden; pointer-events: none; }
/* a list put away beside a document: its button in the top bar, right of Home's round button (TopBar .home: 16px in, 48px, 10px down),
   and the column laid over the chat from the left edge to the document's room, on a panel of its own */
.lbtn { position: absolute; z-index: 21; top: 10px; left: 72px; height: 48px; padding: 0 16px 0 14px; border-radius: 9999px; display: inline-flex; align-items: center; gap: 7px;
  font-size: 15px; font-weight: 500; color: var(--text-primary); background: var(--button-bg); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  transition: background-color .25s, color .25s, scale .12s ease-out; }
.lbtn.on { background: #1d1d1f; color: #f5f5f7; }
:root[data-theme="dark"] .lbtn.on { background: #f5f5f7; color: #1d1d1f; }
.content > .over { z-index: 8; top: 76px; bottom: 16px; left: var(--over-x); width: var(--over-w); padding: 18px 22px; border-radius: 24px; overflow-y: auto;
  background: var(--thin-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: 0 18px 60px rgba(0, 0, 0, .22);
  -webkit-mask-image: none; mask-image: none; }
.clock { position: absolute; left: 32px; bottom: 40px; font-size: 44px; line-height: 1.12; letter-spacing: -0.03em; font-weight: 500; color: var(--text-primary); z-index: 7; pointer-events: none; }
.mfoot { position: absolute; z-index: 6; left: 16px; right: 16px; bottom: 24px; }
.iload { position: absolute; left: 50%; top: 42%; translate: -50% -50%; width: min(420px, calc(100% - 32px)); text-align: center; font-size: 17px; color: var(--text-secondary); }
.iload .ibtns { display: flex; gap: 10px; justify-content: center; margin-top: 14px; }
.np { position: absolute; left: 50%; top: 40%; translate: -50% -50%; width: min(560px, 80%); font-size: clamp(26px, 3vw, 40px); line-height: 1.3; color: var(--text-primary); pointer-events: none; font-weight: 300; word-break: keep-all; }
</style>
