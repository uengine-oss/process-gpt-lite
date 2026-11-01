<script setup>
// 홈 카드 안의 참고 요청 결정(spec pgpt-pro_context-access-request): 요청자·대상·원하는 깊이·지금 하는 일(카드 위),
// 허락하면 나가게 될 것의 미리보기(턴·결정), 깊이·기간·뺄 턴을 정해 허락하거나 거절한다.
import { ref, computed, onMounted } from 'vue'
import { api } from '../../api.js'
import { useApp } from '../../stores/app.js'

const props = defineProps({ n: Object })
const app = useApp()
const id = computed(() => String(props.n.url || '').split('/').pop())
const pv = ref(null), depth = ref('content'), duration = ref('task'), exclude = ref([]), reason = ref(''), denying = ref(false), busy = ref(false), err = ref(''), done = ref('')
onMounted(async () => {
  try { pv.value = await api(`/context/access-requests/${id.value}/preview`); depth.value = pv.value.request.depth } catch (e) { err.value = e.message }
})
async function decide(decision) {
  busy.value = true; err.value = ''
  try {
    const r = await api(`/context/access-requests/${id.value}/decide`, { method: 'POST', body: decision === 'deny' ? { decision, reason: reason.value } : { decision, depth: depth.value, duration: duration.value, exclude: exclude.value } })
    done.value = r.status === 'granted' ? '허락했어요' : '거절했어요'
    setTimeout(() => app.dismissNotification(props.n), 1200)
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="ad">
    <p v-if="pv" class="pv">허락하면 나가는 것 — 턴 {{ pv.turns.length }}개 · 결정 {{ pv.decisions }}개 · 열린 질문 {{ pv.questions }}개</p>
    <details v-if="pv && depth === 'content' && pv.turns.length" class="cut">
      <summary>뺄 턴 고르기<span v-if="exclude.length"> ({{ exclude.length }}개 뺌)</span></summary>
      <label v-for="t in pv.turns" :key="t.id"><input v-model="exclude" type="checkbox" :value="t.id" /> {{ t.prompt }}</label>
    </details>
    <p v-if="done" class="done">{{ done }}</p>
    <div v-else class="opts">
      <label>깊이 <select v-model="depth"><option value="summary">요약</option><option value="content" :disabled="pv?.request.depth === 'summary'">원문</option></select></label>
      <label>기간 <select v-model="duration"><option value="task">이 작업 동안</option><option value="7d">7일</option><option value="forever">회수할 때까지</option></select></label>
      <template v-if="denying">
        <input v-model="reason" class="why" placeholder="거절 사유(선택)" maxlength="300" />
        <button class="b ghost press" :disabled="busy" @click="denying = false">취소</button>
        <button class="b press" :disabled="busy" @click="decide('deny')">거절 보내기</button>
      </template>
      <template v-else>
        <button class="b ghost press" :disabled="busy" @click="denying = true">거절</button>
        <button class="b main press" :disabled="busy" @click="decide('allow')">{{ busy ? '처리 중…' : '허락' }}</button>
      </template>
    </div>
    <small v-if="err" class="err">{{ err }}</small>
  </div>
</template>

<style scoped>
.ad { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 14px; }
.pv { margin: 0; color: var(--text-secondary); font-size: 13px; }
.cut summary { cursor: pointer; color: var(--text-secondary); font-size: 13px; }
.cut label { display: flex; gap: 6px; align-items: center; padding: 3px 0; font-size: 13.5px; }
.opts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.opts label { display: flex; gap: 6px; align-items: center; color: var(--text-secondary); font-size: 13px; }
.opts select, .why { height: 32px; border-radius: 10px; border: 1px solid rgba(128, 128, 128, .3); background: var(--cell-bg); color: var(--text-primary); padding: 0 8px; }
.b { height: 36px; padding: 0 16px; border-radius: 18px; font-size: 15px; background: rgba(0, 0, 0, .06); color: var(--text-primary); }
.b.main { background: var(--color-attention); color: #fff; }
.b.ghost { background: transparent; color: var(--text-secondary); }
.done { margin: 0; font-weight: 600; }
.err { color: #ff7b72; }
</style>
