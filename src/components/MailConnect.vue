<script setup>
import { ref, onMounted } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

const emit = defineEmits(['close'])
const cfg = ref({ google: false })
const mode = ref('pick')
const host = ref('imap.gmail.com')
const username = ref('')
const password = ref('')
const busy = ref(false)
onMounted(async () => { cfg.value = await (await fetch('/api/config')).json() })
const google = () => { window.location.href = '/api/auth/google/start?mail=1' }

async function connect(provider) {
  busy.value = true
  try {
    await api('/mail/connect', { method: 'POST', body: { provider, host: host.value, username: username.value, password: password.value } })
    emit('close')
  } finally { busy.value = false }
}
</script>

<template>
  <div class="sheet-bg" @click.self="emit('close')">
    <div class="sheet glass">
      <div class="h"><span>메일 연결</span><button aria-label="닫기" @click="emit('close')"><Icon name="close" :size="18" /></button></div>
      <template v-if="mode === 'pick'">
        <button class="opt press" :disabled="!cfg.google" @click="google">
          <b>Google 계정</b><small>{{ cfg.google ? 'Gmail · 캘린더 읽기 권한으로 연결' : '서버에 GOOGLE_CLIENT_ID/SECRET 설정이 필요해요' }}</small>
        </button>
        <button class="opt press" @click="mode = 'imap'"><b>IMAP</b><small>앱 비밀번호로 연결 (Gmail·Naver·사내 메일)</small></button>
        <button class="opt press" :disabled="busy" @click="connect('demo')"><b>데모 메일함</b><small>가상의 거래처 메일 5통으로 흐름을 체험해요</small></button>
      </template>
      <form v-else class="form" @submit.prevent="connect('imap')">
        <input v-model="host" placeholder="IMAP 서버 (예: imap.gmail.com)" />
        <input v-model="username" placeholder="메일 주소" autocomplete="username" />
        <input v-model="password" type="password" placeholder="앱 비밀번호" autocomplete="current-password" />
        <button class="dark-btn" :disabled="busy || !username || !password">연결</button>
        <p class="by"><Icon name="lock" :size="14" /> 비밀번호는 암호화된 보관함에만 저장돼요.</p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.sheet-bg { position: absolute; inset: 0; z-index: 45; display: grid; place-items: center; background: rgba(0 0 0 / .12); animation: fade-in .3s both; }
.sheet { width: min(420px, 92vw); border-radius: 28px; padding: 18px; display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow-card); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.h { display: flex; justify-content: space-between; align-items: center; font-size: 17px; font-weight: 500; margin: 0 4px 6px; }
.opt { text-align: left; padding: 14px 16px; border-radius: 18px; background: var(--cell-bg); display: flex; flex-direction: column; gap: 2px; }
.opt:hover:not(:disabled) { background: var(--button-bg); }
.opt:disabled { opacity: .45; cursor: default; }
.opt small { color: var(--text-secondary); font-size: 13px; }
.form { display: flex; flex-direction: column; gap: 8px; }
.form input { height: 44px; border-radius: 9999px; border: 0; outline: 0; padding: 0 16px; background: var(--cell-bg); }
.by { display: flex; gap: 6px; align-items: center; justify-content: center; font-size: 13px; color: var(--text-secondary); margin: 4px 0 0; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
</style>
