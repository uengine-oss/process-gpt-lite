<script setup>
// The mail sheet's row of follow-up actions, beside the reply (2026-11-24 사용자: 「메일에 대해서 무조건 답장만 하지는 않는다. 그 회사에 대해서
// 추가적으로 알아볼 수 도 있고.. 기타 액션을 할 수 있어야 하는데... 채팅에 멘션해서 뭔가 후속 작업을 할 수 있어야하는디」 — spec mail-card-actions).
// The server says the row (lib/mailFollow.js): 「이 회사 알아보기」 · 「채팅에서 이어서」, then a few the judge picked for this mail (회의 잡기 ·
// 제안서 초안 · ‘…’ 시작 · 폴더에 정리 · 동료에게 공유 …). A pill only picks an action: what it will do is said under the row, and nothing runs,
// opens or is sent before that line's button. An agent action's run stays on the card — 「회사 알아본 결과 · 열기」 — while the sheet is
// closed too (the Home card says it).
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'
import { mailItem } from '../fileDrag.js'
import { narrow } from '../viewport.js'
import { runLine, openRun } from '../mailFollow.js'

const props = defineProps({ action: Object })
const emit = defineEmits(['close', 'flow', 'files'])
const app = useApp()
const team = useTeam()
const router = useRouter()
const route = useRoute()
const row = ref(null)
const picked = ref('')
const busy = ref('')
const err = ref('')
// (the server could not say the row: the chat is still there — it needs nothing of the server)
const FALLBACK = [{ key: 'chat', do: 'chat', icon: 'chat', fixed: true, label: '채팅에서 이어서', go: '채팅 열기', says: '채팅 입력창에 이 메일을 멘션으로 붙여요. 할 일을 적어 보내면 에이전트가 메일을 읽고 해요.' }]
onMounted(async () => {
  try { row.value = (await app.mailFollow(props.action.id)).actions } catch (e) { row.value = FALLBACK; console.warn('[mail follow]', e.message) }
})
// a run as the card says it now (its events come while the agent works), else as the row was told
const runOf = (x) => props.action?.source?.follow?.runs?.[x.key] || x.run || null
const cur = computed(() => (row.value || []).find((x) => x.key === picked.value) || null)
const curRun = computed(() => (cur.value ? runOf(cur.value) : null))
const lines = computed(() => (row.value || []).filter((x) => x.do === 'agent').map((x) => runOf(x)).filter(Boolean))
function pick(x) { err.value = ''; picked.value = picked.value === x.key ? '' : x.key }

async function go(x, { again = false } = {}) {
  err.value = ''
  const item = mailItem(props.action)
  if (x.do === 'agent') {
    busy.value = x.key
    try { await app.runMailFollow(props.action.id, x.key, again); picked.value = '' } catch (e) { err.value = e.message }
    busy.value = ''
  } else if (x.do === 'chat') {
    // the AI chat with the mail as a chip in its composer — the person writes what to do next
    emit('close')
    if (narrow.value) app.dockOpen = false
    if (route.path !== '/chat') await router.push('/chat')
    await app.mailToChat(item)
  } else if (x.do === 'share') {
    // the messenger, the mail waiting as a mention for the conversation picked there (Messenger.vue takes team.pendingMention)
    // (the list first: a conversation left open is not taken as the one picked — PR #49 review)
    emit('close')
    team.active = null
    team.pendingMention = [item]
    team.tab = 'threads'
    team.open = true
  } else if (x.do === 'flow') emit('flow', { proc: x.proc, task: x.task })
  else if (x.do === 'file') { picked.value = ''; emit('files') }
}
function open(r) { emit('close'); openRun(app, router, r, { phone: narrow.value }) }
</script>

<template>
  <section class="follow" data-test="mail-follow">
    <div class="frow" role="toolbar" aria-label="이 메일로 할 일" data-test="follow-row">
      <span class="cap">이 메일로</span>
      <template v-if="row">
        <button v-for="x in row" :key="x.key" class="fpill press" :class="{ on: picked === x.key, fixed: x.fixed }" :data-test="`follow-${x.key}`" :data-do="x.do"
          :aria-pressed="picked === x.key" :title="x.says" @click="pick(x)">
          <Icon :name="x.icon || 'more'" :size="14" /><span>{{ x.label }}</span>
        </button>
      </template>
      <span v-else class="fpill wait shimmer-text" data-test="follow-loading">할 일을 고르는 중…</span>
    </div>
    <!-- what the picked action will do, and its one button -->
    <div v-if="cur" class="fsay" data-test="follow-say" :data-key="cur.key">
      <p>{{ cur.says }}</p>
      <div class="row">
        <button class="pill-btn sm" data-test="follow-cancel" @click="picked = ''">취소</button>
        <template v-if="curRun?.status === 'done'">
          <button class="pill-btn sm" data-test="follow-again" :disabled="!!busy" @click="go(cur, { again: true })">다시 하기</button>
          <button class="dark-btn sm" data-test="follow-open" @click="open(curRun)">결과 열기</button>
        </template>
        <button v-else class="dark-btn sm" data-test="follow-go" :disabled="!!busy || curRun?.status === 'running'" @click="go(cur, { again: curRun?.status === 'failed' })">
          {{ busy === cur.key ? '시작하는 중…' : curRun?.status === 'running' ? '하는 중…' : cur.go || '하기' }}
        </button>
      </div>
    </div>
    <!-- an agent action's run: where its result is (the conversation, the instance) -->
    <template v-for="r in lines" :key="r.key">
      <button v-if="r.status === 'done'" class="fnote press" data-test="follow-run" :data-key="r.key" data-status="done" @click="open(r)">
        <Icon name="check" :size="14" /><span>{{ runLine(r) }}</span><Icon name="chevron" :size="12" />
      </button>
      <p v-else class="fnote" :class="r.status" data-test="follow-run" :data-key="r.key" :data-status="r.status">
        <Icon :name="r.status === 'running' ? 'clock' : 'alert'" :size="14" /><span :class="{ 'shimmer-text': r.status === 'running' }">{{ runLine(r) }}</span>
      </p>
    </template>
    <p v-if="err" class="err" data-test="follow-error">{{ err }}</p>
  </section>
</template>

<style scoped>
.follow { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
/* one line that scrolls sideways when it is full (a phone): the last pill shows a little, cut — never squeezed */
.frow { display: flex; align-items: center; gap: 6px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; padding: 2px 0; min-width: 0;
  -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 18px), transparent); padding-right: 18px; }
.frow::-webkit-scrollbar { display: none; }
.cap { flex: none; font-size: 12.5px; color: var(--text-secondary); margin-right: 2px; }
.fpill { flex: none; display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 12px; border-radius: 9999px; font-size: 13px; white-space: nowrap;
  color: var(--text-primary); background: var(--field-bg); border: 1px solid var(--hairline); }
.fpill > :deep(svg) { flex: none; color: var(--text-secondary); }
.fpill.fixed { background: var(--chip-bg); }
.fpill.on { background: #1d1d1f; color: #fff; border-color: #1d1d1f; }
.fpill.on > :deep(svg) { color: rgba(255 255 255 / .8); }
:root[data-theme="dark"] .fpill.on { background: #f5f5f7; color: #1d1d1f; border-color: #f5f5f7; }
:root[data-theme="dark"] .fpill.on > :deep(svg) { color: rgba(29 29 31 / .7); }
.fpill.wait { color: var(--text-secondary); }
.fsay { border-radius: 16px; padding: 10px 12px; background: var(--chip-bg); display: flex; flex-direction: column; gap: 6px; }
.fsay p { margin: 0; font-size: 13.5px; line-height: 1.55; overflow-wrap: anywhere; word-break: keep-all; }
.row { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.sm { height: 38px; }
.pill-btn:disabled, .dark-btn:disabled { opacity: .5; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.fnote { margin: 0; align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 30px; padding: 0 12px; border-radius: 9999px;
  font-size: 13px; color: var(--text-primary); background: var(--field-bg); text-align: left; }
.fnote > :deep(svg) { flex: none; color: var(--text-secondary); }
.fnote span { overflow-wrap: anywhere; }
.fnote.failed { color: #c2410c; }
.err { margin: 0; font-size: 13px; color: #c2410c; overflow-wrap: anywhere; }
</style>
