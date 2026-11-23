<script setup>
// 방법 후보(design-v0.3 §10): 같은 목표(이 일)에 이른 사람마다의 방법 가운데 본인이 「공유하기」를 고른 것.
// 누가 공유했는지 · 그 사람의 말 · 실행 횟수 · 평균 걸린 시간 · 받아들인 비율, 「가장 빠른 방법」(받아들인 비율 0.6 이상
// 가운데 가장 빠른 것, 서버가 셈) · 「스킬」. 관리자는 「이 방법을 스킬로」 → 그 일의 세부 스킬이 되어 일 정의에 붙는다.
// 공유된 방법이 없으면 아무것도 그리지 않는다. emits skill({name, task}) — 일 정의가 바뀌었으니 다시 불러올 때.
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { pct } from './fmt.js'

const props = defineProps({ taskKey: { type: String, required: true }, admin: Boolean })
const emit = defineEmits(['skill'])
const ways = ref([])
const err = ref('')
const busy = ref('')
const made = ref(null)

async function load() {
  try { ways.value = (await api(`/ontology/ways?task=${encodeURIComponent(props.taskKey)}`)) || [] } catch (e) { ways.value = []; err.value = e.message }
}
watch(() => props.taskKey, () => { ways.value = []; err.value = ''; made.value = null; load() }, { immediate: true })

const list = computed(() => [...ways.value].sort((a, b) => (b.status === 'skill') - (a.status === 'skill') || (b.best - a.best) || (b.runs || 0) - (a.runs || 0)))
const mins = (m) => (m == null ? null : m < 1 ? '1분 안' : `${m < 10 ? +Number(m).toFixed(1) : Math.round(m)}분`)

async function toSkill(w) {
  busy.value = w.id; err.value = ''; made.value = null
  try {
    const r = await api(`/ontology/ways/${encodeURIComponent(w.id)}/skill`, { method: 'POST', body: {} })
    made.value = { ...r, by: w.name }
    await load()
    emit('skill', { name: r.name, task: r.task })
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div v-if="ways.length || made" class="sec ways" data-testid="onto-ways">
    <h4>방법 후보 <small>같은 일을 사람마다 다르게 해요 · 본인이 공유한 것만</small></h4>
    <ul class="wl">
      <li v-for="w in list" :key="w.id" class="w" :class="{ best: w.best, skill: w.status === 'skill' }" data-testid="onto-way" :data-way="w.id">
        <div class="top">
          <b class="by">{{ w.name || '이름 없음' }}</b>
          <span v-if="w.best" class="tag best" data-testid="onto-way-best">가장 빠른 방법</span>
          <span v-if="w.status === 'skill'" class="tag skill" data-testid="onto-way-skilled">스킬<template v-if="w.skill_name"> · {{ w.skill_name }}</template></span>
          <span v-if="w.role" class="role">{{ w.role }}</span>
        </div>
        <q class="how">{{ w.how }}</q>
        <small class="nums">
          <span>{{ w.runs ? `${w.runs}번 실행` : '아직 실행 없음' }}</span>
          <template v-if="mins(w.minutes)"> · <span>평균 {{ mins(w.minutes) }}</span></template>
          <template v-if="w.taken != null"> · <span>물었을 때 받아들인 비율 {{ pct(w.taken) }}</span></template>
        </small>
        <button v-if="admin && w.status !== 'skill'" class="go press" :disabled="!!busy" data-testid="onto-way-skill" @click="toSkill(w)">{{ busy === w.id ? '스킬 만드는 중…' : '이 방법을 스킬로' }}</button>
      </li>
    </ul>
    <div v-if="made" class="made" data-testid="onto-way-made">
      <span>{{ made.by }}님의 방법을 「{{ made.name }}」 스킬로 만들어 「{{ made.task }}」의 일 정의에 붙였어요. 스냅샷 실행과 에이전트가 이 스킬을 써요.</span>
      <details v-if="made.skill"><summary>SKILL.md 보기</summary><pre>{{ made.skill }}</pre></details>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.sec { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }
h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
h4 small { display: block; margin-top: 2px; font-weight: 400; color: var(--text-tertiary); }
.wl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.w { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border-radius: 14px; background: var(--field-bg); border-left: 3px solid transparent; }
.w.best { border-left-color: var(--color-success); }
.w.skill { border-left-color: var(--color-info); }
.top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.by { font-size: 14px; font-weight: 600; }
.role { font-size: 12px; color: var(--text-tertiary); }
.tag { font-size: 11.5px; font-weight: 600; padding: 1px 8px; border-radius: 9999px; white-space: nowrap; }
.tag.best { background: color-mix(in srgb, var(--color-success) 22%, transparent); color: var(--color-success); }
.tag.skill { background: color-mix(in srgb, var(--color-info) 22%, transparent); color: var(--color-info); }
.how { font-size: 13.5px; line-height: 1.5; white-space: pre-line; quotes: '“' '”'; }
.nums { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.go { align-self: flex-start; height: 30px; padding: 0 14px; border-radius: 9999px; font-size: 12.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); margin-top: 2px; }
.go:disabled { opacity: .45; cursor: default; }
.made { margin-top: 8px; font-size: 12.5px; color: var(--color-success); line-height: 1.5; }
.made details { margin-top: 4px; color: var(--text-secondary); }
.made summary { cursor: pointer; }
.made pre { max-height: 180px; overflow: auto; margin: 6px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--field-bg); font-size: 11.5px; white-space: pre-wrap; }
.err { margin: 6px 0 0; font-size: 13px; color: var(--color-error); }
</style>
