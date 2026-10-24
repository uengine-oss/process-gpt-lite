<script setup>
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// Vault card in chat, posted by the browser agent (hark):
//   kind login | card | secret  ×  mode request (nothing saved) | update (site rejected it) | capture (user typed it)
// What is typed here goes to the server vault (or, for a one-time secret, straight into the page);
// the card itself never shows a saved secret.
const props = defineProps({ msg: Object })
const c = computed(() => props.msg.content)
const kind = computed(() => c.value.kind || 'login')
const mode = computed(() => c.value.mode || 'request')

const username = ref('')
const password = ref('')
const card = ref({ name: '', number: '', exp: '', cvv: '' })
const secret = ref('')
const show = ref(false)
const busy = ref(false)
const error = ref('')

const site = computed(() => (c.value.site || '').replace(/^www\./, ''))
const title = computed(() => {
  if (kind.value === 'card') return '결제 카드'
  if (/^[\d.:]+$|^localhost/.test(site.value)) return site.value
  const n = site.value.split('.').slice(-2, -1)[0] || site.value
  return n.charAt(0).toUpperCase() + n.slice(1)
})
const head = computed(() => ({ login: '로그인', card: '결제 카드', secret: c.value.label || '인증 코드' }[kind.value]))
const ready = computed(() => {
  if (mode.value === 'capture') return true
  if (kind.value === 'secret') return !!secret.value
  if (kind.value === 'card') return card.value.number.replace(/\D/g, '').length >= 13 && card.value.exp.length === 5 && card.value.cvv.length >= 3
  return (mode.value === 'update' || !!username.value) && !!password.value
})

const fmtCard = (e) => { card.value.number = e.target.value.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ') }
const fmtExp = (e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); card.value.exp = v.length > 2 ? `${v.slice(0, 2)}/${v.slice(2)}` : v }

async function run(fn) {
  busy.value = true
  error.value = ''
  try { await fn() } catch (e) {
    try { error.value = JSON.parse(e.message).error } catch { error.value = '저장하지 못했어요. 다시 시도해 주세요.' }
  } finally { busy.value = false }
}
const submit = () => run(async () => {
  const messageId = props.msg.id
  if (kind.value === 'secret') {
    await api(`/vault/requests/${messageId}/secret`, { method: 'POST', body: { value: secret.value } })
  } else if (mode.value === 'capture') {
    await api(`/vault/${c.value.itemId}/confirm`, { method: 'POST', body: { messageId } })
  } else if (mode.value === 'update') {
    await api(`/vault/${c.value.itemId}`, { method: 'PATCH', body: { data: { password: password.value }, messageId } })
  } else if (kind.value === 'card') {
    await api('/vault', { method: 'POST', body: { kind: 'card', site: 'wallet', data: { ...card.value, number: card.value.number.replace(/\s/g, '') }, messageId } })
  } else {
    await api('/vault', { method: 'POST', body: { kind: 'login', site: c.value.site, data: { username: username.value, password: password.value }, messageId } })
  }
  password.value = ''; secret.value = ''; card.value = { name: '', number: '', exp: '', cvv: '' }
})
const dismiss = () => run(() => (mode.value === 'capture'
  ? api(`/vault/${c.value.itemId}/discard`, { method: 'POST', body: { messageId: props.msg.id } })
  : api(`/vault/requests/${props.msg.id}/dismiss`, { method: 'POST' })))

const done = computed(() => {
  if (c.value.state === 'used') return `${head.value} 전달됨 · 저장하지 않음`
  if (c.value.state !== 'saved') return ''
  if (kind.value === 'card') return `카드 저장됨${c.value.label ? ` · ${c.value.label}` : ''}`
  return mode.value === 'update' ? `${title.value} 비밀번호 갱신됨` : `${title.value} 로그인 저장됨`
})
const muted = { expired: '요청이 만료됐어요', dismissed: '요청을 닫았어요', discarded: '저장하지 않았어요' }
</script>

<template>
  <div v-if="muted[c.state]" class="saved muted">{{ muted[c.state] }}</div>
  <div v-else-if="done" class="saved blur-in"><Icon name="check" :size="16" /> {{ done }}</div>
  <form v-else class="vault glass" @submit.prevent="submit">
    <div class="h">
      <Icon v-if="kind === 'card'" name="card" :size="20" />
      <Icon v-else-if="kind === 'secret'" name="key" :size="20" />
      <img v-else :src="`https://www.google.com/s2/favicons?domain=${site}&sz=64`" alt="" />
      <span>{{ head }}</span>
      <button type="button" class="x" :aria-label="mode === 'capture' ? '저장 안 함' : '닫기'" @click="dismiss"><Icon name="close" :size="16" /></button>
    </div>

    <template v-if="mode === 'capture'">
      <p v-if="kind === 'card'">방금 입력한 카드 <b>{{ c.label }}</b>를 지갑에 저장할까요? 다음 결제부터 바로 쓸 수 있어요.</p>
      <p v-else>방금 입력한 {{ title }} 로그인 <b>{{ c.label }}</b>을 보관함에 저장할까요? 이미 암호화돼 있고, 저장하지 않으면 바로 지워요.</p>
      <div class="go two-btn">
        <button type="button" class="ghost-btn" :disabled="busy" @click="dismiss">저장 안 함</button>
        <button class="dark-btn" :disabled="busy">저장</button>
      </div>
    </template>

    <template v-else-if="kind === 'secret'">
      <p>{{ title }}에서 {{ head }}가 필요해요. 입력한 값은 이 단계에만 쓰이고 저장되지 않아요.</p>
      <input v-model="secret" class="in" inputmode="numeric" autocomplete="one-time-code" :placeholder="head" />
      <div class="go"><button class="dark-btn" :disabled="!ready || busy">입력</button></div>
    </template>

    <template v-else-if="kind === 'card'">
      <p>결제에 사용할 카드를 입력하면 암호화된 보관함에 저장하고 이어서 진행해요. 결제 직전에 한 번 더 여쭤볼게요.</p>
      <input v-model="card.name" class="in" autocomplete="cc-name" placeholder="카드 소유자 이름" />
      <input :value="card.number" class="in" inputmode="numeric" autocomplete="cc-number" placeholder="카드 번호" @input="fmtCard" />
      <div class="two">
        <input :value="card.exp" class="in" inputmode="numeric" autocomplete="cc-exp" placeholder="MM/YY" @input="fmtExp" />
        <input v-model="card.cvv" class="in" inputmode="numeric" maxlength="4" type="password" autocomplete="cc-csc" placeholder="CVC" />
      </div>
      <div class="go"><button class="dark-btn" :disabled="!ready || busy">카드 저장</button></div>
    </template>

    <template v-else>
      <p v-if="mode === 'update'">{{ title }}에서 저장된 비밀번호를 받아들이지 않았어요. 새 비밀번호를 입력하면 보관함을 갱신하고 다시 시도해요.</p>
      <p v-else>{{ title }} 로그인 정보를 입력하면 암호화된 보관함에 저장하고 바로 이어서 진행해요.</p>
      <div v-if="mode === 'update'" class="in ro">{{ c.label }}</div>
      <input v-else v-model="username" class="in" autocomplete="username" placeholder="이메일 또는 아이디" />
      <div class="pw">
        <input v-model="password" class="in" :type="show ? 'text' : 'password'" :autocomplete="mode === 'update' ? 'new-password' : 'current-password'" :placeholder="mode === 'update' ? '새 비밀번호' : '비밀번호'" />
        <button type="button" aria-label="비밀번호 보기" @click="show = !show"><Icon name="eye" :size="18" /></button>
      </div>
      <div class="go"><button class="dark-btn" :disabled="!ready || busy">{{ mode === 'update' ? '다시 로그인' : '로그인' }}</button></div>
    </template>

    <p v-if="error" class="err">{{ error }}</p>
    <div class="by"><Icon name="lock" :size="13" /> 보안 제공: <span class="serif">process gpt</span></div>
  </form>
</template>

<style scoped>
.vault { width: min(100%, 360px); border-radius: 24px; padding: 16px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-card); }
.h { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 500; }
.h img { width: 20px; height: 20px; border-radius: 6px; }
.h .x { margin-left: auto; width: 28px; height: 28px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-secondary); }
p { margin: 0 0 4px; font-size: 14px; line-height: 1.45; color: var(--text-secondary); }
p b { color: var(--text-primary); font-weight: 500; }
.in { width: 100%; height: 44px; border-radius: 9999px; border: 0; outline: 0; padding: 0 16px; background: var(--cell-bg); font-size: 15px; }
.in:focus { box-shadow: 0 0 0 1.5px var(--text-primary) inset; }
.in.ro { display: flex; align-items: center; color: var(--text-secondary); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.pw { position: relative; }
.pw button { position: absolute; right: 12px; top: 12px; color: var(--text-secondary); }
.dark-btn { height: 44px; }
.ghost-btn { height: 44px; padding: 0 18px; border-radius: 9999px; background: var(--cell-bg); font-size: 15px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.err { color: var(--color-error); margin: 0; }
.by { display: flex; align-items: center; justify-content: center; gap: 4px; font-size: 13px; color: var(--text-secondary); border-top: 1px solid var(--hairline); padding-top: 10px; }
.by .serif { color: var(--text-primary); font-weight: 500; }
.muted { color: var(--text-secondary); }
.saved { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px; border-radius: 9999px; background: var(--bubble-user-bg); font-size: 14px; }
.go { display: flex; justify-content: flex-end; }
.two-btn { gap: 8px; }
</style>
