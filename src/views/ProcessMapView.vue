<script setup>
// 회사 프로세스 지도 (spec pgpt-pro_process-ontology, design-v0.2 §4.5)
//   메일 이력 · 채팅 핸드오버로 그린 회사의 일 흐름: 프로세스별 그래프, θ 로 거르기, 지난 시점 보기, 자동으로 정한 값과 근거.
//   처음에는 「지난 메일 읽기(90일)」 → 읽는 동안 진행 막대 → 「지도 그리는 중…」 → 지도.
// 숫자는 모두 서버(lib/ontology/stats.js)가 셈한 것 — 이 화면은 거르고 배치해서 보여 준다(θ 는 보기만 바꾼다).
// 개발 서버에서 ?mock=1 | empty | progress | build 로 가짜 응답(components/ontology/mock.js)을 쓸 수 있다.
// v0.3(design-v0.3 §6): 프로세스는 흐름 · 루틴(한 역할이 결과물 뒤에 혼자 이어서 하는 일), 「사건 보기」로 일 사이의 사건
// (메일 · 결과물 · 채팅)을 넣어 보고(루틴은 늘 사건으로), 「역할」로 역할마다 정의 · 역량 · 수행자 · 지표를 본다.
// 고른 프로세스는 주소의 ?proc= 에 둔다.
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import Icon from '../components/Icon.vue'
import MapGraph from '../components/ontology/MapGraph.vue'
import ThetaControl from '../components/ontology/ThetaControl.vue'
import ValuesPanel from '../components/ontology/ValuesPanel.vue'
import SidePanel from '../components/ontology/SidePanel.vue'
import EdgePanel from '../components/ontology/EdgePanel.vue'
import TaskPanel from '../components/ontology/TaskPanel.vue'
import LabelsDrawer from '../components/ontology/LabelsDrawer.vue'
import FirstRun from '../components/ontology/FirstRun.vue'
import OntoEdgeActions from '../components/ontology/OntoEdgeActions.vue'
import OntoTaskPanel from '../components/ontology/OntoTaskPanel.vue'
import OntoReviewPanel from '../components/ontology/OntoReviewPanel.vue'
import OntoCasePanel from '../components/ontology/OntoCasePanel.vue'
import OntoSnapshotPanel from '../components/ontology/OntoSnapshotPanel.vue'
import EventPanel from '../components/ontology/EventPanel.vue'
import OntoRolePanel from '../components/ontology/OntoRolePanel.vue'
import OntoDocsPanel from '../components/ontology/OntoDocsPanel.vue'
import { visibleGraph, eventGraph, edgeId, procsOf, inProc } from '../components/ontology/mapView.js'
import { BAND, dateKo, dateTimeKo, ymd, taskName } from '../components/ontology/fmt.js'
import { useApp } from '../stores/app.js'
import { api } from '../api.js'
import { narrow } from '../viewport.js'

const app = useApp()
const route = useRoute()
const router = useRouter()
let call = api
const ready = import.meta.env.DEV && route.query.mock
  ? import('../components/ontology/mock.js').then((m) => { call = m.mockApi(String(route.query.mock)) })
  : Promise.resolve()

const status = ref(null)
const map = ref(null)
const phase = ref('loading') // loading | off | empty | mail | build | map | error
const job = ref(null)
const err = ref('')
const note = ref('')
const busy = ref('')
const rebuilding = ref(false)
const procKey = ref('')
const mode = ref('summary')
const at = ref('') // '' = now
const sel = ref(null) // {kind: 'edge'|'task'|'event', id}
const eventsOn = ref(false)
const rolesOpen = ref(false)
const docsOpen = ref(false)
const roleKey = ref('')
const valuesOpen = ref(false)
const reviewOpen = ref(false)
const snapOpen = ref(false)
const caseId = ref(String(route.query.case || ''))
const labelsOpen = ref(false)
const labels = ref([])
const labelsLoading = ref(false)
const labelsErr = ref('')

const meta = computed(() => map.value?.meta || status.value?.meta || null)
// 흐름(건이 많은 것부터) 다음에 루틴
const routineOf = (b) => b?.kind === 'routine'
const processes = computed(() => [...(map.value?.processes || [])].sort((a, b) => routineOf(a) - routineOf(b) || b.cases - a.cases || String(a.name || '').localeCompare(String(b.name || ''))))
const proc = computed(() => processes.value.find((b) => b.key === procKey.value) || null)
const isRoutine = computed(() => routineOf(proc.value))
// 루틴에는 다음 일(NEXT)이 없고 사건 → 일뿐이라 늘 사건으로 본다
const eventsShown = computed(() => eventsOn.value || isRoutine.value)
const view = computed(() => (eventsShown.value ? eventGraph : visibleGraph)(map.value, { proc: procKey.value, mode: mode.value }))
// 회사 전체 건 수: 지금은 meta 의 건 수(어느 흐름에도 들지 않은 건까지), 지난 시점에는 흐름들의 합(루틴은 건이 아니다)
const flowCases = computed(() => processes.value.filter((b) => !routineOf(b)).reduce((a, b) => a + (b.cases || 0), 0))
const allCases = computed(() => (at.value ? flowCases.value || meta.value?.cases : meta.value?.cases || flowCases.value) || 0)
// 시작 비율은 회사 전체 건에 대한 몫 — 프로세스 하나를 볼 때 「시작 n%」는 그 프로세스의 건에 대한 몫으로
// (지도가 그 프로세스 안의 시작 비율 hasTask 를 주면 그대로)
const shareScale = computed(() => (view.value.procShares ? 1 : proc.value?.cases ? allCases.value / proc.value.cases : 1))
const counts = computed(() => {
  const tasks = (map.value?.tasks || []).filter((t) => inProc(t, procKey.value))
  const keys = new Set(tasks.map((t) => t.key))
  return { tasks: tasks.length, edges: (map.value?.edges || []).filter((e) => keys.has(e.from)).length, shownTasks: view.value.tasks.length, shownEdges: view.value.edges.length, events: view.value.events?.length || 0 }
})
// one string (the English-mode dictionary translates it whole)
const countText = computed(() => {
  const c = counts.value
  return eventsShown.value ? `일 ${c.shownTasks}/${c.tasks} · 사건 ${c.events} · 관계 ${c.shownEdges}` : `일 ${c.shownTasks}/${c.tasks} · 관계 ${c.shownEdges}/${c.edges}`
})
const n = (x) => Number(x || 0).toLocaleString('ko-KR')
// 출처 한 줄: 조각마다 따로(영어 모드 사전이 조각 단위로 옮긴다)
const sourceParts = computed(() => {
  const m = meta.value
  if (!m) return []
  const s = m.sources || {}
  const parts = [`메일 이력 ${n(s.mail_history)}건`, `채팅 핸드오버 ${n(s.chat_handover)}건`]
  if (s.agent_delegation) parts.push(`에이전트 위임 ${n(s.agent_delegation)}건`)
  if (s.todolist) parts.push(`실행 기록 ${n(s.todolist)}건`)
  parts.push(`건 ${n(m.cases)}개`)
  if (m.built_at) parts.push(`마지막 계산 ${dateTimeKo(m.built_at)}`)
  return parts
})

// ---------- 시점: 오늘부터 한 주씩 거슬러 데이터 첫날까지 ----------
const weeks = computed(() => {
  const start = meta.value?.data_start ? new Date(meta.value.data_start).getTime() : null
  if (!start) return []
  const out = []
  for (let i = 1; i < 80; i++) {
    const t = Date.now() - i * 7 * 86_400_000
    if (t < start) break
    out.push(ymd(t))
  }
  return out
})
const atLabel = computed(() => `${dateKo(at.value ? `${at.value}T12:00:00` : new Date())} 기준`)
const atIndex = computed(() => (at.value ? weeks.value.indexOf(at.value) : -1))
const older = () => { const i = atIndex.value + 1; if (i < weeks.value.length) at.value = weeks.value[i] }
const newer = () => { const i = atIndex.value - 1; at.value = i >= 0 ? weeks.value[i] : '' }
watch(at, () => { sel.value = null; loadMap().catch((e) => { err.value = e.message }) })

// ---------- 불러오기 · 작업 따라가기 ----------
let timer = null
let alive = true
let picked = false
function poll(fn, ms = 1000) {
  clearTimeout(timer)
  const go = async () => {
    if (!alive) return
    let again = true
    try { again = await fn() } catch (e) { err.value = e.message }
    if (again && alive) timer = setTimeout(go, ms)
  }
  go()
}
async function loadMap() {
  const m = await call(`/ontology/map${at.value ? `?at=${at.value}` : ''}`)
  map.value = m
  if (!m.tasks.length && !at.value) { phase.value = 'empty'; return }
  phase.value = 'map'
  if (procKey.value && !m.processes.some((b) => b.key === procKey.value)) procKey.value = ''
  // the summary card links a proc (?proc=…, older links ?bundle=…); otherwise the one with the most cases
  if (!picked && m.processes.length) {
    picked = true
    const want = String(route.query.proc || route.query.bundle || '')
    procKey.value = m.processes.some((b) => b.key === want) ? want : processes.value[0].key
  }
  if (sel.value?.kind === 'task' && !m.tasks.some((t) => t.key === sel.value.id)) sel.value = null
  if (sel.value?.kind === 'edge' && !m.edges.some((e) => edgeId(e) === sel.value.id)) sel.value = null
  if (sel.value?.kind === 'event' && !(m.events || []).some((e) => e.key === sel.value.id)) sel.value = null
}
async function init() {
  await ready
  try { status.value = await call('/ontology/status') } catch (e) { err.value = e.message; phase.value = 'error'; return }
  if (!status.value.enabled) { phase.value = 'off'; return }
  if (status.value.mail?.status === 'running') return followMail(status.value.mail.id)
  if (status.value.build?.status === 'running') return followJob(status.value.build.id)
  try { await loadMap() } catch (e) { err.value = e.message; phase.value = 'error' }
}
async function retry() {
  busy.value = 'retry'
  err.value = ''
  phase.value = 'loading'
  try { await init() } finally { busy.value = '' }
}
function followMail(id) {
  phase.value = 'mail'
  const before = status.value?.build?.id || null
  poll(async () => {
    const j = await call(`/ontology/jobs/${id}`)
    job.value = j
    if (j.status === 'running') return true
    if (j.status === 'failed') {
      err.value = j.error || '메일을 읽지 못했어요.'
      job.value = null
      phase.value = map.value?.tasks?.length ? 'map' : 'empty'
      return false
    }
    // 다 읽으면 서버가 스스로 지도를 다시 그린다(status.build)
    job.value = null
    phase.value = 'build'
    waitBuild(before)
    return false
  })
}
function waitBuild(before) {
  const since = Date.now()
  poll(async () => {
    status.value = await call('/ontology/status')
    const b = status.value.build
    if (b && b.id !== before) { followJob(b.id); return false }
    if (Date.now() - since > 20000) { await loadMap(); return false }
    return true
  })
}
function followJob(id) {
  if (phase.value === 'map') rebuilding.value = true
  else phase.value = 'build'
  poll(async () => {
    const j = await call(`/ontology/jobs/${id}`)
    if (!rebuilding.value) job.value = j
    if (j.status === 'running') return true
    if (j.status === 'failed') err.value = j.error || '지도를 그리지 못했어요.'
    job.value = null
    rebuilding.value = false
    await loadMap()
    status.value = await call('/ontology/status').catch(() => status.value)
    if (j.status === 'done' && !map.value?.tasks?.length) note.value = '읽은 기록에서 아직 일 흐름을 찾지 못했어요. 인계 기록이 더 쌓이면 다시 셈해 보세요.'
    return false
  })
}
async function startMail() {
  busy.value = 'mail'
  err.value = ''
  try {
    status.value = await call('/ontology/status').catch(() => status.value)
    const r = await call('/ontology/mail-history', { method: 'POST', body: { days: 90 } })
    followMail(r.job)
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function rebuild() {
  busy.value = 'build'
  err.value = ''
  try { const r = await call('/ontology/build', { method: 'POST' }); followJob(r.job) } catch (e) { err.value = e.message } finally { busy.value = '' }
}

// ---------- 고르기 · 패널 ----------
const selEdge = computed(() => (sel.value?.kind === 'edge' ? (map.value?.edges || []).find((e) => edgeId(e) === sel.value.id) || null : null))
const selTask = computed(() => (sel.value?.kind === 'task' ? (map.value?.tasks || []).find((t) => t.key === sel.value.id) || null : null))
const selEvent = computed(() => (sel.value?.kind === 'event' ? (map.value?.events || []).find((e) => e.key === sel.value.id) || null : null))
watch(procKey, (k) => {
  if (String(route.query.proc || '') === k) return
  const query = { ...route.query, proc: k || undefined }
  delete query.bundle
  router.replace({ query }).catch(() => {})
})
function pickProc(k) { procKey.value = k; sel.value = null }
// 일 패널의 「프로세스」에서: 그 프로세스로 옮기고 그 일은 계속 고른 채로
function openProc(k) { const id = sel.value?.kind === 'task' ? sel.value.id : null; pickProc(k); if (id) sel.value = { kind: 'task', id } }
const closeSide = () => { valuesOpen.value = false; reviewOpen.value = false; snapOpen.value = false; rolesOpen.value = false; docsOpen.value = false; roleKey.value = ''; caseId.value = '' }
function onSelect(x) { if (x) closeSide(); sel.value = x }
function toggleValues() { const open = !valuesOpen.value; closeSide(); sel.value = null; valuesOpen.value = open }
function toggleReview() { const open = !reviewOpen.value; closeSide(); sel.value = null; reviewOpen.value = open }
function toggleSnap() { const open = !snapOpen.value; closeSide(); sel.value = null; snapOpen.value = open }
function toggleRoles() { const open = !rolesOpen.value; closeSide(); sel.value = null; rolesOpen.value = open }
function toggleDocs() { const open = !docsOpen.value; closeSide(); sel.value = null; docsOpen.value = open }
// 일 패널의 역할 이름 · 역할 목록에서: 그 역할로
function openRole(key) { closeSide(); sel.value = null; rolesOpen.value = true; roleKey.value = key || '' }
const roleName = computed(() => (map.value?.roles || []).find((r) => r.key === roleKey.value)?.name || roleKey.value)
// 프로세스 채택(관리자): 채택한 프로세스만 들어오는 메일을 받아 스냅샷으로 돈다
const LADDER = [
  { key: 'paused', ko: '관찰', tip: '지도에서 보기만 해요. 요청이 와도 묻지 않아요.' },
  { key: 'suggested', ko: '제안', tip: '이 일로 보이는 메일 · 채팅 요청이 오면 「이 프로세스로 진행할까요?」라고 물어요.' },
  { key: 'adopted', ko: '자동', tip: '메일 · 앞 일 · 타이머가 오면 저절로 시작하고, 사람 단계는 에이전트가 초안을 먼저 만들어 둬요.' },
]
// 회사의 타이머(design-v0.3 §13): 정해 둔 시각에 이 프로세스를 시작한다(단계가 「자동」이면 바로, 「제안」이면 묻는다)
const timerOpen = ref(false)
const CRONS = [{ cron: '0 9 * * 1-5', ko: '평일 9시' }, { cron: '0 9 * * 1', ko: '매주 월 9시' }, { cron: '0 9 1 * *', ko: '매월 1일 9시' }, { cron: '0 17 * * 5', ko: '매주 금 17시' }]
const timerCron = ref(CRONS[0].cron)
const timerEntry = ref('')
const timerMsg = ref('')
const timers = computed(() => (map.value?.startsOn || []).filter((s) => s.from === proc.value?.key && String(s.to).startsWith('timer:'))
  .map((s) => (map.value.events || []).find((e) => e.key === s.to)).filter(Boolean))
async function addTimer() {
  busy.value = 'timer'; timerMsg.value = ''
  try {
    const r = await call('/ontology/timers', { method: 'POST', body: { proc: proc.value.key, entry: timerEntry.value || proc.value.entries?.[0] || '', cron: timerCron.value } })
    timerMsg.value = `${r.when}에 「${r.entry}」부터 시작해요.`
    await loadMap()
  } catch (e) { timerMsg.value = e.message } finally { busy.value = '' }
}
async function setTimer(key, st) {
  busy.value = 'timer'
  try { await call(`/ontology/timers/${encodeURIComponent(key)}`, { method: 'PUT', body: { status: st } }); await loadMap() } catch (e) { timerMsg.value = e.message } finally { busy.value = '' }
}
async function adopt(status) {
  if (!proc.value) return
  busy.value = 'adopt'
  try { await call('/ontology/processes/status', { method: 'POST', body: { key: proc.value.key, status, name: proc.value.name } }); await loadMap() } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function openLabels() {
  labelsOpen.value = true
  labelsLoading.value = true
  labelsErr.value = ''
  try { labels.value = await call('/ontology/labels') } catch (e) { labelsErr.value = e.message } finally { labelsLoading.value = false }
}
// 기록에서 일 이름을 누르면 그 일을 지도에서 고른다(안 보이면 그 프로세스 · θ 전체로)
function showTask(key) {
  const t = (map.value?.tasks || []).find((x) => x.key === key)
  labelsOpen.value = false
  if (!t) return
  if (procKey.value && !procsOf(t).includes(procKey.value)) procKey.value = procsOf(t)[0] || ''
  if (!view.value.tasks.some((x) => x.key === key)) mode.value = 'all'
  // a routine's task is only on the events view
  if (!view.value.tasks.some((x) => x.key === key) && !eventsShown.value) eventsOn.value = true
  onSelect({ kind: 'task', id: key })
}

onMounted(async () => {
  app.mode = 'process-map'
  if (!app.me) app.me = await api('/me').catch(() => null)
  init()
})
onBeforeUnmount(() => { alive = false; clearTimeout(timer) })
</script>

<template>
  <div class="pmap ontomap">
    <TopBar />
    <div class="content" :class="{ narrow, sheet: narrow && (sel || valuesOpen) }">
      <div class="head">
        <div class="ttl">
          <h1>회사 프로세스 지도</h1>
          <span v-if="phase === 'map'" class="src"><template v-for="(x, i) in sourceParts" :key="i"><i v-if="i"> · </i><span>{{ x }}</span></template></span>
        </div>
        <span class="sp" />
        <div v-if="phase === 'map'" class="tools">
          <button class="hbtn glass press" :class="{ on: valuesOpen }" @click="toggleValues">값 보기</button>
          <button class="hbtn glass press" @click="openLabels">이름 맞춘 기록</button>
          <button class="hbtn glass press" :class="{ on: reviewOpen }" @click="toggleReview">검토 안건</button>
          <button class="hbtn glass press" :class="{ on: rolesOpen }" data-testid="onto-roles-button" @click="toggleRoles">역할</button>
          <button class="hbtn glass press" :class="{ on: docsOpen }" data-testid="onto-docs-button" @click="toggleDocs">문서</button>
          <button v-if="proc && !isRoutine" class="hbtn glass press" :class="{ on: snapOpen }" @click="toggleSnap">스냅샷 보기</button>
          <!-- 승격 단계(design-v0.3 §12): 관찰 → 제안(요청이 오면 묻는다) → 자동(이벤트에 저절로 시작, 사람 단계는 초안이 먼저) -->
          <div v-if="proc && !isRoutine" class="ladder glass" role="group" aria-label="이 프로세스의 단계" data-testid="onto-ladder" :data-status="proc.status">
            <button v-for="st in LADDER" :key="st.key" class="press" :class="{ on: proc.status === st.key }" :disabled="!status?.admin || !!busy || proc.status === st.key"
              :title="st.tip" :data-testid="`onto-ladder-${st.key}`" @click="adopt(st.key)">{{ st.ko }}</button>
          </div>
          <button v-if="proc && !isRoutine && status?.admin" class="hbtn glass press" :class="{ on: timerOpen }" data-testid="onto-timer-button" @click="timerOpen = !timerOpen">타이머</button>
          <!-- 온보딩 다시: 새로 온 메일과, 스킬이 바뀐 뒤 아직 그 판으로 읽지 않은 스레드만 읽고 지도를 다시 그린다 -->
          <button class="hbtn glass press" data-testid="onto-reread" :disabled="!!busy || rebuilding" title="새로 온 메일과, 스킬이 바뀐 뒤 아직 읽지 않은 스레드만 읽어요" @click="startMail">
            <Icon name="mail" :size="15" /> 메일 다시 읽기
          </button>
          <button v-if="status?.admin" class="hbtn glass press" :disabled="!!busy || rebuilding" @click="rebuild">
            <Icon name="refresh" :size="15" :class="{ spin: rebuilding }" /> {{ rebuilding ? '셈하는 중…' : '다시 셈하기' }}
          </button>
        </div>
        <button v-else-if="phase === 'empty' && status?.admin" class="hbtn glass press" :disabled="!!busy" @click="rebuild">
          <Icon name="refresh" :size="15" /> 다시 셈하기
        </button>
      </div>

      <p v-if="err" class="err">{{ err }}</p>

      <p v-if="phase === 'loading'" class="loading pulse">불러오는 중…</p>
      <FirstRun v-else-if="phase !== 'map'" :phase="phase" :job="phase === 'build' ? job || status?.build : job" :busy="busy === 'mail' || busy === 'retry'" :note="note" @start="startMail" @retry="retry" />

      <template v-else>
        <div class="bar">
          <div class="chips scroll">
            <button class="bchip press" :class="{ on: !procKey }" @click="pickProc('')">전체 <small>건 {{ n(allCases) }}</small></button>
            <button v-for="b in processes" :key="b.key" class="bchip press" :class="{ on: procKey === b.key, routine: b.kind === 'routine' }" :title="b.summary" data-testid="onto-proc-chip" :data-kind="b.kind || 'flow'" @click="pickProc(b.key)">
              {{ b.name }}
              <template v-if="b.kind === 'routine'"><span class="band routine">루틴</span> <small>{{ b.role }}</small></template>
              <template v-else><span class="band" :class="b.band">{{ BAND[b.band] || b.bandName }}</span> <small>건 {{ n(b.cases) }}</small></template>
            </button>
          </div>
          <div class="when glass-thin">
            <button class="nav" aria-label="한 주 전" :disabled="atIndex >= weeks.length - 1" @click="older"><Icon name="back" :size="14" /></button>
            <label class="pick">
              <span>{{ atLabel }}</span>
              <select v-model="at" aria-label="시점 고르기">
                <option value="">지금</option>
                <option v-for="w in weeks" :key="w" :value="w">{{ dateKo(`${w}T12:00:00`) }}</option>
              </select>
            </label>
            <button class="nav" aria-label="한 주 뒤" :disabled="!at" @click="newer"><Icon name="chevron" :size="14" /></button>
            <button v-if="at" class="now press" @click="at = ''">지금</button>
          </div>
        </div>

        <div class="card glass">
          <div class="ctl">
            <ThetaControl v-if="!isRoutine" v-model:mode="mode" :proc="proc" />
            <p v-else class="rnote">「{{ proc.role }}」 역할에서 결과물이 나오면 혼자 이어서 하는 일이에요. 같은 역할 여러 사람의 습관을 셈했어요.</p>
            <button class="evt press" role="switch" :aria-checked="eventsShown" :class="{ on: eventsShown }" :disabled="isRoutine" :title="isRoutine ? '루틴은 사건으로만 보여요' : '일 사이에 메일 · 결과물 같은 사건을 넣어 봐요'" data-testid="onto-events-toggle" @click="eventsOn = !eventsOn">
              <span class="knob" /> 사건 보기
            </button>
            <small class="cnt">{{ countText }}</small>
          </div>
          <div class="stage">
          <p v-if="!view.tasks.length" class="none">{{ at ? '그날에는 아직 그린 지도가 없어요.' : '이 θ 로는 남는 일이 없어요.' }}</p>
          <MapGraph v-else :tasks="view.tasks" :edges="view.edges" :entries="view.entries" :events="view.events || []" :selected="sel" :dir="narrow ? 'TB' : 'LR'" :side="!!(selEdge || selTask || selEvent || valuesOpen || reviewOpen || snapOpen || rolesOpen || timerOpen || caseId)" :scale="shareScale" @select="onSelect" />
          <div v-if="view.tasks.length && eventsShown" class="legend">
            <span><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-info)" stroke-width="1.6" /></svg>메일</span>
            <span><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-success)" stroke-width="1.6" /></svg>결과물</span>
            <span><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="#a78bfa" stroke-width="1.6" /></svg>채팅</span>
            <span><b class="and">함께</b>한 사건 뒤 여러 일이 함께 열려요</span>
            <span><svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="3.5" /></svg>굵을수록 자주</span>
          </div>
          <div v-else-if="view.tasks.length" class="legend">
            <span><svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="3.5" /></svg>굵을수록 자주</span>
            <span><svg width="26" height="10"><path d="M1 5h24" stroke="#F0883E" stroke-width="2" stroke-dasharray="6 4" /></svg>은퇴 후보</span>
            <span><svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="2" stroke-dasharray="2 4" opacity=".5" /></svg>은퇴함</span>
            <span><svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="2" opacity=".35" /></svg>관찰 적음</span>
          </div>

          <SidePanel v-if="selEdge" kicker="관계" :title="`${taskName(selEdge.from)} → ${taskName(selEdge.to)}`" @close="sel = null">
            <EdgePanel :edge="selEdge">
              <template #actions><OntoEdgeActions :edge="selEdge" :admin="!!status?.admin" @changed="loadMap" /></template>
            </EdgePanel>
          </SidePanel>
          <SidePanel v-else-if="selEvent" kicker="사건" :title="selEvent.name" @close="sel = null">
            <EventPanel :event="selEvent" :triggers="map.triggers || []" :raises="map.raises || []" :tasks="map.tasks" :processes="map.processes || []" :admin="!!status?.admin" @task="showTask" @changed="loadMap" />
          </SidePanel>
          <SidePanel v-else-if="selTask" kicker="일" :title="selTask.name" @close="sel = null">
            <TaskPanel :task="selTask" :edges="map.edges" :processes="processes" @edge="(e) => onSelect({ kind: 'edge', id: edgeId(e) })" @role="openRole" @proc="openProc">
              <template #actions><OntoTaskPanel :task-key="selTask.key" :admin="!!status?.admin" hide-header @changed="loadMap" /></template>
            </TaskPanel>
          </SidePanel>
          <SidePanel v-else-if="reviewOpen" kicker="학습 순환" title="검토 안건" @close="reviewOpen = false">
            <OntoReviewPanel :admin="!!status?.admin" :habits="map.habits || null" @changed="loadMap" @open-edge="(e) => onSelect({ kind: 'edge', id: edgeId(e) })" @open-task="(k) => showTask(k)" />
          </SidePanel>
          <SidePanel v-else-if="rolesOpen" kicker="역할" :title="roleKey ? roleName : '역할'" @close="rolesOpen = false; roleKey = ''">
            <OntoRolePanel :role-key="roleKey" :roles="map.roles || []" :events="map.events || []" :triggers="map.triggers || []" :tasks="map.tasks" :admin="!!status?.admin"
              @pick="(k) => (roleKey = k)" @task="showTask" @changed="loadMap" />
          </SidePanel>
          <SidePanel v-else-if="docsOpen" kicker="규정 · 업무 정의서" title="문서대로와 실제" @close="docsOpen = false">
            <OntoDocsPanel :tasks="map.tasks" @task="showTask" @proc="(k) => { docsOpen = false; pickProc(k) }" @changed="loadMap" />
          </SidePanel>
          <SidePanel v-else-if="timerOpen && proc" kicker="타이머" :title="`${proc.name} 타이머`" @close="timerOpen = false">
            <div class="timers" data-testid="onto-timer-panel">
              <p class="tnote">정해 둔 시각이 되면 이 프로세스를 시작해요. 단계가 「자동」이면 바로 시작하고 사람 단계는 초안이 먼저 만들어져요. 「제안」이면 시작할지 물어요.</p>
              <ul v-if="timers.length" class="tl">
                <li v-for="e in timers" :key="e.key" :class="e.status" data-testid="onto-timer-item">
                  <b>{{ e.name }}</b><small>{{ e.status === 'paused' ? '멈춤' : `${e.n || 0}번 울림` }}</small>
                  <button class="link press" :disabled="!!busy" @click="setTimer(e.key, e.status === 'paused' ? 'active' : 'paused')">{{ e.status === 'paused' ? '켜기' : '멈추기' }}</button>
                  <button class="link press" :disabled="!!busy" @click="setTimer(e.key, 'gone')">지우기</button>
                </li>
              </ul>
              <label>주기 <select v-model="timerCron" data-testid="onto-timer-cron"><option v-for="c in CRONS" :key="c.cron" :value="c.cron">{{ c.ko }}</option></select></label>
              <label>시작할 일 <select v-model="timerEntry" data-testid="onto-timer-entry"><option value="">{{ proc.entries?.[0] || proc.tasks?.[0] }} (가장 흔한 시작)</option>
                <option v-for="t in (proc.tasks || []).filter((x) => x !== proc.entries?.[0])" :key="t" :value="t">{{ t }}</option></select></label>
              <button class="hbtn glass press" :disabled="!!busy" data-testid="onto-timer-add" @click="addTimer">{{ busy === 'timer' ? '거는 중…' : '타이머 걸기' }}</button>
              <small v-if="timerMsg" class="tnote" data-testid="onto-timer-msg">{{ timerMsg }}</small>
            </div>
          </SidePanel>
          <SidePanel v-else-if="snapOpen && proc" kicker="실행 모델" :title="`${proc.name} 스냅샷`" @close="snapOpen = false">
            <OntoSnapshotPanel :proc="proc" :at="at" />
          </SidePanel>
          <SidePanel v-else-if="caseId" kicker="건" title="이 건의 흐름" @close="caseId = ''">
            <OntoCasePanel :case-id="caseId" hide-header @open-task="(k) => showTask(k)" @moved="loadMap" />
          </SidePanel>
          <SidePanel v-else-if="valuesOpen" kicker="자동으로 정한 값" :title="proc ? proc.name : '프로세스마다'" @close="valuesOpen = false">
            <ValuesPanel v-if="proc" :proc="proc" :meta="meta" />
            <template v-else>
              <p class="vnote">프로세스를 하나 고르면 근거 그림이 함께 보여요.</p>
              <div v-for="b in processes" :key="b.key" class="vb">
                <button class="vbn press" @click="pickProc(b.key)">{{ b.name }} <Icon name="chevron" :size="13" /></button>
                <ValuesPanel :proc="b" :meta="meta" compact />
              </div>
            </template>
          </SidePanel>
          </div>
        </div>
      </template>
    </div>

    <LabelsDrawer v-if="labelsOpen" :labels="labels" :loading="labelsLoading" :error="labelsErr" @close="labelsOpen = false" @task="showTask" />
  </div>
</template>

<style scoped>
.pmap { position: absolute; inset: 0; }
.content { position: absolute; top: 76px; left: 0; right: 0; bottom: 0; margin: 0 auto; max-width: 1440px; padding: 0 24px 16px; display: flex; flex-direction: column; gap: 10px; }
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ttl { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
h1 { margin: 0; font-size: 27px; font-weight: 500; letter-spacing: -0.02em; }
.src { font-size: 13px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.src i { font-style: normal; }
.sp { flex: 1; }
.tools { display: flex; gap: 8px; flex-wrap: wrap; }
.ladder { display: inline-flex; height: 38px; border-radius: 19px; padding: 3px; gap: 2px; }
.ladder button { border: 0; background: none; border-radius: 16px; padding: 0 13px; font-size: 13.5px; color: var(--text-secondary); }
.ladder button.on { background: var(--ink); color: var(--text-primary-on); }
.ladder button:disabled:not(.on) { opacity: .55; }
.timers { display: flex; flex-direction: column; gap: 10px; }
.timers label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-secondary); }
.timers select { height: 36px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text-primary); padding: 0 8px; }
.tnote { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.tl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.tl li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.tl li.paused b { opacity: .6; }
.tl small { color: var(--text-secondary); flex: 1; }
.timers .link { border: 0; background: none; padding: 0; color: var(--text-primary); font-size: 12.5px; text-decoration: underline; }
.hbtn { height: 38px; padding: 0 15px; border-radius: 19px; font-size: 13.5px; display: inline-flex; align-items: center; gap: 6px; color: var(--text-primary); }
.hbtn.on { background: var(--ink); color: var(--text-primary-on); }
.hbtn:disabled { opacity: .6; }
.spin { animation: spin 1s linear infinite; }
.err { margin: 0; color: var(--color-error); font-size: 13.5px; }
.loading { color: var(--text-secondary); text-align: center; margin-top: 60px; }

.bar { display: flex; align-items: center; gap: 12px; }
.chips { flex: 1; min-width: 0; display: flex; gap: 6px; overflow-x: auto; padding: 2px; -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 28px), transparent); }
.chips::after { content: ''; flex: none; width: 24px; }
.bchip { flex: none; height: 38px; padding: 0 14px; border-radius: 19px; display: inline-flex; align-items: center; gap: 7px; font-size: 14px; font-weight: 500; background: var(--thin-bg); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: var(--text-secondary); white-space: nowrap; }
.bchip small { font-size: 12px; font-weight: 400; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.bchip.on { background: var(--ink); color: var(--text-primary-on); }
.bchip.on small { color: color-mix(in srgb, var(--text-primary-on) 60%, transparent); }
.band { font-size: 11.5px; font-weight: 600; padding: 1px 8px; border-radius: 9999px; background: var(--chip-bg); color: var(--text-secondary); }
.band.paved { background: color-mix(in srgb, var(--color-success) 24%, transparent); color: var(--color-success); }
.band.open { background: color-mix(in srgb, var(--color-info) 24%, transparent); color: var(--color-info); }
.bchip.on .band { background: color-mix(in srgb, var(--text-primary-on) 14%, transparent); color: var(--text-primary-on); }
.band.routine { background: color-mix(in srgb, #a78bfa 26%, transparent); color: var(--text-primary); }
.bchip.routine { box-shadow: inset 0 0 0 1px color-mix(in srgb, #a78bfa 40%, transparent); }
.when { flex: none; display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 9999px; }
.nav { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; color: var(--text-secondary); }
.nav:disabled { opacity: .3; cursor: default; }
.nav:not(:disabled):hover { color: var(--text-primary); background: var(--button-bg); }
.pick { position: relative; padding: 0 8px; font-size: 13.5px; font-weight: 500; cursor: pointer; white-space: nowrap; }
.pick select { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
.now { height: 30px; padding: 0 12px; border-radius: 15px; background: var(--ink); color: var(--text-primary-on); font-size: 12.5px; font-weight: 500; }

.card { position: relative; flex: 1; min-height: 360px; border-radius: 22px; overflow: hidden; display: flex; flex-direction: column; }
.ctl { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 18px 4px; }
.cnt { margin-left: auto; font-size: 12px; color: var(--text-tertiary); white-space: nowrap; font-variant-numeric: tabular-nums; }
.rnote { margin: 0; font-size: 13px; color: var(--text-secondary); max-width: 520px; line-height: 1.5; }
.evt { height: 30px; padding: 0 12px 0 6px; border-radius: 9999px; display: inline-flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-secondary); background: var(--field-bg); white-space: nowrap; }
.evt .knob { position: relative; width: 30px; height: 18px; border-radius: 9px; background: color-mix(in srgb, var(--text-primary) 16%, transparent); transition: background .2s; }
.evt .knob::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--regular-solid-bg); box-shadow: 0 1px 3px rgba(0 0 0 / .25); transition: translate .25s var(--spring); }
.evt.on { color: var(--text-primary); }
.evt.on .knob { background: var(--color-info); }
.evt.on .knob::after { translate: 12px 0; }
.evt:disabled { cursor: default; opacity: .8; }
.stage { position: relative; flex: 1; min-height: 0; }
.none { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--text-secondary); font-size: 14px; }
.legend { position: absolute; left: 16px; bottom: 14px; right: 170px; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 11.5px; color: var(--text-secondary); pointer-events: none; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend svg { color: var(--text-secondary); }
.legend .and { font-weight: 600; color: var(--color-info); }
.vnote { margin: 0 0 12px; font-size: 13px; color: var(--text-secondary); }
.vb { padding: 12px 0; border-top: 1px solid var(--hairline); }
.vbn { display: inline-flex; align-items: center; gap: 4px; font-size: 14.5px; font-weight: 600; margin-bottom: 8px; }

/* phone: one scrolling column, the map a fixed tall card */
.content.narrow { padding: 0 12px 24px; overflow-y: auto; display: block; scrollbar-width: none; }
.content.narrow > * + * { margin-top: 10px; }
.narrow h1 { font-size: 23px; }
.narrow .tools { width: 100%; }
.narrow .hbtn { height: 34px; padding: 0 12px; font-size: 13px; }
.narrow .src { font-size: 12.5px; line-height: 1.5; }
.narrow .bar { flex-wrap: wrap; gap: 8px; }
.narrow .chips { flex-basis: 100%; }
.narrow .card { height: 74vh; min-height: 460px; }
.narrow .ctl { padding: 10px 12px 2px; gap: 8px 12px; }
.narrow .cnt { margin-left: 0; }
.content.narrow.sheet { padding-bottom: 52vh; }
.narrow .legend { left: 12px; right: 140px; bottom: 10px; gap: 2px 10px; font-size: 11px; }
</style>
