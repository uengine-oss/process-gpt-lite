<script setup>
// Settings › 시스템 설정 › 인터넷 배경 사진 (administrators, server lib/background): the company's switch for the day's background
// photos on Home (on by default), and optional Unsplash · Pexels keys. A key is write-only: the server keeps it in the vault and
// this screen only ever learns whether one is saved.
import { ref, onMounted } from 'vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'

const app = useApp()
const enabled = ref(app.me?.features?.background !== false)
const keys = ref({ unsplash: { saved: false }, pexels: { saved: false } })
const input = ref({ unsplash: '', pexels: '' })
const busy = ref('')
const err = ref('')
const done = ref('')

onMounted(async () => {
  try {
    const r = await api('/admin/background')
    enabled.value = r.enabled
    keys.value = r.keys || keys.value
  } catch (e) { err.value = e.message }
})
async function toggle() {
  busy.value = 'switch'; err.value = ''
  try {
    const r = await api('/admin/background', { method: 'PUT', body: { enabled: !enabled.value } })
    enabled.value = r.enabled
    if (app.me) app.me = { ...app.me, features: { ...(app.me.features || {}), background: r.enabled } }
  } catch (e) { err.value = e.message || '바꾸지 못했어요.' } finally { busy.value = '' }
}
async function saveKey(provider, remove = false) {
  busy.value = provider; err.value = ''
  try {
    const r = await api(`/admin/background/keys/${provider}`, { method: 'PUT', body: { key: remove ? '' : input.value[provider] } })
    keys.value = r.keys
    input.value = { ...input.value, [provider]: '' }
    done.value = remove ? '지웠어요' : '저장했어요'
    setTimeout(() => { done.value = '' }, 2000)
  } catch (e) { err.value = e.message || '저장하지 못했어요.' } finally { busy.value = '' }
}
// (whole sentences per site, so the English screen's dictionary finds each of them)
const SITES = [
  { key: 'unsplash', title: 'Unsplash 키', about: '넣으면 추천의 일부를 Unsplash 에서도 가져와요. 키는 서버 보관함에 암호화해 두고 화면에 다시 보여 주지 않아요.', docs: 'Unsplash API 안내', terms: 'https://unsplash.com/developers', field: 'Unsplash Access Key', replace: '저장됨 · 새 키로 바꾸기' },
  { key: 'pexels', title: 'Pexels 키', about: '넣으면 추천의 일부를 Pexels 에서도 가져와요. 키는 서버 보관함에 암호화해 두고 화면에 다시 보여 주지 않아요.', docs: 'Pexels API 안내', terms: 'https://www.pexels.com/api/', field: 'Pexels API key', replace: '저장됨 · 새 키로 바꾸기' },
]
</script>

<template>
  <p class="cap">인터넷 배경 사진</p>
  <div class="list glass" data-test="bg-admin">
    <div class="li"><div class="main"><b>오늘의 배경 사진 추천</b><small>Home 의 날짜 · 날씨 패널에서 그날의 계절 · 절기 · 날씨에 어울리는 풍경 사진을 추천하고, 사람마다 배경으로 고를 수 있어요. 사진은 Wikimedia Commons 의 자유 라이선스 사진이고, 작가 · 라이선스 · 출처를 늘 함께 보여 줘요. 끄면 회사의 모든 사람이 기본 하늘 배경으로 돌아가요.</small></div>
      <button class="switch" :class="{ on: enabled }" role="switch" :aria-checked="enabled" aria-label="오늘의 배경 사진 추천" data-test="bg-photo-switch" :disabled="busy === 'switch'" @click="toggle"><i /></button></div>
    <div v-for="s in SITES" :key="s.key" class="li col" :data-test="`bg-key-${s.key}`">
      <div class="main"><b>{{ s.title }} <span class="opt">(선택)</span></b><small>{{ s.about }} <a :href="s.terms" target="_blank" rel="noopener noreferrer">{{ s.docs }}</a></small></div>
      <div class="row">
        <input v-model="input[s.key]" class="in" type="password" autocomplete="off" spellcheck="false" :placeholder="keys[s.key]?.saved ? s.replace : s.field" :aria-label="s.field" />
        <button class="pill-btn sm" :disabled="!input[s.key].trim() || !!busy" @click="saveKey(s.key)">저장</button>
        <button v-if="keys[s.key]?.saved" class="pill-btn sm" :disabled="!!busy" :data-test="`bg-key-${s.key}-remove`" @click="saveKey(s.key, true)">지우기</button>
      </div>
      <small v-if="keys[s.key]?.saved" class="saved" :data-test="`bg-key-${s.key}-saved`">저장됨</small>
    </div>
    <p v-if="err" class="ferr">{{ err }}</p>
    <p v-else-if="done" class="ok">{{ done }}</p>
  </div>
</template>

<style scoped>
.cap { color: var(--text-secondary); font-size: 14px; margin: 0 0 18px; }
.list { width: 100%; border-radius: 24px; padding: 4px 22px; margin-bottom: 14px; display: flex; flex-direction: column; }
.li { display: flex; align-items: center; gap: 14px; padding: 18px 0; border-bottom: 1px solid var(--hairline); }
.li:last-of-type { border-bottom: 0; }
.li.col { flex-direction: column; align-items: stretch; gap: 10px; }
.li .main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.li b { font-weight: 450; font-size: 16px; }
.li b .opt { color: var(--text-tertiary); font-weight: 400; font-size: 14px; }
.li small { color: var(--text-secondary); font-size: 14px; line-height: 1.45; }
.li small a { color: inherit; }
.row { display: flex; gap: 8px; align-items: center; }
.in { flex: 1; min-width: 0; height: 42px; border-radius: 9999px; border: 0; outline: 0; padding: 0 16px; background: var(--cell-bg); font-size: 14.5px; color: var(--text-primary); }
.in::placeholder { color: var(--text-tertiary); }
.pill-btn.sm { height: 38px; padding: 0 16px; font-size: 14px; flex: none; }
.saved { color: var(--color-success) !important; font-size: 13px !important; }
.switch { width: 52px; height: 30px; border-radius: 9999px; background: var(--field-bg); position: relative; transition: background-color .25s; flex: none; }
.switch i { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0 0 0 / .25); transition: left .25s var(--spring); }
.switch.on { background: var(--ink); } .switch.on i { left: 25px; }
.ferr { color: var(--color-error); font-size: 13.5px; margin: 0 0 14px; }
.ok { color: var(--color-success); font-size: 13.5px; margin: 0 0 14px; }
</style>
