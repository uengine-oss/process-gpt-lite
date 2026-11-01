<script setup>
// 「이미 한 요청이에요」 카드(spec pgpt-pro_context-repeat-request, server lib/context/repeat.js): 요청이 에이전트로 가기 전에 나나 팀원이
// 이미 같은 요청을 해 답이 있으면 에이전트를 부르지 않고 이 카드로 묻는다.
//   그 답 보기 — 지금 깊이로 다시 읽어 펼친다(복사하지 않는다, 회수되면 다시 볼 수 없다).
//   요청하기 — 제목·요약만 보이는 팀원 맥락이면 원문 참고를 요청한다(같은 팀은 자동 허용 → 바로 그 답 보기).
//   그래도 새로 하기 — 같은 요청을 다시 보낸다(이번에는 알아보지 않는다).
import { computed, ref } from 'vue'
import { marked } from 'marked'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'

const props = defineProps({ msg: Object })
const app = useApp()
const c = computed(() => props.msg.content || {})
const hits = computed(() => c.value.hits || [])
const open = ref({})        // 후보 번호 → 읽어 온 답
const req = ref({})         // 후보 번호 → 요청 상태
const busy = ref('')
const err = ref('')
const chose = ref('')
const md = (s) => marked.parse(String(s || ''), { breaks: true })

function ago(at) {
  const t = new Date(at), ms = Date.now() - t, m = Math.round(ms / 6e4)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  if (t.toDateString() === new Date().toDateString()) return `오늘 ${t.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}`
  const d = Math.max(1, Math.round(ms / 864e5))
  return d === 1 ? '어제' : `${d}일 전`
}
const who = (h) => (h.mine ? '내가' : `${h.owner_name}님이`)
const depthNote = (h) => (h.mine ? '내 맥락' : h.depth === 'content' ? '원문을 볼 수 있어요' : h.depth === 'summary' ? '지금은 요약만' : '지금은 제목만')
const canView = (h, i) => h.mine || h.depth === 'content' || h.depth === 'summary' || req.value[i]?.status === 'granted'

async function view(h, i) {
  err.value = ''; busy.value = `v${i}`
  try { open.value = { ...open.value, [i]: await api(`/context/repeats/${c.value.repeat_id}/answer?n=${i}`) }; chose.value = 'view' } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function ask(h, i) {
  err.value = ''; busy.value = `r${i}`
  try {
    const r = await api('/context/access-requests', { method: 'POST', body: { conversationId: h.conv, depth: 'content', threadId: props.msg.thread_id, doing: String(c.value.request || '').slice(0, 160) } })
    req.value = { ...req.value, [i]: { status: r.status } }
    await api(`/context/repeats/${c.value.repeat_id}/choice`, { method: 'POST', body: { choice: 'request' } }).catch(() => {})
    if (r.status === 'granted') await view(h, i)
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function fresh() {
  chose.value = 'fresh'
  await api(`/context/repeats/${c.value.repeat_id}/choice`, { method: 'POST', body: { choice: 'fresh' } }).catch(() => {})
  app.send(c.value.request, props.msg.thread_id, undefined, { fresh: true })
}
</script>

<template>
  <div class="rp glass" data-testid="repeat-card">
    <div class="hd"><span class="badge">이미 한 요청</span><b>{{ hits[0]?.mine ? '같은 요청을 전에 했어요' : `${hits[0]?.owner_name}님이 같은 요청을 했어요` }}</b></div>
    <small class="sub">새로 만들기 전에 그 답을 볼 수 있어요. 에이전트는 아직 부르지 않았어요.</small>
    <div v-for="(h, i) in hits" :key="`${h.conv}-${i}`" class="hit" :data-repeat="h.title">
      <div class="row">
        <div class="main">
          <b>「{{ h.title }}」</b>
          <small>{{ who(h) }} · {{ ago(h.at) }} · {{ depthNote(h) }}</small>
          <small v-if="h.prompt" class="q">「{{ h.prompt }}」</small>
        </div>
        <button v-if="canView(h, i) && !open[i]" class="pill press" :disabled="busy === `v${i}`" @click="view(h, i)">{{ busy === `v${i}` ? '여는 중…' : '그 답 보기' }}</button>
        <button v-else-if="!canView(h, i) && !req[i]" class="pill press" :disabled="busy === `r${i}`" @click="ask(h, i)">{{ busy === `r${i}` ? '요청 중…' : '요청하기' }}</button>
        <small v-else-if="req[i]?.status === 'pending'" class="st">요청함 — {{ h.owner_name }}에게 갔어요</small>
        <small v-else-if="req[i]?.status === 'denied'" class="st">거절됐어요</small>
      </div>
      <div v-if="open[i]" class="ans" data-testid="repeat-answer">
        <template v-if="open[i].turn">
          <small class="from">{{ open[i].mine ? '내' : `${open[i].owner_name}님의` }} 답 · {{ ago(open[i].turn.at) }}<template v-if="req[i]?.status === 'granted'"> · 같은 팀이라 바로 허락됐어요</template></small>
          <div class="md" v-html="md(open[i].turn.answer)" />
        </template>
        <template v-else>
          <small class="from">{{ open[i].owner_name }}님의 맥락 요약</small>
          <p>{{ open[i].summary }}</p>
          <ul v-if="open[i].decisions?.length"><li v-for="d in open[i].decisions" :key="d">{{ d }}</li></ul>
        </template>
      </div>
    </div>
    <div class="ft">
      <small v-if="chose === 'fresh'" class="st">같은 요청을 새로 보냈어요</small>
      <button v-else class="pill ghost press" data-testid="repeat-fresh" @click="fresh">그래도 새로 하기</button>
    </div>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.rp { padding: 12px 14px; border-radius: 16px; display: flex; flex-direction: column; gap: 8px; max-width: 640px; }
.hd { display: flex; align-items: center; gap: 8px; font-size: 14.5px; }
.badge { font-size: 11.5px; padding: 2px 8px; border-radius: 10px; background: color-mix(in srgb, #0f766e 16%, transparent); color: #0f766e; font-weight: 600; }
.sub { color: var(--text-tertiary); font-size: 12.5px; }
.hit { border-top: 1px solid rgba(128, 128, 128, .18); padding-top: 8px; }
.row { display: flex; align-items: center; gap: 10px; }
.main { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.main small { color: var(--text-secondary); font-size: 12.5px; }
.main .q { color: var(--text-tertiary); }
.pill { height: 30px; padding: 0 14px; border-radius: 15px; border: 1px solid rgba(128, 128, 128, .3); background: var(--cell-bg); color: var(--text-primary); font-size: 13px; cursor: pointer; white-space: nowrap; }
.pill.ghost { background: transparent; }
.ans { margin-top: 8px; padding: 10px 12px; border-radius: 12px; background: var(--field-bg); font-size: 13.5px; }
.ans .from { display: block; color: var(--text-tertiary); font-size: 12px; margin-bottom: 4px; }
.ans .md :deep(table) { border-collapse: collapse; font-size: 12.5px; }
.ans .md :deep(td), .ans .md :deep(th) { border: 1px solid rgba(128, 128, 128, .3); padding: 3px 8px; }
.ft { display: flex; justify-content: flex-end; }
.st { color: var(--text-secondary); font-size: 12.5px; }
.err { color: var(--color-error); }
</style>
