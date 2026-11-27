<script setup>
// 「작업실」 — where to open it (작업본은 한 곳에 P1, spec variation-seats): a variation is changed in one place at a time, so the button first
// asks where. In the desktop app (0.2.7) 「이 PC 에서 작업」 comes first and is the default (Enter): the server moves the seat to this computer
// and the app makes the working copy in its data folder (Finder · the person's terminal · their own CLI work on it there); 「서버 작업실에서
// 열기」 is the web workroom. In a browser only the server workroom — with a word on where the PC way is (the desktop app).
//   variation: one variation (its screen's 「작업실」) · none: the folder header's — my variations of this folder, a new one, and main
//   (main only in the server workroom, editors and up: it is where everyone's work meets — a PC works on a variation and merges it)
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import SeatPill from './SeatPill.vue'
import { folders as F } from '../../foldersApi.js'
import { bridge, inDesktop, oldDesktop, refreshPcSeats, pcSeatOf, thisDevice, seatWhy, TRUST } from '../../desktopSeats.js'
import { chatAgents, refreshAgents } from '../../chatAgent.js'

const props = defineProps({ slug: String, variation: { type: Object, default: null }, folderName: { type: String, default: '' } })
const emit = defineEmits(['close'])
const router = useRouter()
const choices = ref(null)      // GET /folders/:slug/workroom (the header's sheet)
const dev = ref(null)          // this app's device {deviceId, connected}
const busy = ref(null)         // {vid, what}
const err = ref('')
const title = ref('')
const first = ref(null)
// files of the variation that run things by themselves once on this PC (hooks · MCP · .envrc · VS Code tasks · Windows shell files): every
// one said before it comes here, with the name its commit gives (anyone can write any name in a commit — not who it really was). A check
// that could not be made is said as such, never taken for 「nothing there」. 「그래도 열기」 goes on, nothing is blocked (spec variation-seats)
const trust = ref(null) // {v, files, more, failed, head}
// (the commit the last check looked at, per variation — 「이 PC 에서 작업」 sends it; the server says 'moved' when the variation changed since)
const checked = new Map()

const desktop = inDesktop()
const old = oldDesktop()
const pcReady = computed(() => !!bridge() && !!dev.value?.deviceId && dev.value.connected)
const pcWhy = computed(() => (old ? '데스크톱 앱을 새 판(0.2.7)으로 바꾸면 이 PC 에서 작업할 수 있어요.'
  : !dev.value?.deviceId ? '이 PC 가 내 계정에 연결돼 있지 않아요 — 설정 › 내 컴퓨터의 에이전트에서 연결해 주세요.'
    : !dev.value.connected ? '이 PC 가 서버에 이어져 있지 않아요 — 다시 이어지면 할 수 있어요.' : ''))
const rows = computed(() => (props.variation ? [props.variation] : (choices.value?.mine || [])))

onMounted(async () => {
  if (bridge()) refreshPcSeats()
  if (desktop) dev.value = await thisDevice()
  else refreshAgents().catch(() => {})
  if (!props.variation) choices.value = await F.workroom(props.slug).catch((e) => { err.value = e.message; return { mine: [], devices: [], canMain: false } })
  await nextTick()
  first.value?.focus()
})

// where a variation of mine can open now: its seat says (put away · my server workroom · this PC); elsewhere → why not
const seatOf = (v) => v.seat || null
const here = (v) => pcSeatOf(v.id)
const mayPc = (v) => { const s = seatOf(v); return !s?.place || (s.mine && s.state === 'held' && s.place === 'server' && s.run === 'workroom') || (!!here(v) && s?.place === 'device') }
// (this PC's option cannot be pressed now — not linked, off, the seat elsewhere: the server workroom is the default instead)
const pcOff = (v) => !pcReady.value || !mayPc(v)
const mayServer = (v) => { const s = seatOf(v); return !s?.place || !!s.can?.open || !!s.can?.release || (!!here(v) && s?.place === 'device') }
function elsewhere(v) {
  const s = seatOf(v)
  if (!s?.place || mayPc(v) || mayServer(v)) return ''
  if (s.state !== 'held') return '작업본을 넘기는 중이에요 — 잠시 뒤에 다시 해 주세요.'
  if (s.place === 'device' && s.mine) return `${s.device?.name || '내 다른 PC'}에서 작업 중이에요 — 그 PC 에서 돌려놓거나 변형 화면에서 「여기로 가져오기」를 눌러 주세요.`
  if (s.place === 'server' && s.run === 'agent') return '서버 에이전트가 이 변형에서 일하는 중이에요.'
  return `${s.who?.name || ''} 님이 고치는 중이에요.`
}

async function onPc(v, { anyway = false, again = 0 } = {}) {
  err.value = ''
  if (here(v) && ['held', 'blocked'].includes(here(v).state)) { emit('close'); return router.push(`/workroom/variation/${v.id}`) }
  busy.value = { vid: v.id, what: 'pc' }
  try {
    if (!anyway) {
      const t = await F.seatTrust(props.slug, v.id).catch(() => ({ failed: true }))
      if (t?.failed || !Array.isArray(t?.files)) { trust.value = { v, files: [], more: 0, failed: true }; checked.delete(v.id); return }
      if (t.head) checked.set(v.id, t.head); else checked.delete(v.id)
      if (t.files.length) { trust.value = { v, files: t.files, more: t.more || 0 }; return }
    }
    trust.value = null
    dev.value = await thisDevice()
    if (!dev.value?.deviceId) throw new Error(seatWhy('not_linked'))
    try { await F.openOnPc(props.slug, v.id, dev.value.deviceId, checked.get(v.id) || null) } catch (e) {
      // (the variation changed after its files were shown: shown again — the person decides on what would come here now)
      if (e.why === 'moved' && again < 3) { busy.value = null; return onPc(v, { again: again + 1 }) }
      throw e
    }
    // (the server told this app to make the working copy: wait for it here — the app answers once it holds it)
    const r = await bridge().open(v.id)
    // (what this PC fetched is not what the server named — the variation moved: looked at again before anything comes here)
    if (!r?.ok && r?.why === 'moved' && again < 3) { busy.value = null; return onPc(v, { again: again + 1 }) }
    if (!r?.ok) throw new Error(seatWhy(r?.why))
    await refreshPcSeats()
    emit('close')
    router.push(`/workroom/variation/${v.id}`)
  } catch (e) { err.value = e.message } finally { busy.value = null }
}
async function onServer(v) {
  err.value = ''
  busy.value = { vid: v.id, what: 'server' }
  try {
    // (this PC has it: what is here goes up as it is and the working copy goes first — the seat is then free for the server workroom)
    if (here(v)) {
      const g = await bridge().release(v.id)
      if (!g?.ok) throw new Error(seatWhy(g?.why))
      await refreshPcSeats()
    }
    const r = await F.openSeat(props.slug, v.id); emit('close'); router.push(r.workroom)
  } catch (e) { err.value = e.message } finally { busy.value = null }
}
// 「새 작업본」: a variation of mine from main, then opened where the default says (this PC in the app, else the server workroom)
async function onNew() {
  const t = title.value.trim()
  if (!t) return
  err.value = ''
  busy.value = { vid: 'new', what: 'new' }
  let v
  try { v = await F.newVariation(props.slug, { title: t }) } catch (e) { err.value = e.message; busy.value = null; return }
  busy.value = null
  title.value = ''
  const row = { id: v.id, title: v.title, seat: null }
  if (choices.value) choices.value = { ...choices.value, mine: [row, ...(choices.value.mine || [])] }
  return pcReady.value ? onPc(row) : onServer(row)
}
const openMain = () => { emit('close'); router.push(`/workroom/folder/${props.slug}`) }
// the default option takes the focus (Enter opens it): this PC in the app, the server workroom in a browser — or in the app when this PC's
// option cannot be pressed now
const setFirst = (el, i, mine) => { if (el && i === 0 && mine) first.value = el }
const working = (v, what) => busy.value?.vid === v.id && busy.value.what === what
</script>

<template>
  <div class="veil" data-test="seat-sheet" @click.self="emit('close')" @keydown.esc="emit('close')">
    <div class="box glass" role="dialog" :aria-label="'작업실 — 어디서 열까요'">
      <header class="hd"><FIcon name="terminal" :size="19" /><b>작업실 — 어디서 열까요</b><span class="sp" /><button class="ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button></header>
      <div class="body scroll">
        <p class="lead">한 변형의 작업본은 한 번에 한 곳에만 있어요. 고르는 곳으로 옮겨 가고, 다른 곳에서는 올라온 데까지 읽기만 해요.</p>

        <!-- before it comes to this PC: what would run by itself there, and who put it (plain text only) -->
        <div v-if="trust" class="trust" data-test="seat-trust" role="alert">
          <template v-if="trust.failed">
            <b>저절로 실행되는 설정이 있는지 확인하지 못했어요</b>
            <small>서버에 묻지 못했어요. 이 변형에 훅 · MCP 서버 같은 설정이 있을 수 있어요 — 폴더의 파일을 확인한 뒤에 여세요.</small>
          </template>
          <template v-else>
            <b>이 작업본에는 저절로 실행될 수 있는 설정이 있어요</b>
            <small>이 PC 의 터미널에서 Claude Code · Codex · 편집기를 열면 아래 파일이 명령을 실행할 수 있어요.</small>
            <small>누가 바꿨는지 확인할 수 없어요 — 커밋에 적힌 이름은 누구나 적을 수 있어요. 내용을 확인한 뒤에 여세요.</small>
            <ul>
              <li v-for="f in trust.files" :key="f.path"><code>{{ f.path }}</code><span>{{ TRUST[f.reason] || f.reason }}</span><span v-if="f.author" class="by">{{ `커밋에 적힌 이름 · ${f.author}` }}</span></li>
            </ul>
            <small v-if="trust.more">{{ `그 밖에 ${trust.more}개` }}</small>
          </template>
          <div class="tacts">
            <button class="pill-btn" data-test="seat-trust-cancel" @click="trust = null">취소</button>
            <button class="dark-btn" data-test="seat-trust-open" :disabled="!!busy" @click="onPc(trust.v, { anyway: true })">그래도 열기</button>
          </div>
        </div>

        <section v-for="(v, i) in rows" :key="v.id" class="var" :data-variation="v.id">
          <div class="vh"><b class="vt">{{ v.title }}</b><SeatPill v-if="seatOf(v)?.place" :seat="seatOf(v)" :here="here(v)" compact /></div>
          <p v-if="elsewhere(v)" class="why">{{ elsewhere(v) }}</p>
          <div v-else class="opts">
            <button v-if="desktop" :ref="(el) => setFirst(el, i, !pcOff(v))" class="opt press" :class="{ main: !pcOff(v) }" data-test="seat-sheet-pc" :disabled="pcOff(v) || !!busy" @click="onPc(v)">
              <FIcon name="pc" :size="20" />
              <span><b>{{ here(v) ? '이 PC 의 작업본 열기' : working(v, 'pc') ? '이 PC 에 받는 중…' : '이 PC 에서 작업' }}</b>
                <small>{{ pcWhy || (here(v) ? '이미 이 PC 에 있어요.' : '앱 데이터 폴더에 받아 두고 Finder · 내 터미널 · 내 CLI 로 고쳐요. 고친 것은 저절로 이 변형에 올라가요.') }}</small></span>
            </button>
            <button :ref="(el) => setFirst(el, i, !desktop || pcOff(v))" class="opt press" :class="{ main: !desktop || pcOff(v) }" data-test="seat-sheet-server" :disabled="!mayServer(v) || !!busy" @click="onServer(v)">
              <FIcon name="terminal" :size="20" />
              <span><b>{{ working(v, 'server') ? '여는 중…' : '서버 작업실에서 열기' }}</b><small>웹의 파일 · 셸에서 고쳐요.{{ here(v) ? ' 이 PC 의 작업본은 먼저 올리고 치워요.' : '' }}</small></span>
            </button>
          </div>
        </section>

        <!-- the folder header: a new variation of mine, and main -->
        <template v-if="!variation && choices">
          <p v-if="!rows.length" class="fine">이 폴더에 내 작업본이 아직 없어요 — 새로 만들어 시작하세요.</p>
          <form class="new" data-test="seat-sheet-new" @submit.prevent="onNew">
            <input v-model="title" class="fld" placeholder="새 작업본의 이름 — 예: 마감일 추가" maxlength="80" />
            <button class="dark-btn" :disabled="!title.trim() || !!busy">{{ busy?.what === 'new' ? '만드는 중…' : '새 작업본' }}</button>
          </form>
          <button v-if="choices.canMain" class="opt mainline press" data-test="seat-sheet-main" :disabled="!!busy" @click="openMain">
            <FIcon name="branch" :size="20" />
            <span><b>main 을 서버 작업실에서 열기</b><small>여럿이 합친 줄이에요. PC 에서는 변형으로 고치고 반영해요.</small></span>
          </button>
        </template>

        <!-- a browser: the PC way is the desktop app's -->
        <p v-if="!desktop" class="note" data-test="seat-sheet-app">
          <FIcon name="pc" :size="15" />
          <span>내 PC 의 Finder · 터미널 · Claude Code · Codex 로 고치려면 데스크톱 앱에서 「작업실」 → 「이 PC 에서 작업」을 눌러 주세요.</span>
          <a v-if="chatAgents.download" :href="chatAgents.download" target="_blank" rel="noopener">PC 앱 내려받기</a>
        </p>
        <p v-else-if="old" class="note" data-test="seat-sheet-old"><FIcon name="pc" :size="15" /><span>{{ pcWhy }}</span></p>
        <button v-if="desktop && bridge()?.openTrash" class="lnk" data-test="seat-sheet-trash" @click="bridge().openTrash()">이 PC 의 앱 휴지통 열기</button>
        <p v-if="err" class="bad" role="alert">{{ err }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(560px, 100%); max-height: calc(100vh - 48px); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
/* (opaque: the folder's list behind it never shows through the options — f-wl-14 390 dark) */
.box.glass { background: rgb(255 255 255); }
:root[data-theme="dark"] .box.glass { background: rgb(29 29 31); }
.hd { display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; flex: none; }
.sp { flex: 1; }
.ic { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; background: var(--button-bg); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 20px; display: flex; flex-direction: column; gap: 12px; }
.lead { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.6; }
.var { display: flex; flex-direction: column; gap: 8px; }
.vh { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
.vt { font-weight: 600; font-size: 14.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.why { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.55; padding: 10px 12px; border-radius: 12px; background: var(--cell-bg); }
.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.opt { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border-radius: 16px; background: var(--cell-bg); border: 1.5px solid transparent; text-align: left; min-width: 0; }
.opt > svg { flex: none; margin-top: 1px; color: var(--text-secondary); }
.opt span { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.opt b { font-weight: 600; font-size: 14px; }
.opt small { font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.opt.main { border-color: var(--color-info); }
.opt.main > svg { color: var(--color-info); }
.opt:focus-visible { outline: 2px solid var(--color-info); outline-offset: 2px; }
.opt:disabled { opacity: .55; cursor: default; }
.mainline { width: 100%; }
.new { display: flex; gap: 8px; }
.fld { flex: 1; min-width: 0; height: 42px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--field-bg); padding: 0 12px; font-size: 14px; outline: 0; }
.new .dark-btn { height: 42px; flex: none; background: var(--ink); color: var(--ink-inverse); padding: 0 16px; border-radius: 21px; }
.new .dark-btn:disabled { opacity: .5; }
.note { margin: 0; display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; padding: 10px 12px; border-radius: 12px; background: var(--cell-bg); }
.note > svg { flex: none; margin-top: 2px; }
.note span { flex: 1 1 240px; min-width: 0; }
.note a { color: var(--color-info); font-weight: 500; }
.fine { font-size: 13px; color: var(--text-secondary); margin: 0; }
.bad { margin: 0; font-size: 13px; color: var(--color-error); }
.trust { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-radius: 14px; background: rgba(224 138 44 / .12); border: 1px solid rgba(224 138 44 / .45); font-size: 13px; }
.trust b { font-weight: 600; color: #b8691c; }
.trust small { color: var(--text-secondary); line-height: 1.55; font-size: 12.5px; }
.trust ul { margin: 2px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.trust li { display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; font-size: 12.5px; min-width: 0; }
.trust code { font: 12px "SF Mono", Menlo, monospace; overflow-wrap: anywhere; }
.trust .by { color: var(--text-secondary); }
.tacts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
.tacts > button { height: 36px; padding: 0 16px; border-radius: 18px; }
.tacts .dark-btn { background: var(--ink); color: var(--ink-inverse); }
:root[data-theme="dark"] .trust b { color: #ffc98a; }
.lnk { align-self: flex-start; font-size: 12.5px; color: var(--color-info); padding: 0; background: none; }
/* a phone: a sheet from the bottom, one option per line */
@media (max-width: 600px) {
  .veil { place-items: end stretch; padding: 0; }
  .box { width: 100%; border-radius: 24px 24px 0 0; max-height: 88vh; }
  .opts { grid-template-columns: 1fr; }
  .body { padding: 12px 16px 20px; }
}
</style>
