<script setup>
import { ref, computed, watch, nextTick, onMounted, inject } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Icon from './Icon.vue'
import TeamLayer from './team/TeamLayer.vue'
import { useTeam } from '../stores/team.js'
import { useApp } from '../stores/app.js'
import { narrow } from '../viewport.js'

const app = useApp()
const team = useTeam()
const router = useRouter()
const route = useRoute()
const initial = () => (app.me?.user?.name || '?').slice(0, 1)
// MainView's: back where the instance was opened from (history), else the routine list
const closeInstance = inject('closeInstance', null)
const close = () => (closeInstance ? closeInstance() : router.push('/routines'))

// On a phone Home is a tab of its own (hark's 홈 / 채팅 / 프로젝트); on a wide screen it is the
// dock beside the chat, toggled by the round button.
// 루틴 (process instances, /routines) is a tab of its own, apart from 프로젝트; 개선 분석 is opened from it
const tab = computed(() => (route.path.startsWith('/folders') ? 'folders'
  : app.mode === 'routine' || route.path.startsWith('/routines') || route.path.startsWith('/improve') ? 'routine'
  : app.mode === 'project' ? 'project' : narrow.value && app.dockOpen ? 'home' : 'chat'))
const tabs = computed(() => [...(narrow.value ? [{ id: 'home', label: '홈' }] : []), { id: 'chat', label: '채팅' }, { id: 'project', label: '프로젝트' }, { id: 'routine', label: '루틴' }, { id: 'folders', label: '폴더' }])
function go(id) {
  if (id === 'project') return router.push('/projects')
  if (id === 'routine') return router.push('/routines')
  if (id === 'folders') return router.push('/folders')
  if (narrow.value) app.dockOpen = id === 'home'
  router.push('/chat')
}

const seg = ref(null)
const thumb = ref({})
// phone: the pill scrolls sideways when its tabs do not fit (2026-11-18 design rule: a full pill nav
// scrolls, the last tab half shown, rather than squeezing the labels); the chosen tab is brought to the middle
const more = ref({ left: false, right: false })
function edges() {
  const el = seg.value
  if (!el) return
  more.value = { left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 }
}
async function place() {
  await nextTick()
  const el = seg.value?.querySelector(`[data-tab="${tab.value}"]`)
  if (el) thumb.value = { left: `${el.offsetLeft}px`, width: `${el.offsetWidth}px` }
  if (el && narrow.value && seg.value) seg.value.scrollTo({ left: Math.max(0, el.offsetLeft - (seg.value.clientWidth - el.offsetWidth) / 2), behavior: 'smooth' })
  edges()
}
onMounted(place)
watch([tab, narrow], place)
</script>

<template>
  <header class="top" :class="{ narrow }">
    <!-- phone: inside a project (a routine) the left button is hark's ≡ back to the project (routine) list -->
    <button v-if="narrow && app.mode === 'project' && route.params.id" class="home press" aria-label="프로젝트 목록" @click="router.push('/projects')">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h11M4 17h7" /></svg>
    </button>
    <!-- a routine (one instance) opened from Home, a chat card or the list: ‹ closes it, back to where it was
         opened (2026-11-21: with 홈 scrolled out of the pill there was no way back but guessing a tab) -->
    <button v-else-if="narrow && app.mode === 'routine' && route.params.instId" class="home press" aria-label="닫기" data-test="instance-close" @click="close">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <button v-else-if="narrow" class="home press" aria-label="페이지와 메일 검색" @click="app.searchOpen = true">
      <Icon name="search" :size="22" />
    </button>
    <button v-else class="home press" :class="{ on: app.dockOpen && app.mode === 'chat' }" :aria-label="app.dockOpen ? 'Home 접기' : 'Home 펼치기'"
      @click="app.mode === 'chat' ? (app.dockOpen = !app.dockOpen) : router.push('/chat')">
      <Icon name="home" :size="22" />
    </button>

    <nav ref="seg" class="seg glass-thin" :class="{ 'more-l': narrow && more.left, 'more-r': narrow && more.right }" @scroll.passive="edges">
      <span class="thumb" :style="thumb" />
      <button v-for="t in tabs" :key="t.id" :data-tab="t.id" :class="{ on: tab === t.id }" @click="go(t.id)">{{ t.label }}<i v-if="t.id === 'home' && team.unread.total" class="tdot" /></button>
    </nav>

    <div class="right">
      <!-- team messenger: unread badge, inbox, shares (components/team) -->
      <TeamLayer :narrow="narrow" :button="!narrow" />
      <button v-if="!narrow" class="pill-btn" aria-label="페이지와 메일 검색" @click="app.searchOpen = true">검색</button>
      <button class="avatar press" aria-label="설정" @click="router.push(route.path.startsWith('/settings') ? '/chat' : '/settings')">{{ initial() }}</button>
    </div>
  </header>
</template>

<style scoped>
.top { position: absolute; z-index: 20; top: 0; left: 0; right: 0; height: 68px; display: flex; align-items: center; padding: 0 16px; pointer-events: none; }
.top > * { pointer-events: auto; }
.home { width: 48px; height: 48px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-primary);
  background: var(--button-bg); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); transition: background-color .25s, color .25s, scale .12s ease-out; }
.home.on { background: #1d1d1f; color: #f5f5f7; }
:root[data-theme="dark"] .home.on { background: #f5f5f7; color: #1d1d1f; }
.seg { position: absolute; left: calc(var(--chat-center, 50%)); translate: -50% 0; top: 10px; display: flex; padding: 2px; border-radius: 9999px; }
.seg button { position: relative; z-index: 1; height: 44px; padding: 0 20px; border-radius: 9999px; font-size: 15px; font-weight: 500;
  color: var(--text-secondary); transition: color .3s; white-space: nowrap; }
/* phone: the pill sits between the two round buttons (16px edge + 48px button + 8px gap each side) and,
   when its tabs do not fit, scrolls sideways — tabs keep their size, the side with more is faded so the
   cut tab says "slide" (pill navigation on a phone, 2026-11-18; not squeezed labels) */
.narrow .seg { left: 72px; right: 72px; translate: none; overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
  overscroll-behavior-x: contain; scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch; }
.narrow .seg::-webkit-scrollbar { display: none; }
.narrow .seg button { flex: none; padding: 0 16px; scroll-snap-align: center; }
.narrow .seg.more-r { -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent); mask-image: linear-gradient(to right, #000 calc(100% - 30px), transparent); }
.narrow .seg.more-l { -webkit-mask-image: linear-gradient(to left, #000 calc(100% - 30px), transparent); mask-image: linear-gradient(to left, #000 calc(100% - 30px), transparent); }
.narrow .seg.more-l.more-r { -webkit-mask-image: linear-gradient(to right, transparent, #000 30px, #000 calc(100% - 30px), transparent); mask-image: linear-gradient(to right, transparent, #000 30px, #000 calc(100% - 30px), transparent); }
.seg button.on { color: var(--text-primary-on); }
.tdot { position: absolute; top: 8px; right: 7px; width: 8px; height: 8px; border-radius: 4px; background: #e5484d; }
.thumb { position: absolute; top: 2px; bottom: 2px; border-radius: 9999px; background: var(--ink); transition: left .45s var(--spring), width .45s var(--spring); }
.right { margin-left: auto; display: flex; gap: 10px; align-items: center; }
.avatar { width: 48px; height: 48px; border-radius: 9999px; background: linear-gradient(135deg, #8aa6d8, #4a5f9a); color: #fff; font-weight: 600; font-size: 18px; }
</style>
