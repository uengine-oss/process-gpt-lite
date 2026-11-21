<script setup>
// Settings › 시스템 설정 › 회사 Google 연결 (administrators): the company's own Google OAuth client, which its
// people's Google connections use before this install's (server lib/googleClient.js). The secret is
// write-only: once saved it is never shown again, only replaced or removed.
import { ref, computed, onMounted } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

const info = ref(null)
const clientId = ref('')
const secret = ref('')
const busy = ref(false)
const err = ref('')
const saved = ref('')
const copied = ref(false)

async function load() {
  err.value = ''
  try {
    info.value = await api(`/admin/google-client?origin=${encodeURIComponent(location.origin)}`)
    clientId.value = info.value.company?.clientId || ''
  } catch (e) { err.value = e.message }
}
onMounted(load)

const using = computed(() => ({ company: '회사 값을 쓰고 있어요', env: '설치 기본값(서버 설정)을 쓰고 있어요', null: '아직 없어요 · 사람들이 Google 을 연결할 수 없어요' })[String(info.value?.using ?? null)])
const canSave = computed(() => !!clientId.value.trim() && (!!secret.value.trim() || (!!info.value?.company && clientId.value.trim() !== info.value.company.clientId)))

async function save() {
  busy.value = true
  err.value = ''
  try {
    info.value = await api('/admin/google-client', { method: 'PUT', body: { clientId: clientId.value, clientSecret: secret.value, origin: location.origin } })
    secret.value = ''
    saved.value = '저장했어요'
    setTimeout(() => { saved.value = '' }, 2000)
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function remove() {
  if (!confirm('회사 Google 연결 값을 지울까요? 지우면 설치 기본값이 없을 때 사람들이 Google 을 새로 연결할 수 없어요.')) return
  busy.value = true
  err.value = ''
  try {
    info.value = await api(`/admin/google-client?origin=${encodeURIComponent(location.origin)}`, { method: 'DELETE' })
    clientId.value = ''
    secret.value = ''
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function copy() {
  const v = info.value?.redirectUri
  if (!v) return
  try { await navigator.clipboard.writeText(v) } catch {
    // (a page on http: no clipboard API) select it for the person to copy
    const r = document.createRange(); r.selectNodeContents(document.querySelector('[data-testid="google-redirect"]')); getSelection().removeAllRanges(); getSelection().addRange(r)
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1600)
}
const when = (iso) => (iso ? new Date(iso).toLocaleDateString('ko-KR') : '')
</script>

<template>
  <p class="cap">회사 Google 연결</p>
  <div class="list glass gca" data-testid="google-client-admin">
    <div class="li col">
      <div class="main"><b>OAuth 클라이언트</b><small>이 회사 사람들이 메일·캘린더를 Google 로 연결할 때 써요. Google Cloud 콘솔의 「API 및 서비스 › 사용자 인증 정보」에서 만든 웹 애플리케이션용 OAuth 클라이언트 값을 넣어요.</small></div>
      <small class="state" :class="info?.using ? 'ok' : 'off'" data-testid="google-client-using">{{ using }}</small>
      <small v-if="info?.company?.savedAt" class="dim">{{ when(info.company.savedAt) }}에 저장했어요</small>
    </div>
    <div class="li col">
      <div class="main"><b>등록해야 할 리디렉션 URI</b><small>그 OAuth 클라이언트의 「승인된 리디렉션 URI」에 이 주소를 그대로 추가해요.</small></div>
      <div class="uri"><code data-testid="google-redirect" data-no-i18n>{{ info?.redirectUri || '—' }}</code>
        <button class="pill-btn sm" :disabled="!info?.redirectUri" data-testid="google-redirect-copy" @click="copy"><Icon :name="copied ? 'check' : 'doc'" :size="15" /> {{ copied ? '복사했어요' : '복사' }}</button></div>
    </div>
    <form class="li col" @submit.prevent="save">
      <input v-model="clientId" class="in" placeholder="Client ID (…apps.googleusercontent.com)" autocomplete="off" spellcheck="false" aria-label="Client ID" data-testid="google-client-id" />
      <input v-model="secret" class="in" type="password" :placeholder="info?.company ? 'Client secret (바꿀 때만)' : 'Client secret'" autocomplete="new-password" aria-label="Client secret" data-testid="google-client-secret" />
      <small v-if="info?.company" class="hint">저장한 Client secret 은 다시 보여 주지 않아요. 바꿀 때만 새 값을 넣어요.</small>
      <p v-if="err" class="ferr" data-testid="google-client-error">{{ err }}</p>
      <div class="btns">
        <button v-if="info?.company" type="button" class="pill-btn sm danger" :disabled="busy" data-testid="google-client-remove" @click="remove">지우기</button>
        <button class="dark-btn" :disabled="busy || !canSave" data-testid="google-client-save">{{ saved || '저장' }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.cap { color: var(--text-secondary); font-size: 14px; margin: 0 0 18px; }
.list { width: 100%; border-radius: 24px; padding: 4px 22px; margin-bottom: 14px; display: flex; flex-direction: column; }
.li { display: flex; align-items: center; gap: 14px; padding: 18px 0; border-bottom: 1px solid var(--hairline); }
.li:last-child { border-bottom: 0; }
.li.col { flex-direction: column; align-items: stretch; gap: 10px; }
.li .main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.li b { font-weight: 450; font-size: 16px; }
.li small { color: var(--text-secondary); font-size: 14px; line-height: 1.45; }
.state.ok { color: #1f8a4c; }
.state.off { color: #c25400; }
.dim { color: var(--text-tertiary) !important; font-size: 13px !important; margin-top: -6px; }
.uri { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.uri code { flex: 1 1 200px; min-width: 0; padding: 10px 12px; border-radius: 12px; background: var(--cell-bg); font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; user-select: all; }
.pill-btn.sm { height: 34px; padding: 0 14px; font-size: 14px; display: inline-flex; align-items: center; gap: 6px; }
.in { width: 100%; height: 46px; border-radius: 9999px; border: 0; outline: 0; padding: 0 18px; background: var(--cell-bg); font-size: 15px; color: var(--text-primary); }
.in::placeholder { color: var(--text-tertiary); }
.btns { display: flex; justify-content: flex-end; gap: 8px; }
.btns .dark-btn { border-radius: 14px; }
.danger { color: var(--color-error); }
.ferr { margin: 0; color: var(--color-error); font-size: 14px; }
.hint { margin: -2px 8px 0; font-size: 13px !important; color: var(--text-tertiary) !important; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
</style>
