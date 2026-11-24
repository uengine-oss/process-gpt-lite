<script setup>
// The composer's agent picker (src/chatAgent.js · server lib/localAgents/chat.js): a chip next to send naming who answers this message —
// 「기본」 (the server's business agent) or a CLI on my own PC (「Claude Code · 내 PC」 · 「Codex · 내 PC」, only those my desktop app
// reports). When no PC app is on, the local ones show off with why, and a link to the desktop app. The choice is kept per chat (key).
// Inside the desktop app the page can tell more than the server (localRunner.js hereWhy): an app too old to link this computer, a pairing
// that failed or was undone, a link on its way — said instead of 「install the desktop app」, with 「이 컴퓨터 연결」 or the newest app's link.
// Keyboard: the chip opens with Enter · Space · ↑ · ↓; in the list ↑ ↓ Home End move, Enter · Space pick, Esc · Tab close.
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { chatAgents, refreshAgents, choiceOf, choose, isLocal, agentFor } from '../chatAgent.js'
import { runner, hereWhy, desktopApp, olderVersion, pairThis } from '../localRunner.js'
import { useApp } from '../stores/app.js'

// row: on its own line over the composer's box (a phone)
const props = defineProps({ chatKey: { type: String, required: true }, row: Boolean })
const open = ref(false)
const root = ref(null)
const btn = ref(null)
const list = ref(null)
const at = ref(0)
const uid = `ca-${Math.random().toString(36).slice(2, 8)}`

const chosen = computed(() => choiceOf(props.chatKey))
// what the message goes to now (a CLI no desktop reports any more: 기본)
const effective = computed(() => agentFor(props.chatKey))
const app = useApp()
// this computer, when the page runs in the desktop app and no desktop of the person is on (null otherwise)
const here = computed(() => (chatAgents.desktop?.online ? null : hereWhy(app.me?.user?.id)))
const HERE_WHY = {
  old: 'PC 앱이 오래돼 이 컴퓨터를 연결할 수 없어요 — 업데이트하면 쓸 수 있어요',
  error: '이 컴퓨터를 연결하지 못했어요 — 다시 연결해 주세요',
  refused: '서버가 이 컴퓨터의 연결을 끊었어요 — 다시 연결해 주세요',
  unpaired: '이 컴퓨터는 연결을 해제해 두었어요 — 다시 연결하면 쓸 수 있어요',
  connecting: '이 컴퓨터가 서버에 연결 중이에요',
}
const items = computed(() => chatAgents.agents.map((a) => (here.value && a.id !== 'default' && !a.available ? { ...a, why: HERE_WHY[here.value.kind] } : a)))
const current = computed(() => items.value.find((a) => a.id === effective.value) || items.value[0])
const off = computed(() => isLocal(effective.value) && current.value && !current.value.available)
const noPc = computed(() => !chatAgents.desktop?.online)
// the app this page runs in, and a newer one to offer (the server reads the newest release: desktop.latest)
const appVersion = computed(() => desktopApp()?.version || '')
const newer = computed(() => (desktopApp() && olderVersion(appVersion.value, chatAgents.desktop?.latest) ? chatAgents.desktop.latest : ''))
const canPair = computed(() => ['error', 'refused', 'unpaired'].includes(here.value?.kind))
const pairing = ref(false)
async function pairHere() {
  if (pairing.value) return
  pairing.value = true
  try { await pairThis(app.me) } catch (e) { runner.error = runner.error || e.message } finally { pairing.value = false }
  refreshAgents(props.chatKey)
}
const title = (a) => (a.id === 'default' ? a.label : `${a.label} · ${a.where}`)

watch(() => props.chatKey, (k) => { if (k) refreshAgents(k) }, { immediate: true })
// the PC app came on or went off (server 'local_presence', stores/app.js): what is offered now
function onPresence() { refreshAgents(props.chatKey) }
onMounted(() => window.addEventListener('pgl:local-presence', onPresence))

const outside = (e) => { if (!root.value?.contains(e.target)) close(false) }
// on a phone the list spans the screen above the chip (16px from each side) — the chip sits mid-composer, a list hung from it would run off
const place = ref({})
function measure() {
  const r = btn.value?.getBoundingClientRect()
  place.value = r && window.innerWidth <= 480 ? { position: 'fixed', left: '16px', right: '16px', width: 'auto', bottom: `${Math.round(window.innerHeight - r.top + 6)}px` } : {}
}
async function show() {
  if (open.value) return
  measure()
  open.value = true
  at.value = Math.max(0, items.value.findIndex((a) => a.id === effective.value))
  document.addEventListener('pointerdown', outside, true)
  refreshAgents(props.chatKey)
  await nextTick()
  focusAt()
}
function close(refocus = true) {
  if (!open.value) return
  open.value = false
  document.removeEventListener('pointerdown', outside, true)
  if (refocus) nextTick(() => btn.value?.focus())
}
onBeforeUnmount(() => { close(false); window.removeEventListener('pgl:local-presence', onPresence) })
function focusAt() { list.value?.querySelectorAll('[role=option]')[at.value]?.focus() }
async function pick(a) {
  if (!a.available && a.id !== 'default') return
  close()
  if (a.id !== chosen.value) await choose(props.chatKey, a.id)
}
function onBtnKey(e) {
  if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); show() }
}
function onListKey(e) {
  const n = items.value.length
  // (the option that has the focus — a pointer resting over the list must not change what Enter picks)
  const here = [...(list.value?.querySelectorAll('[role=option]') || [])].indexOf(e.target)
  if (here >= 0) at.value = here
  if (e.key === 'ArrowDown') { e.preventDefault(); at.value = (at.value + 1) % n; focusAt() }
  else if (e.key === 'ArrowUp') { e.preventDefault(); at.value = (at.value - 1 + n) % n; focusAt() }
  else if (e.key === 'Home') { e.preventDefault(); at.value = 0; focusAt() }
  else if (e.key === 'End') { e.preventDefault(); at.value = n - 1; focusAt() }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(items.value[at.value]) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
  else if (e.key === 'Tab') {
    // (:scope — the chat page's own .foot holds this picker)
    const foot = !e.shiftKey && root.value?.querySelector(':scope .menu .foot a, :scope .menu .foot button')
    if (foot) { e.preventDefault(); foot.focus() } else close(false)
  }
}
function onFootKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() } }
</script>

<template>
  <span ref="root" class="ca" :class="{ row }" data-test="chat-agent" :data-agent="effective" :data-off="off ? 'yes' : 'no'">
    <button ref="btn" type="button" class="chip press" :class="{ local: isLocal(effective), off }" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="`${uid}-list`"
      :aria-label="`보낼 에이전트: ${title(current)}${off ? ` — ${current.why || ''}` : ''}`" :title="off ? current.why : title(current)" data-test="chat-agent-chip"
      @click="open ? close() : show()" @keydown="onBtnKey">
      <span class="dot" aria-hidden="true" />
      <span class="lb">{{ current.label }}</span><span v-if="isLocal(effective)" class="wh"> · {{ current.where }}</span>
      <svg class="car" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 6.5 5 3.5 8 6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>
    </button>
    <Transition name="fade">
      <div v-if="open" class="menu glass" :style="place" data-test="chat-agent-menu">
        <p class="cap" :id="`${uid}-cap`">이 대화에서 메시지를 받을 에이전트</p>
        <ul :id="`${uid}-list`" ref="list" role="listbox" :aria-labelledby="`${uid}-cap`" @keydown="onListKey">
          <li v-for="(a, i) in items" :id="`${uid}-o${i}`" :key="a.id" role="option" tabindex="-1" class="opt" :class="{ on: a.id === effective, dis: !a.available }"
            :aria-selected="a.id === effective" :aria-disabled="!a.available" :data-agent="a.id" data-test="chat-agent-option" @click="pick(a)">
            <span class="ck" aria-hidden="true">{{ a.id === effective ? '✓' : '' }}</span>
            <span class="tx">
              <b>{{ title(a) }}</b>
              <small v-if="a.id === 'default'">{{ a.where }}</small>
              <small v-else-if="a.available && a.devices?.length">{{ a.devices.join(' · ') }}<template v-if="a.note"> · {{ a.note }}</template></small>
              <small v-if="!a.available" class="why" data-test="chat-agent-why">{{ a.why }}</small>
            </span>
          </li>
        </ul>
        <p v-if="here?.kind === 'old'" class="foot" data-test="chat-agent-old" @keydown="onFootKey">
          <span v-if="appVersion">{{ newer ? `지금 쓰는 PC 앱은 ${appVersion} 버전, 최신은 ${newer} 버전이에요` : `지금 쓰는 PC 앱은 ${appVersion} 버전이에요` }}</span>
          <a v-if="chatAgents.download" :href="chatAgents.download" target="_blank" rel="noopener" data-test="chat-agent-update">최신 버전 받기</a>
        </p>
        <p v-else-if="canPair" class="foot" data-test="chat-agent-pair" @keydown="onFootKey">
          <span>연결하면 이 컴퓨터의 Claude Code · Codex로 보낼 수 있어요</span>
          <button type="button" class="lnk" :disabled="pairing" data-test="chat-agent-pair-btn" @click="pairHere">이 컴퓨터 연결</button>
        </p>
        <p v-else-if="here?.kind === 'connecting'" class="foot" data-test="chat-agent-connecting"><span>연결되면 바로 고를 수 있어요</span></p>
        <p v-else-if="noPc" class="foot" data-test="chat-agent-nopc">
          <span>{{ chatAgents.desktop?.linked ? 'PC 앱을 켜면 내 PC 의 Claude Code · Codex 로 보낼 수 있어요' : '내 PC 의 Claude Code · Codex 는 Process GPT Lite 데스크톱 앱으로 써요' }}</span>
          <a v-if="chatAgents.download" :href="chatAgents.download" target="_blank" rel="noopener" data-test="chat-agent-download">PC 앱 내려받기</a>
        </p>
        <p v-else-if="!items.some((a) => a.id !== 'default')" class="foot" data-test="chat-agent-nocli"><span>연결된 PC 에 Claude Code · Codex 가 없어요 — 설치한 뒤 PC 앱의 설정에서 「다시 찾기」를 눌러 주세요</span></p>
        <!-- a newer desktop app (this page runs in an older one), or a linked PC too old for chat (the server's row says so) -->
        <p v-if="here?.kind !== 'old' && chatAgents.download && (newer || items.some((a) => a.update))" class="foot" data-test="chat-agent-newer" @keydown="onFootKey">
          <span v-if="newer">PC 앱 새 버전({{ newer }})이 나왔어요</span>
          <a :href="chatAgents.download" target="_blank" rel="noopener">{{ newer ? '내려받기' : '최신 버전 받기' }}</a>
        </p>
      </div>
    </Transition>
  </span>
</template>

<style scoped>
.ca { position: relative; display: inline-flex; align-items: flex-end; flex: none; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 30px; margin: 9px 2px; padding: 0 9px 0 8px; border-radius: 15px; font-size: 12.5px; color: var(--text-secondary);
  background: var(--cell-bg); border: 1px solid var(--hairline); max-width: 168px; white-space: nowrap; }
.chip:hover { color: var(--text-primary); }
.chip:focus-visible { outline: 2px solid var(--color-info); outline-offset: 1px; }
.chip .lb { overflow: hidden; text-overflow: ellipsis; color: var(--text-primary); font-weight: 500; }
.chip .wh { flex: none; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
.chip.local .dot { background: var(--color-success); }
.chip.off .dot { background: var(--color-attention); }
.chip.off { border-color: color-mix(in srgb, var(--color-attention) 55%, transparent); }
.car { flex: none; opacity: .7; }
.menu { position: absolute; right: -4px; bottom: calc(100% + 6px); z-index: 30; border-radius: 16px; padding: 8px; width: 300px; max-width: calc(100vw - 32px);
  box-shadow: var(--shadow-card); --regular-bg: var(--regular-solid-bg); display: flex; flex-direction: column; gap: 4px; }
.cap { margin: 2px 8px 4px; font-size: 12px; color: var(--text-secondary); }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; outline: none; }
.opt { display: flex; align-items: flex-start; gap: 8px; padding: 9px 10px; border-radius: 10px; cursor: pointer; color: var(--text-primary); min-height: 44px; box-sizing: border-box; }
.opt:hover, .opt:focus { background: var(--cell-bg); outline: none; }
.opt:focus-visible { box-shadow: inset 0 0 0 2px var(--color-info); }
.opt.dis { cursor: default; }
.opt.dis b { color: var(--text-secondary); }
.ck { width: 14px; flex: none; color: var(--color-info); font-weight: 700; line-height: 20px; }
.tx { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.tx b { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.tx small { font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
.tx small.why { color: var(--color-attention); }
.foot { margin: 4px 8px 2px; padding-top: 8px; border-top: 1px solid var(--hairline); font-size: 12px; color: var(--text-secondary); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.foot a, .foot .lnk { color: var(--color-info); font-weight: 600; text-decoration: underline; }
.foot .lnk { background: none; border: 0; padding: 0; font: inherit; cursor: pointer; }
.foot .lnk:disabled { opacity: .6; cursor: default; }
.foot a:focus-visible, .foot .lnk:focus-visible { outline: 2px solid var(--color-info); outline-offset: 2px; border-radius: 4px; }
.row .chip { margin: 0; max-width: 100%; background: var(--thin-bg); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); }
</style>
