<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Wordmark from '../components/Wordmark.vue'
import { api } from '../api.js'

const router = useRouter()
const now = new Date().getFullYear()
const years = Array.from({ length: 90 }, (_, i) => now - 14 - i)
const y = ref(''), m = ref(''), d = ref('')
const days = computed(() => (y.value && m.value ? new Date(y.value, m.value, 0).getDate() : 31))
const ok = computed(() => y.value && m.value && d.value)

onMounted(async () => {
  const me = await api('/me')
  if (me.profile?.onboarded_at) router.replace('/chat')
})

async function next() {
  await api('/profile', { method: 'POST', body: { birth: `${y.value}-${String(m.value).padStart(2, '0')}-${String(d.value).padStart(2, '0')}` } })
  router.push('/welcome/intro')
}
</script>

<template>
  <div class="age">
    <div class="card blur-in">
      <Wordmark :size="40" />
      <h2>생년월일이 언제인가요?</h2>
      <p>이 정보는 연령에 맞는 서비스 제공을 위해 확인하는 것이며, 다른 사람에게 공개되지 않아요.</p>
      <div class="row">
        <select v-model="y" class="sel"><option value="" disabled>연도</option><option v-for="v in years" :key="v" :value="v">{{ v }}</option></select>
        <select v-model="m" class="sel"><option value="" disabled>월</option><option v-for="v in 12" :key="v" :value="v">{{ v }}월</option></select>
        <select v-model="d" class="sel"><option value="" disabled>일</option><option v-for="v in days" :key="v" :value="v">{{ v }}</option></select>
      </div>
      <button class="dark-btn wide" :disabled="!ok" @click="next">계속</button>
    </div>
  </div>
</template>

<style scoped>
.age { position: absolute; inset: 0; display: grid; place-items: center; }
.card { width: min(400px, 92vw); display: flex; flex-direction: column; align-items: center; text-align: center; }
h2 { font-size: 20px; font-weight: 600; margin: 36px 0 8px; }
p { font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin: 0 0 24px; }
.row { display: grid; grid-template-columns: 1.3fr 1fr 1fr; gap: 8px; width: 100%; margin-bottom: 16px; }
.sel { height: 48px; border-radius: 9999px; border: 0; padding: 0 16px; outline: 0; appearance: none; text-align: center;
  background: var(--thin-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); color: var(--text-primary); font-size: 15px; }
.wide { width: 100%; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
</style>
