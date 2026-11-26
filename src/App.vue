<script setup>
import { onMounted, computed, defineAsyncComponent, watch } from 'vue'
import { useRoute } from 'vue-router'
import SkyCanvas from './sky/SkyCanvas.vue'
import PhotoBackdrop from './sky/PhotoBackdrop.vue'
import { useSky } from './stores/sky.js'
import { useBackground } from './stores/background.js'
import { useApp } from './stores/app.js'
import { useTeam } from './stores/team.js'
import { newVersion, watchVersion } from './appVersion.js'
import { runner, startDesktopRunner } from './localRunner.js'

// On every page, loaded when first shown (not with the sign-in page):
// - the open document and a mail's sheet: opened from the team messenger, a meeting or a Home card, they showed only on the
//   chat pages before (a document clicked in the messenger on the process map opened nothing — 2026-11-24)
// - the team messenger, here rather than in each page's top bar: docked beside the page it stays put while one moves between
//   pages (in the bar it went away and came back with every page, and the page jumped to full width meanwhile)
const OfficeSheet = defineAsyncComponent(() => import('./components/OfficeSheet.vue'))
const MailReplySheet = defineAsyncComponent(() => import('./components/MailReplySheet.vue'))
const Messenger = defineAsyncComponent(() => import('./components/team/Messenger.vue'))
// a picture · sound · video opened from a conversation (artifacts.js viewMedia): over everything, the messenger included
const MediaViewer = defineAsyncComponent(() => import('./components/MediaViewer.vue'))

const app = useApp()
const team = useTeam()
const route = useRoute()
// pages with the top bar (its 메시지 button): not sign-in, onboarding, the workroom or settings
const teamHere = computed(() => !!route.matched.length && !route.meta.public && !route.meta.noTeam && !route.meta.settings)

const sky = useSky()
onMounted(() => { sky.init(); watchVersion() })
// the day's background photo this person chose (Home's date · weather panel), from GET /api/me; never on the sign-in pages
const bg = useBackground()
watch(() => app.me, (me) => { if (me && me.user?.id !== bg.owner) bg.init(me) }, { immediate: true })
// in the desktop app: this computer pairs for the signed-in person on whatever page opens first (the folders page too, not only the chat —
// src/localRunner.js); a browser has no bridge and nothing happens
watch(() => app.me?.user?.id, (id) => { if (id) startDesktopRunner(app.me).catch(() => {}) }, { immediate: true })
const photoHere = computed(() => !!app.me && !!route.matched.length && !route.meta.public)
// Home's dock and the chat's thread list share the left column: Home opened from anywhere (its button, a notification, a mail's
// sheet) puts the list away (and the list opened puts Home away: app.setThreadList)
watch(() => app.dockOpen, (open) => { if (open && app.threadList) app.setThreadList(false) })
const reload = () => location.reload()
const later = () => { newVersion.value = false }
</script>

<template>
  <div class="stage">
    <SkyCanvas />
    <PhotoBackdrop v-if="photoHere" />
    <!-- the page: a docked team messenger takes a column from it (components/team/Messenger.vue, src/messengerDock.js) -->
    <div class="page">
      <RouterView v-slot="{ Component }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
      <Transition name="fade"><OfficeSheet v-if="app.officeDoc" /></Transition>
    </div>
    <!-- the desktop app: a CLI agent of this computer is running one of this person's steps (src/localRunner.js) -->
    <button v-if="runner.status?.running?.length" class="localrun press" role="status" data-test="local-run-pill" :title="runner.status.running.map((r) => `${r.label} · ${r.activity}`).join('\n')"
      @click="runner.status.running[0]?.instId && $router.push(`/routines/${encodeURIComponent(runner.status.running[0].instId)}`)">
      <span class="dot" />로컬 에이전트 실행 중 · {{ [...new Set(runner.status.running.map((r) => r.label))].join(' · ') }}<template v-if="runner.status.running.length > 1"> ({{ runner.status.running.length }})</template>
    </button>
    <!-- a mail's card, from Home or 팀 메시지 › 받은 편지함: the mail and its reply -->
    <MailReplySheet v-if="app.mailCard" :key="app.mailCard.id" :action="app.mailCard" @close="app.mailCard = null" />
    <Teleport to="body"><Transition name="fade"><Messenger v-if="team.open && teamHere" /></Transition></Teleport>
    <MediaViewer v-if="app.media" />
    <!-- a newer build was deployed while this page stayed open: reload to get it (appVersion.js) -->
    <div v-if="newVersion" class="newver" role="status" data-test="new-version">
      <span>새 버전이 나왔어요. 새로 고침하면 바로 적용돼요.</span>
      <button class="go press" @click="reload">새로 고침</button>
      <button class="x press" aria-label="닫기" @click="later">✕</button>
    </div>
  </div>
</template>

<style scoped>
.stage { position: fixed; inset: 0; overflow: clip; }
.localrun { position: fixed; z-index: 89; right: 16px; bottom: calc(env(safe-area-inset-bottom, 0px) + 16px); display: flex; align-items: center; gap: 8px;
  max-width: calc(100vw - 32px); padding: 7px 14px; border-radius: 18px; background: #1d1d1f; color: #f5f5f7; font-size: 13px; box-shadow: 0 8px 24px rgba(0, 0, 0, .28);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.localrun .dot { width: 8px; height: 8px; border-radius: 4px; background: #34c759; flex: none; animation: pulse 1.6s ease-in-out infinite; }
.page { position: absolute; inset: 0; }
.newver { position: fixed; z-index: 90; left: 50%; transform: translateX(-50%); top: calc(env(safe-area-inset-top, 0px) + 10px);
  display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); padding: 7px 8px 7px 16px; border-radius: 22px;
  background: #1d1d1f; color: #f5f5f7; font-size: 13.5px; box-shadow: 0 10px 30px rgba(0, 0, 0, .3); }
.newver .go { height: 30px; padding: 0 14px; border-radius: 15px; background: #7a5af5; color: #fff; font-size: 13px; flex: none; }
.newver .x { width: 28px; height: 28px; border-radius: 14px; color: #b8b8c0; flex: none; }
</style>
