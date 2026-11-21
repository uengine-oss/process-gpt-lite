<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// 텔레그램으로 알림 받기: the person's own bot (made with @BotFather) sends them what Lite has to say
// (routes/telegram.js). ① BotFather → ② paste the token → ③ 「봇 열기」 and Start, checked every 2 s
// for up to 2 min → ④ 연결됐어요. compact: a row in 설정 › 계정 › 연결 that opens into the steps;
// otherwise a card of its own (a chat answer). scheduleName: the schedule that wanted this connection.
const props = defineProps({ compact: Boolean, scheduleName: String })
const emit = defineEmits(['linked', 'disconnected'])

const st = ref(null) // {connected, bot, linked, chatName, link?}
const open = ref(!props.compact)
const token = ref('')
const busy = ref(false)
const err = ref('')
const waiting = ref(false)
const timedOut = ref(false)
const tested = ref('')
const sureOff = ref(false)
let timer = null, deadline = 0, inFlight = false, offTimer = null
const hint = ref('')

const phase = computed(() => (!st.value ? 'loading' : !st.value.connected ? 'token' : !st.value.linked ? 'start' : 'linked'))
const stateText = computed(() => ({ loading: '', token: '연결 안 됨', start: '시작 기다림', linked: '' })[phase.value])
const subText = computed(() => ({
  loading: '확인하는 중…',
  token: '예약 작업 알림을 내 텔레그램 봇으로 받아요',
  start: `@${st.value?.bot} 에서 시작을 누르면 끝나요`,
  linked: `@${st.value?.bot}`,
})[phase.value])

async function load() {
  try { st.value = await api('/telegram') } catch (e) { st.value = { connected: false }; err.value = e.message }
  // a card that comes up already waiting (a second card in the chat, the settings row) does not poll on its
  // own — 「봇 열기」 or 「다시 확인」 starts it (one loop, not one per card)
  if (phase.value === 'start') { open.value = true; timedOut.value = true }
}
onMounted(() => { load(); document.addEventListener('visibilitychange', onVisible) })
onBeforeUnmount(() => { stop(); clearTimeout(offTimer); document.removeEventListener('visibilitychange', onVisible) })

async function connect() {
  if (!token.value.trim() || busy.value) return
  busy.value = true
  err.value = ''
  try {
    const r = await api('/telegram/connect', { method: 'POST', body: { token: token.value } })
    token.value = ''
    st.value = { connected: true, bot: r.bot, linked: r.linked, chatName: r.chatName, link: r.link }
    if (r.linked) emit('linked', { chatName: r.chatName, bot: r.bot })
    else watchStart()
  } catch (e) { err.value = e.message } finally { busy.value = false }
}

// ③ ask the server whether Start was pressed: every 2 s for 2 min, and at once when the person comes back
function watchStart() {
  stop()
  timedOut.value = false
  waiting.value = true
  deadline = Date.now() + 120000
  timer = setTimeout(tick, 2000)
}
function stop() { clearTimeout(timer); timer = null; waiting.value = false }
async function tick() {
  clearTimeout(timer)
  if (!waiting.value || inFlight) return
  inFlight = true
  try {
    const r = await api('/telegram/link', { method: 'POST' })
    hint.value = r.hint === 'use_link' ? '봇을 이름으로 찾아 누른 시작은 받지 않아요. 여기의 「봇 열기」로 열어 시작을 눌러 주세요.' : ''
    if (r.linked) {
      stop()
      st.value = { ...st.value, linked: true, chatName: r.chatName, link: undefined }
      emit('linked', { chatName: r.chatName, bot: st.value.bot })
      return
    }
  } catch (e) {
    // the bot is gone (disconnected in another tab) or Telegram refused: say so and stop
    if (e.status && e.status < 500) { stop(); err.value = e.message; if (e.status === 409) load(); return }
  } finally { inFlight = false }
  if (!waiting.value) return
  if (Date.now() > deadline) { stop(); timedOut.value = true; return }
  timer = setTimeout(tick, 2000)
}
function openedBot() {
  err.value = ''
  if (!waiting.value) watchStart()
  else deadline = Date.now() + 120000
}
function onVisible() { if (document.visibilityState === 'visible' && waiting.value) tick() }

async function sendTest() {
  busy.value = true
  err.value = ''
  tested.value = ''
  try {
    await api('/telegram/test', { method: 'POST' })
    tested.value = '보냈어요. 텔레그램을 확인해 보세요.'
  } catch (e) { err.value = e.message } finally { busy.value = false }
}

// 연결 끊기 asks once more (no dialog); 다른 봇으로 바꾸기 (nothing sent yet) does not
async function disconnect({ sure = false } = {}) {
  if (!sure && !sureOff.value) { sureOff.value = true; clearTimeout(offTimer); offTimer = setTimeout(() => { sureOff.value = false }, 4000); return }
  sureOff.value = false
  busy.value = true
  err.value = ''
  try {
    await api('/telegram', { method: 'DELETE' })
    stop()
    timedOut.value = false
    tested.value = ''
    st.value = { connected: false, bot: null, linked: false, chatName: null }
    open.value = true
    emit('disconnected')
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="tg" :class="{ compact, card: !compact, glass: !compact }" data-test="tg-card">
    <div class="head">
      <span class="ic" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="16" height="16"><path fill="#fff" d="M4.6 11.3 18.2 6c.7-.3 1.3.2 1.1 1.2l-2.3 10.9c-.2.8-.7 1-1.3.6l-3.6-2.6-1.7 1.7c-.2.2-.4.3-.7.3l.3-3.6 6.5-5.9c.3-.3-.1-.4-.4-.2l-8 5.1-3.5-1.1c-.8-.2-.8-.8 0-1.1z" /></svg>
      </span>
      <div class="main">
        <b>{{ compact ? '텔레그램' : '텔레그램으로 알림 받기' }}<template v-if="stateText"> · {{ stateText }}</template></b>
        <small>{{ subText }}</small>
      </div>
      <button v-if="compact && phase !== 'linked' && phase !== 'loading'" class="pill-btn sm press" data-test="tg-open" @click="open = !open">{{ open ? '닫기' : phase === 'start' ? '이어서 하기' : '연결하기' }}</button>
    </div>

    <!-- ① ② bot token -->
    <div v-if="phase === 'token' && open" class="body">
      <div class="step">
        <span class="n">1</span>
        <div class="what">
          <p>BotFather 에서 <code>/newbot</code> 으로 봇을 만들고 받은 토큰을 붙여 넣으세요.</p>
          <a class="pill-btn sm press link-btn" href="https://t.me/BotFather" target="_blank" rel="noopener" data-test="tg-botfather">BotFather 열기</a>
        </div>
      </div>
      <form class="step" @submit.prevent="connect">
        <span class="n">2</span>
        <div class="what">
          <input v-model="token" class="tok" type="password" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="123456789:AA…" aria-label="봇 토큰" data-test="tg-token" />
          <button class="dark-btn sm" :disabled="!token.trim() || busy" data-test="tg-connect">{{ busy ? '확인하는 중…' : '연결' }}</button>
          <small class="lock"><Icon name="lock" :size="13" /> 토큰은 암호화된 보관함에만 저장돼요.</small>
        </div>
      </form>
    </div>

    <!-- ③ Start in the bot's chat -->
    <div v-if="phase === 'start' && open" class="body">
      <p class="found"><Icon name="check" :size="15" /> @{{ st.bot }} 봇을 찾았어요.</p>
      <div class="step">
        <span class="n">3</span>
        <div class="what">
          <p>봇 화면에서 시작(Start)을 누르면 자동으로 확인해요.</p>
          <div class="row">
            <a class="dark-btn sm link-btn" :href="st.link" target="_blank" rel="noopener" data-test="tg-open-bot" @click="openedBot">봇 열기</a>
            <span v-if="waiting" class="wait" data-test="tg-waiting"><i class="dot" /> 기다리는 중…</span>
          </div>
          <p v-if="hint" class="late" data-test="tg-hint">{{ hint }}</p>
          <p v-if="timedOut" class="late">아직 시작 신호가 없어요. <button class="txt" data-test="tg-recheck" @click="watchStart">다시 확인</button></p>
        </div>
      </div>
      <button class="txt other" :disabled="busy" @click="disconnect({ sure: true })">다른 봇으로 바꾸기</button>
    </div>

    <!-- ④ linked -->
    <div v-if="phase === 'linked'" class="body">
      <p class="linked" data-test="tg-linked"><Icon name="check" :size="15" /> 연결됐어요 · <span data-no-i18n>{{ st.chatName }}</span></p>
      <p v-if="scheduleName" class="sched">「<span data-no-i18n>{{ scheduleName }}</span>」 알림도 이제 텔레그램으로 가요</p>
      <div class="row">
        <button class="pill-btn sm press" :disabled="busy" data-test="tg-test" @click="sendTest">시험 메시지 보내기</button>
        <button class="pill-btn sm press" :class="{ warn: sureOff }" :disabled="busy" data-test="tg-disconnect" @click="disconnect()">{{ sureOff ? '한 번 더 누르면 끊어요' : '연결 끊기' }}</button>
      </div>
      <small v-if="tested" class="done" data-test="tg-tested">{{ tested }}</small>
    </div>

    <small v-if="err" class="err" role="alert">{{ err }}</small>
  </div>
</template>

<style scoped>
.tg { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.tg.compact { padding: 18px 0; }
.tg.card { border-radius: 22px; padding: 16px 18px; }
.head { display: flex; align-items: center; gap: 14px; min-width: 0; }
.ic { flex: none; width: 22px; height: 22px; border-radius: 9999px; background: #2aabee; display: grid; place-items: center; }
.ic svg { margin-left: -1px; }
.main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.main b { font-weight: 450; font-size: 16px; }
.main small { color: var(--text-secondary); font-size: 14px; overflow-wrap: anywhere; }
.pill-btn.sm { height: 34px; padding: 0 14px; font-size: 14px; flex: none; }
.dark-btn.sm { height: 40px; padding: 0 18px; font-size: 14px; }
.link-btn { display: inline-flex; align-items: center; justify-content: center; text-decoration: none; align-self: flex-start; }
.pill-btn.link-btn { color: var(--text-primary); }
.body { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.tg.compact .body { padding-left: 36px; }
.step { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
.n { flex: none; width: 22px; height: 22px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); font-size: 12.5px; display: grid; place-items: center; margin-top: 1px; }
.what { flex: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.what p, .found, .linked, .sched, .late { margin: 0; font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.what code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; padding: 1px 6px; border-radius: 6px; background: var(--field-bg); }
.tok { width: 100%; min-width: 0; box-sizing: border-box; height: 42px; border-radius: 9999px; border: 0; outline: 0; padding: 0 16px; background: var(--field-bg); font-size: 15px; overflow-wrap: anywhere; }
.tok::placeholder { color: var(--text-tertiary); }
.what .dark-btn { align-self: flex-start; }
.lock { display: flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--text-secondary); }
.found, .linked { color: var(--color-success); }
.found svg, .linked svg { vertical-align: -2px; margin-right: 5px; }
.linked { font-size: 15px; font-weight: 500; }
.sched { color: var(--text-secondary); }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wait { display: inline-flex; align-items: center; gap: 7px; font-size: 13.5px; color: var(--text-secondary); }
.dot { width: 8px; height: 8px; border-radius: 9999px; background: #2aabee; animation: tg-pulse 1.2s ease-in-out infinite; }
@keyframes tg-pulse { 0%, 100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
.late { color: var(--text-secondary); }
.txt { font-size: 13.5px; color: var(--text-secondary); text-decoration: underline; text-underline-offset: 3px; }
.txt.other { align-self: flex-start; }
.pill-btn.warn { color: var(--color-error); }
.done { font-size: 13px; color: var(--text-secondary); }
.err { font-size: 13px; line-height: 1.45; color: var(--color-error); overflow-wrap: anywhere; }
.tg.compact .err { padding-left: 36px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
</style>
