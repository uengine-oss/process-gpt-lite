<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { api } from '../api.js'
import { BASE } from '../base.js'
import { useApp } from '../stores/app.js'
import { connectInBrowser, connectOnPhone } from '../googleConnect.js'

const emit = defineEmits(['close'])
const app = useApp()
const router = useRouter()
const cfg = ref({ google: false })
const mode = ref('pick')
const host = ref('imap.gmail.com')
const username = ref('')
const password = ref('')
const busy = ref(false)
const err = ref('')
onMounted(async () => { cfg.value = await (await fetch(BASE + '/api/config')).json() })
// Google: in the server browser (one sign-in for the mail and for Google sites there), else on this device
async function google(where) {
  busy.value = true
  err.value = ''
  try {
    if (where === 'phone') return await connectOnPhone()
    await connectInBrowser(app, router)
    emit('close')
  } catch (e) { err.value = e.message } finally { busy.value = false }
}

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
        <button class="opt press" :disabled="!cfg.google || busy" data-testid="mail-google" @click="google('browser')">
          <b>Google 계정</b><small>{{ cfg.google ? '서버 브라우저에서 Google에 로그인해 연결해요. NotebookLM 같은 Google 사이트도 함께 로그인돼요' : '회사 관리자가 설정 › 시스템 설정에서 Google 연결을 켜야 해요' }}</small>
        </button>
        <button v-if="cfg.google" class="alt press" :disabled="busy" data-testid="mail-google-phone" @click="google('phone')"><u>휴대폰에서 연결</u> <small>· 이 기기에서 Google에 로그인해 메일만 연결해요</small></button>
        <p v-if="err" class="err">{{ err }}</p>
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
.alt { align-self: flex-start; margin: -2px 6px 4px; font-size: 13px; line-height: 1.45; color: var(--text-secondary); text-align: left; }
.alt u { text-underline-offset: 3px; }
.alt small { font-size: 12.5px; }
.err { margin: 0 6px; font-size: 13px; line-height: 1.45; color: var(--color-error); }
.form { display: flex; flex-direction: column; gap: 8px; }
.form input { height: 44px; border-radius: 9999px; border: 0; outline: 0; padding: 0 16px; background: var(--cell-bg); }
.by { display: flex; gap: 6px; align-items: center; justify-content: center; font-size: 13px; color: var(--text-secondary); margin: 4px 0 0; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
</style>
