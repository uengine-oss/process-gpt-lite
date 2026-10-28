<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import SkyCanvas from '../sky/SkyCanvas.vue'
import Wordmark from '../components/Wordmark.vue'
import Typewriter from '../components/Typewriter.vue'
import { auth } from '../api.js'
import { BASE } from '../base.js'

const router = useRouter()
const route = useRoute()
const cfg = ref({ google: false, demoLogin: false })
const step = ref('start') // start | code
const email = ref('')
const code = ref(['', '', '', '', '', ''])
const codeEls = ref([])
const busy = ref(false)
const error = ref(route.query.error || '')
const valid = computed(() => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value))

const samples = [
  '노스윈드 견적 요청 메일에 작년 조건으로 회신 초안 써줘',
  '매일 아침 8시에 국제 경제 브리핑을 메일로 보내줘',
  '파트너포털에 로그인해서 세금계산서 발행해줘',
  '코스피랑 우리 고객사 주가 추적하는 패널 만들어줘',
]
const sampleIdx = ref(0)
const nextSample = () => setTimeout(() => { sampleIdx.value = (sampleIdx.value + 1) % samples.length }, 2600)

onMounted(async () => {
  cfg.value = await (await fetch(BASE + '/api/config')).json()
  // behind the ProcessGPT gateway sign-in is ProcessGPT's own (its cookies are taken in main.js)
  if (cfg.value.hostLogin) location.href = '/'
})

function google() {
  if (!cfg.value.google) {
    error.value = 'Google OAuth가 아직 설정되지 않았어요. 이메일로 계속해 주세요.'
    return
  }
  location.href = BASE + '/api/auth/google/start'
}

async function startEmail() {
  busy.value = true
  error.value = ''
  const r = await fetch(BASE + '/api/auth/email/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value }) })
  busy.value = false
  const j = await r.json()
  if (!r.ok && !j.demo) { error.value = '코드를 보내지 못했어요.'; return }
  step.value = 'code'
}
// the code step mounts after the out-in transition, so focus once it has entered
const focusCode = () => codeEls.value[0]?.focus()

function onCode(i, e) {
  const v = e.target.value.replace(/\D/g, '')
  if (v.length > 1) { v.slice(0, 6).split('').forEach((c, k) => { code.value[k] = c }); verify(); return }
  code.value[i] = v
  if (v && i < 5) codeEls.value[i + 1]?.focus()
  if (code.value.join('').length === 6) verify()
}
function onKey(i, e) { if (e.key === 'Backspace' && !code.value[i] && i > 0) codeEls.value[i - 1]?.focus() }

async function verify() {
  busy.value = true
  const r = await fetch(BASE + '/api/auth/email/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: email.value, code: code.value.join('') }) })
  busy.value = false
  if (!r.ok) { error.value = '코드가 맞지 않아요.'; code.value = ['', '', '', '', '', '']; codeEls.value[0]?.focus(); return }
  auth.set(await r.json())
  router.replace('/welcome/age')
}
</script>

<template>
  <div class="login">
    <section class="media">
      <SkyCanvas :hour="17.4" />
      <div class="logo"><svg width="30" height="30" viewBox="0 0 30 30"><path d="M4 15 26 5 20 26 15 17z" fill="currentColor" /></svg></div>
      <div class="sample glass blur-in" :key="sampleIdx">
        <Typewriter :text="samples[sampleIdx]" :cps="26" @done="nextSample" />
      </div>
      <button class="learn glass-thin press">더 알아보기</button>
    </section>

    <section class="form">
      <div class="inner">
        <Wordmark :size="54" />
        <p class="tag">업무를 위한 새로운 운영체제.<br />무엇이든 process gpt에게 맡기세요.</p>

        <Transition name="fade" mode="out-in" @after-enter="step === 'code' && focusCode()">
          <div v-if="step === 'start'" key="start" class="stack">
            <button class="dark-btn wide" @click="google">
              <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
              Google로 계속하기
            </button>
            <div class="or"><span>또는</span></div>
            <input v-model="email" class="field" type="email" placeholder="이메일 주소" @keydown.enter="valid && startEmail()" />
            <button class="dark-btn wide" :class="{ off: !valid }" :disabled="!valid || busy" @click="startEmail">계속</button>
          </div>
          <div v-else key="code" class="stack">
            <p class="hint">{{ email }}로 보낸 6자리 코드를 입력하세요.<span v-if="cfg.demoLogin"><br />(로컬 데모: 000000)</span></p>
            <div class="code">
              <input v-for="(c, i) in code" :key="i" :ref="(el) => (codeEls[i] = el)" :value="c" inputmode="numeric" maxlength="6"
                @input="onCode(i, $event)" @keydown="onKey(i, $event)" />
            </div>
            <button class="pill-btn" @click="step = 'start'">다른 이메일 사용</button>
          </div>
        </Transition>
        <p v-if="error" class="err blur-in">{{ error }}</p>
      </div>
      <p class="legal">계속하면 서비스 약관에 동의하고, 개인정보처리방침에 따라 데이터가 처리됨을 확인하는 것으로 간주됩니다.</p>
    </section>
  </div>
</template>

<style scoped>
.login { position: absolute; inset: 0; display: grid; grid-template-columns: minmax(0, 672px) 1fr; padding: 20px; gap: 20px;
  --ink: #1d1d1f; color: var(--ink); }
:root[data-theme="dark"] .login { --ink: #f5f5f7; }
.media { position: relative; border-radius: 24px; overflow: hidden; box-shadow: 0 20px 60px rgba(0 0 0 / .18); }
.logo { position: absolute; top: 24px; left: 24px; color: #fff; filter: drop-shadow(0 1px 6px rgba(0 0 0 / .3)); }
.sample { position: absolute; left: 50%; bottom: 120px; translate: -50% 0; width: min(80%, 460px); padding: 16px 20px; border-radius: 24px;
  font-size: 17px; line-height: 1.45; color: var(--text-primary); --regular-bg: rgba(255 255 255 / .6); }
:root[data-theme="dark"] .sample { --regular-bg: rgba(29 29 31 / .5); }
.learn { position: absolute; left: 20px; bottom: 20px; height: 48px; padding: 0 20px; border-radius: 9999px; color: #f5f5f7; --thin-bg: rgba(29 29 31 / .55); font-size: 15px; }
.form { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.inner { width: min(380px, 100%); display: flex; flex-direction: column; align-items: center; animation: blur-in .8s var(--spring) both; }
.tag { text-align: center; font-size: 20px; line-height: 1.38; font-weight: 450; margin: 28px 0 36px; letter-spacing: -0.01em; }
.stack { width: 100%; display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.wide { width: 100%; }
.dark-btn.off { background: rgba(29 29 31 / .3); opacity: 1; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.or { display: flex; align-items: center; gap: 12px; color: var(--text-secondary); font-size: 13px; margin: 12px 0; }
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: currentColor; opacity: .25; }
.field { height: 48px; border-radius: 9999px; border: 0; outline: 0; padding: 0 20px; text-align: center; font-size: 15px;
  background: rgba(255 255 255 / .5); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); color: var(--ink); }
:root[data-theme="dark"] .field { background: rgba(255 255 255 / .1); }
.field::placeholder { color: var(--text-secondary); }
.hint { text-align: center; color: var(--text-secondary); font-size: 14px; line-height: 1.5; margin: 0 0 6px; }
.code { display: flex; gap: 8px; justify-content: center; }
.code input { width: 48px; height: 56px; border-radius: 16px; border: 0; outline: 0; text-align: center; font-size: 22px;
  background: rgba(255 255 255 / .55); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); color: var(--ink); }
:root[data-theme="dark"] .code input { background: rgba(255 255 255 / .1); }
.code input:focus { box-shadow: 0 0 0 2px var(--ink) inset; }
.err { color: var(--color-attention); font-size: 14px; margin-top: 16px; text-align: center; }
.legal { position: absolute; bottom: 4px; width: min(360px, 90%); text-align: center; font-size: 12px; line-height: 1.4; color: var(--text-secondary); }
@media (max-width: 860px) {
  .login { grid-template-columns: 1fr; }
  .media { display: none; }
}
</style>
