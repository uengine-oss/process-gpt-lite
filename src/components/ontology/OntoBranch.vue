<script setup>
// 갈림길 조건(design-v0.3 §25): 관계(화살표)를 누르면 「어떤 경우에 이 길로 가는가」를 글로 — 같은 일에서 나가는 다른 갈래의 조건과 나란히.
// 조건은 그 갈래로 실제로 간 건을 예시로 AI가 뽑았다(판단할 때 볼 것 · 확실한 정도 · 근거로 본 건). 스냅샷의 갈림과 다음 단계 추천이 이 글을 쓴다.
// 관리자는 이 갈림길만 다시 뽑을 수 있다.
import { ref, watch, computed } from 'vue'
import { api } from '../../api.js'
import { pct, dateKo, END, condText } from './fmt.js'

const props = defineProps({ edge: { type: Object, required: true }, admin: Boolean })
const d = ref(null)
const busy = ref(false)
const err = ref('')
const CONF = { high: '뚜렷함', mid: '대체로', low: '짐작' }
async function load() { try { d.value = await api(`/ontology/branches/${encodeURIComponent(props.edge.from)}`); err.value = '' } catch (e) { d.value = null; err.value = e.message } }
watch(() => props.edge.from, load, { immediate: true })
const me = computed(() => d.value?.branches.find((b) => b.to === props.edge.to) || null)
const others = computed(() => (d.value?.branches || []).filter((b) => b.to !== props.edge.to))
const name = (k) => (k === END ? '끝' : k)
const condOf = (b) => (b.numeric ? condText(b.numeric) : b.cond)
async function redo() {
  busy.value = true; err.value = ''
  try { d.value = await api(`/ontology/branches/${encodeURIComponent(props.edge.from)}`, { method: 'POST', body: {} }) } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div v-if="d?.split" class="br" data-testid="onto-branch">
    <h4>이 길로 가는 조건</h4>
    <template v-if="me && condOf(me)">
      <p class="cond" data-testid="onto-branch-cond">{{ condOf(me) }}<span v-if="me.confidence && !me.numeric" class="cf" :class="me.confidence">{{ CONF[me.confidence] }}</span><span v-else-if="me.numeric" class="cf high">금액으로 배움</span></p>
      <p v-if="me.signals?.length" class="sm"><span class="k">볼 것</span>{{ me.signals.join(' · ') }}</p>
      <details v-if="me.examples?.length" class="ex">
        <summary>근거로 본 건 {{ me.examples.length }}개</summary>
        <ul><li v-for="(x, i) in me.examples" :key="i"><time>{{ dateKo(x.at) }}</time><span>{{ x.subject || x.said }}</span><small v-if="x.next"> → {{ x.next }}</small></li></ul>
      </details>
    </template>
    <p v-else class="muted">{{ me ? '아직 조건을 뽑지 않았어요.' : '한두 번만 지나간 길이라 조건을 뽑지 않았어요.' }}</p>
    <template v-if="others.length">
      <h5>「{{ edge.from }}」 뒤의 다른 갈래</h5>
      <ul class="oth">
        <li v-for="b in others" :key="b.to"><b>{{ name(b.to) }}</b><small>{{ pct(b.p) }}</small><span>{{ condOf(b) || '—' }}</span></li>
      </ul>
    </template>
    <p v-if="d.note" class="note">{{ d.note }}</p>
    <p class="sm foot"><template v-if="d.model">{{ d.model }} 판단 · </template>스냅샷의 갈림과 다음 단계 추천에 쓰여요(「짐작」은 빼고).
      <button v-if="admin" class="lnk press" :disabled="busy" data-testid="onto-branch-redo" @click="redo">{{ busy ? '뽑는 중…' : d.model ? '다시 뽑기' : '조건 뽑기' }}</button></p>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.br { padding: 12px; border-radius: 16px; background: var(--cell-bg); display: flex; flex-direction: column; gap: 6px; word-break: keep-all; }
h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
h5 { margin: 6px 0 0; font-size: 12px; font-weight: 500; color: var(--text-tertiary); }
.cond { margin: 0; font-size: 14.5px; font-weight: 500; line-height: 1.45; }
.cf { margin-left: 8px; font-size: 11px; font-weight: 500; padding: 1px 7px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); white-space: nowrap; }
.cf.high { background: color-mix(in srgb, var(--color-success) 24%, transparent); color: var(--text-primary); }
.cf.low { background: color-mix(in srgb, #d9822b 24%, transparent); color: var(--text-primary); }
.sm { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.k { color: var(--text-tertiary); margin-right: 6px; }
.muted { margin: 0; font-size: 12.5px; color: var(--text-secondary); }
.ex { font-size: 12px; color: var(--text-secondary); }
.ex summary { cursor: pointer; }
.ex ul, .oth { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ex li { display: flex; gap: 6px; flex-wrap: wrap; line-height: 1.4; }
.ex time { color: var(--text-tertiary); white-space: nowrap; }
.ex small { color: var(--text-tertiary); }
.oth li { display: grid; grid-template-columns: 1fr auto; gap: 0 8px; padding: 6px 9px; border-radius: 10px; background: var(--field-bg); font-size: 12.5px; }
.oth b { font-weight: 500; } .oth small { color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.oth span { grid-column: 1 / -1; color: var(--text-secondary); line-height: 1.4; }
.note { margin: 0; padding: 7px 10px; border-radius: 10px; background: var(--field-bg); font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.foot { color: var(--text-tertiary); }
.lnk { margin-left: 6px; color: var(--color-info); }
.err { margin: 0; font-size: 12.5px; color: var(--color-error); }
</style>
