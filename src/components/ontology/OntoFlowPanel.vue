<script setup>
// 병목 보기(server lib/ontology/flowload.js · flowtime.js, 설계 docs/auto-ax-onboarding/design-improve-on-map.md): 원천은 프로세스 지도다.
//   - 지금 쌓인 할 일: 지도 엔진 · 스냅샷 건이 단계마다 넣은 todolist 행을 일(activity_id)마다 센 것 — 가장 많이 쌓인 사람 단계가 병목
//   - 회사의 제약: 그 할 일을 역할로 모아(여러 프로세스에 걸쳐) 한 사람당 — 가장 무거운 역할
//   - 흔한 길(크리티컬 패스): 지도의 길(마이닝에서 자주 일어난 넘어감)을 엔진처럼 매번 가장 흔한 쪽으로 따라가며, 일마다 걸린 시간과
//     그 앞에 쌓인 것을 치우는 데 드는 시간(리틀의 법칙)을 더한 것
//   - 걸린 시간: 실행 건이 5건 이상이면 실행 기록, 아니면 메일 · 대화 기록에서 잰 응답 시간(추정) — 근무 시간(평일 9~18시)
//   - 에이전트 구간: 에이전트가 한 단계(실행 기록) · AI 후보 · 단계 가르기 — 사람의 처리 능력에 넣지 않는다
// emits heat({marks, badges, ways}) 지도에 칠할 것 · task(일) · role(역할) · candidates(AI 후보 열기)
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { api } from '../../api.js'
import { edgeId } from './mapView.js'

const props = defineProps({ procKey: { type: String, default: '' }, at: { type: String, default: '' }, admin: Boolean })
const emit = defineEmits(['heat', 'task', 'role', 'candidates'])
const d = ref(null)
const err = ref('')
const busy = ref(false)
const showAll = ref(false)
let timer = 0, alive = true

const WORK_H = 9
function fmtH(h) {
  if (h == null || !Number.isFinite(h)) return '—'
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}분`
  if (h < WORK_H) return `${Math.round(h * 10) / 10}시간`
  return `${Math.round((h / WORK_H) * 10) / 10}일`
}
const n1 = (v) => (v == null ? '—' : Math.round(v * 10) / 10)
const pct = (v) => `${Math.round((v || 0) * 100)}%`
const STEP_KO = { find: '찾기', exploit: '최대 활용', subordinate: '맞추기', elevate: '늘리기', repeat: '다시 보기' }
const FIT_KO = { high: 'AI가 맡을 수 있음', mid: 'AI가 초안 · 사람이 확인', low: 'AI는 돕기만', none: '사람이 함' }

async function load(quiet = false) {
  if (!quiet) busy.value = true
  try {
    const qs = new URLSearchParams()
    if (props.procKey) qs.set('proc', props.procKey)
    if (props.at) qs.set('at', props.at)
    d.value = await api(`/ontology/flow?${qs}`)
    err.value = ''
  } catch (e) { err.value = e.message } finally { busy.value = false }
  clearTimeout(timer)
  // the open work items move as people hand in their steps: read again now and then while the panel is open (not for a past day)
  if (alive && !props.at) timer = setTimeout(() => load(true), 10_000)
}
// back to the window (another tab, another app where the step was handed in): read again
const onFocus = () => { if (!props.at && document.visibilityState !== 'hidden') load(true) }
onMounted(() => { load(); window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onFocus) })
onBeforeUnmount(() => { alive = false; clearTimeout(timer); window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) })
watch(() => [props.procKey, props.at], () => load())
defineExpose({ load })

const tasks = computed(() => d.value?.tasks || [])
const b = computed(() => d.value?.bottleneck || null)
const bTask = computed(() => tasks.value.find((t) => t.key === b.value?.key) || null)
const C = computed(() => d.value?.constraint || { roles: [] })
const cRole = computed(() => C.value.roles.find((r) => r.role === C.value.key) || null)
const path = computed(() => d.value?.path || null)
const pathMax = computed(() => Math.max(1, ...(path.value?.steps || []).map((s) => s.nowH || 0)))
const shownTasks = computed(() => (showAll.value ? tasks.value : tasks.value.filter((t) => t.wip || t.inPath || (t.share || 0) >= 0.02).slice(0, 12)))
const wipMax = computed(() => Math.max(1, ...tasks.value.map((t) => t.wip || 0)))

// what the map paints: the bottleneck, the heat of the open items, an agent's steps, an outside role's steps; the usual way bold
watch(d, (v) => {
  const marks = new Map(), badges = new Map()
  for (const t of v?.tasks || []) {
    if (t.key === v.bottleneck?.key) { marks.set(t.key, 'bott'); badges.set(t.key, { text: `병목 · 할 일 ${t.wip}`, kind: 'bott' }); continue }
    if (t.outside) { marks.set(t.key, 'out'); if (t.wip) badges.set(t.key, { text: `바깥 대기 ${t.wip}`, kind: 'out' }); continue }
    if (t.agent) { marks.set(t.key, 'agent'); badges.set(t.key, { text: t.wip ? `에이전트 · ${t.wip}` : '에이전트', kind: 'agent' }); continue }
    marks.set(t.key, t.heat ? `heat${t.heat}` : 'calm')
    if (t.wip) badges.set(t.key, { text: `할 일 ${t.wip}`, kind: 'hot' })
  }
  const ways = new Set()
  const keys = (v?.path?.steps || []).map((s) => s.key)
  for (let i = 0; i + 1 < keys.length; i++) ways.add(edgeId({ from: keys[i], to: keys[i + 1] }))
  // two steps side by side: both ways out of the step before them
  for (const [a, x] of v?.path?.parallel || []) { const i = keys.indexOf(a); if (i > 0) { ways.add(edgeId({ from: keys[i - 1], to: x })); ways.add(edgeId({ from: x, to: keys[i + 2] || '' })) } }
  emit('heat', { marks, badges, ways })
}, { immediate: true })

const why = computed(() => {
  const x = b.value
  if (!x) return ''
  if (x.by === 'mined') return '아직 지도에서 돈 건이 없어서, 메일 · 대화 기록으로 잰 「보통 쌓여 있던 양」(추정)이 가장 큰 일이에요.'
  const parts = [`우리 쪽 사람 단계 가운데 지금 할 일이 가장 많이 쌓였어요`]
  if (x.growing) parts.push('최근 2주 동안 들어온 것이 넘긴 것보다 많아요')
  if (x.onPath) parts.push('보통 건이 지나는 길 위에 있어요')
  return `${parts.join(' · ')}.`
})
const gradeText = (t) => (!t?.time || t.time.grade === 'none' ? '잴 수 없음' : t.time.grade === 'run' ? `실행 ${t.time.nRun}건` : `기록 ${t.time.nMined}건 · 추정`)
const taskOf = (k) => tasks.value.find((t) => t.key === k)
</script>

<template>
  <div class="fp" data-testid="onto-flow">
    <p v-if="!d && !err" class="muted pulse">세는 중…</p>
    <template v-else-if="d">
      <div class="sum">
        <button class="tile bott press" :disabled="!b" data-testid="onto-flow-bottleneck" :data-task="b?.key || ''" @click="b && emit('task', b.key)">
          <small>병목</small><b>{{ b?.key || '없음' }}</b><span v-if="b">할 일 {{ b.wip }}건<template v-if="b.by === 'mined'"> · 추정</template></span>
        </button>
        <button class="tile press" :disabled="!C.key" data-testid="onto-flow-constraint" :data-role="C.key || ''" @click="C.key && emit('role', C.key)">
          <small>회사의 제약</small><b>{{ C.key || '없음' }}</b><span v-if="cRole">한 사람당 {{ cRole.perPerson }}건</span>
        </button>
        <div v-if="path" class="tile" data-testid="onto-flow-lead"><small>흔한 길 · 지금 들어오면</small><b>{{ fmtH(path.nowH) }}</b><span>지난 건 {{ fmtH(path.pastH) }}</span></div>
      </div>
      <p class="note" data-testid="onto-flow-source">
        지도에서 돈 건 {{ d.measured.runCases }}개의 할 일 {{ d.measured.runItems }}개(지금 열린 것 {{ d.measured.openItems }}개)와 메일 · 대화 기록 {{ d.measured.minedCases }}건으로 셈했어요.
        시간은 근무 시간(평일 9~18시)이에요.<template v-if="d.at"> {{ d.at.slice(0, 10) }} 기준이에요.</template>
        <button v-if="!d.at" class="lnk press" :disabled="busy" data-testid="onto-flow-reload" @click="load()">{{ busy ? '세는 중…' : '다시 세기' }}</button>
      </p>

      <!-- 병목 -->
      <section v-if="b" class="box bott" data-testid="onto-flow-bott">
        <h4>병목 · {{ b.key }}<small>{{ b.role }}</small></h4>
        <p class="why">{{ why }}</p>
        <div class="kv">
          <span><i>지금 할 일</i><b>{{ b.wip }}건</b></span>
          <span><i>가장 오래 기다림</i><b>{{ fmtH(b.oldestH) }}</b></span>
          <span><i>근무일마다 들어옴 · 넘김</i><b>{{ n1(b.inPerDay) }} · {{ n1(b.perDay) }}건</b></span>
          <span><i>쌓인 것 치우기</i><b>{{ b.clearH == null ? '처리 없음' : fmtH(b.clearH) }}</b></span>
        </div>
        <ul v-if="bTask?.open?.length" class="open">
          <li v-for="(o, i) in bTask.open" :key="i"><span>{{ o.subject || `건 ${i + 1}` }}</span><small>{{ fmtH(o.ageH) }} 기다림<template v-if="o.who"> · {{ o.who }}</template></small></li>
        </ul>
        <p v-if="bTask?.cand" class="sm">AI 후보: {{ FIT_KO[bTask.cand.fit] || bTask.cand.fit }}</p>
      </section>

      <!-- 흔한 길 = 크리티컬 패스 -->
      <section v-if="path" class="box" data-testid="onto-flow-path">
        <h4>흔한 길 · 크리티컬 패스<small>보통 건 {{ pct(path.p) }}가 이 길과 같아요</small></h4>
        <p class="sm">지도가 마이닝에서 센 자주 일어난 길을 엔진처럼 매번 가장 흔한 쪽으로 따라갔어요. 파란 막대는 지난 건이 그 일에서 걸린 시간(기다림 포함), 주황은 지금 줄이 선 일에서 더 기다릴 시간(쌓인 할 일 ÷ 하루 처리량)이에요.</p>
        <ol class="chain">
          <li v-for="s in path.steps" :key="s.key" :class="{ long: s.key === path.longest, bott: s.key === b?.key, beside: s.beside }" data-testid="onto-flow-path-step" :data-task="s.key">
            <button class="nm press" @click="emit('task', s.key)">{{ s.key }}<small v-if="s.beside"> · 나란히(더하지 않음)</small><small v-else-if="taskOf(s.key)?.agent"> · 에이전트</small></button>
            <span class="bar"><i class="w" :style="{ width: `${(100 * (s.pastH || 0)) / pathMax}%` }" /><i class="q" :style="{ width: `${(100 * (s.extraH || 0)) / pathMax}%` }" /></span>
            <small class="t">{{ fmtH(s.pastH) }}<template v-if="s.extraH"> → 지금 {{ fmtH(s.nowH) }}</template><template v-else-if="s.stuck"> · 넘긴 것 없이 쌓임</template></small>
          </li>
        </ol>
        <p class="sm total">지난 건 {{ fmtH(path.pastH) }} · 지금 들어오면 {{ fmtH(path.nowH) }}<template v-if="path.extraH">(줄 때문에 +{{ fmtH(path.extraH) }})</template><template v-if="path.longest"> · 가장 긴 고리 「{{ path.longest }}」</template></p>
        <p v-if="path.bottOnPath && path.longest === b?.key" class="hit" data-testid="onto-flow-chain">병목이 흔한 길 위의 가장 긴 고리예요. 이 일 앞의 기다림이 줄면 리드타임이 그만큼 줄어요.</p>
        <p v-else-if="b && !path.bottOnPath" class="sm">병목 「{{ b.key }}」은 흔한 길 밖에 있어요. 그 길로 가는 건만 늦어져요.</p>
        <p class="legend"><i class="w" />지난 건이 걸린 시간 <i class="q" />지금 줄 때문에 더 기다릴 시간</p>
      </section>

      <!-- 일마다 -->
      <section class="box" data-testid="onto-flow-tasks">
        <h4>일마다<small>할 일 · 들어옴/넘김(근무일마다) · 걸린 시간</small></h4>
        <ul class="rows">
          <li v-for="t in shownTasks" :key="t.key" :class="{ bott: t.key === b?.key, agent: t.agent, out: t.outside }" data-testid="onto-flow-task" :data-task="t.key" :data-wip="t.wip">
            <button class="nm press" @click="emit('task', t.key)">{{ t.key }}<small>{{ t.agent ? '에이전트' : t.outside ? `${t.role} · 바깥` : t.role }}</small></button>
            <span class="wip"><i :style="{ width: `${(100 * (t.wip || 0)) / wipMax}%` }" /><b>{{ t.wip }}</b></span>
            <span class="io">{{ n1(t.inPerDay) }} / {{ n1(t.perDay) }}<b v-if="t.growing" class="up" title="들어온 것이 넘긴 것보다 많아요">↑</b></span>
            <span class="tm">{{ fmtH(t.time?.medH) }}<small :class="{ est: t.time?.estimated }">{{ gradeText(t) }}</small></span>
          </li>
        </ul>
        <button v-if="tasks.length > shownTasks.length || showAll" class="lnk press" @click="showAll = !showAll">{{ showAll ? '접기' : `일 ${tasks.length}개 모두 보기` }}</button>
      </section>

      <!-- 오래 걸리는 구간(기록) -->
      <section v-if="d.ways?.length" class="box" data-testid="onto-flow-ways">
        <h4>오래 걸리는 구간<small>메일 · 대화 기록 · 앞 일이 넘긴 때부터</small></h4>
        <ul class="ways">
          <li v-for="w in d.ways" :key="`${w.from}>${w.to}`"><span>{{ w.from }} → {{ w.to }}</span><b>{{ fmtH(w.medH) }}</b><small>{{ w.n }}건</small></li>
        </ul>
      </section>

      <!-- 회사의 제약 -->
      <section class="box" data-testid="onto-flow-roles">
        <h4>회사의 제약 · 역할마다<small>모든 프로세스의 할 일을 역할로</small></h4>
        <ul class="roles">
          <li v-for="r in C.roles" :key="r.role" :class="{ top: r.role === C.key }" data-testid="onto-flow-role" :data-role="r.role">
            <button class="nm press" @click="emit('role', r.role)">{{ r.role }}<small>{{ r.members }}명</small></button>
            <span class="pp"><b>{{ r.perPerson }}</b>건/사람<b v-if="r.growing && r.wip" class="up">↑</b></span>
            <span class="procs"><em v-for="p in r.procs" :key="p.key">{{ p.name }} {{ p.wip }}</em><em v-if="!r.procs.length" class="none">쌓인 할 일 없음</em></span>
          </li>
        </ul>
        <p v-if="cRole && cRole.procs.length > 1" class="sm">「{{ cRole.role }}」 역할은 {{ cRole.procs.length }}개 프로세스의 할 일을 함께 짊어지고 있어요. 한 프로세스만 보면 보이지 않는 제약이에요.</p>
      </section>

      <!-- 에이전트 구간 -->
      <section v-if="d.agentSteps?.length || bTask" class="box" data-testid="onto-flow-agents">
        <h4>에이전트 구간<small>사람의 처리 능력에 넣지 않아요</small></h4>
        <ul class="ways">
          <li v-for="a in d.agentSteps" :key="a.key"><span>{{ a.key }}</span><b>{{ a.run ? fmtH(a.run.medH) : '—' }}</b><small>{{ a.run ? `에이전트가 ${a.run.n}번` : '에이전트가 맡는 일' }}</small></li>
        </ul>
        <p v-if="bTask && !bTask.cand" class="sm">병목 「{{ bTask.key }}」을 AI가 도울 수 있는지는 아직 보지 않았어요. <button class="lnk press" data-testid="onto-flow-open-candidates" @click="emit('candidates')">AI 후보 보기</button></p>
      </section>

      <!-- 개선 제안 -->
      <section v-if="d.suggestions?.length" class="box" data-testid="onto-flow-suggest">
        <h4>개선 제안<small>제약 이론의 다섯 걸음</small></h4>
        <ol class="sug">
          <li v-for="(s, i) in d.suggestions" :key="i"><b>{{ STEP_KO[s.step] }}</b><span>{{ s.text }}</span></li>
        </ol>
      </section>
      <p class="foot">할 일 = 지도에서 돈 건이 단계마다 넣은 할 일 목록(todolist)의 행 가운데 아직 끝나지 않은 것을 일(activity_id)마다 센 수예요. 기다림 = 할 일 ÷ 근무일마다 넘긴 수(리틀의 법칙).</p>
    </template>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.fp { display: flex; flex-direction: column; gap: 10px; word-break: keep-all; }
.muted, .note { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 0; font-size: 13px; color: var(--color-error); }
.sum { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.tile { padding: 9px 10px; border-radius: 14px; background: var(--cell-bg); display: flex; flex-direction: column; gap: 1px; text-align: left; min-width: 0; }
.tile small { font-size: 11px; color: var(--text-secondary); }
.tile b { font-size: 15px; font-weight: 700; overflow-wrap: anywhere; line-height: 1.25; }
.tile span { font-size: 11.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.tile.bott { background: color-mix(in srgb, #d6336c 14%, var(--cell-bg)); }
.tile.bott b { color: #c2255c; }
.box { padding: 10px 12px; border-radius: 14px; background: var(--field-bg); display: flex; flex-direction: column; gap: 7px; }
.box.bott { border-left: 3px solid #d6336c; }
h4 { margin: 0; font-size: 13.5px; font-weight: 700; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
h4 small { font-size: 11.5px; font-weight: 400; color: var(--text-tertiary); }
.why, .sm { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--text-secondary); }
.kv { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; }
.kv span { display: flex; flex-direction: column; }
.kv i { font-style: normal; font-size: 11px; color: var(--text-tertiary); }
.kv b { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.open { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.open li { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; padding: 4px 8px; border-radius: 8px; background: var(--cell-bg); }
.open small { color: var(--text-tertiary); white-space: nowrap; }
.chain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.chain li { display: grid; grid-template-columns: 96px 1fr auto; align-items: center; gap: 8px; }
.chain li.beside { opacity: .55; }
.chain .nm { font-size: 12.5px; text-align: left; overflow-wrap: anywhere; }
.chain .nm small { color: var(--text-tertiary); }
.chain li.long .nm, .chain li.bott .nm { font-weight: 700; color: #c2255c; }
.bar { display: flex; height: 10px; border-radius: 5px; background: var(--cell-bg); overflow: hidden; }
.bar i { display: block; height: 100%; }
i.w, .legend i.w { background: #4c6ef5; }
i.q, .legend i.q { background: #e8590c; }
.chain .t { font-size: 11.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.total { font-weight: 500; color: var(--text-primary); }
.hit { margin: 0; font-size: 12.5px; line-height: 1.5; padding: 6px 9px; border-radius: 10px; background: color-mix(in srgb, #d6336c 12%, transparent); color: var(--text-primary); }
.legend { margin: 0; font-size: 11px; color: var(--text-tertiary); display: flex; align-items: center; gap: 5px; }
.legend i { width: 10px; height: 8px; border-radius: 2px; display: inline-block; margin-left: 6px; }
.rows, .roles, .ways { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.rows li { display: grid; grid-template-columns: 1fr 64px 54px 82px; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 9px; }
.rows li.bott { background: color-mix(in srgb, #d6336c 10%, transparent); }
.rows li.agent .nm small { color: #2f9e6e; }
.rows li.out { opacity: .6; }
.rows .nm, .roles .nm { display: flex; flex-direction: column; align-items: flex-start; text-align: left; font-size: 12.5px; min-width: 0; overflow-wrap: anywhere; }
.rows .nm small, .roles .nm small { font-size: 11px; color: var(--text-tertiary); }
.wip { position: relative; height: 16px; border-radius: 5px; background: var(--cell-bg); overflow: hidden; display: flex; align-items: center; }
.wip i { position: absolute; left: 0; top: 0; bottom: 0; background: color-mix(in srgb, #e8590c 55%, transparent); }
.rows li.bott .wip i { background: #d6336c; }
.wip b { position: relative; margin-left: 5px; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.io { font-size: 11.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.up { color: #e8590c; margin-left: 2px; }
.tm { display: flex; flex-direction: column; align-items: flex-end; font-size: 12px; font-variant-numeric: tabular-nums; }
.tm small { font-size: 10.5px; color: var(--text-tertiary); white-space: nowrap; }
.tm small.est { color: #b5651d; }
.roles li { display: grid; grid-template-columns: 82px 74px 1fr; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 9px; }
.roles li.top { background: color-mix(in srgb, #d6336c 10%, transparent); }
.pp { font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; }
.pp b { font-size: 14px; color: var(--text-primary); margin-right: 2px; font-variant-numeric: tabular-nums; }
.procs { display: flex; flex-wrap: wrap; gap: 3px; }
.procs em { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 9999px; background: var(--cell-bg); color: var(--text-secondary); }
.procs em.none { background: none; padding: 0; color: var(--text-tertiary); }
.ways li { display: grid; grid-template-columns: 1fr auto 44px; gap: 8px; align-items: baseline; font-size: 12.5px; }
.ways b { font-variant-numeric: tabular-nums; }
.ways small { font-size: 11px; color: var(--text-tertiary); text-align: right; }
.sug { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
.sug li { display: grid; grid-template-columns: 60px 1fr; gap: 6px; font-size: 12.5px; line-height: 1.45; }
.sug b { font-size: 11.5px; color: #c2255c; }
.lnk { font-size: 12.5px; color: var(--color-info); align-self: flex-start; }
.foot { margin: 0; font-size: 11px; color: var(--text-tertiary); line-height: 1.5; }
</style>
