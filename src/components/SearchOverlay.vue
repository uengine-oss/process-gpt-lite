<script setup>
import { ref, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'

const app = useApp()
const router = useRouter()
const qv = ref('')
const res = ref([])
const input = ref(null)
let t
watch(qv, (v) => {
  clearTimeout(t)
  t = setTimeout(async () => { res.value = v.trim() ? await api(`/search?q=${encodeURIComponent(v)}`) : [] }, 200)
})
onMounted(() => input.value?.focus())
function go(r) {
  app.searchOpen = false
  router.push(r.kind === 'project' ? `/projects/${r.thread_id}` : '/chat')
}
</script>

<template>
  <div class="search" @click.self="app.searchOpen = false" @keydown.esc="app.searchOpen = false">
    <div class="box glass">
      <Icon name="search" :size="22" />
      <input ref="input" v-model="qv" placeholder="검색" />
    </div>
    <ul v-if="res.length" class="res glass">
      <li v-for="r in res" :key="r.id" @click="go(r)">
        <small>{{ r.kind === 'project' ? r.title : '채팅' }} · {{ new Date(r.created_at).toLocaleDateString('ko-KR') }}</small>
        <span>{{ r.text }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.search { position: absolute; inset: 0; z-index: 40; display: flex; flex-direction: column; align-items: center; padding-top: 22vh;
  -webkit-backdrop-filter: blur(40px) saturate(1.1); backdrop-filter: blur(40px) saturate(1.1); background: rgba(255 255 255 / .06); animation: fade-in .35s both; }
.box { width: min(600px, 90vw); height: 48px; border-radius: 9999px; display: flex; align-items: center; gap: 10px; padding: 0 20px; box-shadow: var(--shadow-card); animation: pop-in .4s var(--spring) both; }
.box input { flex: 1; border: 0; outline: 0; background: transparent; font-size: 17px; }
.res { list-style: none; margin: 14px 0 0; padding: 8px; width: min(600px, 90vw); max-height: 50vh; overflow: auto; border-radius: 24px; animation: blur-in .3s both; }
.res li { padding: 10px 14px; border-radius: 14px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
.res li:hover { background: var(--cell-bg); }
.res small { color: var(--text-secondary); font-size: 12px; }
.res span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: 15px; }
</style>
