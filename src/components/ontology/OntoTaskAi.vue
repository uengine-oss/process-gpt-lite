<script setup>
// 일 패널의 「AI 판단」(design-v0.3 §24): 이 일을 AI(에이전트 · 스킬)에 맡길 수 있는지, 사람이 꼭 해야 하는지 —
// 지도에 칠한 색과 같은 색 · 같은 말로. 까닭 · 쓸 스킬 · 갖출 것 · 조심할 점, 사람이 꼭 해야 하는 까닭(규칙에 걸린 낱말 또는 AI 판단),
// 판단한 모델. 관리자는 채택 · 아님을 정한다. 아직 판단하지 않은 일은 그렇다고만 보인다.
import { ref, watch, computed } from 'vue'
import { api } from '../../api.js'

const props = defineProps({ taskKey: { type: String, required: true }, admin: Boolean })
const emit = defineEmits(['changed'])
const c = ref(null)
const loaded = ref(false)
const busy = ref(false)
const err = ref('')
async function load() {
  loaded.value = false
  try { c.value = (await api(`/ontology/candidates/${encodeURIComponent(props.taskKey)}`)).candidate } catch { c.value = null } finally { loaded.value = true }
}
watch(() => props.taskKey, load, { immediate: true })

const HOW = { agent: '에이전트가 처음부터 끝까지', draft: '에이전트가 초안, 사람이 확인하고 보냄', assist: '사람이 하고 AI가 자료 · 요약을 도움', person: '사람이 함' }
// the same four kinds as the map's colours (MapGraph mk-*) and its legend
const kind = computed(() => {
  if (!c.value) return null
  if (c.value.human?.length) return { k: 'human', label: '사람이 꼭 해야 하는 일' }
  if (c.value.fit === 'high') return { k: 'high', label: 'AI가 맡을 수 있는 일' }
  if (c.value.fit === 'mid') return { k: 'mid', label: 'AI가 초안 · 사람이 확인' }
  return { k: 'rest', label: c.value.fit === 'low' ? 'AI는 돕기만' : '사람이 하는 일' }
})
async function decide(status) {
  busy.value = true; err.value = ''
  try { c.value = await api(`/ontology/candidates/${encodeURIComponent(props.taskKey)}`, { method: 'POST', body: { status } }); emit('changed') } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div v-if="loaded" class="sec ai" data-testid="onto-task-ai">
    <h4>AI 판단</h4>
    <template v-if="c">
      <div class="badge" :class="kind.k" data-testid="onto-task-ai-kind"><i />{{ kind.label }}<small v-if="c.status === 'accepted'"> · 채택함</small><small v-else-if="c.status === 'rejected'"> · 아님으로 정함</small></div>
      <p class="how">{{ HOW[c.how] }}</p>
      <p class="why">{{ c.why }}</p>
      <dl class="kv">
        <template v-for="h in c.human || []" :key="h.key"><dt>{{ h.name }}</dt><dd>{{ h.why }}<small>{{ h.hit ? ` — 규칙에 걸린 것: ${h.hit}` : ' — AI 판단' }}</small></dd></template>
        <template v-if="c.skills?.length"><dt>쓸 스킬</dt><dd class="chips"><code v-for="s in c.skills" :key="s">{{ s }}</code></dd></template>
        <template v-if="c.needs?.length"><dt>갖출 것</dt><dd>{{ c.needs.join(' · ') }}</dd></template>
        <template v-if="c.risk"><dt>조심할 점</dt><dd>{{ c.risk }}</dd></template>
        <template v-if="c.facts?.model"><dt>판단</dt><dd>{{ c.facts.model }}<small v-if="c.facts.monthly != null"> · 한 달 {{ c.facts.monthly }}번을 보고</small></dd></template>
      </dl>
      <div v-if="admin && !c.human?.length && (c.fit === 'high' || c.fit === 'mid')" class="btns">
        <button v-if="c.status !== 'rejected'" class="ghost press" :disabled="busy" @click="decide('rejected')">아님</button>
        <button v-if="c.status !== 'accepted'" class="go press" :disabled="busy" data-testid="onto-task-ai-accept" @click="decide('accepted')">채택</button>
        <button v-else class="ghost press" :disabled="busy" @click="decide('proposed')">채택 취소</button>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
    </template>
    <p v-else class="muted">아직 AI가 보지 않은 일이에요. 지도 위 「AI 후보」에서 고르면 여기에 나와요(한 번만 나온 일은 기본으로 빼요).</p>
  </div>
</template>

<style scoped>
.sec { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; }
h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.badge { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.badge i { width: 18px; height: 12px; border-radius: 4px; box-sizing: border-box; border: 1px solid var(--hairline); }
.badge.high i { background: color-mix(in srgb, #2f9e6e 34%, transparent); border: 2px solid #2f9e6e; }
.badge.mid i { background: color-mix(in srgb, #2f9e6e 14%, transparent); border: 1.5px dashed #2f9e6e; }
.badge.human i { background: color-mix(in srgb, #d9822b 26%, transparent); border: 2px solid #d9822b; }
.badge small { font-weight: 400; color: var(--text-secondary); font-size: 12.5px; }
.how { margin: 6px 0 2px; font-size: 13px; }
.why { margin: 0 0 8px; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 12px; margin: 0; font-size: 12.5px; }
.kv dt { color: var(--text-tertiary); white-space: nowrap; }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; line-height: 1.45; }
.kv small { color: var(--text-tertiary); }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chips code { font: 11.5px ui-monospace, Menlo, monospace; padding: 1px 7px; border-radius: 9999px; background: var(--field-bg); }
.muted { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 6px 0 0; font-size: 12.5px; color: var(--color-error); }
.btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
.ghost { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 12.5px; color: var(--text-secondary); }
.go { height: 30px; padding: 0 14px; border-radius: 9999px; font-size: 12.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go:disabled, .ghost:disabled { opacity: .45; }
</style>
