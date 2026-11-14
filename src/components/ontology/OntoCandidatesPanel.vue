<script setup>
// AI 후보(design-v0.3 §24): 지도의 일 가운데 AI(에이전트 · 스킬)에 맡길 수 있는 일과, 사람이 꼭 해야 하는 일.
// 자주 일어나고 맡기기 쉬운 순으로 보인다(맡길 수 있는 정도 × 한 달 횟수). 관리자는 「AI로 고르기」로 다시 묻고, 후보마다 채택 · 아님을 정한다.
// emits marks(Map 일 → high|mid|human) 지도에 칠할 것 · task(일) 그 일 패널 열기
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { api } from '../../api.js'

const props = defineProps({ admin: Boolean })
const emit = defineEmits(['marks', 'task'])
const HOW = { agent: '에이전트가 맡음', draft: '에이전트가 초안 · 사람이 확인', assist: '사람이 하고 AI가 도움', person: '사람이 함' }
const FIT = { high: '맡길 수 있음', mid: '초안까지', low: '돕기만', none: '사람' }
const d = ref(null)
const err = ref('')
const tab = ref('ai')
const busy = ref('')
const openKey = ref('')
let timer = 0, alive = true

async function load() {
  try { d.value = await api('/ontology/candidates'); err.value = '' } catch (e) { err.value = e.message }
  clearTimeout(timer)
  if (alive && d.value?.job?.status === 'running') timer = setTimeout(load, 4000)
}
onMounted(load)
// the marks stay on the map while a task's panel is open over this one (the page clears them when AI 후보 is closed)
onBeforeUnmount(() => { alive = false; clearTimeout(timer) })

const running = computed(() => d.value?.job?.status === 'running')
const feed = computed(() => (d.value?.job?.detail?.feed || []).at(-1)?.text || '')
const items = computed(() => d.value?.items || [])
const ai = computed(() => items.value.filter((x) => (x.fit === 'high' || x.fit === 'mid') && x.status !== 'rejected'))
const human = computed(() => items.value.filter((x) => x.human?.length).sort((a, b) => b.n - a.n))
const rest = computed(() => items.value.filter((x) => x.fit && !ai.value.includes(x) && !x.human?.length))
const shown = computed(() => (tab.value === 'ai' ? ai.value : tab.value === 'human' ? human.value : rest.value))
const saved = computed(() => +ai.value.reduce((a, x) => a + x.monthly, 0).toFixed(0))
watch([ai, human], () => {
  const m = new Map()
  for (const x of human.value) m.set(x.task, 'human')
  for (const x of ai.value) m.set(x.task, x.fit)
  emit('marks', m)
}, { immediate: true })

async function start() {
  busy.value = 'start'; err.value = ''
  try { await api('/ontology/candidates', { method: 'POST', body: {} }); await load() } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function decide(x, status) {
  busy.value = x.task; err.value = ''
  try { await api(`/ontology/candidates/${encodeURIComponent(x.task)}`, { method: 'POST', body: { status } }); await load() } catch (e) { err.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div class="cp" data-testid="onto-candidates">
    <p v-if="!d && !err" class="muted pulse">불러오는 중…</p>
    <template v-else-if="d">
      <div v-if="d.judged" class="sum">
        <div><b>{{ ai.length }}</b><small>AI 후보</small></div>
        <div><b>{{ human.length }}</b><small>사람이 꼭</small></div>
        <div><b>{{ saved }}</b><small>후보 일, 한 달 횟수</small></div>
      </div>
      <p class="note">
        <template v-if="d.judged">{{ d.minN }}번 이상 나온 일 {{ d.judged }}개를 봤어요(한 번만 나온 일 {{ d.once }}개는 빼고). 자주 일어나고 맡기기 쉬운 순서예요.</template>
        <template v-else>지도의 일마다 AI가 맡을 수 있는지, 사람이 꼭 해야 하는지 골라 봐요. 얼마나 자주 일어나는지 · 어떻게 오갔는지 · 양식 · 정해진 때를 근거로 봐요.</template>
      </p>
      <p v-if="running" class="feed pulse" data-testid="onto-candidates-feed">{{ feed || 'AI가 일을 하나씩 보고 있어요…' }}</p>
      <button v-else-if="admin" class="go press" :disabled="!!busy" data-testid="onto-candidates-start" @click="start">{{ d.judged ? (d.unjudged ? `새 일 ${d.unjudged}개 더 보기` : '다시 고르기') : 'AI로 고르기' }}</button>

      <div v-if="d.judged" class="seg" role="tablist">
        <button :class="{ on: tab === 'ai' }" data-testid="onto-cand-tab-ai" @click="tab = 'ai'"><i class="dot ai" />AI 후보 {{ ai.length }}</button>
        <button :class="{ on: tab === 'human' }" data-testid="onto-cand-tab-human" @click="tab = 'human'"><i class="dot human" />사람이 꼭 {{ human.length }}</button>
        <button :class="{ on: tab === 'rest' }" @click="tab = 'rest'">그 밖 {{ rest.length }}</button>
      </div>
      <ul class="list">
        <li v-for="x in shown" :key="x.task" :class="[x.human?.length ? 'human' : x.fit, { acc: x.status === 'accepted', rej: x.status === 'rejected' }]" data-testid="onto-candidate">
          <button class="row press" @click="openKey = openKey === x.task ? '' : x.task">
            <span class="hd"><b>{{ x.task }}</b><span v-if="x.status === 'accepted'" class="tag ok">채택</span><span v-else-if="x.status === 'rejected'" class="tag">아님</span></span>
            <span class="meta">한 달 {{ x.monthly }}번<template v-if="x.role"> · {{ x.role }}</template><template v-if="x.schedule"> · {{ x.schedule }}</template></span>
            <span v-if="x.human?.length" class="how h">{{ x.human.map((h) => h.name).join(' · ') }}</span>
            <span v-else class="how">{{ HOW[x.how] }}<small> · {{ FIT[x.fit] }}</small></span>
            <span class="why">{{ x.why }}</span>
          </button>
          <div v-if="openKey === x.task" class="detail">
            <p v-for="h in x.human || []" :key="h.key" class="sm"><span class="k">{{ h.name }}</span>{{ h.why }}<template v-if="h.hit"> — 규칙에 걸린 것: {{ h.hit }}</template><template v-else> — AI 판단</template></p>
            <p v-if="x.skills?.length" class="sm"><span class="k">쓸 스킬</span><code v-for="s in x.skills" :key="s">{{ s }}</code></p>
            <p v-if="x.needs?.length" class="sm"><span class="k">갖출 것</span>{{ x.needs.join(' · ') }}</p>
            <p v-if="x.risk" class="sm"><span class="k">조심할 점</span>{{ x.risk }}</p>
            <p v-if="x.model" class="sm"><span class="k">판단</span>{{ x.model }}</p>
            <div class="btns">
              <button class="lnk press" @click="emit('task', x.task)">일 · 근거 보기</button>
              <template v-if="admin && !x.human?.length">
                <button v-if="x.status !== 'rejected'" class="ghost press" :disabled="busy === x.task" @click="decide(x, 'rejected')">아님</button>
                <button v-if="x.status !== 'accepted'" class="go small press" :disabled="busy === x.task" data-testid="onto-candidate-accept" @click="decide(x, 'accepted')">채택</button>
                <button v-else class="ghost press" :disabled="busy === x.task" @click="decide(x, 'proposed')">채택 취소</button>
              </template>
            </div>
          </div>
        </li>
      </ul>
    </template>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.cp { display: flex; flex-direction: column; gap: 10px; word-break: keep-all; }
.muted, .note { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 0; font-size: 13px; color: var(--color-error); }
.sum { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.sum div { padding: 10px 12px; border-radius: 14px; background: var(--cell-bg); display: flex; flex-direction: column; }
.sum b { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.sum small { font-size: 11.5px; color: var(--text-secondary); }
.feed { margin: 0; padding: 8px 12px; border-radius: 12px; background: var(--field-bg); font-size: 12.5px; color: var(--text-secondary); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); align-self: flex-start; }
.go.small { height: 30px; font-size: 12.5px; }
.go:disabled, .ghost:disabled { opacity: .45; }
.seg { display: flex; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg button { flex: 1; height: 28px; border-radius: 9999px; font-size: 12px; color: var(--text-secondary); display: inline-flex; align-items: center; justify-content: center; gap: 5px; white-space: nowrap; }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.dot { width: 8px; height: 8px; border-radius: 50%; }
.dot.ai { background: #2f9e6e; } .dot.human { background: #d9822b; }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.list li { border-radius: 12px; background: var(--field-bg); border-left: 3px solid transparent; overflow: hidden; }
.list li.high { border-left-color: #2f9e6e; } .list li.mid { border-left-color: color-mix(in srgb, #2f9e6e 45%, transparent); } .list li.human { border-left-color: #d9822b; }
.list li.rej { opacity: .55; }
.row { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 9px 11px; text-align: left; }
.hd { display: flex; align-items: center; gap: 6px; }
.hd b { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.tag { font-size: 11px; padding: 0 7px; border-radius: 9999px; background: var(--chip-bg, var(--cell-bg)); color: var(--text-secondary); }
.tag.ok { background: color-mix(in srgb, #2f9e6e 24%, transparent); color: var(--text-primary); }
.meta { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.how { font-size: 12.5px; } .how small { color: var(--text-tertiary); } .how.h { font-weight: 500; }
.why { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; }
.detail { padding: 0 11px 10px; display: flex; flex-direction: column; gap: 5px; }
.sm { margin: 0; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
p.sm code { font: 11.5px ui-monospace, Menlo, monospace; padding: 1px 7px; border-radius: 9999px; background: var(--cell-bg); margin-right: 4px; }
.k { color: var(--text-tertiary); margin-right: 6px; }
.btns { display: flex; align-items: center; justify-content: flex-end; gap: 6px; margin-top: 2px; }
.lnk { margin-right: auto; font-size: 12.5px; color: var(--color-info); }
.ghost { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 12.5px; color: var(--text-secondary); }
</style>
