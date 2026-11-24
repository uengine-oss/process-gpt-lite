<script setup>
import { onMounted, computed, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'
import SkyCanvas from './sky/SkyCanvas.vue'
import { useSky } from './stores/sky.js'
import { useApp } from './stores/app.js'
import { useTeam } from './stores/team.js'
import { newVersion, watchVersion } from './appVersion.js'

// On every page, loaded when first shown (not with the sign-in page):
// - the open document and a mail's sheet: opened from the team messenger, a meeting or a Home card, they showed only on the
//   chat pages before (a document clicked in the messenger on the process map opened nothing — 2026-11-24)
// - the team messenger, here rather than in each page's top bar: docked beside the page it stays put while one moves between
//   pages (in the bar it went away and came back with every page, and the page jumped to full width meanwhile)
const OfficeSheet = defineAsyncComponent(() => import('./components/OfficeSheet.vue'))
const MailReplySheet = defineAsyncComponent(() => import('./components/MailReplySheet.vue'))
const Messenger = defineAsyncComponent(() => import('./components/team/Messenger.vue'))

const app = useApp()
const team = useTeam()
const route = useRoute()
// pages with the top bar (its 메시지 button): not sign-in, onboarding, the workroom or settings
const teamHere = computed(() => !!route.matched.length && !route.meta.public && !route.meta.noTeam && !route.meta.settings)

const sky = useSky()
onMounted(() => { sky.init(); watchVersion() })
const reload = () => location.reload()
const later = () => { newVersion.value = false }
</script>

<template>
  <div class="stage">
    <SkyCanvas />
    <!-- the page: a docked team messenger takes a column from it (components/team/Messenger.vue, src/messengerDock.js) -->
    <div class="page">
      <RouterView v-slot="{ Component }">
        <Transition name="fade" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
      <Transition name="fade"><OfficeSheet v-if="app.officeDoc" /></Transition>
    </div>
    <!-- a mail's card, from Home or 팀 메시지 › 받은 편지함: the mail and its reply -->
    <MailReplySheet v-if="app.mailCard" :key="app.mailCard.id" :action="app.mailCard" @close="app.mailCard = null" />
    <Teleport to="body"><Transition name="fade"><Messenger v-if="team.open && teamHere" /></Transition></Teleport>
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
.page { position: absolute; inset: 0; }
.newver { position: fixed; z-index: 90; left: 50%; transform: translateX(-50%); top: calc(env(safe-area-inset-top, 0px) + 10px);
  display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); padding: 7px 8px 7px 16px; border-radius: 22px;
  background: #1d1d1f; color: #f5f5f7; font-size: 13.5px; box-shadow: 0 10px 30px rgba(0, 0, 0, .3); }
.newver .go { height: 30px; padding: 0 14px; border-radius: 15px; background: #7a5af5; color: #fff; font-size: 13px; flex: none; }
.newver .x { width: 28px; height: 28px; border-radius: 14px; color: #b8b8c0; flex: none; }
</style>
