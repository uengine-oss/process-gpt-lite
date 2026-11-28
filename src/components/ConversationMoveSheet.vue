<script setup>
// 「프로젝트로 옮기기」 — 걸러 본 대화(쓰레드)를 통째로 프로젝트로 (2026-11-28 사용자: 「필터링된 채팅방 자체를 프로젝트로 이관하는 기능. 이관 후엔 이 채팅
// 내용은 프로젝트에서만 볼 수 있음. 기존 채팅 목록에서는 제거됩니다... 라는 알림도 줘야」 — spec thread-to-project, server lib/conversationMove.js).
// Opened from the conversation's bar (ConversationBar 「다른 대화 ▾」): the person's projects (one they may no longer write in shows why and
// cannot be picked) or 「새 프로젝트로」 (the confirm card of 「프로젝트로 시작」 — its 「만들고 옮기기」 makes the project and moves it there).
// Before the move: what happens to it, in words — only in the project from now on, gone from the chat's list and 전체 대화 — and, when
// the project works in a shared folder other people are members of, that they will see what it makes there: confirmed once more (a box
// to tick; the server refuses without it). Done: the page goes to the project's conversation.
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { topicPath } from '../projectTopics.js'
import { wideLayout } from '../viewport.js'
import { moveNotice, membersLine, movedNotice, followedNotice, projectLine } from '../convMove.js'

const app = useApp()
const router = useRouter()
const s = computed(() => app.moveSheet)
const step = ref('pick')        // pick · confirm
const data = ref(null)
const loadErr = ref('')
const picked = ref(null)
const membersOk = ref(false)
const members = ref([])         // who else sees what it makes (the server's list, or what its refusal named)
const busy = ref(false)
const err = ref('')
const find = ref('')
const sheet = ref(null)
const conv = computed(() => data.value?.conversation || null)
const count = computed(() => conv.value?.count ?? s.value?.count ?? 0)
const title = computed(() => conv.value?.title || s.value?.title || '대화')
const projects = computed(() => {
  const all = data.value?.projects || []
  const w = find.value.trim().toLowerCase()
  // (plain text, for finding a row in a long list — never a reading of what anyone means)
  return w ? all.filter((p) => String(p.title || '').toLowerCase().includes(w)) : all
})
const notice = computed(() => (picked.value ? moveNotice({ count: count.value, project: picked.value.title }) : ''))
const membersSay = computed(() => (picked.value && members.value.length ? membersLine({ folder: picked.value.folder?.name, members: members.value }) : ''))
const canGo = computed(() => !!picked.value && !busy.value && (!members.value.length || membersOk.value))

async function load() {
  loadErr.value = ''
  data.value = null
  try { data.value = await app.moveTargets(s.value.conv) } catch (e) { loadErr.value = e.message }
  // (moved meanwhile — another screen: it is there already)
  if (data.value?.place) { close(); go(data.value.place); return }
  // opened for the project the person named (the card 「…로 옮기기」 — ConvMoveCard.vue): straight to what the move does
  const named = s.value?.project && data.value?.projects?.find((p) => p.id === s.value.project && p.writable)
  if (named && data.value.conversation?.movable !== false) pick(named)
}
// (the focus at once — Esc closes it while the projects still load; opened from the list's row, the focus was left on the row's button);
// closed, the focus goes back to what opened it when that is still there (a row of a long list — PR #129 review)
const opener = typeof document !== 'undefined' ? document.activeElement : null
onMounted(() => { nextTick(() => sheet.value?.focus()); load() })
// (only a plain cancel: a move — or the card it opens — goes on to another view, and a text field opener would flash the keyboard)
let leaving = false
onBeforeUnmount(() => { if (!leaving && opener && opener !== document.body && opener.isConnected) opener.focus?.({ preventScroll: true }) })
watch(() => s.value?.conv, (v, old) => { if (v && v !== old) { step.value = 'pick'; picked.value = null; load() } })

function pick(p) {
  if (!p.writable) return
  picked.value = p
  members.value = p.members || []
  membersOk.value = false
  err.value = ''
  step.value = 'confirm'
}
function back() { step.value = 'pick'; err.value = '' }
function close() { app.moveSheet = null }
function go(place, text) {
  router.push(topicPath(place.project.id, place.topic || s.value?.conv))
  if (text) app.notice = { text, tone: 'ok' }
}
async function move() {
  if (!canGo.value) return
  busy.value = true
  err.value = ''
  const id = s.value.conv
  try {
    const r = await app.moveConversation(id, { project: picked.value.id, membersOk: membersOk.value })
    leaving = true
    close()
    go({ project: r.project, topic: r.topic || id }, movedNotice(r.project.title))
  } catch (e) {
    // members came meanwhile (or the list was old): they are said, and the box must be ticked
    if (e.code === 'confirm_members') { await load(); const p = data.value?.projects?.find((x) => x.id === picked.value.id); members.value = p?.members || members.value; membersOk.value = false }
    // moved elsewhere meanwhile (another screen): the page follows it there (PR #125 review 10)
    if (e.code === 'moved' && e.place?.project?.id) { leaving = true; close(); go(e.place, followedNotice(e.place.project.title)); return }
    err.value = e.message
  } finally { busy.value = false }
}
// 「새 프로젝트로」: the confirm card of 「프로젝트로 시작」 for this conversation, brought into view (its 「만들고 옮기기」 does the rest)
async function toNew() {
  busy.value = true
  err.value = ''
  const mine = app.moveSheet
  try {
    const conv = s.value.conv
    const { offer } = await app.moveOffer(conv)
    if (offer) { const list = (app.messages[offer.thread_id] ||= []); if (!list.some((m) => m.id === offer.id)) list.push(offer) }
    // (closed — or another conversation's sheet opened — while the card was being drafted, a model's few seconds: the card is in the
    // chat, and the person is left where they went — PR #129 last check 1)
    if (app.moveSheet !== mine || !offer) return
    leaving = true
    close()
    // (opened from the conversation list — PR #129 review 1: on a phone the list is a sheet and the chat under it is not there, on a wide
    // screen another conversation may be the one shown; the card is filed in this conversation) — the chat of this conversation first
    if (app.mode !== 'chat' || app.convFilter !== conv) await router.push(`/chat/c/${encodeURIComponent(conv)}`)
    if (app.threadList && !wideLayout.value) app.setThreadList(false)
    let row = null
    for (let i = 0; i < 30 && !row; i++) { await nextTick(); row = document.querySelector(`.row[data-id="${offer.id}"]`); if (!row) await new Promise((ok) => setTimeout(ok, 40)) }
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } catch (e) {
    if (app.moveSheet !== mine) return
    if (e.code === 'moved' && e.place?.project?.id) { leaving = true; close(); go(e.place, followedNotice(e.place.project.title)); return }
    err.value = e.message
  } finally { busy.value = false }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="s" class="veil" data-test="move-veil" @click.self="close">
      <div ref="sheet" class="sheet glass blur-in" role="dialog" aria-modal="true" aria-label="프로젝트로 옮기기" tabindex="-1" data-test="conv-move" :data-step="step"
        :aria-busy="!data && !loadErr ? 'true' : undefined" @keydown.esc.stop.prevent="close">
        <header>
          <button v-if="step === 'confirm'" class="x press" aria-label="뒤로" data-test="move-back" @click="back"><Icon name="back" :size="17" /></button>
          <div class="hd">
            <h2>{{ step === 'confirm' ? '옮기기 전에 확인해 주세요' : '프로젝트로 옮기기' }}</h2>
            <p class="sub"><span data-no-i18n>「{{ title }}」</span> · 메시지 {{ count }}개</p>
          </div>
          <button class="x press" aria-label="닫기" data-test="move-close" @click="close"><Icon name="close" :size="17" /></button>
        </header>

        <template v-if="step === 'pick'">
          <p v-if="loadErr" class="err" data-test="move-load-error">{{ loadErr }}</p>
          <p v-else-if="!data" class="wait shimmer-text">프로젝트를 불러오는 중…</p>
          <template v-else-if="conv && conv.movable === false">
            <p class="err" role="alert" data-test="move-refused" :data-code="conv.code">{{ conv.why }}</p>
          </template>
          <template v-else>
            <p class="says" data-test="move-intro">옮긴 대화는 고른 프로젝트에서만 볼 수 있어요. 채팅 목록과 전체 대화에서는 사라져요.</p>
            <button class="mi press" data-test="move-new" :disabled="busy" @click="toNew">
              <span class="ic"><Icon name="plus" :size="18" /></span>
              <span class="mt"><b>새 프로젝트로 옮기기</b><small>이 대화로 새 프로젝트를 만들어 옮겨요 · 이름과 템플릿을 먼저 확인해요</small></span><Icon name="chevron" :size="14" />
            </button>
            <p class="sec">내 프로젝트</p>
            <label v-if="(data.projects || []).length > 6" class="find"><Icon name="search" :size="15" /><input v-model="find" placeholder="프로젝트 찾기" data-test="move-find" /></label>
            <div class="list" role="listbox" aria-label="옮길 프로젝트">
              <button v-for="p in projects" :key="p.id" class="opt press" role="option" :aria-disabled="!p.writable" :disabled="!p.writable || busy"
                data-test="move-project" :data-project="p.id" :data-writable="p.writable ? '1' : '0'" @click="pick(p)">
                <span class="ic sm"><Icon name="folder" :size="16" /></span>
                <span class="nm"><b data-no-i18n>{{ p.title }}</b>
                  <small v-if="!p.writable" class="why" data-test="move-project-why">{{ p.why }}</small>
                  <small v-else-if="projectLine(p)" data-test="move-project-line">{{ projectLine(p) }}</small></span>
                <i v-if="p.writable && p.members?.length" class="tag" data-test="move-project-shared">구성원 {{ p.members.length }}명</i>
                <Icon v-if="p.writable" name="chevron" :size="14" />
              </button>
              <p v-if="!projects.length" class="none" data-test="move-no-projects">{{ find ? '맞는 프로젝트가 없어요' : '아직 프로젝트가 없어요 · 새 프로젝트로 옮길 수 있어요' }}</p>
            </div>
          </template>
          <p v-if="err" class="err" role="alert" data-test="move-error">{{ err }}</p>
        </template>

        <template v-else>
          <!-- (the words scroll on a short phone; 「옮기기」 stays on the sheet — PR #125 review 4) -->
          <div class="body" data-test="move-body">
            <div class="pv" data-test="move-route"><b><span data-no-i18n>「{{ title }}」</span> → 프로젝트 <span data-no-i18n>「{{ picked?.title }}」</span></b></div>
            <p class="notice" role="note" data-test="move-notice">{{ notice }}</p>
            <div v-if="membersSay" class="warn" role="alert" data-test="move-members">
              <p><Icon name="team" :size="15" /> <span>{{ membersSay }}</span></p>
              <label class="ok"><input v-model="membersOk" type="checkbox" data-test="move-members-ok" /> 구성원도 볼 수 있다는 것을 확인했어요</label>
            </div>
            <p class="says">프로젝트의 이 대화에서 「채팅으로 되돌리기」를 누르면 다시 채팅으로 가져와요.</p>
            <p v-if="err" class="err" role="alert" data-test="move-error">{{ err }}</p>
          </div>
          <footer>
            <button class="cancel press" :disabled="busy" @click="back">뒤로</button>
            <button class="go press" :disabled="!canGo" data-test="move-go" @click="move">{{ busy ? '옮기는 중…' : '옮기기' }}</button>
          </footer>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .28); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(460px, 100%); min-width: 0; box-sizing: border-box; max-height: min(80vh, 680px); max-height: min(80dvh, 680px); border-radius: 26px; padding: 16px 16px 14px;
  display: flex; flex-direction: column; gap: 10px; background: var(--regular-solid-bg, var(--bubble-agent-bg)); box-shadow: var(--shadow-card); color: var(--text-primary); overflow: hidden; }
.sheet:focus { outline: none; }
header { display: flex; align-items: flex-start; gap: 8px; }
.hd { flex: 1; min-width: 0; }
h2 { margin: 2px 0 0; font-size: 17px; font-weight: 600; }
.sub { margin: 3px 0 0; font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); flex: none; color: var(--text-primary); }
.says { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; word-break: keep-all; overflow-wrap: anywhere; }
.mi { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 8px 10px; border-radius: 16px; text-align: left; color: var(--text-primary); background: var(--cell-bg, rgba(127, 127, 127, .08)); }
.mi:disabled { opacity: .6; }
.ic { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; flex: none; background: var(--field-bg); }
.ic.sm { width: 30px; height: 30px; border-radius: 10px; }
.mt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mt b { font-size: 14.5px; font-weight: 600; }
.mt small { font-size: 12px; color: var(--text-secondary); line-height: 1.35; overflow-wrap: anywhere; }
.sec { margin: 4px 6px 0; font-size: 11.5px; font-weight: 600; color: var(--text-secondary); }
.find { display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 12px; border-radius: 12px; background: var(--field-bg); border: 1px solid var(--hairline); color: var(--text-secondary); }
.find input { flex: 1; min-width: 0; border: 0; background: transparent; outline: 0; color: var(--text-primary); font: inherit; font-size: 14px; }
.list { flex: 1; min-height: 80px; overflow: auto; display: flex; flex-direction: column; gap: 2px; }
.opt { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px; border-radius: 12px; text-align: left; color: var(--text-primary); }
.opt:hover:not(:disabled) { background: var(--cell-bg, rgba(127, 127, 127, .1)); }
.opt:disabled { cursor: default; }
.opt:disabled .nm b { color: var(--text-secondary); }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm b { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm small { font-size: 12px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm small.why { white-space: normal; color: var(--color-error, #c62828); }
.tag { font-style: normal; font-size: 11px; padding: 2px 7px; border-radius: 8px; background: rgba(42, 120, 214, .14); color: var(--color-info, #2a78d6); flex: none; }
.none, .wait { font-size: 13px; color: var(--text-secondary); margin: 8px 4px; }
.pv { padding: 10px 12px; border-radius: 14px; background: var(--cell-bg, rgba(127, 127, 127, .08)); border: 1px solid var(--hairline); min-width: 0; }
.pv b { display: block; font-size: 13.5px; font-weight: 600; overflow-wrap: anywhere; }
.notice { margin: 0; font-size: 14px; line-height: 1.5; word-break: keep-all; overflow-wrap: anywhere; }
.warn { padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255, 77, 0, .45); background: rgba(255, 77, 0, .08); display: flex; flex-direction: column; gap: 8px; }
.warn p { margin: 0; display: flex; gap: 6px; align-items: flex-start; font-size: 13px; line-height: 1.45; word-break: keep-all; overflow-wrap: anywhere; }
.warn p svg { flex: none; margin-top: 2px; }
.ok { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 500; }
.ok input { width: 18px; height: 18px; flex: none; accent-color: var(--color-attention); }
.err { margin: 0; color: var(--color-error, #c62828); font-size: 12.5px; overflow-wrap: anywhere; }
.body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; overscroll-behavior: contain; }
footer { display: flex; justify-content: flex-end; gap: 8px; flex: none; }
.cancel { height: 40px; padding: 0 16px; border-radius: 20px; background: var(--field-bg); font-size: 14px; }
.go { height: 40px; padding: 0 20px; border-radius: 20px; background: var(--text-primary); color: var(--ink-inverse, #fff); font-size: 14.5px; font-weight: 600; }
.go:disabled { opacity: .45; }
@media (max-width: 760px) {
  .veil { place-items: end stretch; padding: 0; }
  .sheet { width: 100%; max-height: 86dvh; border-radius: 26px 26px 0 0; padding-bottom: max(14px, env(safe-area-inset-bottom)); }
}
</style>
