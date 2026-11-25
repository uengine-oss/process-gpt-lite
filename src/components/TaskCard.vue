<script setup>
import { computed, ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { isEnglish } from '../i18n/lang.js'
import { connectInBrowser, connectOnPhone } from '../googleConnect.js'

const props = defineProps({ msg: Object, full: Boolean })
const app = useApp()
const showPlan = ref(false)
const c = computed(() => props.msg.content)
const frame = computed(() => app.frames[props.msg.id] || (c.value.shot ? { data: c.value.shot } : null))
const screen = ref(null)
const done = computed(() => c.value.steps?.filter((s) => s.done).length || 0)
const running = computed(() => c.value.state === 'running')
const needs = computed(() => c.value.state === 'needs_input')
// waiting for the browser (another task holds it) · ended without doing anything (lib/browser.js honest)
const queued = computed(() => c.value.state === 'queued')
const review = computed(() => c.value.state === 'needs_review')
const failed = computed(() => c.value.state === 'failed')
const ended = computed(() => review.value || failed.value)
// cancelled (그만두기 · 작업 취소): said on the pill, not a check mark that reads as done
const cancelled = computed(() => c.value.state === 'cancelled')
// finished with no picture of its last screen (an older card, a page that could not be photographed): a short
// bar with its pill, not an empty screen whose shimmering title read as still loading (2026-11-22 phone
// screenshot). The pill still opens the plan, at full size.
const bare = computed(() => !props.full && !frame.value?.data && !running.value && !needs.value && !queued.value && !showPlan.value)
// 직접 로그인 / 직접 확인 open the full view with 직접 제어 already on (app.takeover)
const takeover = ref(false)
// frames come when the page changes: a card opened while it waits still has to show the page, or nobody can take over
onMounted(async () => {
  if (props.full && app.takeover === props.msg.id) {
    takeover.value = true
    app.takeover = null
    nextTick(() => screen.value?.focus())
  }
  if (app.frames[props.msg.id] || !['running', 'needs_input'].includes(c.value.state)) return
  const last = await api('/browser/frame').catch(() => null)
  if (last?.data && last.taskId === props.msg.id && !app.frames[props.msg.id]) app.frames[props.msg.id] = { taskId: last.taskId, data: last.data, url: last.url }
})
// hark: while it runs, the pill says what the agent is doing right now (the live line, lib/browser.js say), not
// the task's title; each new line slides in
const live = computed(() => (running.value && app.status[props.msg.thread_id]) || null)

// What it waits on, in a few words (server lib/browser.js content.need): "확인 필요 · <title>" read as a failure
// with nothing to do about it (recording 2026-11-21). The reason under the screen says what to do.
const host = computed(() => String(c.value.site || c.value.url || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0])
// the server names the site as its page calls itself (content.siteName, lib/browser.js); else its address
const site = computed(() => c.value.siteName || host.value)
const need = computed(() => (needs.value || ended.value ? c.value.need || null : null))
const label = computed(() => {
  const n = site.value || c.value.title
  switch (need.value) {
    case 'login': return `로그인 필요 · ${n}`
    case 'blocked': return `로그인을 막음 · ${n}`
    case 'captcha': return `사람 확인 필요 · ${n}`
    case 'choice': return `선택 필요 · ${n}`
    case 'approve': return `승인 필요 · ${n}`
    case 'stuck': return '같은 화면에서 멈춤'
    // the budget of actions ran out — never 「같은 화면에서 멈춤」 for work that kept going (server lib/browserProgress.js)
    case 'limit': return c.value.progress?.count ? `${c.value.progress.count}개 처리 · 동작 한도` : '동작 한도에서 멈춤'
    case 'offline': return `PC 연결 끊김 · ${n}`
    case 'other': return `확인 필요 · ${n}`
  }
  return needs.value ? '조치 필요' : failed.value ? `하지 못했어요 · ${c.value.title}` : `확인 필요 · ${c.value.title}`
})
// the whole reason, never cut: what stopped it and what lets it go on
const why = computed(() => String(c.value.reason || (ended.value ? c.value.summary : '') || '').trim())
// Where it runs (server lib/browser.js content.where): the person's own PC — 「내 PC · <기기>」 and 「이 PC에서 보기」, which shows that
// browser's window on the PC for them to use directly — or this server's browser (said only when it moved there from the PC)
const where = computed(() => c.value.where || null)
const onPc = computed(() => where.value?.kind === 'local')
// a task that ended needing the person: its page is kept on their PC for 「이 PC에서 보기」 (until another task takes that browser)
const pcKept = computed(() => onPc.value && ended.value && c.value.pcKept === true)
const whereText = computed(() => (onPc.value ? `내 PC · ${where.value.device || 'PC'}` : where.value?.from === 'local' ? '서버 브라우저에서 이어서' : ''))
const pcErr = ref('')
async function showOnPc() {
  pcErr.value = ''
  try {
    const r = await api('/browser/show', { method: 'POST', body: { taskId: props.msg.id } })
    if (!r?.ok) pcErr.value = 'PC 앱에 닿지 않았어요. PC 앱이 켜져 있는지 확인해 주세요.'
  } catch (e) { pcErr.value = e.message }
}
// the PC went off (need 'offline'): 「서버에서 이어서」 — this server's browser takes it from the same page — or 「PC가 다시 켜지면」
const offline = computed(() => (needs.value && need.value === 'offline' ? c.value.offline || {} : null))
const routeTo = (to) => api('/browser/route', { method: 'POST', body: { taskId: props.msg.id, to } }).catch((e) => { pcErr.value = e.message })
// the card that answers it (a login to save, a choice, an approval) when the agent posted one
const answerCard = computed(() => (app.messages[props.msg.thread_id] || []).find((m) => ['vault', 'choice'].includes(m.kind) && m.content?.taskId === props.msg.id && m.content?.state === 'pending'))
// a sign-in wall the vault has a login for: the agent is typing it in (server lib/browser.js vaultFirstOnWall → content.signingIn)
const vaultIn = computed(() => (running.value && c.value.signingIn?.via === 'vault' ? c.value.signingIn : null))
// a sign-in form with no login saved for it: the vault's card beside 「직접 로그인」 asks for one
const saveCard = computed(() => (answerCard.value?.kind === 'vault' && answerCard.value.content.kind === 'login' && answerCard.value.content.mode === 'request' ? answerCard.value : null))

// one at a time, in order: a password typed fast must not arrive shuffled
let sending = Promise.resolve()
const send = (body) => { sending = sending.then(() => api('/browser/input', { method: 'POST', body })).catch(() => {}) }
function onClick(e) {
  if (!takeover.value) return
  const r = e.currentTarget.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
  send({ type: 'click', x, y })
  ripple(x, y, 'click')
  if (kbd.value) { mirror = ''; kbd.value.value = ''; kbd.value.focus() }
}
function onKey(e) {
  if (!takeover.value) return
  const cmd = e.metaKey || e.ctrlKey
  if (cmd && e.key.toLowerCase() === 'v') return // onPaste brings the text itself
  e.preventDefault()
  if (['Process', 'Dead', 'Unidentified', 'HangulMode', 'HanjaMode'].includes(e.key)) return // input method keys, not characters
  if (cmd) { if (e.key.length === 1) send({ type: 'key', key: `ControlOrMeta+${e.key}` }) }
  else if (e.key.length === 1) send({ type: 'text', text: e.key })
  else send({ type: 'key', key: e.key })
}
function onPaste(e) {
  if (!takeover.value) return
  e.preventDefault()
  const text = e.clipboardData?.getData('text')
  if (text) send({ type: 'text', text })
}
// a phone has no keys for the screen itself: a field under it whose text goes to the page as it changes
// (what was added is typed, what was taken away is Backspace — Android keyboards compose words, so the
// value is compared, not the key events). A tap on the page starts a new field there.
const touch = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth <= 760)
const kbd = ref(null)
let mirror = ''
function onKbInput(e) {
  const v = e.target.value
  let i = 0
  while (i < mirror.length && i < v.length && mirror[i] === v[i]) i++
  for (let k = mirror.length; k > i; k--) send({ type: 'key', key: 'Backspace' })
  if (v.length > i) send({ type: 'text', text: v.slice(i) })
  mirror = v
}
function onKbEnter(e) {
  if (e.isComposing) return
  e.preventDefault()
  send({ type: 'key', key: 'Enter' })
  mirror = ''
  e.target.value = ''
}
function finishTakeover() {
  takeover.value = false
  api('/browser/resume', { method: 'POST', body: { text: 'The user took over and finished the manual part. Re-check the page and continue.' } })
}
// this card's task, whether it holds the browser or waits in line
const cancel = () => api('/browser/cancel', { method: 'POST', body: { taskId: props.msg.id } })

// In line (server lib/browser.js queueAction, 2026-11-25 recording 「계속 블러킹이 되는」): what it waits on — the task ahead, and when that
// one waits for the person, what it asked (content.blocked) — and, for a task the person just asked for behind it, three ways, the
// likeliest first (content.offer.default): its words as the answer · stop the one ahead and do this first · stay in line. Any card in
// line can go first or be cancelled.
const blocked = computed(() => (queued.value ? c.value.blocked || null : null))
const offer = computed(() => (queued.value && blocked.value && c.value.offer ? c.value.offer : null))
const qErr = ref('')
const qBusy = ref(false)
async function queueDo(action) {
  qErr.value = ''
  qBusy.value = true
  try { await api('/browser/queue', { method: 'POST', body: { taskId: props.msg.id, action } }) } catch (e) { qErr.value = e.message } finally { qBusy.value = false }
}
const queueActs = computed(() => {
  if (!queued.value) return []
  const all = {
    answer: { key: 'q-answer', label: '이 말을 앞 작업의 답으로', run: () => queueDo('answer') },
    first: { key: 'q-first', label: '앞 작업 멈추고 이것부터', run: () => queueDo('first') },
    after: { key: 'q-after', label: '앞 작업 뒤에 줄 세우기', run: () => queueDo('after') },
  }
  const drop = { key: 'q-cancel', label: '취소', run: cancel }
  if (offer.value) {
    const d = all[offer.value.default] ? offer.value.default : 'after'
    return [{ ...all[d], big: true }, ...['answer', 'first', 'after'].filter((k) => k !== d).map((k) => all[k]), drop]
  }
  return [all.first, drop]
})
// repetitive work that keeps changing the page (deleting one item after another): how many rounds so far, not a stop
const progressN = computed(() => (running.value || needs.value ? c.value.progress?.count || 0 : 0))
// what the person said to it in the chat — an answer to its question, or how to go on — shown as received
const heard = computed(() => (running.value || needs.value ? (c.value.steered?.text ? { kind: '받은 지시', text: c.value.steered.text } : c.value.answered?.text ? { kind: '채팅으로 답함', text: c.value.answered.text } : null) : null))

// Nothing has moved for a while (server lib/browser.js guard → content.stall { what, since, after }): instead of a screen
// that looks frozen, what it is waiting on, for how long, and 다시 시도 (that step again) · 그만두기 (stop the task).
const stall = computed(() => (running.value && c.value.stall?.what ? c.value.stall : null))
const now = ref(Date.now())
let seenAt = 0, tick = null
watch(() => stall.value?.since, (since) => {
  clearInterval(tick)
  tick = null
  if (!since) return
  seenAt = Date.now()
  now.value = seenAt
  tick = setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(tick))
// the server's clock when it is plausible, else counted on from when this card first saw the stall (a phone's clock may be off)
const stallSecs = computed(() => {
  if (!stall.value) return 0
  const after = Number(stall.value.after) || 20
  const d = now.value - Date.parse(stall.value.since)
  return Math.floor(d >= (after - 5) * 1000 && d < 3600e3 ? d / 1000 : after + (now.value - seenAt) / 1000)
})
const stallTime = computed(() => (stallSecs.value >= 60 ? `${Math.floor(stallSecs.value / 60)}분 ${stallSecs.value % 60}초` : `${stallSecs.value}초`))
const stepping = ref(false)
async function retryStep() {
  stepping.value = true
  try { await api('/browser/retry', { method: 'POST', body: { taskId: props.msg.id } }) } catch { /* the card says what happens next */ } finally { setTimeout(() => { stepping.value = false }, 1500) }
}
const takeOver = () => { app.takeover = props.msg.id; app.handoff = props.msg.id }
const toAnswer = () => document.querySelector(`.row[data-id="${answerCard.value?.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
const retry = () => app.send(isEnglish ? `Try again: ${c.value.title}` : `다시 시도해 줘: ${c.value.title}`, props.msg.thread_id)
// 「Google 연결」 (server lib/browser.js connectGoogle): again in the server browser, or on this device for the mail alone
const google = computed(() => c.value.connect === 'google')
const err = ref('')
const viaGoogle = (fn) => async () => { err.value = ''; try { await fn() } catch (e) { err.value = e.message } }
const phone = { key: 'phone', label: '휴대폰에서 연결', icon: 'chevron', run: viaGoogle(connectOnPhone) }
const again = { key: 'again', label: '다시 연결', icon: 'refresh', run: viaGoogle(() => connectInBrowser(app)) }
// connected: the full view steps aside for the chat, where the result is said
watch(() => c.value.state, (s) => {
  if (props.full && google.value && s === 'done') setTimeout(() => { if (app.handoff === props.msg.id) app.handoff = null }, 1500)
})
// the first button is the one that gets it going again, made big; the second is the way out
const acts = computed(() => {
  const stop = { key: 'stop', label: '멈추기', run: cancel }
  if (google.value && ended.value) return need.value === 'blocked' ? [phone, again] : [again, phone]
  if (needs.value) {
    if (offline.value) {
      const server = { key: 'server', label: '서버에서 이어서', icon: 'refresh', run: () => routeTo('server') }
      return offline.value.waiting ? [server, stop] : [server, { key: 'wait', label: 'PC가 다시 켜지면', run: () => routeTo('wait') }, stop]
    }
    // on the person's PC: its window there is the other way to do it by hand
    if (onPc.value && ['login', 'captcha', 'stuck', 'other', 'blocked'].includes(need.value)) {
      const pc = { key: 'pc', label: '이 PC에서 보기', run: showOnPc }
      if (need.value === 'login') return [{ key: 'login', label: '직접 로그인', icon: 'hand', run: takeOver }, pc, stop]
      if (need.value !== 'blocked') return [{ key: 'look', label: '직접 확인', icon: 'hand', run: takeOver }, pc, stop]
    }
    if (need.value === 'login' && google.value) return [{ key: 'login', label: '직접 로그인', icon: 'hand', run: takeOver }, phone, stop]
    if (need.value === 'login' && saveCard.value) return [{ key: 'login', label: '직접 로그인', icon: 'hand', run: takeOver }, { key: 'save', label: '로그인 정보 저장', run: toAnswer }, stop]
    if (need.value === 'login') return [{ key: 'login', label: '직접 로그인', icon: 'hand', run: takeOver }, stop]
    if (need.value === 'blocked') return [{ ...stop, icon: 'close' }, { key: 'look', label: '직접 확인', run: takeOver }]
    if (answerCard.value && ['choice', 'approve'].includes(need.value)) return [{ key: 'answer', label: need.value === 'approve' ? '승인하러 가기' : '고르러 가기', icon: 'chevron', run: toAnswer }, stop]
    return [{ key: 'look', label: '직접 확인', icon: 'hand', run: takeOver }, stop]
  }
  // (ended needing the person on their PC: the page is kept there — server lib/browser.js keepsPage → content.pcKept)
  if (ended.value) return [{ key: 'retry', label: '다시 시도', icon: 'refresh', run: retry }, ...(pcKept.value ? [{ key: 'pc', label: '이 PC에서 보기', run: showOnPc }] : [])]
  return []
})

// hark: a ring that swells and fades where the agent is about to click (SSE browser.click, x/y on its w×h page).
// The page is drawn object-fit: cover from the top, so the point goes through the same fit to land where it is seen.
const ripples = ref([])
let rid = 0
function ripple(fx, fy, kind) {
  const box = screen.value?.getBoundingClientRect()
  if (!box?.width || !(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) return
  const img = screen.value.querySelector('img')
  const iw = img?.naturalWidth || 16, ih = img?.naturalHeight || 10
  const s = Math.max(box.width / iw, box.height / ih)
  const x = (box.width - iw * s) / 2 + fx * iw * s, y = fy * ih * s
  if (x < 0 || y < 0 || x > box.width || y > box.height) return
  const id = ++rid
  ripples.value.push({ id, kind, left: `${(x / box.width) * 100}%`, top: `${(y / box.height) * 100}%` })
  setTimeout(() => { ripples.value = ripples.value.filter((r) => r.id !== id) }, 900)
}
watch(() => app.clicks[props.msg.id]?.n, () => {
  const k = app.clicks[props.msg.id]
  if (k) ripple(k.x / (k.w || 1280), k.y / (k.h || 800), k.kind)
})
</script>

<template>
  <div class="task" :class="{ full }">
    <div ref="screen" class="screen" :class="{ live: running, takeover, bare }" tabindex="0" @click="onClick" @keydown="onKey" @paste="onPaste">
      <img v-if="frame?.data" :src="`data:image/jpeg;base64,${frame.data}`" alt="" />
      <div v-else class="blank"><span v-if="!bare" :class="running || queued ? 'shimmer-text' : 'still'">{{ running ? '브라우저 여는 중' : queued ? (c.order ? '② 대기 중' : '대기 중') : c.title }}</span></div>
      <span v-if="progressN" class="prog" data-testid="task-progress">진행 중 · {{ progressN }}개 처리</span>
      <div class="rings" aria-hidden="true"><i v-for="r in ripples" :key="r.id" class="ring" :class="r.kind" :style="{ left: r.left, top: r.top }" data-testid="click-ring" /></div>
      <span v-if="whereText && !bare" class="where" :class="{ pc: onPc }" data-testid="task-where">{{ whereText }}</span>
      <Transition name="fade">
        <div v-if="showPlan" class="plan glass" @click.stop>
          <div class="ph">작업 진행 상황 <button aria-label="닫기" @click="showPlan = false"><Icon name="close" :size="18" /></button></div>
          <ul>
            <li v-for="(s, i) in c.steps" :key="i" :class="{ done: s.done }"><span class="dot" />{{ s.text }}<small v-if="s.note">{{ s.note }}</small></li>
          </ul>
        </div>
      </Transition>
      <!-- hark: the task rides on the live screen — title pill (tap for the plan), expand, stop -->
      <div v-if="!full" class="ctl">
        <button v-if="needs" class="attn press" :aria-label="label === '조치 필요' ? label : `조치 필요 · ${label}`" @click.stop="app.handoff = msg.id"><Icon name="alert" :size="16" /><span class="tt">{{ label }}</span></button>
        <span v-else-if="queued" class="title wait" :title="c.reason"><Icon name="clock" :size="14" /><span class="tt">대기 · {{ c.title }}</span></span>
        <button v-else-if="ended" class="title review press" :title="why" @click.stop="showPlan = !showPlan"><Icon name="alert" :size="14" /><span class="tt">{{ label }}</span></button>
        <button v-else class="title press" :aria-label="`${c.title}, 계획 ${done}/${c.steps?.length}`" @click.stop="showPlan = !showPlan">
          <span v-if="running" class="dots"><i /><i /><i /></span><Icon v-else :name="cancelled ? 'close' : 'check'" :size="14" />
          <Transition name="line"><span :key="live || c.title" class="tt" data-testid="task-pill">{{ live || (cancelled ? `취소함 · ${c.title}` : c.title) }}</span></Transition>
        </button>
        <button class="round press" aria-label="확장" @click.stop="app.handoff = msg.id"><Icon name="expand" :size="16" /></button>
        <button v-if="running || needs || queued" class="round press" aria-label="작업 취소" @click.stop="cancel"><Icon name="close" :size="16" /></button>
      </div>
    </div>
    <!-- nothing moved for a while: what it waits on, for how long, and the way on or out (also in the full view) -->
    <div v-if="stall" class="ask stall" :class="{ inFull: full }" data-testid="task-stall" role="status">
      <p class="why"><b data-testid="task-stall-what">기다리는 중 · {{ stall.what }}</b> <span class="secs" data-testid="task-stall-time">{{ stallTime }}</span></p>
      <p class="hint">진행이 멈춘 것 같으면 「다시 시도」로 이 단계를 다시 하거나, 「그만두기」로 작업을 멈춰요.</p>
      <div class="acts">
        <button class="press go" data-testid="task-retry-step" :disabled="stepping" @click="retryStep"><Icon name="refresh" :size="18" />다시 시도</button>
        <button class="press sub" data-testid="task-giveup" @click="cancel">그만두기</button>
      </div>
    </div>
    <!-- in line: what it waits on (the question the task ahead asked, when it waits for the person) and what to do with this one -->
    <div v-if="!full && queued" class="ask queue" :class="{ urgent: !!blocked }" data-testid="task-queue">
      <p class="why" data-testid="task-queue-why">{{ c.reason || '앞 작업이 끝나면 시작해요' }}</p>
      <p v-if="blocked?.question" class="asked" data-testid="task-queue-question"><small>앞 작업이 물은 것</small><span data-no-i18n>{{ blocked.question }}</span></p>
      <div class="acts">
        <button v-for="(a, i) in queueActs" :key="a.key" class="press" :class="a.big ? 'go' : 'sub'" :disabled="qBusy" :data-testid="`task-${a.key}`" :data-default="a.big ? 'yes' : null" @click="a.run">{{ a.label }}</button>
      </div>
      <p v-if="qErr" class="aerr" data-testid="task-queue-error">{{ qErr }}</p>
    </div>
    <!-- what the person said to it in the chat, as received -->
    <p v-if="heard && !full" class="heard" data-testid="task-heard"><b>{{ heard.kind }}</b><span data-no-i18n>{{ heard.text }}</span></p>
    <!-- signing in with the vault's login: which way it is going in (also in the full view) -->
    <div v-if="vaultIn && !stall" class="ask vaultin" :class="{ inFull: full }" data-testid="task-vault-signin" role="status">
      <p class="why"><Icon name="key" :size="16" /><b>보관함의 로그인으로 들어가는 중</b><span class="vsite">· {{ vaultIn.site }}</span></p>
      <p class="hint">저장된 로그인 정보를 서버에서 바로 입력해요. 비밀번호는 화면에도 AI에도 보이지 않아요.</p>
    </div>
    <!-- waiting or stopped: why, in full, and the one thing that gets it going again -->
    <div v-if="!full && (needs || ended) && (why || acts.length)" class="ask" :class="{ urgent: needs }" data-testid="task-ask">
      <p v-if="why" class="why" data-testid="task-reason">{{ why }}</p>
      <div v-if="acts.length" class="acts">
        <button v-for="(a, i) in acts" :key="a.key" class="press" :class="i ? 'sub' : 'go'" :data-testid="`task-${a.key}`" @click="a.run"><Icon v-if="a.icon && !i" :name="a.icon" :size="18" />{{ a.label }}</button>
      </div>
      <p v-if="err" class="aerr" data-testid="task-error">{{ err }}</p>
      <p v-if="pcErr" class="aerr" data-testid="task-pc-error">{{ pcErr }}</p>
    </div>
    <div v-if="full" class="bar">
      <button class="pill press" :aria-label="`계획, ${c.steps?.length}단계 중 ${done} 완료`" @click="showPlan = !showPlan"><Icon name="plan" :size="16" /> 계획 {{ done }}/{{ c.steps?.length }}</button>
      <!-- one of three: the PC went off — 서버에서 이어서; else 직접 제어, or 제어 돌려주기 while taking over -->
      <button v-if="offline" class="pill press on" data-testid="task-to-server" @click="routeTo('server')"><Icon name="refresh" :size="16" /> 서버에서 이어서</button>
      <button v-else-if="!takeover" class="pill press" data-testid="task-take-control" @click="takeover = true"><Icon name="hand" :size="16" /> 직접 제어</button>
      <button v-else class="pill press on" data-testid="task-give-back" @click="finishTakeover"><Icon name="check" :size="16" /> 제어 돌려주기</button>
      <button v-if="onPc && (running || needs || pcKept)" class="pill press" data-testid="task-show-pc" @click="showOnPc"><Icon name="expand" :size="16" /> 이 PC에서 보기</button>
      <button v-if="running || needs || queued" class="pill press" @click="cancel">작업 취소</button>
    </div>
    <input v-if="full && takeover && touch" ref="kbd" class="kbd" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go"
      placeholder="화면의 칸을 누르고 여기에 입력해요" data-testid="takeover-kbd" @input="onKbInput" @keydown.enter="onKbEnter" />

  </div>
</template>

<style scoped>
.task { width: 100%; min-width: 0; }
.screen { position: relative; aspect-ratio: 16 / 10; border-radius: 24px; overflow: hidden; background: #fff; box-shadow: var(--shadow-card); outline: 0; }
.screen img { width: 100%; height: 100%; object-fit: cover; object-position: top; display: block; }
.screen.takeover { box-shadow: 0 0 0 3px var(--color-attention), var(--shadow-card); cursor: crosshair; }
.blank { position: absolute; inset: 0; display: grid; place-items: center; background: #f3f5fa; font-size: 15px; --text-tertiary: rgba(29 29 31 / .3); --text-primary: #1d1d1f; }
.blank .still { color: rgba(29 29 31 / .45); }
.screen.bare { aspect-ratio: auto; height: 64px; }
/* where it runs: the person's own PC (or this server, when it moved there) — a small label at the screen's top left */
.where { position: absolute; left: 12px; top: 12px; max-width: 60%; height: 28px; padding: 0 12px; border-radius: 9999px; display: inline-flex; align-items: center;
  background: rgba(255 255 255 / .92); color: #1d1d1f; font-size: 13px; font-weight: 500; box-shadow: 0 2px 10px rgba(0 0 0 / .12); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; pointer-events: none; }
.where.pc::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #0F9D58; margin-right: 7px; flex: none; }
/* where the agent clicks: a ring that swells and fades (0.8 s), a dot at its middle */
.rings { position: absolute; inset: 0; pointer-events: none; }
.ring { position: absolute; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid rgba(26 115 232 / .95); background: rgba(26 115 232 / .16);
  box-shadow: 0 0 0 2px rgba(255 255 255 / .7); animation: ripple .8s cubic-bezier(.2, .7, .3, 1) forwards; }
.ring::after { content: ''; position: absolute; left: 50%; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: rgba(26 115 232 / .95); }
.ring.type { border-color: rgba(124 58 237 / .95); background: rgba(124 58 237 / .14); }
.ring.type::after { background: rgba(124 58 237 / .95); }
.full .ring { width: 60px; height: 60px; margin: -30px 0 0 -30px; }
@keyframes ripple { 0% { transform: scale(.3); opacity: 1; } 60% { opacity: .95; } 100% { transform: scale(1.5); opacity: 0; } }
.ctl { position: absolute; left: 12px; right: 12px; bottom: 12px; display: flex; gap: 8px; justify-content: flex-end; }
.title { margin-right: auto; min-width: 0; max-width: 72%; height: 40px; padding: 0 16px 0 14px; border-radius: 9999px; display: flex; align-items: center; gap: 10px; background: rgba(255 255 255 / .94); color: #1d1d1f; font-size: 14px; box-shadow: 0 2px 12px rgba(0 0 0 / .12); }
.tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
/* the old line goes at once (never a blank pill while lines come fast), the new one slides in */
.line-enter-active { transition: opacity .25s, translate .25s; }
.line-enter-from { opacity: 0; translate: 0 6px; }
.line-leave-active { display: none; }
.title.wait { color: rgba(29 29 31 / .65); }
.title.review { color: #b25000; }
.dots { position: relative; width: 14px; height: 14px; flex: none; animation: spin 1.4s linear infinite; }
.dots i { position: absolute; width: 4.5px; height: 4.5px; border-radius: 50%; background: #1d1d1f; }
.dots i:nth-child(1) { left: 5px; top: 0; } .dots i:nth-child(2) { left: 0; bottom: 1px; opacity: .7; } .dots i:nth-child(3) { right: 0; bottom: 1px; opacity: .45; }
.round { flex: none; width: 40px; height: 40px; border-radius: 9999px; display: grid; place-items: center; background: rgba(255 255 255 / .9); color: #1d1d1f; box-shadow: 0 2px 10px rgba(0 0 0 / .12); }
.attn { margin-right: auto; min-width: 0; max-width: 72%; height: 40px; padding: 0 14px; border-radius: 9999px; background: var(--color-attention); color: #fff; display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 500; animation: pop-in .4s var(--spring); }
.attn > :deep(svg) { flex: none; }
.ask { margin-top: 10px; padding: 14px 16px 16px; border-radius: 22px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(40px); backdrop-filter: blur(40px); box-shadow: var(--shadow-card); }
.ask.urgent { box-shadow: inset 0 0 0 1.5px rgba(255 77 0 / .55), var(--shadow-card); }
.why { margin: 0 0 12px; font-size: 15px; line-height: 1.55; color: var(--text-primary); white-space: pre-line; word-break: keep-all; overflow-wrap: anywhere; }
.acts { display: flex; flex-wrap: wrap; gap: 8px; }
.acts button { height: 48px; padding: 0 18px; border-radius: 9999px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; font-size: 15px; font-weight: 600; }
.acts .go { flex: 1 1 180px; background: var(--color-attention); color: #fff; box-shadow: 0 4px 14px rgba(255 77 0 / .28); }
.acts .sub { flex: 0 1 auto; background: rgba(127 127 127 / .13); color: var(--text-primary); font-weight: 500; }
.ask.stall { box-shadow: inset 0 0 0 1.5px rgba(178 80 0 / .4), var(--shadow-card); }
.ask.stall.inFull { width: min(92vw, 1024px, 112vh); margin: 12px auto 0; }
.ask.stall .why b { font-weight: 600; }
.ask.stall .secs { color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ask.stall .hint { margin: -4px 0 12px; font-size: 13.5px; line-height: 1.5; color: var(--text-secondary); word-break: keep-all; overflow-wrap: anywhere; }
.acts button:disabled { opacity: .55; }
.ask.queue .asked { margin: -4px 0 12px; padding: 10px 12px; border-radius: 14px; background: rgba(127 127 127 / .1); font-size: 14.5px; line-height: 1.5; overflow-wrap: anywhere; word-break: keep-all; }
.ask.queue .asked small { display: block; font-size: 12.5px; color: var(--text-secondary); margin-bottom: 2px; }
.ask.queue .acts .go { flex: 1 1 100%; }
.prog { position: absolute; right: 12px; top: 12px; height: 28px; padding: 0 12px; border-radius: 9999px; display: inline-flex; align-items: center; background: rgba(15 157 88 / .92); color: #fff; font-size: 13px; font-weight: 600; box-shadow: 0 2px 10px rgba(0 0 0 / .12); pointer-events: none; }
.heard { margin: 8px 4px 0; display: flex; gap: 8px; align-items: baseline; font-size: 13.5px; line-height: 1.45; color: var(--text-secondary); overflow-wrap: anywhere; }
.heard b { flex: none; font-weight: 600; color: #0F9D58; }
.ask.vaultin { box-shadow: inset 0 0 0 1.5px rgba(15 157 88 / .45), var(--shadow-card); }
.ask.vaultin.inFull { width: min(92vw, 1024px, 112vh); margin: 12px auto 0; }
.ask.vaultin .why { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-bottom: 4px; }
.ask.vaultin .why :deep(svg) { flex: none; color: #0F9D58; }
.ask.vaultin .why b { font-weight: 600; }
.ask.vaultin .vsite { color: var(--text-secondary); overflow-wrap: anywhere; }
.ask.vaultin .hint { margin: 0; font-size: 13.5px; line-height: 1.5; color: var(--text-secondary); word-break: keep-all; overflow-wrap: anywhere; }
.aerr { margin: 10px 2px 0; font-size: 13.5px; line-height: 1.45; color: var(--color-error); }
.meta { display: flex; justify-content: space-between; align-items: center; padding: 8px 6px 0; font-size: 14px; color: var(--text-secondary); }
.steps { font-size: 13px; color: var(--text-tertiary); }
.plan { position: absolute; inset: 16px; border-radius: 18px; padding: 18px 22px; overflow: auto; color: #1d1d1f; --regular-bg: rgba(255 255 255 / .82); cursor: default; }
.ph { display: flex; justify-content: space-between; font-size: 16px; margin-bottom: 10px; }
.plan ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
.plan li { display: grid; grid-template-columns: 22px 1fr; align-items: start; font-size: 15px; line-height: 1.45; color: rgba(29 29 31 / .5); }
.plan li.done { color: #1d1d1f; }
.plan li small { grid-column: 2; color: rgba(29 29 31 / .45); }
.dot { width: 8px; height: 8px; border-radius: 9999px; background: rgba(29 29 31 / .2); margin-top: 7px; }
li.done .dot { background: #0F9D58; }
.full .screen { width: min(92vw, 1024px, 112vh); margin: 0 auto; } /* keeps 16/10, the browser's own shape: nothing cropped, and a click lands where it is seen */
.bar { display: flex; justify-content: center; gap: 8px; margin-top: 16px; }
.pill { height: 40px; padding: 0 16px; border-radius: 9999px; background: rgba(255 255 255 / .92); color: #1d1d1f; display: flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 500; }
.pill.on { background: var(--color-attention); color: #fff; }
.kbd { display: block; width: min(92vw, 520px); height: 48px; margin: 12px auto 0; padding: 0 18px; border-radius: 24px; border: 0; outline: 0; font-size: 16px; color: #1d1d1f; background: rgba(255 255 255 / .94); box-shadow: 0 0 0 2px var(--color-attention); }
</style>
