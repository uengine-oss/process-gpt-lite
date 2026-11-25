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
import { sortThreads, filterThreads, threadLine, whenText } from '../threadList.js'

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
    <p class="cap">판단 모델이 주제별로 나눈 대화예요. 고르면 채팅이 그 대화만 보여 줘요.</p>
    <label v-if="all.length" class="find">
      <Icon name="search" :size="16" />
      <input v-model="query" type="search" placeholder="대화 찾기" aria-label="대화 찾기" data-testid="thread-search" enterkeyhint="search" @keydown.esc="query = ''" />
    </label>

    <div class="items">
      <button class="item all" :class="{ on: !app.convFilter }" :aria-current="!app.convFilter ? 'true' : undefined" data-testid="thread-all" @click="pick(null)">
        <span class="row1"><span class="name">전체 대화</span></span>
        <span class="row2"><span class="line">모든 메시지를 한 흐름으로</span><span class="count" :aria-label="`메시지 ${total}개`">{{ total }}</span></span>
      </button>
      <button v-for="c in shown" :key="c.id" class="item" :class="{ on: c.id === app.convFilter }" :aria-current="c.id === app.convFilter ? 'true' : undefined"
        :data-conv="c.id" data-testid="thread-row" @click="pick(c)">
        <span class="row1">
          <span v-if="KIND_ICON[c.kind]" class="kind" :data-kind="c.kind" :title="KIND_LABEL[c.kind]" :aria-label="KIND_LABEL[c.kind]" data-testid="thread-kind"><Icon :name="KIND_ICON[c.kind]" :size="16" /></span>
          <span class="name">{{ c.title || '제목 없는 대화' }}</span><small class="when">{{ whenText(c.updated_at) }}</small>
        </span>
        <span class="row2"><span class="line">{{ threadLine(c) }}</span><span class="count" :aria-label="`메시지 ${c.count}개`">{{ c.count }}</span></span>
      </button>
    </div>
    <p v-if="!all.length" class="empty" data-testid="thread-empty">아직 나뉜 대화가 없어요. 채팅에서 다른 주제를 물으면 판단 모델이 대화를 나눠 여기에 모아요.</p>
    <p v-else-if="!shown.length" class="empty" data-testid="thread-none">「{{ query }}」와 맞는 대화가 없어요.</p>
  </aside>
</template>

<style scoped>
/* the same column as the project and routine lists (ProjectList.vue, RoutineList.vue) */
.tlist { position: absolute; z-index: 5; top: 0; bottom: 0; left: 0; width: 420px; padding: 100px 40px 60px; overflow-x: hidden; overscroll-behavior: contain; }
.tlist.mobile { width: auto; right: 0; padding: 88px 24px 48px; }
.head { display: flex; align-items: center; gap: 10px; }
.title { font-size: 26px; line-height: 1.3; letter-spacing: -0.02em; font-weight: 500; color: var(--text-primary); }
.n { font-size: 14px; color: var(--text-tertiary); }
.x { margin-left: auto; width: 36px; height: 36px; border-radius: 9999px; display: grid; place-items: center; color: var(--text-secondary); background: var(--button-bg); }
.x:hover { color: var(--text-primary); }
.cap { margin: 6px 0 0; font-size: 13px; line-height: 1.45; color: var(--text-tertiary); word-break: keep-all; }
.find { display: flex; align-items: center; gap: 8px; height: 40px; margin: 16px 0 10px; padding: 0 14px; border-radius: 9999px; background: var(--field-bg); color: var(--text-tertiary); }
.find input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; font: inherit; font-size: 15px; color: var(--text-primary); }
.find input::placeholder { color: var(--text-tertiary); }
.find:focus-within { box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 25%, transparent); }
.items { display: flex; flex-direction: column; gap: 2px; margin: 0 -14px; }
.find + .items { margin-top: 0; }
.cap + .items { margin-top: 14px; }
.item { display: flex; flex-direction: column; align-items: stretch; gap: 5px; min-width: 0; text-align: left; padding: 12px 14px; border-radius: 18px;
  color: var(--text-secondary); transition: color .3s, background-color .25s; }
.item:hover { color: var(--text-primary); }
.item.on { color: var(--text-primary); background: var(--field-bg); }
.item.on .name { font-weight: 500; }
.row1, .row2 { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
.name { flex: 1; min-width: 0; font-size: 19px; line-height: 1.3; letter-spacing: -0.02em; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: keep-all; overflow-wrap: anywhere; }
.when { flex: none; font-size: 12.5px; color: var(--text-tertiary); }
/* a scheduled task's, the briefs', a mail's conversation: its icon before the title, on the title's first line */
.kind { flex: none; align-self: center; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 9999px; color: var(--text-secondary); background: var(--field-bg); }
.item.on .kind { background: var(--button-bg); color: var(--text-primary); }
.line { flex: 1; min-width: 0; font-size: 13px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.count { flex: none; min-width: 24px; height: 20px; padding: 0 7px; border-radius: 10px; font-size: 12px; line-height: 20px; text-align: center; color: var(--text-secondary); background: var(--field-bg); }
.item.on .count { background: var(--button-bg); color: var(--text-primary); }
.item.all { margin-bottom: 6px; }
.item.all .name { font-size: 17px; }
.empty { margin-top: 14px; font-size: 14.5px; line-height: 1.5; color: var(--text-secondary); }
.tlist.mobile .name { font-size: 18px; }
</style>
