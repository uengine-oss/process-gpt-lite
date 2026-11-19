<script setup>
// 회사 프로세스 지도 (spec pgpt-pro_process-ontology, design-v0.2 §4.5)
//   메일 이력 · 채팅 핸드오버로 그린 회사의 일 흐름: 프로세스별 그래프, θ 로 거르기, 지난 시점 보기, 자동으로 정한 값과 근거.
//   처음에는 「지난 메일 읽기(90일)」 → 읽는 동안 진행 막대 → 「지도 그리는 중…」 → 지도.
// 숫자는 모두 서버(lib/ontology/stats.js)가 셈한 것 — 이 화면은 거르고 배치해서 보여 준다(θ 는 보기만 바꾼다).
// 개발 서버에서 ?mock=1 | empty | progress | build 로 가짜 응답(components/ontology/mock.js)을 쓸 수 있다.
// v0.3(design-v0.3 §6): 프로세스는 흐름 · 루틴(한 역할이 결과물 뒤에 혼자 이어서 하는 일), 「사건 보기」로 일 사이의 사건
// (메일 · 결과물 · 채팅)을 넣어 보고(루틴은 늘 사건으로), 「역할」로 역할마다 정의 · 역량 · 수행자 · 지표를 본다.
// 고른 프로세스는 주소의 ?proc= 에 둔다.
// 말로 고치기 · 더하기 · 의견: 지도 아래의 입력 칸(OntoEditBox)에 말하면 계획(POST /ontology/edit/plan)을 미리 보기 패널(OntoEditPreview)과
// 지도(고친 뒤의 더함 · 뺌 · 바뀜)로 보여 주고, 적용(관리자) · 의견으로 남기기. 사람이 고친 프로세스는 다듬은 흐름이 기본(「다듬은 것 · 찾은 대로」),
// 말로 만든 프로세스는 「말로 정함」. 남은 의견은 지도에 「의견 N」 · 「해소 필요」, 「의견 · 해소」 패널(OntoOpinions)에서 정한다.
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
import OntoBranch from '../components/ontology/OntoBranch.vue'
import OntoCandidatesPanel from '../components/ontology/OntoCandidatesPanel.vue'
import OntoFlowPanel from '../components/ontology/OntoFlowPanel.vue'
import OntoRefine from '../components/ontology/OntoRefine.vue'
import OntoEdgeRule from '../components/ontology/OntoEdgeRule.vue'
import MapLegend from '../components/ontology/MapLegend.vue'
import OntoEditBox from '../components/ontology/OntoEditBox.vue'
import OntoEditPreview from '../components/ontology/OntoEditPreview.vue'
import OntoOpinions from '../components/ontology/OntoOpinions.vue'
import { visibleGraph, eventGraph, flowView, edgeId, procsOf, inProc, isSimple, isSaid, withoutSimple } from '../components/ontology/mapView.js'
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
// (processes made by words come first among the flows — they have no cases yet, and they are what a person just drew)
const processes = computed(() => [...(map.value?.processes || [])].sort((a, b) => routineOf(a) - routineOf(b) || (!!b.said - !!a.said) || b.cases - a.cases || String(a.name || '').localeCompare(String(b.name || ''))))
const proc = computed(() => processes.value.find((b) => b.key === procKey.value) || null)
const isRoutine = computed(() => routineOf(proc.value))
// 루틴에는 다음 일(NEXT)이 없고 사건 → 일뿐이라 늘 사건으로 본다
const eventsShown = computed(() => eventsOn.value || isRoutine.value)
// 단순 프로세스(일 하나짜리 흐름): 목록에서는 따로 모으고, 전체 지도에서는 빼고 본다(기본 · 이 기기에 기억)
const flowProcs = computed(() => processes.value.filter((b) => !isSimple(b)))
const simpleProcs = computed(() => processes.value.filter(isSimple))
const simpleOpen = ref(false)
const readHide = () => { try { return localStorage.getItem('onto.hideSimple') !== '0' } catch { return true } }
const hideSimple = ref(readHide())
watch(hideSimple, (v) => { try { localStorage.setItem('onto.hideSimple', v ? '1' : '0') } catch { /* private window */ } })
const shownMap = computed(() => (!procKey.value && hideSimple.value ? withoutSimple(map.value) : map.value))
// 다듬은 것 · 찾은 대로: 사람이 고친 프로세스는 다듬은 흐름이 기본(말로 만든 프로세스에는 찾은 흐름이 없어 고르지 않는다)
const flowMode = ref('refined') // 'refined' | 'found'
const canFlow = computed(() => !!(procKey.value && map.value?.refined?.[procKey.value] && !isSaid(proc.value)))
const view = computed(() => (eventsShown.value ? eventGraph : visibleGraph)(shownMap.value, { proc: procKey.value, mode: mode.value, flow: flowMode.value }))
const bandName = (b) => (b?.band === 'said' ? '말로 정함' : BAND[b?.band] || b?.bandName)
// 회사 전체 건 수: 지금은 meta 의 건 수(어느 흐름에도 들지 않은 건까지), 지난 시점에는 흐름들의 합(루틴은 건이 아니다)
const flowCases = computed(() => processes.value.filter((b) => !routineOf(b)).reduce((a, b) => a + (b.cases || 0), 0))
const allCases = computed(() => (at.value ? flowCases.value || meta.value?.cases : meta.value?.cases || flowCases.value) || 0)
// 시작 비율은 회사 전체 건에 대한 몫 — 프로세스 하나를 볼 때 「시작 n%」는 그 프로세스의 건에 대한 몫으로
// (지도가 그 프로세스 안의 시작 비율 hasTask 를 주면 그대로)
const shareScale = computed(() => (view.value.procShares ? 1 : proc.value?.cases ? allCases.value / proc.value.cases : 1))
const counts = computed(() => {
  // a refined flow counts its own steps and ways (a said process has no found ways)
  const F = view.value.refined && procKey.value ? map.value?.refined?.[procKey.value] : null
  const tasks = F ? F.tasks || [] : (shownMap.value?.tasks || []).filter((t) => inProc(t, procKey.value))
  const keys = new Set(tasks.map((t) => t.key))
  const edges = F ? (F.edges || []).length : (shownMap.value?.edges || []).filter((e) => keys.has(e.from)).length
  return { tasks: tasks.length, edges, shownTasks: view.value.tasks.length, shownEdges: view.value.edges.length, events: view.value.events?.length || 0 }
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
  if (status.value.admin) loadEngine()
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
// 간선 설정(edge-step-condition): 사건 보기에서 프로세스를 골랐을 때 사건 → 일 간선을 누르면 그 간선의 설정(OntoEdgeRule)
const triggerPick = computed(() => eventsShown.value && !!procKey.value && !isRoutine.value)
const selTrigger = computed(() => {
  if (sel.value?.kind !== 'trigger' || !triggerPick.value) return null
  const [event, task] = String(sel.value.id).split('\u0000')
  const ev = (view.value.events || []).find((e) => e.ev?.key === event)?.ev
  return { event, task, name: ev?.name || event }
})
const edgeMarks = ref(new Map())
async function loadEdgeMarks() {
  if (!triggerPick.value) { edgeMarks.value = new Map(); return }
  const key = procKey.value
  try {
    const r = await call(`/ontology/processes/${encodeURIComponent(key)}/edge-conditions`)
    if (key === procKey.value) edgeMarks.value = new Map((r.edges || []).filter((e) => e.mark || e.cls).map((e) => [`${e.event}\u0000${e.step}`, { mark: e.mark, cls: e.cls }]))
  } catch { edgeMarks.value = new Map() }
}
watch(triggerPick, loadEdgeMarks)
watch(procKey, () => { if (triggerPick.value) loadEdgeMarks() })
// a side panel covers the map's right (the map keeps room, the box moves left of it)
const sideOpen = computed(() => !!(selEdge.value || selTask.value || selEvent.value || selTrigger.value || valuesOpen.value || reviewOpen.value || snapOpen.value || rolesOpen.value || docsOpen.value
  || timerOpen.value || caseId.value || candOpen.value || flowOpen.value || plan.value || opinionsOpen.value))
watch(procKey, (k) => {
  if (String(route.query.proc || '') === k) return
  const query = { ...route.query, proc: k || undefined }
  delete query.bundle
  router.replace({ query }).catch(() => {})
})
function pickProc(k) { procKey.value = k; sel.value = null; newMode.value = false }
// 일 패널의 「프로세스」에서: 그 프로세스로 옮기고 그 일은 계속 고른 채로
function openProc(k) { const id = sel.value?.kind === 'task' ? sel.value.id : null; pickProc(k); if (id) sel.value = { kind: 'task', id } }
const closeSide = () => {
  valuesOpen.value = false; reviewOpen.value = false; snapOpen.value = false; rolesOpen.value = false; docsOpen.value = false; roleKey.value = ''; caseId.value = ''
  plan.value = null; opinionsOpen.value = false; opPreview.value = null
}
// while a plan is previewed the map is the plan's drawing: a click there opens nothing
function onSelect(x) { if (plan.value) return; if (x) closeSide(); sel.value = x }

// ---------- 말로 고치기 · 더하기 ----------
// 여러 개 고르기(Shift · Cmd + 누르기, Shift + 끌기): 말로 고치기의 범위 {tasks, ways(edge id)} — 프로세스를 골랐을 때만
// (범위는 한 프로세스 안의 것), 미리 보기 동안은 쉰다(아직 없는 단계를 고르지 않게)
const chosen = ref({ tasks: [], ways: [] })
const chosenN = computed(() => chosen.value.tasks.length + chosen.value.ways.length)
const clearChosen = () => { chosen.value = { tasks: [], ways: [] } }
function onPick(x) { chosen.value = { tasks: [...(x?.tasks || [])], ways: [...(x?.ways || [])] }; if (chosenN.value) newMode.value = false }
const newMode = ref(false) // 「＋ 새 프로세스」: no process, the box draws a new one
const editWords = ref('')
const editBusy = ref('') // '' | 'plan' | 'apply' | 'voice'
const editErr = ref('')
const plan = ref(null) // POST /ontology/edit/plan
const planAsk = ref(null) // the body that plan answered (sent again with an answer)
const pside = ref('after') // 고치기 전 · 고친 뒤
const resolveCtx = ref(null) // 「말로 정리하기」 of a conflict: {opinions, note} sent with 적용
const editNote = ref(null) // {text, proc, refine} — one line above the map
const boxEl = ref(null)
const eul = (w) => { const c = String(w || '').trim().slice(-1).charCodeAt(0); return c >= 0xac00 && c <= 0xd7a3 ? ((c - 0xac00) % 28 ? '을' : '를') : '을(를)' }
const editScope = computed(() => (newMode.value || !proc.value ? 'new' : chosenN.value ? 'range' : 'process'))
const editPlaceholder = computed(() => {
  if (editScope.value === 'new') return '새 프로세스를 말로 그려 보세요 — 예: 견적 요청이 오면 영업이 견적서를 만들고, 500만 원 이상이면 대표 승인 후 고객에게 보내요'
  if (editScope.value === 'range') return `고른 단계 ${chosen.value.tasks.length}개 · 관계 ${chosen.value.ways.length}개 안에서만 고쳐요 — 예: 이 단계는 에이전트가 하게`
  return `「${proc.value.name}」${eul(proc.value.name)} 말로 고쳐 보세요 — 예: 고객 회신 뒤에 결과 보고를 넣어 줘`
})
const editContext = computed(() => (resolveCtx.value ? `엇갈린 의견 ${resolveCtx.value.opinions.length}개를 이 말로 정리해요` : ''))
// the past map is for looking only
const boxOn = computed(() => phase.value === 'map' && !at.value)
const toWays = (ids) => ids.map((id) => { const [from, to] = String(id).split('\u0000'); return { from, to } })
function startNew() { closeSide(); sel.value = null; procKey.value = ''; newMode.value = true; clearChosen(); boxEl.value?.focus() }
async function askPlan(body) {
  editBusy.value = 'plan'; editErr.value = ''
  try {
    const r = await call('/ontology/edit/plan', { method: 'POST', body })
    closeSide(); sel.value = null
    plan.value = r; planAsk.value = body; pside.value = 'after'
    return true
  } catch (e) { editErr.value = e.message; return false } finally { editBusy.value = '' }
}
async function submitEdit() {
  const words = editWords.value.trim()
  if (!words || editBusy.value) return
  const body = { words }
  if (editScope.value !== 'new') body.proc = proc.value.key
  if (editScope.value === 'range') body.scope = { tasks: [...chosen.value.tasks], ways: toWays(chosen.value.ways) }
  if (await askPlan(body)) editWords.value = ''
}
const answerPlan = (a) => planAsk.value && askPlan({ ...planAsk.value, answer: a })
async function applyPlan() {
  const p = plan.value
  if (!p || editBusy.value) return
  editBusy.value = 'apply'; editErr.value = ''
  try {
    const body = { proc: p.proc?.key || undefined, scope: p.range || undefined, words: p.words, ops: p.ops || [] }
    if (resolveCtx.value) body.resolve = { opinions: [...resolveCtx.value.opinions], note: resolveCtx.value.note || '' }
    const r = await call('/ontology/edit/apply', { method: 'POST', body })
    const key = r?.proc?.key || p.proc?.key || ''
    plan.value = null; planAsk.value = null; resolveCtx.value = null; newMode.value = false; clearChosen()
    await loadMap()
    if (key && map.value?.processes?.some((b) => b.key === key)) { procKey.value = key; sel.value = null }
    flowMode.value = 'refined'
    editNote.value = { text: '적용했어요 — 「고친 기록」에서 하나씩 되돌릴 수 있어요', proc: key, refine: true }
    loadOpinions()
  } catch (e) { editErr.value = e.message } finally { editBusy.value = '' }
}
async function voicePlan() {
  const p = plan.value
  const key = p?.proc?.key || procKey.value
  if (!p || !key || editBusy.value) return
  editBusy.value = 'voice'; editErr.value = ''
  try {
    const r = await call('/ontology/opinions', { method: 'POST', body: { proc: key, scope: p.range || undefined, words: p.words, ops: p.ops || [], source: 'map' } })
    const agree = Number(r?.agree ?? r?.opinion?.agree ?? 1) || 1
    plan.value = null; planAsk.value = null
    editNote.value = { text: `의견으로 남겼어요(같은 의견 ${agree}명). 관리자가 정하면 알려 드려요.`, proc: key }
    loadOpinions()
    loadMap().catch(() => {})
  } catch (e) { editErr.value = e.message } finally { editBusy.value = '' }
}
// 고쳐 말하기: the words back in the box (the range and a 말로 정리하기 stay)
function rephrase() { editWords.value = plan.value?.words || editWords.value; plan.value = null; planAsk.value = null; boxEl.value?.focus() }
function stopPlan() { plan.value = null; planAsk.value = null; resolveCtx.value = null; editErr.value = '' }
// 고친 뒤(또는 고치기 전) 그림: 계획 · 고른 의견을 미리 볼 때 지도는 그 Flow 를 그린다(더함 · 뺌 · 바뀜)
const opPreview = ref(null) // {id, before, after} of the opinion the 의견 패널 shows
const preview = computed(() => (plan.value?.after ? { kind: 'plan', before: plan.value.before || null, after: plan.value.after, proc: plan.value.proc?.key || '' }
  : opPreview.value?.after ? { kind: 'opinion', before: opPreview.value.before || null, after: opPreview.value.after, proc: procKey.value } : null))
watch(preview, () => { pside.value = 'after' })
const previewGraph = computed(() => {
  const p = preview.value
  const f = p && (pside.value === 'before' && p.before ? p.before : p.after)
  // a plan with only a question (no steps yet) leaves the map as it is
  return f?.tasks?.length ? flowView(f, map.value, { proc: p.proc }) : null
})
const graph = computed(() => previewGraph.value || view.value)
// a preview keeps the readable size: bring its first 더함 · 뺌 · 바뀜 into view (after the map has laid out and gone home)
const stageEl = ref(null)
let pvT = 0
watch(previewGraph, (g) => {
  clearTimeout(pvT)
  if (!g) return
  pvT = setTimeout(() => {
    const el = stageEl.value?.querySelector('svg.map g.node[class*="df-"]') || stageEl.value?.querySelector('svg.map g.lbl[class*="df-"]')
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, 450)
})
const planTitle = computed(() => (plan.value?.scope === 'new' ? plan.value.name || '새 프로세스' : plan.value?.proc?.name || proc.value?.name || ''))

// 말로 만든 프로세스 지우기(관리자): 한 번 더 묻고 DELETE /ontology/said/:proc
const delAsk = ref(false)
async function delSaid() {
  const p = proc.value
  if (!p) return
  busy.value = 'said'; err.value = ''
  try {
    await call(`/ontology/said/${encodeURIComponent(p.key)}`, { method: 'DELETE' })
    delAsk.value = false
    pickProc('')
    await loadMap()
    editNote.value = { text: `말로 만든 「${p.name}」${eul(p.name)} 지웠어요.`, proc: '' }
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}

// ---------- 의견 · 해소 ----------
const opinionsOpen = ref(false)
const opinions = ref(null) // GET /ontology/processes/:proc/opinions
const opinionsErr = ref('')
const onlyNotes = ref(false) // 해소 필요만
let opSeq = 0
async function loadOpinions() {
  const k = procKey.value
  const my = ++opSeq
  if (opinions.value?.proc?.key !== k) opinions.value = null
  opinionsErr.value = ''
  if (!k) return
  try {
    const r = await call(`/ontology/processes/${encodeURIComponent(k)}/opinions`)
    if (my === opSeq) opinions.value = r
  } catch (e) { if (my === opSeq) { opinions.value = null; opinionsErr.value = e.message } }
}
const notes = computed(() => opinions.value?.marks || null)
const notesOn = computed(() => !!notes.value && Object.keys(notes.value.tasks || {}).length + Object.keys(notes.value.ways || {}).length > 0)
const conflictsN = computed(() => Number(opinions.value?.counts?.conflicts ?? proc.value?.opinions?.conflicts ?? 0))
function toggleOpinions() { const open = !opinionsOpen.value; closeSide(); sel.value = null; opinionsOpen.value = open; if (open) loadOpinions() }
function closeOpinions() { opinionsOpen.value = false; opPreview.value = null }
function onResolved(v) {
  if (v?.conflicts) opinions.value = v; else loadOpinions()
  opPreview.value = null
  flowMode.value = 'refined'
  loadMap().catch((e) => { err.value = e.message })
}
// the steps a conflict's opinions touch (their ops' args), as the box's range — only what the map shows
function opsScope(ops) {
  const keys = new Set(view.value.tasks.map((t) => t.key)), ids = new Set(view.value.edges.map(edgeId))
  const tasks = new Set(), raw = new Set(), ways = new Set()
  for (const { args: a = {} } of ops) {
    for (const k of [a.task, a.after, a.before, a.into, a.from, a.to]) if (k) { raw.add(k); if (keys.has(k)) tasks.add(k) }
    if (a.from && a.to && ids.has(`${a.from}\u0000${a.to}`)) ways.add(`${a.from}\u0000${a.to}`)
  }
  return { tasks: [...(tasks.size ? tasks : raw)], ways: [...ways] }
}
// 말로 정리하기: the box opens on the conflict's steps; 적용 then closes those opinions as merged
function speakConflict({ conflict, opinions: ids, note }) {
  const s = opsScope((conflict?.opinions || []).flatMap((o) => o.ops || []))
  closeOpinions(); newMode.value = false
  chosen.value = s
  resolveCtx.value = { opinions: ids || [], note: note || '' }
  boxEl.value?.focus()
}
watch(procKey, (k) => {
  flowMode.value = 'refined'; onlyNotes.value = false; delAsk.value = false
  clearChosen(); resolveCtx.value = null; plan.value = null; planAsk.value = null; opPreview.value = null
  if (editNote.value && editNote.value.proc !== k) editNote.value = null
  loadOpinions()
})
function toggleValues() { const open = !valuesOpen.value; closeSide(); sel.value = null; valuesOpen.value = open }
function toggleReview() { const open = !reviewOpen.value; closeSide(); sel.value = null; reviewOpen.value = open }
function toggleSnap() { const open = !snapOpen.value; closeSide(); sel.value = null; snapOpen.value = open }
function toggleRoles() { const open = !rolesOpen.value; closeSide(); sel.value = null; rolesOpen.value = open }
function toggleDocs() { const open = !docsOpen.value; closeSide(); sel.value = null; docsOpen.value = open }
// 일 패널의 역할 이름 · 역할 목록에서: 그 역할로
function openRole(key) { closeSide(); sel.value = null; rolesOpen.value = true; roleKey.value = key || '' }
const roleName = computed(() => (map.value?.roles || []).find((r) => r.key === roleKey.value)?.name || roleKey.value)
// 프로세스 채택(관리자): 채택한 프로세스만 들어오는 메일을 받아 스냅샷으로 돈다. 단계가 시작과 진행을 함께 정해요(server
// lib/ontology/runmode.js modeOfStage) — 제안: 단계마다 사람이 정함 · 자동: 사람이 지켜봄. 건은 시작할 때의 단계대로 끝까지 가요.
const LADDER = [
  { key: 'paused', ko: '관찰', to: '「관찰」로', tip: '지도에서 보기만 해요. 요청이 와도 시작하지 않고 묻지도 않아요.' },
  { key: 'suggested', ko: '제안', to: '「제안」으로', tip: '이 일로 보이는 요청이 오면 진행할지 묻고, 시작한 뒤에도 단계마다 사람이 정해요.' },
  { key: 'adopted', ko: '자동', to: '「자동」으로', tip: '요청이 오면 저절로 시작하고, 사람은 지켜봐요. 사람 단계는 에이전트가 초안을 먼저 만들어 둬요. 책임 · 되돌릴 수 없는 단계에서는 기다려요.' },
]
const LADDER_NOTE = { paused: '새 요청은 시작하지 않고 묻지도 않아요.', suggested: '새 건부터 진행할지 묻고, 시작한 뒤에도 단계마다 사람이 정해요.', adopted: '새 건부터 저절로 시작하고, 사람은 지켜봐요.' }
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
// 단계 · 엔진을 바꾼 뒤 지도 위에 한 줄로 알려 줘요(다른 프로세스로 옮기면 지워요)
const runModeMsg = ref('')
watch(procKey, () => { runModeMsg.value = '' })
// 실행 방식의 엔진(server lib/ontology/mapengine.js, 회사마다 · 관리자): 프로세스 정의로(기존 — 건마다 지도를 펼쳐 프로세스 정의를 만들고
// 엔진이 돌린다) · 지도에서 바로(정의 없이 단계가 끝날 때마다 그때의 지도를 읽어 다음 단계를 정한다). 건은 시작할 때의 엔진으로 끝까지 가요.
const ENGINES = [
  { key: 'bpm', ko: '프로세스 정의로(기존)', tip: '건이 들어오면 지도를 펼쳐 프로세스 정의(스냅샷)를 만들고, 그 정의로 엔진이 끝까지 돌려요. 옮기거나 되감으면 새 인스턴스로 이어요.' },
  { key: 'map', ko: '지도에서 바로', tip: '프로세스 정의 없이, 단계가 끝날 때마다 지도를 읽어 다음 단계를 정해요. 건 하나는 처음부터 끝까지 인스턴스 하나예요. 꼭 하는 단계가 있으면 시작한 날의 지도로 고정해요.' },
]
const engine = ref(null)
async function loadEngine() { try { engine.value = await call('/ontology/engine') } catch { engine.value = null } }
async function setEngine(k) {
  busy.value = 'engine'; runModeMsg.value = ''
  try {
    engine.value = await call('/ontology/engine', { method: 'PUT', body: { engine: k } })
    runModeMsg.value = `실행 방식의 엔진: 「${ENGINES.find((x) => x.key === k)?.ko || k}」. 새로 들어오는 건부터 이 엔진으로 가요 — 진행 중인 건은 시작할 때의 엔진 그대로예요.${engine.value?.env ? ` (지금은 서버 설정 PRO_ONTO_ENGINE=${engine.value.env}이 우선해요.)` : ''}`
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function adopt(status) {
  if (!proc.value) return
  busy.value = 'adopt'; runModeMsg.value = ''
  try {
    const r = await call('/ontology/processes/status', { method: 'POST', body: { key: proc.value.key, status, name: proc.value.name } })
    await loadMap()
    const st = LADDER.find((x) => x.key === status)
    runModeMsg.value = `${st?.to || status} 바꿨어요. ${LADDER_NOTE[status] || ''}${r?.running ? ` 진행 중인 건 ${r.running}개는 시작할 때 방식 그대로 가요.` : ''}`
  } catch (e) { err.value = e.message } finally { busy.value = '' }
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

// 전체 화면: the whole map edge to edge (the browser's full screen where it lets us), fitted to the screen. The title, the
// buttons and the process chips become a drawer that slides down when the pointer comes to the top (or the 「메뉴」 tab is
// pressed). Esc (or the button, or F) leaves.
const full = ref(false)
// AI 후보: the panel hands the map what to paint (일 → high · mid · human)
const candOpen = ref(false)
const marks = ref(new Map())
watch(candOpen, (on) => { if (on) flowOpen.value = false; else if (!flowOpen.value) marks.value = new Map() })
// 병목 보기(OntoFlowPanel): 지금 쌓인 할 일로 일을 칠하고(병목 · 많고 적음 · 에이전트 구간 · 바깥 대기), 꼬리표를 달고, 흔한 길을 굵게
const flowOpen = ref(false)
const flowHeat = ref({ badges: new Map(), ways: new Set() })
const NO_BADGES = new Map(), NO_WAYS = new Set()
function onFlowHeat(h) { if (!flowOpen.value) return; marks.value = h.marks; flowHeat.value = { badges: h.badges, ways: h.ways } }
watch(flowOpen, (on) => {
  if (on) { candOpen.value = false; return }
  flowHeat.value = { badges: new Map(), ways: new Set() }
  if (!candOpen.value) marks.value = new Map()
})
function toggleFlow() { sel.value = null; flowOpen.value = !flowOpen.value }
// 프로세스 다듬기(바로잡기): 지도 위를 덮는 창 — 열려 있는 동안 이 페이지의 F · Esc 는 쉰다
const refineOpen = ref(false)
const menuOpen = ref(false)
const menuEl = ref(null)
let menuT = 0
async function enterFull() {
  full.value = true; menuOpen.value = false
  try { if (document.fullscreenEnabled && !document.fullscreenElement) await document.documentElement.requestFullscreen() } catch { /* the page fills the window instead */ }
}
function exitFull() {
  if (!full.value) return
  full.value = false; menuOpen.value = false
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
}
const toggleFull = () => (full.value ? exitFull() : enterFull())
// the browser left full screen (Esc): leave ours too
function onFsChange() { if (!document.fullscreenElement) exitFull() }
function onKey(e) {
  const t = e.target
  if (refineOpen.value || e.metaKey || e.ctrlKey || e.altKey || t?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName || '')) return
  if (e.key === 'Escape' && full.value) exitFull()
  else if ((e.key === 'f' || e.key === 'F') && phase.value === 'map' && !labelsOpen.value) { e.preventDefault(); toggleFull() }
}
let hoverAt = 0
function menuIn() { if (!full.value) return; clearTimeout(menuT); if (!menuOpen.value) hoverAt = Date.now(); menuOpen.value = true }
// the tab: a press right after the pointer opened the drawer (a mouse, or a phone's tap that hovers first) keeps it open
function tabPress() { if (menuOpen.value && Date.now() - hoverAt < 600) return; menuOpen.value = !menuOpen.value }
// leaving the drawer closes it — not while one of its pickers (the week select) is open
function menuOut() {
  if (!full.value) return
  clearTimeout(menuT)
  menuT = setTimeout(() => { if (document.activeElement?.tagName !== 'SELECT' || !menuEl.value?.contains(document.activeElement)) menuOpen.value = false }, 380)
}

onMounted(async () => {
  document.addEventListener('keydown', onKey)
  document.addEventListener('fullscreenchange', onFsChange)
  app.mode = 'process-map'
  if (!app.me) app.me = await api('/me').catch(() => null)
  init()
})
onBeforeUnmount(() => {
  alive = false; clearTimeout(timer); clearTimeout(menuT); clearTimeout(pvT)
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('fullscreenchange', onFsChange)
  if (full.value && document.fullscreenElement) document.exitFullscreen().catch(() => {})
})
</script>

<template>
  <div class="pmap ontomap" :class="{ full }">
    <TopBar v-show="!full" />
    <div class="content" :class="{ narrow, sheet: narrow && (sel || valuesOpen || plan || opinionsOpen) }">
      <div v-if="full" class="hot" aria-hidden="true" @mouseenter="menuIn" />
      <div ref="menuEl" class="menu" :class="{ drawer: full, open: full && menuOpen, glass: full }" data-testid="onto-menu" @mouseenter="menuIn" @mouseleave="menuOut">
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
          <button class="hbtn glass press" :class="{ on: candOpen }" data-testid="onto-candidates-button" @click="sel = null; candOpen = !candOpen">AI 후보</button>
          <button class="hbtn glass press" :class="{ on: flowOpen }" title="지금 쌓인 할 일로 병목 · 회사의 제약 · 흔한 길을 봐요" data-testid="onto-flow-button" @click="toggleFlow">병목 보기</button>
          <button v-if="proc && !isRoutine" class="hbtn glass press" :class="{ on: snapOpen }" @click="toggleSnap">스냅샷 보기</button>
          <button v-if="proc && !isRoutine && (!isSimple(proc) || isSaid(proc))" class="hbtn glass press" :class="{ on: refineOpen }" title="찾은 순서를 바로잡고 단계를 나눠요" data-testid="onto-refine-button" @click="refineOpen = true">다듬기</button>
          <button v-if="proc" class="hbtn glass press" :class="{ on: opinionsOpen }" title="이 프로세스에 남은 의견을 보고 정해요" data-testid="onto-opinions-button" @click="toggleOpinions">
            의견 · 해소<b v-if="conflictsN" class="hcf" data-testid="onto-opinions-conflicts">{{ conflictsN }}</b>
          </button>
          <!-- 말로 만든 프로세스(관리자): 한 번 더 묻고 지운다 -->
          <template v-if="proc && isSaid(proc) && status?.admin">
            <button v-if="!delAsk" class="hbtn glass press danger" data-testid="onto-said-delete" @click="delAsk = true">이 프로세스 지우기</button>
            <span v-else class="ask glass" data-testid="onto-said-confirm">
              「{{ proc.name }}」{{ eul(proc.name) }} 지울까요?
              <button class="press yes" :disabled="!!busy" data-testid="onto-said-delete-yes" @click="delSaid">{{ busy === 'said' ? '지우는 중…' : '지우기' }}</button>
              <button class="press" :disabled="!!busy" data-testid="onto-said-delete-no" @click="delAsk = false">그만두기</button>
            </span>
          </template>
          <!-- 승격 단계(design-v0.3 §12): 관찰 → 제안(요청이 오면 묻고, 단계마다 사람이 정한다) → 자동(저절로 시작, 사람은 지켜본다 ·
               사람 단계는 초안이 먼저). 실행 방식은 따로 고르지 않아요 — 이 단계가 정해요(새 건부터). -->
          <div v-if="proc && !isRoutine" class="ladder glass" role="group" aria-label="이 프로세스의 단계" data-testid="onto-ladder" :data-status="proc.status">
            <button v-for="st in LADDER" :key="st.key" class="press" :class="{ on: proc.status === st.key }" :disabled="!status?.admin || !!busy || proc.status === st.key"
              :title="st.tip" :data-testid="`onto-ladder-${st.key}`" @click="adopt(st.key)">{{ st.ko }}</button>
          </div>
          <!-- 실행 방식의 엔진(관리자, 회사 전체): 프로세스 정의로(기존) · 지도에서 바로 -->
          <div v-if="status?.admin && engine" class="ladder glass engine" role="group" aria-label="실행 방식의 엔진" data-testid="onto-engine" :data-engine="engine.engine" :data-from="engine.from">
            <span class="elbl" title="실행 방식의 엔진 — 회사 전체에 적용돼요">엔진</span>
            <button v-for="m in ENGINES" :key="m.key" class="press" :class="{ on: engine.engine === m.key }" :disabled="!!busy || engine.engine === m.key || !!engine.env"
              :title="`${m.tip}${engine.env ? ` (서버 설정 PRO_ONTO_ENGINE=${engine.env}이 우선해요)` : engine.from === 'product' ? ' (지금은 제품 기본값을 따라요)' : ''}`" :data-testid="`onto-engine-${m.key}`" @click="setEngine(m.key)">{{ m.ko }}</button>
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

      <div v-if="phase === 'map'" class="bar">
        <div class="chips scroll">
          <button class="bchip newp press" :class="{ on: newMode }" title="말로 새 프로세스를 그려요" data-testid="onto-new-proc" @click="startNew">＋ 새 프로세스</button>
          <button class="bchip press" :class="{ on: !procKey && !newMode }" @click="pickProc('')">전체 <small>건 {{ n(allCases) }}</small></button>
          <button v-if="proc && isSimple(proc)" class="bchip press on" data-testid="onto-simple-picked" @click="simpleOpen = !simpleOpen">
            {{ proc.name }} <span class="band simple">단순</span> <small>건 {{ n(proc.cases) }}</small>
          </button>
          <button v-for="b in flowProcs" :key="b.key" class="bchip press" :class="{ on: procKey === b.key, routine: b.kind === 'routine' }" :title="b.summary" data-testid="onto-proc-chip" :data-kind="b.kind || 'flow'" @click="pickProc(b.key)">
            {{ b.name }}
            <template v-if="b.kind === 'routine'"><span class="band routine">루틴</span> <small>{{ b.role }}</small></template>
            <template v-else><span class="band" :class="b.band" :data-band="b.band">{{ bandName(b) }}</span> <small>건 {{ n(b.cases) }}</small></template>
            <!-- 의견: 엇갈린 것(해소 필요)은 눈에 띄게, 남은 의견 수는 조용히 -->
            <small v-if="b.opinions?.open" class="ocnt" :title="`남은 의견 ${b.opinions.open}`" data-testid="onto-proc-opinions">의견 {{ b.opinions.open }}</small>
            <b v-if="b.opinions?.conflicts" class="ocf" :title="`해소 필요 ${b.opinions.conflicts}`" data-testid="onto-proc-conflicts">{{ b.opinions.conflicts }}</b>
          </button>
        </div>
        <button v-if="simpleProcs.length" class="bchip simplebtn press" :class="{ open: simpleOpen }" :aria-expanded="simpleOpen" data-testid="onto-simple-button" @click="simpleOpen = !simpleOpen">
          단순 프로세스 <small>{{ simpleProcs.length }}</small> <Icon name="chevron" :size="12" class="schev" />
        </button>
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
      <div v-if="phase === 'map' && simpleOpen" class="simple glass" data-testid="onto-simple-list">
        <p class="snote">일이 하나뿐인 프로세스예요. 같은 일이 되풀이될 뿐 앞뒤 흐름이 없어서 목록과 전체 지도에서 따로 모았어요.</p>
        <div class="sgrid">
          <button v-for="b in simpleProcs" :key="b.key" class="sitem press" :class="{ on: procKey === b.key }" data-testid="onto-simple-item" @click="pickProc(b.key); simpleOpen = false">
            <b>{{ b.name }}</b><small><span class="band" :class="b.band">{{ BAND[b.band] || b.bandName }}</span> 건 {{ n(b.cases) }}</small>
          </button>
        </div>
      </div>
      <!-- 전체 화면: the drawer's tab, peeking under the top edge -->
      <button v-if="full" class="tab press" :aria-expanded="menuOpen" data-testid="onto-menu-tab" @click="tabPress" @mouseenter="menuIn">
        메뉴 <Icon name="chevron" :size="12" class="tchev" :class="{ up: menuOpen }" />
      </button>
      </div>

      <p v-if="err" class="err">{{ err }}</p>
      <p v-if="runModeMsg && phase === 'map'" class="rmnote" data-testid="onto-runmode-note">{{ runModeMsg }}</p>
      <p v-if="editNote && phase === 'map'" class="rmnote enote" data-testid="onto-edit-note">
        <span>{{ editNote.text }}</span>
        <button v-if="editNote.refine && proc" class="nlk press" data-testid="onto-edit-note-refine" @click="refineOpen = true">고친 기록 보기</button>
        <button class="nx press" aria-label="닫기" @click="editNote = null"><Icon name="close" :size="12" /></button>
      </p>

      <p v-if="phase === 'loading'" class="loading pulse">불러오는 중…</p>
      <FirstRun v-else-if="phase !== 'map'" :phase="phase" :job="phase === 'build' ? job || status?.build : job" :busy="busy === 'mail' || busy === 'retry'" :note="note" @start="startMail" @retry="retry" />

      <template v-else>
        <div class="card glass" @pointerdown="full && (menuOpen = false)">
          <div class="ctl">
            <ThetaControl v-if="!isRoutine" v-model:mode="mode" :proc="proc" />
            <p v-else class="rnote">「{{ proc.role }}」 역할에서 결과물이 나오면 혼자 이어서 하는 일이에요. 같은 역할 여러 사람의 습관을 셈했어요.</p>
            <!-- 사람이 고친 프로세스: 다듬은 것(기본) · 찾은 대로 -->
            <div v-if="canFlow && !previewGraph" class="seg2" role="group" aria-label="다듬은 것 · 찾은 대로" data-testid="onto-flow-switch" :data-flow="flowMode">
              <button class="press" :class="{ on: flowMode === 'refined' }" title="사람이 고친 대로" data-testid="onto-flow-refined" @click="flowMode = 'refined'">다듬은 것</button>
              <button class="press" :class="{ on: flowMode === 'found' }" title="메일 · 대화에서 읽은 그대로" data-testid="onto-flow-found" @click="flowMode = 'found'">찾은 대로</button>
            </div>
            <span v-if="previewGraph" class="pvtag" data-testid="onto-preview-tag" :data-kind="preview.kind">미리 보기 · {{ pside === 'before' && preview.before ? '고치기 전' : '고친 뒤' }} — 아직 지도는 그대로예요</span>
            <button class="evt press" role="switch" :aria-checked="eventsShown" :class="{ on: eventsShown }" :disabled="isRoutine" :title="isRoutine ? '루틴은 사건으로만 보여요' : '일 사이에 메일 · 결과물 같은 사건을 넣어 봐요'" data-testid="onto-events-toggle" @click="eventsOn = !eventsOn">
              <span class="knob" /> 사건 보기
            </button>
            <button v-if="!procKey && simpleProcs.length" class="evt press" role="switch" :aria-checked="hideSimple" :class="{ on: hideSimple }" :title="`일이 하나뿐인 프로세스 ${simpleProcs.length}개를 전체 지도에서 빼요(다른 흐름에도 든 일은 남아요)`" data-testid="onto-hide-simple" @click="hideSimple = !hideSimple">
              <span class="knob" /> 단순 프로세스 빼기
            </button>
            <button v-if="proc && conflictsN && notes" class="evt press" role="switch" :aria-checked="onlyNotes" :class="{ on: onlyNotes }" title="의견이 엇갈린 단계 · 관계만 또렷하게 봐요" data-testid="onto-only-notes" @click="onlyNotes = !onlyNotes">
              <span class="knob" /> 해소 필요만
            </button>
            <small class="cnt">{{ countText }}<template v-if="!procKey && hideSimple && shownMap?.hidden"> · 단순 {{ shownMap.hidden }}개 뺌</template></small>
            <button class="fs press" :class="{ on: full }" :title="full ? '전체 화면 나가기 (Esc)' : '지도를 화면 가득 (F)'" data-testid="onto-fullscreen" @click="toggleFull">
              <Icon :name="full ? 'shrink' : 'expand'" :size="14" /> {{ full ? '나가기' : '전체 화면' }}
            </button>
          </div>
          <div ref="stageEl" class="stage" :data-preview="preview?.kind || ''" :data-side="pside" :data-flow="flowMode">
          <p v-if="!graph.tasks.length" class="none">{{ at ? '그날에는 아직 그린 지도가 없어요.' : '이 θ 로는 남는 일이 없어요.' }}</p>
          <MapGraph v-else :whole="full" :marks="marks" :edge-marks="previewGraph ? new Map() : edgeMarks" :trigger-pick="triggerPick && !previewGraph" :tasks="graph.tasks" :edges="graph.edges" :entries="graph.entries" :events="previewGraph ? [] : view.events || []" :selected="sel" :dir="narrow ? 'TB' : 'LR'" :side="sideOpen" :scale="shareScale"
            :picked="chosen" :pickable="!!procKey && !previewGraph" :notes="notes" :only-notes="onlyNotes && !!notes"
            :badges="flowOpen && !previewGraph ? flowHeat.badges : NO_BADGES" :hot-ways="flowOpen && !previewGraph ? flowHeat.ways : NO_WAYS" @select="onSelect" @pick="onPick" />
          <!-- 아래쪽: 말로 고치기 입력 칸(넓은 화면) 바로 밑에 범례 -->
          <div class="dock" :class="{ side: sideOpen && !narrow }">
          <OntoEditBox v-if="boxOn && !narrow" ref="boxEl" v-model="editWords" :placeholder="editPlaceholder" :scope="editScope" :pending="editBusy === 'plan'" :picked="chosenN" :context="editContext" :error="plan ? '' : editErr"
            @submit="submitEdit" @clear-pick="clearChosen" @clear-context="resolveCtx = null" />
          <div v-if="graph.tasks.length && eventsShown && !previewGraph" class="legend">
            <span><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-info)" stroke-width="1.6" /></svg>메일</span>
            <span><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="var(--color-success)" stroke-width="1.6" /></svg>결과물</span>
            <span><svg width="14" height="14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="#a78bfa" stroke-width="1.6" /></svg>채팅</span>
            <span><b class="and">함께</b>한 사건 뒤 여러 일이 함께 열려요</span>
            <span><svg width="26" height="10"><path d="M1 5h24" stroke="currentColor" stroke-width="3.5" /></svg>굵을수록 자주</span>
            <template v-if="triggerPick">
              <span><svg width="26" height="10"><path d="M1 5h24" stroke="#7a4fd0" stroke-width="3.2" /></svg>꼭 하는 단계</span>
              <span><svg width="26" height="10"><path d="M1 5h24" stroke="#2b7fbf" stroke-width="2" stroke-dasharray="6 4" /></svg>해도 되고 안 해도 되는 단계</span>
              <span><svg width="26" height="10"><path d="M1 5h24" stroke="#2b7fbf" stroke-width="2" stroke-dasharray="1.5 3" /></svg>사안에 따라</span>
              <span>사건 → 일 간선을 눌러 정해요</span>
            </template>
          </div>
          <div v-else-if="graph.tasks.length && flowOpen" class="legend" data-testid="onto-flow-legend">
            <span><i class="lg bott" />병목(할 일이 가장 많이 쌓인 사람 단계)</span>
            <span><i class="lg heat" />할 일이 쌓인 일 — 짙을수록 많아요</span>
            <span><i class="lg agent" />에이전트 구간</span>
            <span><i class="lg out" />바깥 대기(고객)</span>
            <span><svg width="26" height="10"><path d="M1 5h24" stroke="#d6336c" stroke-width="3.5" /></svg>흔한 길(크리티컬 패스)</span>
          </div>
          <div v-else-if="graph.tasks.length && marks.size" class="legend" data-testid="onto-cand-legend">
            <span><i class="lg high" />AI가 맡을 수 있는 일</span>
            <span><i class="lg mid" />AI가 초안 · 사람이 확인</span>
            <span><i class="lg human" />사람이 꼭 해야 하는 일</span>
            <span><i class="lg dim" />그 밖 · 아직 안 본 일</span>
          </div>
          <MapLegend v-else-if="graph.tasks.length" :refined="!!(view.decided || previewGraph)" :preview="!!previewGraph" :notes="notesOn" />
          </div>

          <SidePanel v-if="plan" kicker="말로 고치기" :title="planTitle" @close="stopPlan">
            <OntoEditPreview v-model:side="pside" :plan="plan" :admin="!!status?.admin" :busy="editBusy" :resolving="resolveCtx?.opinions?.length || 0" :error="editErr"
              @answer="answerPlan" @apply="applyPlan" @voice="voicePlan" @rephrase="rephrase" @stop="stopPlan" />
          </SidePanel>
          <SidePanel v-else-if="opinionsOpen && proc" kicker="의견 · 해소" :title="proc.name" @close="closeOpinions">
            <OntoOpinions :view="opinions" :proc="proc" :admin="!!status?.admin && opinions?.admin !== false" :call="call" :current="opPreview?.id || ''" :error="opinionsErr"
              @preview="(p) => (opPreview = p)" @changed="onResolved" @speak="speakConflict" />
          </SidePanel>
          <SidePanel v-else-if="selEdge" kicker="관계" :title="`${taskName(selEdge.from)} → ${taskName(selEdge.to)}`" @close="sel = null">
            <EdgePanel :edge="selEdge">
              <template #actions><OntoBranch :edge="selEdge" :admin="!!status?.admin" /><OntoEdgeActions :edge="selEdge" :admin="!!status?.admin" @changed="loadMap" /></template>
            </EdgePanel>
          </SidePanel>
          <SidePanel v-else-if="selTrigger" kicker="간선" :title="`${selTrigger.name} → ${selTrigger.task}`" @close="sel = null">
            <OntoEdgeRule :proc-key="procKey" :event="selTrigger.event" :task="selTrigger.task" :admin="!!status?.admin" @changed="loadEdgeMarks" />
          </SidePanel>
          <SidePanel v-else-if="selEvent" kicker="사건" :title="selEvent.name" @close="sel = null">
            <EventPanel :event="selEvent" :triggers="map.triggers || []" :raises="map.raises || []" :tasks="map.tasks" :processes="map.processes || []" :admin="!!status?.admin" @task="showTask" @changed="loadMap" />
          </SidePanel>
          <SidePanel v-else-if="selTask" kicker="일" :title="selTask.name" @close="sel = null">
            <TaskPanel :task="selTask" :edges="map.edges" :processes="processes" @edge="(e) => onSelect({ kind: 'edge', id: edgeId(e) })" @role="openRole" @proc="openProc">
              <template #actions><OntoTaskPanel :task-key="selTask.key" :admin="!!status?.admin" hide-header @changed="loadMap"></OntoTaskPanel></template>
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
          <SidePanel v-else-if="flowOpen" kicker="병목 보기" :title="proc ? proc.name : '회사 전체'" @close="flowOpen = false">
            <OntoFlowPanel :proc-key="procKey" :at="at" :admin="!!status?.admin" @heat="onFlowHeat" @task="showTask" @role="openRole" @candidates="flowOpen = false; candOpen = true" />
          </SidePanel>
          <SidePanel v-else-if="candOpen" kicker="AI 후보" title="AI에 맡길 일 · 사람이 꼭 할 일" @close="candOpen = false">
            <OntoCandidatesPanel :admin="!!status?.admin" @marks="(m) => (marks = m)" @task="showTask" />
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
          <!-- 폰: 입력 칸은 지도 아래 -->
          <div v-if="boxOn && narrow" class="under">
            <OntoEditBox ref="boxEl" v-model="editWords" :placeholder="editPlaceholder" :scope="editScope" :pending="editBusy === 'plan'" :picked="chosenN" :context="editContext" :error="plan ? '' : editErr"
              @submit="submitEdit" @clear-pick="clearChosen" @clear-context="resolveCtx = null" />
          </div>
        </div>
      </template>
    </div>

    <LabelsDrawer v-if="labelsOpen" :labels="labels" :loading="labelsLoading" :error="labelsErr" @close="labelsOpen = false" @task="showTask" />
    <OntoRefine v-if="refineOpen && proc" :proc="proc" :admin="!!status?.admin" :call="call" @close="refineOpen = false; loadMap().catch(() => {}); loadOpinions()" />
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
.engine { align-items: center; }
.engine .elbl { padding: 0 6px 0 10px; font-size: 12px; color: var(--text-tertiary); }
.engine button { padding: 0 11px; font-size: 12.5px; }
.rmnote { margin: 0 0 8px; font-size: 13px; color: var(--text-secondary); line-height: 1.5; overflow-wrap: anywhere; word-break: keep-all; }
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
.lg { width: 18px; height: 12px; border-radius: 4px; box-sizing: border-box; }
.lg.high { background: color-mix(in srgb, #2f9e6e 34%, transparent); border: 2px solid #2f9e6e; }
.lg.mid { background: color-mix(in srgb, #2f9e6e 14%, transparent); border: 1.5px dashed #2f9e6e; }
.lg.human { background: color-mix(in srgb, #d9822b 26%, transparent); border: 2px solid #d9822b; }
.lg.dim { border: 1px solid var(--hairline); opacity: .5; }
.lg.bott { background: color-mix(in srgb, #d6336c 30%, transparent); border: 2.5px solid #d6336c; }
.lg.heat { background: linear-gradient(90deg, color-mix(in srgb, #e8590c 9%, transparent), color-mix(in srgb, #e8590c 34%, transparent)); border: 2px solid #e8590c; }
.lg.agent { background: color-mix(in srgb, #2f9e6e 14%, transparent); border: 1.5px dashed #2f9e6e; }
.lg.out { border: 1.5px dotted var(--text-tertiary); }
.legend .and { font-weight: 600; color: var(--color-info); }
/* 아래쪽: 말로 고치기 입력 칸 + 범례(범례는 칸 바로 밑, 칸 높이와 상관없이) */
.dock { position: absolute; z-index: 3; left: 16px; right: 170px; bottom: 14px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; pointer-events: none; }
.dock.side { right: 370px; }
.dock .legend { position: static; }
.dock .ebox { pointer-events: auto; }
.under { padding: 8px 10px 10px; }
.under .ebox { max-width: none; }
/* 다듬은 것 · 찾은 대로 */
.seg2 { display: inline-flex; height: 30px; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg2 button { padding: 0 12px; border-radius: 9999px; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; }
.seg2 button.on { background: var(--ink); color: var(--text-primary-on); }
.pvtag { height: 26px; padding: 0 11px; border-radius: 13px; display: inline-flex; align-items: center; font-size: 12.5px; font-weight: 500; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  color: var(--text-primary); background: color-mix(in srgb, #2f9e6e 16%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, #2f9e6e 45%, transparent); }
/* 프로세스 칩: 말로 정함 · 의견 · 해소 필요 · 새 프로세스 */
.band.said { background: color-mix(in srgb, #17979a 22%, transparent); color: #17979a; }
.bchip .ocnt { font-size: 11.5px; color: var(--text-tertiary); }
.ocf, .hcf { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; background: #e8590c; color: #fff; }
.hcf { margin-left: 2px; }
.bchip.newp { color: var(--text-primary); box-shadow: inset 0 0 0 1px var(--hairline); }
.bchip.newp.on { box-shadow: none; color: var(--text-primary-on); }
.hbtn.danger { color: var(--color-error); }
.ask { height: 38px; padding: 0 6px 0 14px; border-radius: 19px; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; white-space: nowrap; }
.ask button { height: 28px; padding: 0 11px; border-radius: 14px; font-size: 12.5px; color: var(--text-secondary); background: var(--button-bg); }
.ask button.yes { background: var(--color-error); color: #fff; font-weight: 600; }
.ask button:disabled { opacity: .5; }
.enote { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; }
.nlk { font-size: 13px; font-weight: 600; color: var(--color-info); }
.nx { width: 22px; height: 22px; border-radius: 11px; display: grid; place-items: center; color: var(--text-tertiary); }
.nx:hover { color: var(--text-primary); background: var(--button-bg); }
.simplebtn { flex: none; }
.simplebtn .schev { rotate: 90deg; transition: rotate .2s; }
.simplebtn.open .schev { rotate: -90deg; }
.band.simple { background: color-mix(in srgb, var(--text-primary-on) 14%, transparent); color: var(--text-primary-on); }
.simple { border-radius: 18px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.snote { margin: 0; font-size: 12.5px; color: var(--text-secondary); }
.sgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 6px; max-height: 40vh; overflow: auto; }
.sitem { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 8px 11px; border-radius: 12px; background: var(--field-bg); text-align: left; }
.sitem b { font-size: 13.5px; font-weight: 500; }
.sitem small { font-size: 12px; color: var(--text-tertiary); display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.sitem.on { background: var(--ink); color: var(--text-primary-on); }
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
.narrow .dock { left: 12px; right: 140px; bottom: 10px; }
.narrow .ask { white-space: normal; height: auto; min-height: 34px; padding: 4px 6px 4px 12px; flex-wrap: wrap; }

.menu { display: flex; flex-direction: column; gap: 10px; }
.fs { flex: none; height: 30px; padding: 0 12px; border-radius: 9999px; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); background: var(--field-bg); white-space: nowrap; }
.fs:hover, .fs.on { color: var(--text-primary); }

/* 전체 화면: the map card fills the window; the title, buttons and chips are a drawer above it */
.pmap.full .content { position: fixed; inset: 0; z-index: 30; max-width: none; padding: 0; gap: 0; display: flex; overflow: hidden; }
.pmap.full .content > * + * { margin-top: 0; }
.pmap.full .card { flex: 1; height: auto; min-height: 0; border-radius: 0; }
.pmap.full .ctl { padding-top: 32px; }
.hot { position: absolute; z-index: 7; top: 0; left: 0; right: 0; height: 14px; }
.menu.drawer { position: absolute; z-index: 8; top: 0; left: 0; right: 0; padding: 16px 24px 14px; border-radius: 0 0 22px 22px; translate: 0 -100%; transition: translate .32s var(--spring), box-shadow .32s; }
.menu.drawer.open { translate: 0 0; box-shadow: 0 12px 40px rgba(0 0 0 / .22); }
.tab { position: absolute; left: 50%; top: 100%; translate: -50% 0; height: 26px; padding: 0 14px; border-radius: 0 0 13px 13px; display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 500; color: var(--text-secondary); background: inherit; -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); }
.tab:hover { color: var(--text-primary); }
.tab .tchev { rotate: 90deg; transition: rotate .2s; }
.tab .tchev.up { rotate: -90deg; }
.pmap.full .narrow .menu.drawer { padding: 12px 12px 10px; }
</style>
