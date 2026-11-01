<script setup>
// 자동 참고 칩(spec pgpt-pro_context-auto-reference): 사람 메시지 아래(= 답 위)에 「참고한 맥락」, 답 아래에 「요청하면 볼 수 있는 맥락」.
// 칩: 빼기·고정, 요약 칩의 원문 요청. 요청 후보: 요청하기 → 자동 허용이면 바로 「허락됨」, 아니면 「요청함」(주인의 홈 카드).
// 허락이 오면(알림 이벤트, 놓치면 5초마다 다시 읽기) 「지금 반영해 다시 답하기」 — 같은 요청을 이 대화에 다시 보낸다.
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'

const props = defineProps({
  part: { type: String, default: 'used' },     // used(사람 메시지 아래) | requestable(답 아래)
  refer: { type: Object, default: null },      // 사람 메시지에 남은 고른 결과(다시 읽기 전)
  referId: { type: String, default: null },
  thread: { type: String, default: null },
})
const router = useRouter()
const app = useApp()
const DEPTH = { title: '제목', summary: '요약', content: '원문' }
const id = computed(() => props.referId || props.refer?.refer_id || null)
const st = ref(props.refer && !props.refer.off ? { ...props.refer } : null)
const ask = ref(null), busy = ref(false), err = ref('')
let timer

async function load() { if (id.value) try { st.value = await api(`/context/refer/${id.value}`) } catch (e) { err.value = e.message } }
const all = computed(() => [...(st.value?.used || []), ...(st.value?.requestable || [])])
const pending = computed(() => all.value.some((x) => x.request?.status === 'pending'))
const onEvent = (e) => { if (e.detail?.type === 'notifications' && (pending.value || props.part === 'requestable')) load() }
onMounted(() => {
  if (props.part === 'requestable' || !props.refer) load()
  window.addEventListener('pgpt:event', onEvent)
  timer = setInterval(() => { if (pending.value) load() }, 5000)
})
onUnmounted(() => { window.removeEventListener('pgpt:event', onEvent); clearInterval(timer) })
watch(id, load)

const used = computed(() => (st.value?.used || []).filter((x) => !x.dropped))
const requestable = computed(() => st.value?.requestable || [])
const granted = (x) => x.granted || x.request?.status === 'granted'
const depthNow = (x) => (granted(x) ? `허락됨 · ${DEPTH[x.request?.depth || 'content']}` : DEPTH[x.depth_now && x.depth_now !== 'none' ? x.depth_now : x.depth])
async function edit(x, action) {
  try { await api('/context/refer/edit', { method: 'POST', body: { threadId: props.thread, owner: x.owner, conversationId: x.id, action } }); if (action === 'drop') x.dropped = true; else x.pinned = action === 'pin' } catch (e) { err.value = e.message }
}
function openAsk(x) { ask.value = { x, doing: String(st.value?.message || '').slice(0, 160) } }
async function send() {
  const { x, doing } = ask.value
  busy.value = true; err.value = ''
  try {
    const r = await api('/context/access-requests', { method: 'POST', body: { conversationId: x.id, depth: 'content', threadId: props.thread, doing } })
    x.request = { id: r.request_id, status: r.status, depth: r.grant?.depth || 'content' }
    if (r.status === 'granted') x.granted = true
    ask.value = null
    await load()
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
const anyGranted = computed(() => all.value.some((x) => x.request && granted(x)))
const rerun = () => st.value?.message && app.send(st.value.message, props.thread)
// 이 대화의 자동 참고 끄기·켜기(서버가 대화마다 기억한다)
const off = ref(!!props.refer?.off)
async function toggle(on) {
  try { await api('/context/refer/edit', { method: 'POST', body: { threadId: props.thread, action: on ? 'on' : 'off' } }); off.value = !on } catch (e) { err.value = e.message }
}
</script>

<template>
  <div v-if="part === 'used' && off" class="rc used"><span class="chip off">자동 참고 꺼짐 · <button class="mini" @click="toggle(true)">켜기</button></span></div>
  <div v-else-if="part === 'used' && st && (used.length || st.skipped === 'timeout')" class="rc used">
    <span v-if="st.skipped === 'timeout'" class="chip off">참고 생략(시간 초과)</span>
    <span v-for="x in used" :key="x.id" class="chip" :class="{ other: !x.mine, ok: granted(x) }" :data-ref="x.title">
      <span class="lbl">참고</span>
      <button class="t" :title="(x.why || []).join(', ')" @click="router.push(`/context/${encodeURIComponent(x.id)}`)">{{ x.title }}</button>
      <span class="who">{{ x.mine ? '내 맥락' : x.owner_name }} · {{ depthNow(x) }}</span>
      <button v-if="x.can_request && !granted(x) && x.request?.status !== 'pending'" class="mini" @click="openAsk(x)">원문 요청</button>
      <span v-else-if="x.request?.status === 'pending'" class="mini wait">요청함</span>
      <button class="mini" :class="{ on: x.pinned }" :title="x.pinned ? '고정 풀기' : '이 대화에서 늘 붙이기'" @click="edit(x, x.pinned ? 'unpin' : 'pin')">{{ x.pinned ? '고정됨' : '고정' }}</button>
      <button class="mini x" title="이 대화에서 빼기" aria-label="빼기" @click="edit(x, 'drop')">×</button>
    </span>
    <button class="mini" title="이 대화에서는 다른 맥락을 붙이지 않기" @click="toggle(false)">자동 참고 끄기</button>
  </div>

  <div v-if="part === 'requestable' && st && requestable.length" class="rc req glass">
    <div class="head">요청하면 볼 수 있는 맥락</div>
    <div v-for="x in requestable" :key="x.id" class="rrow" :data-req="x.title">
      <span class="name">{{ x.title }} <small>{{ x.owner_name }} · 지금은 제목만</small></span>
      <span v-if="granted(x)" class="badge ok">허락됨 · {{ DEPTH[x.request?.depth || 'content'] }}</span>
      <span v-else-if="x.request?.status === 'pending'" class="badge wait">요청함 — {{ x.owner_name }}에게 갔어요</span>
      <span v-else-if="x.request?.status === 'denied'" class="badge no">거절됨</span>
      <button v-else class="pill press" @click="openAsk(x)">요청하기</button>
    </div>
  </div>
  <button v-if="part === 'requestable' && anyGranted" class="pill again press" @click="rerun">지금 반영해 다시 답하기</button>

  <div v-if="ask" class="ask glass" role="dialog" aria-label="참고 요청">
    <b>「{{ ask.x.title }}」 원문 요청 — {{ ask.x.owner_name }}에게</b>
    <label>지금 하는 일<input v-model="ask.doing" maxlength="200" /></label>
    <p>주인이 정해 둔 자동 허용 규칙에 맞으면 바로 들어오고, 아니면 주인의 홈에 요청 카드가 갑니다.</p>
    <div class="row"><button class="pill ghost press" @click="ask = null">취소</button><button class="pill press" :disabled="busy" @click="send">요청 보내기</button></div>
  </div>
  <small v-if="err" class="err">{{ err }}</small>
</template>

<style scoped>
.rc.used { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin: 8px 4px 0 0; max-width: 560px; }
.chip { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; max-width: 100%; padding: 5px 8px 5px 12px; border-radius: 16px; font-size: 13px;
  background: var(--cell-bg); border: 1px solid transparent; }
.chip > * { white-space: nowrap; }
.chip.other { border-color: rgba(120, 160, 255, .45); }
.chip.ok { border-color: rgba(60, 190, 120, .6); }
.chip.off { color: var(--text-secondary); }
.lbl { font-weight: 600; color: #7aa2ff; }
.t { font-weight: 600; color: var(--text-primary); background: none; border: 0; padding: 0; cursor: pointer; font-size: 13px; }
.who { color: var(--text-secondary); }
.mini { font-size: 12px; padding: 1px 9px; border-radius: 999px; border: 1px solid var(--divider, rgba(128,128,128,.3)); background: none; color: var(--text-secondary); cursor: pointer; }
.mini.on { color: #7aa2ff; border-color: #7aa2ff; }
.mini.x { border: 0; font-size: 16px; line-height: 1; padding: 0 2px; }
.mini.wait { border-style: dashed; cursor: default; }
.rc.req { margin-top: 10px; padding: 12px 14px; border-radius: 18px; display: flex; flex-direction: column; gap: 8px; max-width: 480px; font-size: 14px; }
.head { font-weight: 600; font-size: 13px; color: var(--text-secondary); }
.rrow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.name { flex: 1; min-width: 0; font-weight: 600; }
.name small { font-weight: 400; color: var(--text-secondary); margin-left: 4px; }
.pill { font-size: 13px; padding: 6px 14px; border-radius: 999px; border: 0; background: var(--button-bg); color: var(--text-primary); cursor: pointer; }
.pill.ghost { background: none; }
.again { margin-top: 8px; }
.badge { font-size: 12.5px; padding: 3px 10px; border-radius: 999px; background: var(--cell-bg); }
.badge.ok { background: rgba(60, 190, 120, .22); }
.badge.wait { background: rgba(240, 160, 40, .2); }
.badge.no { background: rgba(240, 80, 70, .2); }
.ask { position: sticky; bottom: 8px; z-index: 5; margin-top: 10px; padding: 14px; border-radius: 18px; display: flex; flex-direction: column; gap: 8px; max-width: 480px; font-size: 14px; }
.ask label { display: flex; flex-direction: column; gap: 4px; color: var(--text-secondary); }
.ask input { padding: 8px 10px; border-radius: 10px; border: 1px solid var(--divider, rgba(128,128,128,.3)); background: var(--cell-bg); color: var(--text-primary); font-size: 14px; }
.ask p { margin: 0; color: var(--text-secondary); font-size: 13px; }
.ask .row { display: flex; justify-content: flex-end; gap: 8px; }
.err { color: #ff7b72; }
</style>
