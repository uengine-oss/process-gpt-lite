<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { narrow } from '../viewport.js'

const app = useApp()
const router = useRouter()
const route = useRoute()
const initial = () => (app.me?.user?.name || '?').slice(0, 1)

// On a phone Home is a tab of its own (hark's 홈 / 채팅 / 프로젝트); on a wide screen it is the
// dock beside the chat, toggled by the round button.
const tab = computed(() => (route.path.startsWith('/folders') ? 'folders' : app.mode === 'project' ? 'project' : narrow.value && app.dockOpen ? 'home' : 'chat'))
const tabs = computed(() => [...(narrow.value ? [{ id: 'home', label: '홈' }] : []), { id: 'chat', label: '채팅' }, { id: 'project', label: '프로젝트' }, { id: 'folders', label: '폴더' }])
function go(id) {
  if (id === 'project') return router.push('/projects')
  if (id === 'folders') return router.push('/folders')
  if (narrow.value) app.dockOpen = id === 'home'
  router.push('/chat')
}

const seg = ref(null)
const thumb = ref({})
async function place() {
  await nextTick()
  const el = seg.value?.querySelector(`[data-tab="${tab.value}"]`)
  if (el) thumb.value = { left: `${el.offsetLeft}px`, width: `${el.offsetWidth}px` }
}
onMounted(place)
watch([tab, narrow], place)
</script>

<template>
  <header class="top" :class="{ narrow }">
    <!-- phone: inside a project the left button is hark's ≡ back to the project list -->
    <button v-if="narrow && app.mode === 'project' && (route.params.id || route.params.instId)" class="home press" aria-label="프로젝트 목록" @click="router.push('/projects')">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h11M4 17h7" /></svg>
    </button>
    <button v-else-if="narrow" class="home press" aria-label="페이지와 메일 검색" @click="app.searchOpen = true">
      <Icon name="search" :size="22" />
    </button>
    <button v-else class="home press" :class="{ on: app.dockOpen && app.mode === 'chat' }" :aria-label="app.dockOpen ? 'Home 접기' : 'Home 펼치기'"
      @click="app.mode === 'chat' ? (app.dockOpen = !app.dockOpen) : router.push('/chat')">
      <Icon name="home" :size="22" />
    </button>

    <nav ref="seg" class="seg glass-thin">
      <span class="thumb" :style="thumb" />
      <button v-for="t in tabs" :key="t.id" :data-tab="t.id" :class="{ on: tab === t.id }" @click="go(t.id)">{{ t.label }}</button>
    </nav>

    <div class="right">
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
.narrow .seg { left: 50%; }
.seg button { position: relative; z-index: 1; height: 44px; padding: 0 20px; border-radius: 9999px; font-size: 15px; font-weight: 500;
  color: var(--text-secondary); transition: color .3s; white-space: nowrap; }
.narrow .seg button { padding: 0 16px; }
.seg button.on { color: var(--text-primary-on); }
.thumb { position: absolute; top: 2px; bottom: 2px; border-radius: 9999px; background: var(--ink); transition: left .45s var(--spring), width .45s var(--spring); }
.right { margin-left: auto; display: flex; gap: 10px; align-items: center; }
.avatar { width: 48px; height: 48px; border-radius: 9999px; background: linear-gradient(135deg, #8aa6d8, #4a5f9a); color: #fff; font-weight: 600; font-size: 18px; }
</style>
