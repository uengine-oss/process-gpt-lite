<script setup>
// The chat's thread list (2026-11-24: 「채팅을 더블클릭하면 프로젝트에서의 목록처럼 왼편에 묶음 처리된 쓰레드 목록이 쭉 나와서 필터링됨」 —
// spec openspec/specs/chat-thread-list): the conversations the context router told apart in the main chat, newest first, in the left
// column where Home's dock is (a sheet over the chat on a phone). A row narrows the chat to that conversation — the same
// /chat/c/:cid as the conversation bar over the chat (components/ConversationBar.vue), so the two always agree; 「전체 대화」 is
// the whole chat again. The rows come from the store (app.convList: the router's rows with the chat's message counts).
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { sortThreads, filterThreads, threadLine, whenText, movable } from '../threadList.js'
import { hold as vHold } from './holdMenu.js'
import { touchOnly } from '../holdHint.js'

// sheet: the list is a page of its own over the chat (a phone): picking a row closes it, and the chat shows that conversation
const props = defineProps({ sheet: { type: Boolean, default: false } })
const app = useApp()
const router = useRouter()
const el = ref(null)
const query = ref('')
const all = computed(() => sortThreads(app.convList))
const shown = computed(() => filterThreads(all.value, query.value))
const total = computed(() => (app.messages[app.mainThread?.id] || []).length)

// a conversation of its own (server lib/ownConversations.js): a scheduled task's has the clock, the briefs' the sun, a mail's the envelope
const KIND_ICON = { schedule: 'clock', brief: 'sun', mail: 'mail' }
const KIND_LABEL = { schedule: '예약 작업', brief: '브리프', mail: '메일' }
// 「프로젝트로 옮기기」 from the list too (2026-11-28 사용자 「쓰레드 내용을 곧바로 프로젝트로 만드는 기능 어떻게 되고 있니?」 — it was only in the
// conversation bar's 「다른 대화 ▾」): a long press (phone), a right-click or the folder button (PC) opens the same sheet
// (ConversationMoveSheet.vue — spec thread-to-project). Not for the standing conversations — a scheduled task's, the briefs' — whose
// runs keep arriving in the chat (server lib/conversationMove.js STANDING), nor for an empty one.
function moveFrom(c) { if (movable(c)) app.moveSheet = { conv: c.id, title: c.title || '제목 없는 대화', count: c.count } }
// the hint follows the input, not the width: a finger holds, a mouse right-clicks (a narrow desktop window has no long press, a tablet no
// right button — PR #129 review 4); said only when there is a conversation to move
const touch = touchOnly()
const anyMovable = computed(() => all.value.some(movable))
function pick(c) {
  router.push(c ? `/chat/c/${encodeURIComponent(c.id)}` : '/chat')
  if (props.sheet) app.setThreadList(false)
}
// opened inside a conversation: its row in view
onMounted(() => nextTick(() => el.value?.querySelector('.item.on:not(.all)')?.scrollIntoView({ block: 'nearest' })))
</script>

<template>
  <aside ref="el" class="tlist scroll" :class="{ mobile: sheet }" data-testid="thread-list" aria-label="대화 목록">
    <div class="head">
      <span class="title">대화</span>
      <small v-if="all.length" class="n">{{ all.length }}</small>
      <button class="x press" aria-label="대화 목록 닫기" title="대화 목록 닫기" data-testid="thread-list-close" @click="app.setThreadList(false)">
        <Icon name="close" :size="18" />
      </button>
    </div>
    <p class="cap">판단 모델이 주제별로 나눈 대화예요. 고르면 채팅이 그 대화만 보여 줘요.<template v-if="anyMovable"> <span data-testid="thread-move-hint">{{ touch ? '길게 누르면 프로젝트로 옮길 수 있어요.' : '오른쪽 단추로 누르면 프로젝트로 옮길 수 있어요.' }}</span></template></p>
    <label v-if="all.length" class="find">
      <Icon name="search" :size="16" />
      <input v-model="query" type="search" placeholder="대화 찾기" aria-label="대화 찾기" data-testid="thread-search" enterkeyhint="search" @keydown.esc="query = ''" />
    </label>

    <div class="items">
      <button class="item all" :class="{ on: !app.convFilter }" :aria-current="!app.convFilter ? 'true' : undefined" data-testid="thread-all" @click="pick(null)">
        <span class="row1"><span class="name">전체 대화</span></span>
        <span class="row2"><span class="line">모든 메시지를 한 흐름으로</span><span class="meta"><span class="count" :aria-label="`메시지 ${total}개`">{{ total }}</span></span></span>
      </button>
      <div v-for="c in shown" :key="c.id" class="rowwrap" :class="{ movable: movable(c) }">
        <!-- (held · right-clicked: 「프로젝트로 옮기기」 — a tap still picks the conversation) -->
        <button v-hold="movable(c) ? () => moveFrom(c) : null" data-hold-tap class="item" :class="{ on: c.id === app.convFilter }"
          :aria-current="c.id === app.convFilter ? 'true' : undefined" :data-conv="c.id" data-testid="thread-row" @click="pick(c)">
          <span class="row1">
            <span v-if="KIND_ICON[c.kind]" class="kind" :data-kind="c.kind" :title="KIND_LABEL[c.kind]" :aria-label="KIND_LABEL[c.kind]" data-testid="thread-kind"><Icon :name="KIND_ICON[c.kind]" :size="16" /></span>
            <span class="name">{{ c.title || '제목 없는 대화' }}</span>
          </span>
          <span class="row2"><span class="line">{{ threadLine(c) }}</span><span class="meta"><small class="when">{{ whenText(c.updated_at) }}</small><span class="count" :aria-label="`메시지 ${c.count}개`">{{ c.count }}</span></span></span>
        </button>
        <button v-if="movable(c)" class="mv press" data-testid="thread-move" :aria-label="`「${c.title || '제목 없는 대화'}」 프로젝트로 옮기기`" title="프로젝트로 옮기기" @click="moveFrom(c)">
          <Icon name="folder" :size="16" />
        </button>
      </div>
    </div>
    <p v-if="!all.length" class="empty" data-testid="thread-empty">아직 나뉜 대화가 없어요. 채팅에서 다른 주제를 물으면 판단 모델이 대화를 나눠 여기에 모아요.</p>
    <p v-else-if="!shown.length" class="empty" data-testid="thread-none">「{{ query }}」와 맞는 대화가 없어요.</p>
  </aside>
</template>

<style scoped>
/* the same column as the project and routine lists (ProjectList.vue, RoutineList.vue) — and their look (2026-11-28 사용자, a phone over a
   photo: 「채팅 쓰레드 너무 글씨가 흐려... 그냥 프로젝트 쪽과 같이」): big names in the project list's ink, the selected one by colour and
   weight; the line under a name at the secondary ink (the tertiary — 30% — vanished over a photo), the time and the count in one solid
   badge as the project list's 「작업 중」 */
.tlist { position: absolute; z-index: 5; top: 0; bottom: 0; left: 0; width: 420px; padding: 100px 40px 60px; overflow-x: hidden; overscroll-behavior: contain; }
.tlist.mobile { width: auto; right: 0; padding: 88px 24px 48px; }
.head { display: flex; align-items: center; gap: 10px; }
.title { font-size: 26px; line-height: 1.3; letter-spacing: -0.02em; font-weight: 500; color: var(--text-primary); }
.n { font-size: 14px; color: var(--text-secondary); }
.x { margin-left: auto; width: 36px; height: 36px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-secondary); background: var(--button-bg); }
.x:hover { color: var(--text-primary); }
.cap { margin: 6px 0 0; font-size: 13.5px; line-height: 1.45; color: var(--text-secondary); word-break: keep-all; }
.find { display: flex; align-items: center; gap: 8px; height: 40px; margin: 16px 0 10px; padding: 0 14px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.find input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; font: inherit; font-size: 15px; color: var(--text-primary); }
.find input::placeholder { color: var(--text-secondary); }
.find:focus-within { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 25%, transparent); }
.items { display: flex; flex-direction: column; }
.find + .items { margin-top: 0; }
.cap + .items { margin-top: 14px; }
.rowwrap { position: relative; display: flex; flex-direction: column; }
.item { display: flex; flex-direction: column; align-items: stretch; gap: 6px; min-width: 0; text-align: left; padding: 13px 0;
  color: var(--text-secondary); transition: color .3s; }
.item:hover { color: var(--text-primary); }
.item.on { color: var(--text-primary); }
.item.on .name { font-weight: 500; }
.row1, .row2 { display: flex; align-items: center; gap: 10px; min-width: 0; }
.name { flex: 1; min-width: 0; font-size: 26px; line-height: 1.3; letter-spacing: -0.02em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: keep-all; overflow-wrap: anywhere; }
/* a scheduled task's, the briefs', a mail's conversation: its icon before the title */
.kind { flex: none; align-self: center; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9999px; color: var(--text-primary); background: var(--bubble-user-bg); }
.line { flex: 1; min-width: 0; font-size: 14px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item.on .line, .item:hover .line { color: var(--text-primary); opacity: .78; }
.meta { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 9999px; font-size: 12.5px; font-weight: 500;
  color: var(--text-primary); background: var(--bubble-user-bg); }
.meta .when { font-size: inherit; color: inherit; }
.meta .when + .count::before { content: '·'; margin-right: 6px; opacity: .6; }
.count { font-size: inherit; }
.item.all { margin-bottom: 4px; }
.item.all .name { font-size: 20px; }
/* 「프로젝트로 옮기기」 beside a row: shown when the pointer is on the row or the button has the keyboard's focus; a phone holds the row instead
   (the button stays in the accessibility tree — a screen reader, a keyboard — but takes no room and no touch) */
.mv { position: absolute; top: 12px; right: -6px; width: 34px; height: 34px; border-radius: 17px; display: grid; place-items: center; color: var(--text-primary);
  background: var(--regular-solid-bg, var(--button-bg)); box-shadow: var(--shadow-card, 0 2px 10px rgba(0, 0, 0, .12)); opacity: 0; transition: opacity .2s; }
.mv:focus-visible { opacity: 1; }
/* (only where a pointer hovers: a finger's tap must not reveal a button — iOS then drops the tap as a hover menu; the room for it is kept
   always, so a long title does not wrap under the pointer — PR #129 review 2 · 5) */
@media (hover: hover) {
  .rowwrap:hover .mv { opacity: 1; }
  .rowwrap.movable .item .row1 { padding-right: 34px; }
}
@media (hover: none) {
  .mv:not(:focus-visible) { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; pointer-events: none; }
}
/* a phone's long press is the row's 「프로젝트로 옮기기」, never the system's text selection or callout */
@media (pointer: coarse) { .rowwrap.movable .item { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; } }
.empty { margin-top: 14px; font-size: 14.5px; line-height: 1.5; color: var(--text-secondary); }
.tlist.mobile .name { font-size: 22px; }
.tlist.mobile .item.all .name { font-size: 19px; }
</style>
