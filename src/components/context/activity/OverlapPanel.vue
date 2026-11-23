<script setup>
// 비슷한 주제를 하는 사람(GET /team-activity/overlaps): 최근 14일 동안 움직인 서로 다른 사람의 맥락 가운데 뜻이 가까운 쌍(유사도 0.75 이상).
// 내가 당사자(두 주인·장·관리자)인 쌍만, 내가 볼 수 있는 글(제목 깊이면 제목·한 줄 목적)로만 잰 것이다. 상대 맥락은 열거나 원문을 요청한다.
import { ref, onMounted } from 'vue'
import { api } from '../../../api.js'
import { DEPTH } from './fmt.js'

const emit = defineEmits(['open'])
const d = ref(null), err = ref(''), sent = ref({})
async function load() {
  try { d.value = await api('/team-activity/overlaps') } catch (e) { err.value = e.message }
}
async function ask(side) {
  sent.value = { ...sent.value, [side.conversationId]: '요청 중…' }
  try {
    const r = await api('/context/access-requests', { method: 'POST', body: { conversationId: side.conversationId, depth: 'content', doing: '팀 활동 · 비슷한 주제를 하는 사람에서 살펴봄' } })
    sent.value = { ...sent.value, [side.conversationId]: r.status === 'granted' ? '허락됨' : r.status === 'pending' ? '요청함 — 주인에게 갔습니다' : '거절됨' }
  } catch (e) { sent.value = { ...sent.value, [side.conversationId]: e.message } }
}
onMounted(load)
defineExpose({ load })
const open = (s) => emit('open', { user: s.owner, conversationId: s.conversationId, title: s.title })
</script>

<template>
  <div class="ov glass">
    <p class="ct">비슷한 주제를 하는 사람</p>
    <template v-if="d">
      <div v-for="(p, i) in d.pairs" :key="i" class="pair">
        <div v-for="s in [p.a, p.b]" :key="s.conversationId" class="side">
          <button class="t press" @click="open(s)"><b>{{ s.title }}</b><i class="dp" :class="s.depth">{{ DEPTH[s.depth] }}</i></button>
          <small>{{ s.mine ? '나' : s.owner_name }}<template v-if="s.line"> · {{ s.line }}</template><template v-else-if="s.purpose"> · {{ s.purpose }}</template></small>
          <button v-if="s.request && !sent[s.conversationId]" class="rq press" @click="ask(s)">요청하기</button>
          <small v-else-if="sent[s.conversationId]" class="sent">{{ sent[s.conversationId] }}</small>
        </div>
        <span class="sc">유사도 {{ p.score.toFixed(2) }}</span>
      </div>
      <p v-if="!d.pairs.length" class="none">최근 {{ d.days }}일 동안 겹치는 주제가 없어요<br /><small>유사도 {{ d.min }} 이상만 · 내가 볼 수 있는 글로 비교</small></p>
      <p v-if="d.error" class="none">{{ d.error }}</p>
    </template>
    <p v-else-if="err" class="none">{{ err }}</p>
    <p v-else class="none">재는 중…</p>
  </div>
</template>

<style scoped>
.ov { border-radius: 20px; padding: 14px 14px 12px; display: flex; flex-direction: column; gap: 8px; }
.ct { margin: 0; font-weight: 600; font-size: 14.5px; }
.pair { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 9px 10px; border-radius: 14px; background: var(--cell-bg); }
.side { display: flex; flex-direction: column; gap: 1px; align-items: flex-start; }
.side + .side { padding-top: 6px; border-top: 1px dashed var(--hairline); }
.t { display: flex; align-items: center; gap: 6px; text-align: left; }
.t b { font-weight: 500; font-size: 13.5px; }
.side small { font-size: 12px; color: var(--text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dp { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 8px; background: var(--field-bg); color: var(--text-secondary); }
.dp.summary { background: rgba(76, 141, 246, .16); color: var(--color-info); }
.dp.content { background: rgba(59, 185, 138, .16); color: var(--color-success); }
.rq { margin-top: 3px; font-size: 12px; padding: 3px 10px; border-radius: 10px; background: var(--ink); color: var(--ink-inverse); }
.sent { color: var(--color-info) !important; }
.sc { position: absolute; top: 8px; right: 10px; font-size: 11.5px; color: var(--text-tertiary); }
.none { margin: 0; font-size: 13px; color: var(--text-tertiary); line-height: 1.5; }
.none small { font-size: 12px; }
</style>
