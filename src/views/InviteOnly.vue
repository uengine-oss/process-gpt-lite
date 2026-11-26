<script setup>
// The refusal screen (invite-only, 2026-11-25 사용자: 「우리가 초대를 해준 사람에 한해서만 로그인 할 수 있는 거야」): someone who is not an
// approved member of this company signed in. No session is kept (src/api.js leaveRefused); this says so calmly, with the company and the
// address they used, and whether their request is waiting for an administrator. The words are the server's (lib/membership.js refusal, in
// the screen's language): kept by the page that was refused (sessionStorage), or — after an install's own Google sign-in — fetched once
// with the key the server put in the address. Nothing a link says is shown. 「가입 요청 보내기」 asks to join only when pressed (POST
// /api/auth/join-request with the ticket of this sign-in); then the screen says the request is waiting.
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Wordmark from '../components/Wordmark.vue'
import { REFUSED, rememberRefusal } from '../api.js'
import { BASE } from '../base.js'

const route = useRoute()
const router = useRouter()
const state = ref(null)
const sending = ref(false)
const said = ref('')

const stored = () => { try { return JSON.parse(sessionStorage.getItem(REFUSED) || 'null') } catch { return null } }
onMounted(async () => {
  const k = typeof route.query.k === 'string' ? route.query.k : ''
  if (k) {
    const r = await fetch(`${BASE}/api/auth/refusal/${encodeURIComponent(k)}`).catch(() => null)
    if (r?.ok) rememberRefusal(await r.json())
    router.replace('/invite-only')
  }
  state.value = stored()
  if (!state.value?.title) router.replace('/login')
})

async function ask() {
  sending.value = true
  said.value = ''
  try {
    const r = await fetch(`${BASE}/api/auth/join-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: state.value.ticket }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) { said.value = j.error || '보내지 못했어요.'; return }
    rememberRefusal(j)
    state.value = stored()
  } catch { said.value = '보내지 못했어요.' } finally { sending.value = false }
}

function another() {
  try { sessionStorage.removeItem(REFUSED) } catch { /* ignore */ }
  router.replace('/login')
}
</script>

<template>
  <div class="io">
    <section v-if="state?.title" class="card glass blur-in" data-test="invite-only" :data-pending="state.pending ? '' : null">
      <Wordmark :size="34" />
      <div class="mark" aria-hidden="true">
        <svg v-if="state.pending" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16v12H4z" /><path d="m4 7 8 6 8-6" /></svg>
        <svg v-else width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 21V4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21" /><path d="M4 21h16" /><circle cx="14.5" cy="12.5" r=".9" fill="currentColor" /></svg>
      </div>
      <h1 data-test="refusal-title">{{ state.title }}</h1>
      <p class="detail" data-test="refusal-detail">{{ state.detail }}</p>
      <dl class="facts">
        <div v-if="state.company"><dt>회사</dt><dd data-test="refusal-company">{{ state.company }}</dd></div>
        <div v-if="state.email"><dt>로그인한 주소</dt><dd data-test="refusal-email">{{ state.email }}</dd></div>
      </dl>
      <button v-if="state.canRequest && !state.pending" class="dark-btn wide ask" data-test="refusal-ask" :disabled="sending" @click="ask">가입 요청 보내기</button>
      <p v-if="said" class="said" data-test="refusal-said">{{ said }}</p>
      <button class="wide" :class="state.canRequest && !state.pending ? 'pill-btn other' : 'dark-btn'" data-test="refusal-other" @click="another">다른 계정으로 로그인</button>
    </section>
  </div>
</template>

<style scoped>
.io { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px 16px; overflow-y: auto;
  --ink: #1d1d1f; color: var(--ink); }
:root[data-theme="dark"] .io { --ink: #f5f5f7; }
.card { width: min(420px, 100%); border-radius: 28px; padding: 32px 28px 26px; display: flex; flex-direction: column; align-items: center;
  text-align: center; box-shadow: var(--shadow-card); }
.mark { margin: 22px 0 14px; width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center;
  background: var(--button-bg); color: var(--text-secondary); }
h1 { margin: 0; font-size: 20px; line-height: 1.4; font-weight: 600; letter-spacing: -0.01em; color: var(--text-primary); }
.detail { margin: 8px 0 0; font-size: 15px; line-height: 1.55; color: var(--text-secondary); word-break: keep-all; }
.facts { width: 100%; margin: 22px 0 22px; padding: 4px 16px; border-radius: 16px; background: var(--field-bg); }
.facts div { display: flex; justify-content: space-between; gap: 16px; padding: 10px 0; font-size: 14px; }
.facts div + div { border-top: 1px solid var(--hairline); }
.facts dt { color: var(--text-secondary); flex: none; }
.facts dd { margin: 0; color: var(--text-primary); min-width: 0; overflow-wrap: anywhere; text-align: right; }
.wide { width: 100%; }
.ask { margin-bottom: 10px; }
.other { height: 44px; }
.said { margin: -2px 0 10px; font-size: 13px; color: var(--color-error); }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
</style>
