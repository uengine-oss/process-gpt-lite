<script setup>
// 프로세스 다듬기(pgpt-pro/docs/auto-ax-onboarding/plan-process-refinement.md): 찾은 지도를 조직이 합의한 프로세스로.
// 여섯 걸음 가운데 지금은 ① 바로잡기 · ② 단계 가르기(③~⑥은 「준비 중」). 걸음마다 「AI 제안 → 살펴보기 → 정하기」 세 칸.
//   ① 바로잡기: 「찾은 대로」와 「다듬은 것」을 나란히(다듬은 쪽의 더한 일 · 화살표는 파랑 점선, 찾은 쪽의 뺀 것은 빨강 점선),
//      AI가 찾은 문제(순서 · 섞인 일 · 기록 탓 · 빠진 단계)마다 「제안대로 고침」 · 「그대로 둠」, 「내가 고침」, 고친 기록과 「되돌리기」.
//   ② 단계 가르기: 다듬은 지도를 다섯 가지 색으로(꼭 하는 관문 · 사람이 꼭 · AI가 맡음 · 걷어냄 · 건너뛰었지만 해야 함), 일마다 정하기.
// 찾은 것은 지우지 않는다 — 고친 것은 서버가 따로 기록한다. 관리자만 고치고 정한다(다른 사람은 읽기만).
// 서버: GET /ontology/refine/:proc · POST …/review · …/issues/:id · …/corrections · …/classes({task, class} — class null 은 AI 제안으로 되돌림)
//   · DELETE …/corrections/:id.
// 지도 페이지 위를 덮는 창(닫기 · Esc). ?mock 개발 화면에서는 페이지의 가짜 응답(mock.js → mock-refine.js)을 쓴다.
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from '../Icon.vue'
import MapGraph from './MapGraph.vue'
import { api } from '../../api.js'
import { END, dateKo, dateTimeKo, taskName } from './fmt.js'
import { edgeId } from './mapView.js'
import { narrow } from '../../viewport.js'

const props = defineProps({
  proc: { type: Object, required: true }, // {key, name}
  admin: Boolean,
  call: { type: Function, default: api }, // the page's api (the mock with ?mock in dev)
})
const emit = defineEmits(['close'])

const STEPS = [
  { key: 'fix', no: '①', ko: '바로잡기', q: '이 순서가 맞나요?', sub: 'AI가 이상한 곳을 찾아 제안하면, 지도를 나란히 살펴보고 정해요.', live: true },
  { key: 'classify', no: '②', ko: '단계 가르기', q: '단계마다 어떤 단계인가요?', sub: 'AI가 다섯 가지로 나눠 제안하면, 지도 색으로 살펴보고 일마다 정해요.', live: true },
  { key: 'compare', no: '③', ko: '견주기' },
  { key: 'redraw', no: '④', ko: '새 그림' },
  { key: 'agree', no: '⑤', ko: '합의' },
  { key: 'run', no: '⑥', ko: '시행 · 지켜보기' },
]
const KIND = { order: '순서', mixed: '섞인 일', artifact: '기록 탓', missing: '빠진 단계' }
const OPS = [
  { key: 'reverse_edge', ko: '화살표 뒤집기' },
  { key: 'remove_edge', ko: '화살표 끊기' },
  { key: 'add_edge', ko: '화살표 잇기' },
  { key: 'rename_task', ko: '이름 바꾸기' },
  { key: 'merge_task', ko: '다른 일과 합치기' },
  { key: 'add_task', ko: '기록에 없는 일 더하기' },
  { key: 'remove_task', ko: '일 빼기' },
]
// 기획안 §4 다섯 가지(지도 색은 MapGraph mk-*)
const CLASSES = [
  { key: 'gate', ko: '꼭 하는 관문', tip: '건너뛰면 안 되는 확인 · 승인 · 검토예요(품질 · 돈 · 법 · 보안). 실행에서 고정돼요.' },
  { key: 'human', ko: '사람이 꼭', tip: '사람의 판단 · 책임 · 대면이 필요한 일이에요. AI는 자료만 챙겨요.' },
  { key: 'ai', ko: 'AI가 맡음', tip: '글 · 양식 작성, 자료 모으기처럼 에이전트가 할 수 있는 일이에요.' },
  { key: 'drop', ko: '걷어냄', tip: '수작업 때문에 필요했던 일이에요(전달 · 취합 · 옮겨 적기 · 확인 재촉). 쓰지 않게 돼요.' },
  { key: 'skipped', ko: '건너뛰었지만 해야 함', tip: '기록에서는 자주 빠지지만 해야 하는 단계예요. 관문으로 올려요.' },
]
const CLASS_KO = { ...Object.fromEntries(CLASSES.map((c) => [c.key, c.ko])), none: '그 밖' }
const MARKED = new Set(CLASSES.map((c) => c.key))

const root = ref(null)
const formEl = ref(null)
const d = ref(null)
const err = ref('')
const busy = ref('')
const step = ref('fix')
const sel = ref(null) // the selection both maps show: {kind: 'task'|'edge', id}
const focus = ref('') // the issue whose place the maps show
let timer = 0
let alive = true
const base = computed(() => `/ontology/refine/${encodeURIComponent(props.proc.key)}`)

async function load() {
  try { d.value = await props.call(base.value); err.value = '' } catch (e) { err.value = e.message }
  clearTimeout(timer)
  if (alive && d.value?.job?.status === 'running') timer = setTimeout(load, 4000)
}
// a POST/DELETE that answers with the whole refine view
async function send(key, path, opts) {
  busy.value = key; err.value = ''
  try {
    const r = await props.call(`${base.value}${path}`, opts)
    if (r?.found && r?.refined) d.value = r
    return r || {}
  } catch (e) { err.value = e.message; return null } finally { busy.value = '' }
}

// ---------- AI가 살펴보기 ----------
const review = computed(() => d.value?.review || null)
const running = computed(() => d.value?.job?.status === 'running')
const failed = computed(() => d.value?.job?.status === 'failed')
const feed = computed(() => (d.value?.job?.detail?.feed || []).at(-1)?.text || '')
async function startReview() {
  const r = await send('review', '/review', { method: 'POST', body: {} })
  if (r) await load()
}

// ---------- 지도: 계약의 일 · 화살표를 MapGraph 가 쓰는 꼴로 ----------
function graphOf(tasks = [], edges = [], flags = true) {
  const keys = new Set(tasks.map((t) => t.key))
  const es = edges.filter((e) => e.from !== e.to && keys.has(e.from) && (e.to === END || keys.has(e.to)))
  const ins = new Set(es.map((e) => e.to))
  let entries = tasks.filter((t) => !ins.has(t.key)).map((t) => t.key)
  if (!entries.length && tasks.length) entries = [tasks[0].key]
  return {
    tasks: tasks.map((t) => ({ key: t.key, name: t.name || t.key, role: t.role || '', n_cases: t.n ?? 0, added: flags && !!t.added, removed: flags && !!t.removed })),
    edges: es.map((e) => ({ from: e.from, to: e.to, n: e.n ?? 0, p: e.p ?? 0, added: flags && !!e.added, removed: flags && !!e.removed })),
    entries,
  }
}
const found = computed(() => d.value?.found || { tasks: [], edges: [] })
const refined = computed(() => d.value?.refined || { tasks: [], edges: [], removed: { tasks: [], edges: [] } })
const foundKeys = computed(() => new Set(found.value.tasks.map((t) => t.key)))
const refinedKeys = computed(() => new Set(refined.value.tasks.map((t) => t.key)))
const removedList = computed(() => ({ tasks: refined.value.removed?.tasks || [], edges: refined.value.removed?.edges || [] }))
// 찾은 대로 쪽: 다듬은 것에 없는 일 · 화살표(뺀 것, 뒤집은 것, 이름을 바꾼 것)는 빨강 점선
const foundG = computed(() => {
  const goneT = new Set(removedList.value.tasks)
  const goneE = new Set(removedList.value.edges.map(edgeId))
  const keep = new Set(refined.value.edges.map(edgeId))
  return graphOf(
    found.value.tasks.map((t) => ({ ...t, removed: goneT.has(t.key) || !refinedKeys.value.has(t.key) })),
    found.value.edges.map((e) => ({ ...e, removed: goneE.has(edgeId(e)) || !keep.has(edgeId(e)) })),
  )
})
const refinedG = computed(() => graphOf(refined.value.tasks, refined.value.edges))
const changed = computed(() => (d.value?.corrections || []).length > 0)

// both maps show one selection; an issue shows where it is
function issueSel(i) {
  const a = i.fix?.args || {}
  if (a.from && a.to) return { kind: 'edge', id: edgeId(a) }
  const k = a.task || a.after || a.before || /「([^」]+)」/.exec(i.title || '')?.[1]
  return k && (foundKeys.value.has(k) || refinedKeys.value.has(k)) ? { kind: 'task', id: k } : null
}
function pickIssue(i) {
  if (focus.value === i.id) { focus.value = ''; sel.value = null; return }
  focus.value = i.id
  sel.value = issueSel(i)
}

// ---------- 정하기: 문제 · 내가 고침 · 고친 기록 ----------
const issues = computed(() => review.value?.issues || [])
const openIssues = computed(() => issues.value.filter((i) => !i.status || i.status === 'open').length)
const issueCounts = computed(() => ({ accepted: issues.value.filter((i) => i.status === 'accepted').length, dismissed: issues.value.filter((i) => i.status === 'dismissed').length }))
const decideIssue = (i, action) => send(`issue:${i.id}`, `/issues/${encodeURIComponent(i.id)}`, { method: 'POST', body: { action } })
const undo = (c) => send(`undo:${c.id}`, `/corrections/${encodeURIComponent(c.id)}`, { method: 'DELETE' })

const blank = { op: 'reverse_edge', edge: null, from: '', to: '', task: '', into: '', name: '', role: '', after: '', before: '', why: '' }
const f = reactive({ ...blank })
watch(() => f.op, () => Object.assign(f, { edge: null, from: '', to: '', task: '', into: '', name: '', role: '', after: '', before: '' }))
const rTasks = computed(() => refined.value.tasks.map((t) => t.key))
const rEdges = computed(() => refined.value.edges.filter((e) => e.from !== e.to))
const edgeChoices = computed(() => rEdges.value.filter((e) => f.op !== 'reverse_edge' || e.to !== END))
const roles = computed(() => [...new Set(refined.value.tasks.map((t) => t.role).filter(Boolean))])
const hasEdge = (a, b) => rEdges.value.some((e) => e.from === a && e.to === b)
// what the form would send, or why not yet
const draft = computed(() => {
  const name = f.name.trim()
  switch (f.op) {
    case 'reverse_edge': case 'remove_edge': return f.edge ? { args: { from: f.edge.from, to: f.edge.to } } : {}
    case 'add_edge':
      if (!f.from || !f.to) return {}
      if (f.from === f.to) return { hint: '같은 일끼리는 이을 수 없어요.' }
      return hasEdge(f.from, f.to) ? { hint: '이미 있는 화살표예요.' } : { args: { from: f.from, to: f.to } }
    case 'rename_task':
      if (!f.task || !name) return {}
      if (name === f.task) return { hint: '지금 이름과 같아요.' }
      return rTasks.value.includes(name) ? { hint: '이미 있는 이름이에요. 합치려면 「다른 일과 합치기」를 고르세요.' } : { args: { task: f.task, name } }
    case 'merge_task':
      if (!f.task || !f.into) return {}
      return f.task === f.into ? { hint: '다른 일을 고르세요.' } : { args: { task: f.task, into: f.into } }
    case 'add_task':
      if (!name) return {}
      if (rTasks.value.includes(name)) return { hint: '이미 있는 일 이름이에요.' }
      if (f.after && f.after === f.before) return { hint: '앞뒤에 같은 일을 고를 수 없어요.' }
      return { args: { name, role: f.role.trim(), ...(f.after ? { after: f.after } : {}), ...(f.before ? { before: f.before } : {}) } }
    case 'remove_task': return f.task ? { args: { task: f.task } } : {}
  }
  return {}
})
const formOk = computed(() => !!draft.value.args && !!f.why.trim())
async function submitFix() {
  if (!formOk.value) return
  const r = await send('fix', '/corrections', { method: 'POST', body: { op: f.op, args: draft.value.args, why: f.why.trim() } })
  if (r) { const op = f.op; Object.assign(f, { ...blank, op }) }
}
// an issue with no fix of its own: the form, with the issue as the reason
function fixByHand(i) {
  focus.value = i.id
  sel.value = issueSel(i)
  if (!f.why.trim()) f.why = i.title
  nextTick(() => { formEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); formEl.value?.querySelector('select')?.focus({ preventScroll: true }) })
}
// a task or arrow pressed on a map fills the form's pickers (in the order the form asks)
function onPick(x) {
  sel.value = x
  focus.value = ''
  if (!x || !props.admin) return
  if (x.kind === 'edge') {
    const e = rEdges.value.find((y) => edgeId(y) === x.id)
    if (e && (f.op === 'reverse_edge' || f.op === 'remove_edge') && (f.op === 'remove_edge' || e.to !== END)) f.edge = e
    else if (e && f.op === 'add_edge') { f.from = e.from; f.to = '' }
    return
  }
  if (x.kind !== 'task' || !rTasks.value.includes(x.id)) return
  const k = x.id
  if (f.op === 'add_edge') { if (!f.from || f.to) { f.from = k; f.to = '' } else f.to = k }
  else if (f.op === 'merge_task') { if (!f.task || f.into) { f.task = k; f.into = '' } else f.into = k }
  else if (f.op === 'add_task') { if (!f.after || f.before) { f.after = k; f.before = '' } else f.before = k }
  else if (f.op === 'rename_task' || f.op === 'remove_task') f.task = k
}

// 「AI가 생각하는 프로세스」: 차례대로, 기록에 없던 단계와 다음 단계가 바로 아래가 아닌 곳은 따로 적는다
const proposed = computed(() => {
  const p = review.value?.proposed
  if (!p?.steps?.length) return []
  const flows = p.flows || []
  return p.steps.map((s, i) => {
    const nexts = flows.filter((x) => x.from === s.task).map((x) => x.to)
    const last = i === p.steps.length - 1
    const plain = !flows.length || (nexts.length === 1 && nexts[0] === (last ? END : p.steps[i + 1]?.task)) || (!nexts.length && last)
    return { ...s, fresh: !foundKeys.value.has(s.task), added: refinedKeys.value.has(s.task), next: plain ? '' : nexts.map(taskName).join(' · ') }
  })
})
const leftOut = computed(() => {
  const inProp = new Set((review.value?.proposed?.steps || []).map((s) => s.task))
  return inProp.size ? rTasks.value.filter((k) => !inProp.has(k)) : []
})

// ---------- ② 단계 가르기 ----------
function flowOrder(g) {
  const keys = new Set(g.tasks.map((t) => t.key))
  const es = g.edges.filter((e) => e.from !== e.to && keys.has(e.from) && keys.has(e.to))
  const ins = new Set(es.map((e) => e.to))
  const q = g.tasks.filter((t) => !ins.has(t.key)).map((t) => t.key)
  if (!q.length && g.tasks.length) q.push(g.tasks[0].key)
  const seen = new Set(), out = []
  while (q.length) {
    const k = q.shift()
    if (seen.has(k)) continue
    seen.add(k); out.push(k)
    for (const e of es.filter((x) => x.from === k).sort((a, b) => (b.p || 0) - (a.p || 0))) if (!seen.has(e.to)) q.push(e.to)
  }
  for (const t of g.tasks) if (!seen.has(t.key)) out.push(t.key)
  return out
}
const classRows = computed(() => {
  const by = new Map(refined.value.tasks.map((t) => [t.key, t]))
  return flowOrder(refined.value).map((k) => {
    const c = d.value?.classes?.[k] || null
    return { key: k, role: by.get(k)?.role || '', n: by.get(k)?.n || 0, cls: c?.class || '', why: c?.why || '', by: c?.by || '', decided: !!c?.decided }
  })
})
const classTotal = computed(() => classRows.value.length)
const classed = computed(() => classRows.value.filter((r) => r.cls).length)
const decidedCount = computed(() => classRows.value.filter((r) => r.decided).length)
const countBy = computed(() => classRows.value.reduce((a, r) => ({ ...a, [r.cls]: (a[r.cls] || 0) + 1 }), {}))
const classMarks = computed(() => new Map(classRows.value.filter((r) => MARKED.has(r.cls)).map((r) => [r.key, r.cls])))
const classG = computed(() => graphOf(refined.value.tasks, refined.value.edges, false))
const setClass = (task, cls) => send(`class:${task}`, '/classes', { method: 'POST', body: { task, class: cls } })
function onPickClass(x) {
  sel.value = x
  if (x?.kind !== 'task') return
  nextTick(() => {
    const row = [...(root.value?.querySelectorAll('[data-testid="onto-refine-class-row"]') || [])].find((el) => el.dataset.task === x.id)
    row?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
}

function pickStep(k) { step.value = k; sel.value = null; focus.value = '' }

// Esc: out of a text field first, then closes (the map page leaves its own keys alone while this is open)
function onKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  const t = e.target
  if (/^(INPUT|TEXTAREA)$/.test(t?.tagName || '')) { t.blur(); return }
  e.preventDefault()
  emit('close')
}
onMounted(() => {
  document.addEventListener('keydown', onKey)
  load()
  nextTick(() => root.value?.focus({ preventScroll: true }))
})
onBeforeUnmount(() => { alive = false; clearTimeout(timer); document.removeEventListener('keydown', onKey) })
</script>

<template>
  <Teleport to="body">
  <div ref="root" class="rf ontomap" role="dialog" aria-modal="true" :aria-label="`${proc.name} 다듬기`" tabindex="-1" data-testid="onto-refine">
    <header class="top">
      <div class="tt">
        <small>프로세스 다듬기</small>
        <b>{{ d?.proc?.name || proc.name }}</b>
      </div>
      <p class="lead">찾은 지도는 그대로 두고, 고친 것은 따로 기록해요. 언제든 「찾은 대로」와 나란히 볼 수 있어요.</p>
      <button class="x press" aria-label="닫기" title="닫기 (Esc)" data-testid="onto-refine-close" @click="emit('close')"><Icon name="close" :size="16" /></button>
    </header>

    <nav class="steps" aria-label="여섯 걸음">
      <button v-for="s in STEPS" :key="s.key" class="st press" :class="{ on: step === s.key, off: !s.live }" :disabled="!s.live" :aria-current="step === s.key ? 'step' : null"
        :data-testid="`onto-refine-step-${s.key}`" @click="pickStep(s.key)">
        <i>{{ s.no }}</i><span>{{ s.ko }}</span>
        <small v-if="!s.live">준비 중</small>
        <small v-else-if="s.key === 'fix' && openIssues">{{ openIssues }}개 남음</small>
        <small v-else-if="s.key === 'classify' && classed">정함 {{ decidedCount }}/{{ classTotal }}</small>
      </button>
    </nav>

    <p v-if="err" class="err top-err" role="alert" data-testid="onto-refine-error">{{ err }}
      <button v-if="!d" class="lnk press" @click="load">다시 불러오기</button></p>
    <p v-if="!d && !err" class="loading pulse">불러오는 중…</p>

    <main v-else-if="d" class="body">
      <p class="q">{{ STEPS.find((s) => s.key === step).q }} <span>{{ STEPS.find((s) => s.key === step).sub }}</span></p>

      <!-- ① 바로잡기 -->
      <section v-if="step === 'fix'" class="grid" data-testid="onto-refine-fix">
        <div class="area ai">
          <h3 class="ah"><i>1</i>AI 제안</h3>
          <div class="rv">
            <p v-if="running" class="feed pulse" data-testid="onto-refine-feed">{{ feed || 'AI가 지도를 살펴보고 있어요…' }}</p>
            <template v-else-if="review">
              <p class="summary" data-testid="onto-refine-summary">{{ review.summary }}</p>
              <p class="meta">{{ review.model || 'AI' }} 판단<template v-if="review.made_at"> · {{ dateTimeKo(review.made_at) }}</template></p>
            </template>
            <p v-else class="muted">아직 AI가 살펴보지 않았어요. 순서가 이상한 곳, 한 이름에 섞인 일, 기록 때문에 잘못 읽은 순서, 빠진 단계를 찾아 「사실은 이런 프로세스일 것」을 그려 보여요.</p>
            <p v-if="failed" class="err">살펴보지 못했어요.<template v-if="feed"> {{ feed }}</template></p>
            <button v-if="admin && !running" class="go press" :disabled="!!busy" data-testid="onto-refine-review" @click="startReview">
              {{ busy === 'review' ? '시작하는 중…' : review ? '다시 살펴보기' : 'AI로 살펴보기' }}</button>
            <p v-else-if="!admin && !review && !running" class="muted sm">관리자가 「AI로 살펴보기」를 누르면 여기에 나와요.</p>
          </div>

          <div v-if="proposed.length" class="prop" data-testid="onto-refine-proposed">
            <h4>AI가 생각하는 프로세스</h4>
            <p class="sm">사실은 이런 차례일 거예요.</p>
            <ol>
              <li v-for="(s, i) in proposed" :key="`${s.task}-${i}`" :class="{ fresh: s.fresh }" data-testid="onto-refine-proposed-step">
                <i>{{ i + 1 }}</i>
                <span class="pn"><b>{{ s.task }}</b><span v-if="s.fresh" class="tag new">{{ s.added ? '더함' : '기록에 없음' }}</span></span>
                <small>{{ s.role }}</small>
                <span v-if="s.next" class="nx">다음 → {{ s.next }}</span>
              </li>
            </ol>
            <p v-if="leftOut.length" class="sm">AI 그림에 없는 일: {{ leftOut.join(' · ') }}</p>
          </div>
        </div>

        <div class="area look">
          <h3 class="ah"><i>2</i>살펴보기</h3>
          <div class="maps">
            <div class="mapcol" data-testid="onto-refine-found">
              <div class="mh"><b>찾은 대로</b><small>메일 · 대화에서 읽은 그대로 · 일 {{ foundG.tasks.length }} · 화살표 {{ foundG.edges.length }}</small></div>
              <div class="mapbox">
                <MapGraph v-if="foundG.tasks.length" :tasks="foundG.tasks" :edges="foundG.edges" :entries="foundG.entries" :selected="sel" dir="TB" @select="onPick" />
                <p v-else class="nomap">찾은 일이 없어요.</p>
              </div>
            </div>
            <div class="mapcol" data-testid="onto-refine-refined">
              <div class="mh"><b>다듬은 것</b><small>고친 것을 반영했어요 · 일 {{ refinedG.tasks.length }} · 화살표 {{ refinedG.edges.length }}</small></div>
              <div class="mapbox">
                <MapGraph v-if="refinedG.tasks.length" :tasks="refinedG.tasks" :edges="refinedG.edges" :entries="refinedG.entries" :selected="sel" dir="TB" @select="onPick" />
                <p v-else class="nomap">남은 일이 없어요.</p>
              </div>
              <div v-if="removedList.tasks.length || removedList.edges.length" class="removed" data-testid="onto-refine-removed">
                <span class="k">뺀 것</span>
                <span v-for="t in removedList.tasks" :key="`t-${t}`" class="rm">{{ t }}</span>
                <span v-for="e in removedList.edges" :key="`e-${edgeId(e)}`" class="rm">{{ taskName(e.from) }} → {{ taskName(e.to) }}</span>
              </div>
              <p v-else-if="!changed" class="same">아직 고친 것이 없어서 찾은 대로와 같아요.</p>
            </div>
          </div>
          <div class="legend">
            <span><i class="sw added" />더한 일 · 화살표</span>
            <span><i class="sw removed" />다듬으며 뺀 것</span>
            <span><svg width="26" height="10" aria-hidden="true"><path d="M1 5h24" stroke="currentColor" stroke-width="3.5" /></svg>굵을수록 자주</span>
            <span class="hint">일이나 화살표를 누르면 두 지도에서 함께 보여요.</span>
          </div>
        </div>

        <div class="area decide">
          <h3 class="ah"><i>3</i>정하기</h3>
          <div class="sec">
            <h4>AI가 찾은 문제 <small v-if="issues.length">{{ issues.length }}개 · 고침 {{ issueCounts.accepted }} · 그대로 둠 {{ issueCounts.dismissed }} · 남음 {{ openIssues }}</small></h4>
            <p v-if="!review" class="muted sm">AI가 살펴보면 문제가 여기에 하나씩 나와요.</p>
            <p v-else-if="!issues.length" class="muted sm">AI가 찾은 문제가 없어요.</p>
            <ul class="ilist">
              <li v-for="i in issues" :key="i.id" class="iss" :class="[i.status || 'open', i.kind, { on: focus === i.id }]" data-testid="onto-refine-issue" :data-kind="i.kind" :data-status="i.status || 'open'">
                <button class="ihead press" :aria-pressed="focus === i.id" title="지도에서 보기" @click="pickIssue(i)">
                  <span class="kind" :class="i.kind">{{ KIND[i.kind] || i.kind }}</span><b>{{ i.title }}</b>
                </button>
                <p class="why">{{ i.why }}</p>
                <details v-if="i.evidence?.length" class="ev">
                  <summary>근거 {{ i.evidence.length }}건</summary>
                  <ul><li v-for="(x, k) in i.evidence" :key="k"><time v-if="x.at">{{ dateKo(x.at) }}</time><q>{{ x.said }}</q></li></ul>
                </details>
                <p class="fixl" :class="{ nofix: !i.fix }"><span class="k">제안</span>{{ i.fix ? i.fix.label : '고칠 방법은 사람이 정해야 해요.' }}</p>
                <div class="ibtns">
                  <span v-if="i.status === 'accepted'" class="state ok" data-testid="onto-refine-issue-state">고쳤어요</span>
                  <span v-else-if="i.status === 'dismissed'" class="state" data-testid="onto-refine-issue-state">그대로 둠</span>
                  <template v-else-if="admin">
                    <button class="ghost press" :disabled="!!busy" data-testid="onto-refine-issue-dismiss" @click="decideIssue(i, 'dismiss')">그대로 둠</button>
                    <button v-if="i.fix" class="go small press" :disabled="!!busy" data-testid="onto-refine-issue-accept" @click="decideIssue(i, 'accept')">{{ busy === `issue:${i.id}` ? '고치는 중…' : '제안대로 고침' }}</button>
                    <button v-else class="go small press" :disabled="!!busy" data-testid="onto-refine-issue-hand" @click="fixByHand(i)">내가 고침</button>
                  </template>
                </div>
              </li>
            </ul>
          </div>

          <form v-if="admin" ref="formEl" class="sec mine" data-testid="onto-refine-fix-form" @submit.prevent="submitFix">
            <h4>내가 고침</h4>
            <p class="sm">지도에서 일이나 화살표를 누르면 아래 칸이 채워져요.</p>
            <label>무엇을
              <select v-model="f.op" data-testid="onto-refine-fix-op"><option v-for="o in OPS" :key="o.key" :value="o.key">{{ o.ko }}</option></select>
            </label>
            <label v-if="f.op === 'reverse_edge' || f.op === 'remove_edge'">화살표
              <select v-model="f.edge" data-testid="onto-refine-fix-edge">
                <option :value="null" disabled>고르세요</option>
                <option v-for="e in edgeChoices" :key="edgeId(e)" :value="e">{{ taskName(e.from) }} → {{ taskName(e.to) }}</option>
              </select>
            </label>
            <div v-else-if="f.op === 'add_edge'" class="two">
              <label>어디서<select v-model="f.from" data-testid="onto-refine-fix-from"><option value="" disabled>고르세요</option><option v-for="k in rTasks" :key="k" :value="k">{{ k }}</option></select></label>
              <label>어디로<select v-model="f.to" data-testid="onto-refine-fix-to"><option value="" disabled>고르세요</option><option v-for="k in rTasks" :key="k" :value="k">{{ k }}</option><option :value="END">끝</option></select></label>
            </div>
            <template v-else-if="f.op === 'rename_task'">
              <label>일<select v-model="f.task" data-testid="onto-refine-fix-task"><option value="" disabled>고르세요</option><option v-for="k in rTasks" :key="k" :value="k">{{ k }}</option></select></label>
              <label>새 이름<input v-model="f.name" type="text" maxlength="60" placeholder="예: 착공일 고객 안내" data-testid="onto-refine-fix-name"></label>
            </template>
            <div v-else-if="f.op === 'merge_task'" class="two">
              <label>이 일을<select v-model="f.task" data-testid="onto-refine-fix-task"><option value="" disabled>고르세요</option><option v-for="k in rTasks" :key="k" :value="k">{{ k }}</option></select></label>
              <label>이 일에 합쳐요<select v-model="f.into" data-testid="onto-refine-fix-into"><option value="" disabled>고르세요</option><option v-for="k in rTasks.filter((x) => x !== f.task)" :key="k" :value="k">{{ k }}</option></select></label>
            </div>
            <template v-else-if="f.op === 'add_task'">
              <label>일 이름<input v-model="f.name" type="text" maxlength="60" placeholder="예: 계약금 입금 확인" data-testid="onto-refine-fix-name"></label>
              <label>맡는 역할<input v-model="f.role" type="text" maxlength="40" list="onto-refine-roles" placeholder="예: 재무" data-testid="onto-refine-fix-role"></label>
              <datalist id="onto-refine-roles"><option v-for="r in roles" :key="r" :value="r" /></datalist>
              <div class="two">
                <label>앞에 오는 일<select v-model="f.after" data-testid="onto-refine-fix-after"><option value="">없음</option><option v-for="k in rTasks" :key="k" :value="k">{{ k }}</option></select></label>
                <label>뒤에 오는 일<select v-model="f.before" data-testid="onto-refine-fix-before"><option value="">없음</option><option v-for="k in rTasks" :key="k" :value="k">{{ k }}</option></select></label>
              </div>
            </template>
            <label v-else-if="f.op === 'remove_task'">일<select v-model="f.task" data-testid="onto-refine-fix-task"><option value="" disabled>고르세요</option><option v-for="k in rTasks" :key="k" :value="k">{{ k }}</option></select></label>
            <label>왜 고치나요
              <textarea v-model="f.why" rows="2" maxlength="300" placeholder="예: 공정표가 있어야 발주할 수 있어요" data-testid="onto-refine-fix-why" />
            </label>
            <p v-if="draft.hint" class="sm warn">{{ draft.hint }}</p>
            <button class="go press" type="submit" :disabled="!formOk || !!busy" data-testid="onto-refine-fix-submit">{{ busy === 'fix' ? '고치는 중…' : '고치기' }}</button>
          </form>
          <p v-else class="muted sm">관리자만 고칠 수 있어요. 고친 기록과 까닭은 모두에게 보여요.</p>

          <div class="sec corr">
            <h4>고친 기록 <small v-if="d.corrections?.length">{{ d.corrections.length }}</small></h4>
            <p v-if="!d.corrections?.length" class="muted sm">아직 고친 것이 없어요. 찾은 지도는 고쳐도 그대로 남아요.</p>
            <ul>
              <li v-for="c in d.corrections || []" :key="c.id" data-testid="onto-refine-correction" :data-source="c.source">
                <b>{{ c.label }}</b>
                <span v-if="c.why" class="why">{{ c.why }}</span>
                <small>{{ c.source === 'ai' ? 'AI 제안대로' : '직접 고침' }}<template v-if="c.by"> · {{ c.by }}</template><template v-if="c.at"> · {{ dateTimeKo(c.at) }}</template></small>
                <button v-if="admin" class="lnk press" :disabled="!!busy" data-testid="onto-refine-correction-undo" @click="undo(c)">{{ busy === `undo:${c.id}` ? '되돌리는 중…' : '되돌리기' }}</button>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <!-- ② 단계 가르기 -->
      <section v-else-if="step === 'classify'" class="grid" data-testid="onto-refine-classify">
        <div class="area ai">
          <h3 class="ah"><i>1</i>AI 제안</h3>
          <template v-if="classed">
            <ul class="ccount" data-testid="onto-refine-class-counts">
              <li v-for="c in CLASSES" :key="c.key" :title="c.tip"><i class="sw" :class="c.key" /><span>{{ c.ko }}</span><b>{{ countBy[c.key] || 0 }}</b></li>
              <li v-if="countBy.none"><i class="sw none" /><span>그 밖</span><b>{{ countBy.none }}</b></li>
            </ul>
            <p class="sm">{{ classTotal }}단계 가운데 {{ decidedCount }}개를 정했어요. 아직 정하지 않은 것은 AI 제안이에요.</p>
          </template>
          <p v-else class="muted">아직 AI가 단계를 나누지 않았어요. AI가 살펴보면 단계마다 다섯 가지 가운데 하나를 까닭과 함께 제안해요.</p>
          <p v-if="running" class="feed pulse" data-testid="onto-refine-feed">{{ feed || 'AI가 지도를 살펴보고 있어요…' }}</p>
          <button v-else-if="admin" class="go press" :disabled="!!busy" data-testid="onto-refine-review" @click="startReview">
            {{ busy === 'review' ? '시작하는 중…' : review ? '다시 살펴보기' : 'AI로 살펴보기' }}</button>
          <p class="sm caution">「걷어냄」은 조심해서 정해요. 그 일로 오가던 정보를 누가 대신 받는지 까닭을 꼭 보세요.</p>
          <p v-if="review" class="meta">{{ review.model || 'AI' }} 판단<template v-if="review.made_at"> · {{ dateTimeKo(review.made_at) }}</template></p>
        </div>

        <div class="area look">
          <h3 class="ah"><i>2</i>살펴보기 <small>다듬은 것 기준</small></h3>
          <div class="mapbox big" data-testid="onto-refine-class-map">
            <MapGraph v-if="classG.tasks.length" :tasks="classG.tasks" :edges="classG.edges" :entries="classG.entries" :marks="classMarks" :selected="sel" :dir="narrow ? 'TB' : 'LR'" @select="onPickClass" />
            <p v-else class="nomap">남은 일이 없어요.</p>
          </div>
          <div class="legend" data-testid="onto-refine-class-legend">
            <span v-for="c in CLASSES" :key="c.key"><i class="sw" :class="c.key" />{{ c.ko }}</span>
            <span><i class="sw none" />그 밖 · 아직 안 나눔</span>
          </div>
        </div>

        <div class="area decide">
          <h3 class="ah"><i>3</i>정하기</h3>
          <p v-if="!admin" class="muted sm">관리자만 정할 수 있어요.</p>
          <ul class="clist">
            <li v-for="t in classRows" :key="t.key" class="crow" :class="[`c-${t.cls || 'unset'}`, { on: sel?.kind === 'task' && sel.id === t.key, decided: t.decided }]"
              data-testid="onto-refine-class-row" :data-task="t.key" :data-class="t.cls" :data-decided="t.decided">
              <button class="chead press" title="지도에서 보기" @click="sel = { kind: 'task', id: t.key }">
                <b>{{ t.key }}</b><small>{{ t.role }}<template v-if="t.n"> · {{ t.n }}건</template></small>
                <span v-if="t.decided" class="state ok">정함</span>
              </button>
              <p v-if="t.cls" class="cwhy">
                <span class="badge"><i class="sw" :class="t.cls" />{{ CLASS_KO[t.cls] || t.cls }}</span>
                <small>{{ !t.decided ? 'AI 제안' : t.by === 'person' ? '사람이 정함' : 'AI 제안대로 정함' }}</small>
                <button v-if="admin && t.decided" class="lnk press" :disabled="!!busy" data-testid="onto-refine-class-reset" @click="setClass(t.key, null)">AI 제안으로 되돌리기</button>
              </p>
              <p v-else class="muted sm">아직 나누지 않았어요.</p>
              <p v-if="t.why" class="why">{{ t.why }}</p>
              <div v-if="admin" class="cbtns" role="group" :aria-label="`${t.key} 나누기`">
                <button v-for="c in CLASSES" :key="c.key" class="cb press" :class="{ on: t.decided && t.cls === c.key, sug: !t.decided && t.cls === c.key }" :title="c.tip"
                  :aria-pressed="t.decided && t.cls === c.key" :disabled="!!busy" :data-testid="`onto-refine-class-${c.key}`" @click="setClass(t.key, c.key)">
                  <i class="sw" :class="c.key" />{{ c.ko }}</button>
              </div>
            </li>
          </ul>
        </div>
      </section>
    </main>
  </div>
  </Teleport>
</template>

<style scoped>
.rf { position: fixed; inset: 0; z-index: 75; display: flex; flex-direction: column; color: var(--text-primary); background: linear-gradient(var(--regular-solid-bg), var(--regular-solid-bg)), var(--surface-secondary); animation: fade-in .2s both; outline: none; word-break: keep-all; --orange: #d9822b; --green: #2f9e6e; }
.top { flex: none; display: flex; align-items: center; gap: 16px; padding: 14px 20px 6px; }
.tt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tt small { font-size: 12px; color: var(--text-tertiary); }
.tt b { font-size: 21px; font-weight: 600; letter-spacing: -0.01em; }
.lead { flex: 1; margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.x { width: 34px; height: 34px; border-radius: 17px; display: grid; place-items: center; color: var(--text-secondary); background: var(--button-bg); flex: none; }
.x:hover { color: var(--text-primary); }

.steps { flex: none; display: flex; gap: 6px; padding: 6px 20px 10px; overflow-x: auto; scrollbar-width: none; }
.steps::-webkit-scrollbar { display: none; }
.st { flex: none; height: 36px; padding: 0 14px 0 6px; border-radius: 18px; display: inline-flex; align-items: center; gap: 7px; font-size: 13.5px; font-weight: 500; background: var(--field-bg); color: var(--text-secondary); white-space: nowrap; }
.st i { font-style: normal; width: 24px; height: 24px; border-radius: 12px; display: grid; place-items: center; font-size: 13.5px; background: var(--cell-bg); }
.st small { font-size: 11.5px; font-weight: 400; color: var(--text-tertiary); }
.st:not(:disabled):hover { color: var(--text-primary); }
.st.on { background: var(--ink); color: var(--ink-inverse); }
.st.on i { background: color-mix(in srgb, var(--ink-inverse) 16%, transparent); }
.st.on small { color: color-mix(in srgb, var(--ink-inverse) 62%, transparent); }
.st.off { opacity: .5; cursor: default; }

.err { margin: 0; font-size: 13px; color: var(--color-error); line-height: 1.5; }
.top-err { padding: 0 20px 6px; }
.loading { text-align: center; margin-top: 60px; color: var(--text-secondary); }
.body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; padding: 0 20px 16px; }
.q { flex: none; margin: 0; font-size: 15px; font-weight: 600; line-height: 1.5; }
.q span { margin-left: 6px; font-size: 13px; font-weight: 400; color: var(--text-secondary); }

.grid { flex: 1; min-height: 0; display: grid; gap: 12px; grid-template-columns: 300px minmax(0, 1fr) 380px; grid-template-rows: minmax(0, 1fr); grid-template-areas: 'ai look decide'; }
.area { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: 12px 14px 14px; border-radius: 20px; background: var(--cell-bg); overflow-y: auto; scrollbar-width: thin; }
.area.ai { grid-area: ai; }
.area.look { grid-area: look; overflow: hidden; }
.area.decide { grid-area: decide; }
.ah { flex: none; margin: 0; display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.ah i { font-style: normal; width: 20px; height: 20px; border-radius: 10px; display: grid; place-items: center; background: var(--ink); color: var(--ink-inverse); font-size: 11.5px; }
.ah small { font-weight: 400; color: var(--text-tertiary); }
h4 { margin: 0; font-size: 13.5px; font-weight: 600; }
h4 small { margin-left: 4px; font-size: 12px; font-weight: 400; color: var(--text-tertiary); font-variant-numeric: tabular-nums; }
.sec { display: flex; flex-direction: column; gap: 8px; }
.sec + .sec { padding-top: 12px; border-top: 1px solid var(--hairline); }
.muted { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.sm { margin: 0; font-size: 12px; color: var(--text-secondary); line-height: 1.5; }
.warn { color: var(--orange); }
.meta { margin: 0; font-size: 11.5px; color: var(--text-tertiary); }
.k { margin-right: 6px; color: var(--text-tertiary); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); align-self: flex-start; white-space: nowrap; }
.go.small { height: 30px; padding: 0 13px; font-size: 12.5px; }
.ghost { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 12.5px; color: var(--text-secondary); background: var(--button-bg); white-space: nowrap; }
.go:disabled, .ghost:disabled, .cb:disabled { opacity: .45; cursor: default; }
.lnk { margin-left: 6px; font-size: 12.5px; color: var(--color-info); }
.lnk:disabled { opacity: .5; }
.state { font-size: 12px; font-weight: 500; padding: 2px 9px; border-radius: 9999px; background: var(--chip-bg); color: var(--text-secondary); white-space: nowrap; }
.state.ok { background: color-mix(in srgb, var(--color-success) 22%, transparent); color: var(--text-primary); }
.tag { flex: none; font-size: 11px; font-weight: 500; padding: 0 7px; border-radius: 9999px; background: var(--chip-bg); color: var(--text-secondary); white-space: nowrap; }
.tag.new { background: color-mix(in srgb, var(--color-info) 22%, transparent); color: var(--text-primary); }

/* AI 제안 */
.rv { display: flex; flex-direction: column; gap: 8px; }
.summary { margin: 0; font-size: 13.5px; line-height: 1.6; }
.feed { margin: 0; padding: 8px 12px; border-radius: 12px; background: var(--field-bg); font-size: 12.5px; color: var(--text-secondary); }
.prop { display: flex; flex-direction: column; gap: 6px; padding-top: 12px; border-top: 1px solid var(--hairline); }
.prop ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.prop li { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; align-items: baseline; gap: 2px 8px; padding: 6px 10px; border-radius: 10px; background: var(--field-bg); font-size: 13px; }
.prop li.fresh { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--color-info) 55%, transparent); }
.prop li i { font-style: normal; color: var(--text-tertiary); font-size: 12px; font-variant-numeric: tabular-nums; }
.pn { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; min-width: 0; }
.pn b { font-weight: 500; overflow-wrap: anywhere; }
.prop li small { font-size: 12px; color: var(--text-tertiary); white-space: nowrap; }
.nx { grid-column: 2 / -1; font-size: 11.5px; color: var(--text-tertiary); }

/* 살펴보기 */
.maps { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); gap: 10px; }
.mapcol { min-width: 0; min-height: 0; display: flex; flex-direction: column; gap: 6px; }
.mh { flex: none; display: flex; align-items: baseline; gap: 4px 8px; flex-wrap: wrap; }
.mh b { font-size: 14px; font-weight: 600; }
.mh small { font-size: 12px; color: var(--text-tertiary); }
.mapbox { position: relative; flex: 1; min-height: 260px; border-radius: 16px; background: var(--field-bg); overflow: hidden; }
.nomap { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; font-size: 13px; color: var(--text-secondary); }
.removed { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: 12px; max-height: 64px; overflow-y: auto; }
.rm { padding: 1px 8px; border-radius: 9999px; border: 1px dashed color-mix(in srgb, var(--color-error) 70%, transparent); color: var(--text-secondary); text-decoration: line-through; text-decoration-color: var(--color-error); }
.same { flex: none; margin: 0; font-size: 12px; color: var(--text-tertiary); }
.legend { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; font-size: 11.5px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend .hint { color: var(--text-tertiary); }
.sw { display: inline-block; flex: none; width: 18px; height: 12px; border-radius: 4px; box-sizing: border-box; }
.sw.added { border: 2px dashed var(--color-info); }
.sw.removed { border: 1.5px dashed var(--color-error); }
.sw.gate { background: color-mix(in srgb, var(--orange) 40%, transparent); border: 3.5px solid var(--orange); }
.sw.human { background: color-mix(in srgb, var(--orange) 26%, transparent); border: 2px solid var(--orange); }
.sw.ai { background: color-mix(in srgb, var(--green) 30%, transparent); border: 2px solid var(--green); }
.sw.drop { border: 1.5px solid var(--text-tertiary); background: linear-gradient(transparent 42%, var(--text-secondary) 42% 58%, transparent 58%); }
.sw.skipped { background: color-mix(in srgb, var(--orange) 10%, transparent); border: 2px dashed var(--orange); }
.sw.none { border: 1px solid var(--hairline); opacity: .6; }

/* 정하기 · ① */
.ilist, .clist, .corr ul, .ccount { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.iss { padding: 10px 12px; border-radius: 14px; background: var(--field-bg); border-left: 3px solid var(--text-tertiary); display: flex; flex-direction: column; gap: 6px; }
.iss.order { border-left-color: var(--orange); }
.iss.missing { border-left-color: var(--color-info); }
.iss.mixed { border-left-color: #a78bfa; }
.iss.on { box-shadow: inset 0 0 0 1.5px var(--text-secondary); }
.iss.accepted, .iss.dismissed { opacity: .7; }
.ihead { display: flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; }
.ihead b { font-size: 13.5px; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere; }
.kind { flex: none; margin-top: 1px; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 9999px; background: var(--chip-bg); color: var(--text-secondary); white-space: nowrap; }
.kind.order { background: color-mix(in srgb, var(--orange) 26%, transparent); color: var(--text-primary); }
.kind.missing { background: color-mix(in srgb, var(--color-info) 22%, transparent); color: var(--text-primary); }
.kind.mixed { background: color-mix(in srgb, #a78bfa 26%, transparent); color: var(--text-primary); }
.why { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.ev { font-size: 12px; color: var(--text-secondary); }
.ev summary { cursor: pointer; color: var(--text-tertiary); }
.ev ul { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ev li { display: flex; gap: 6px; line-height: 1.45; }
.ev time { flex: none; color: var(--text-tertiary); white-space: nowrap; }
.ev q { quotes: '“' '”'; overflow-wrap: anywhere; }
.fixl { margin: 0; font-size: 12.5px; line-height: 1.5; }
.fixl.nofix { color: var(--text-secondary); }
.ibtns { display: flex; justify-content: flex-end; align-items: center; gap: 6px; flex-wrap: wrap; }
.mine label { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-secondary); min-width: 0; }
.mine select, .mine input, .mine textarea { width: 100%; min-height: 34px; padding: 6px 9px; border-radius: 10px; border: 1px solid var(--hairline); background: var(--field-bg); color: var(--text-primary); font-size: 13px; }
.mine textarea { resize: vertical; line-height: 1.45; }
.two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
.corr li { padding: 9px 11px; border-radius: 12px; background: var(--field-bg); display: flex; flex-direction: column; gap: 3px; }
.corr li b { font-size: 13px; font-weight: 500; line-height: 1.45; overflow-wrap: anywhere; }
.corr li small { font-size: 11.5px; color: var(--text-tertiary); }
.corr li[data-source='ai'] { border-left: 3px solid var(--green); }
.corr .lnk { align-self: flex-end; margin: 0; }

/* ② */
.ccount { gap: 4px; }
.ccount li { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 10px; background: var(--field-bg); font-size: 13px; }
.ccount li span { flex: 1; }
.ccount li b { font-variant-numeric: tabular-nums; }
.caution { color: var(--text-tertiary); }
.mapbox.big { min-height: 320px; }
.crow { padding: 10px 12px; border-radius: 14px; background: var(--field-bg); border-left: 3px solid var(--hairline); display: flex; flex-direction: column; gap: 6px; }
.crow.c-gate { border-left-color: var(--orange); border-left-width: 5px; }
.crow.c-human { border-left-color: var(--orange); }
.crow.c-ai { border-left-color: var(--green); }
.crow.c-drop { border-left-color: var(--text-tertiary); }
.crow.c-skipped { border-left-style: dashed; border-left-color: var(--orange); }
.crow.on { box-shadow: inset 0 0 0 1.5px var(--text-secondary); }
.chead { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; flex-wrap: wrap; }
.chead b { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.crow.c-drop .chead b { text-decoration: line-through; text-decoration-color: var(--text-secondary); }
.chead small { flex: 1; font-size: 12px; color: var(--text-tertiary); }
.cwhy { margin: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.badge { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.cwhy small { font-size: 11.5px; color: var(--text-tertiary); }
.cbtns { display: flex; flex-wrap: wrap; gap: 4px; }
.cb { height: 28px; padding: 0 10px 0 7px; border-radius: 9999px; display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-secondary); background: var(--button-bg); white-space: nowrap; }
.cb .sw { width: 14px; height: 10px; border-radius: 3px; }
.cb:not(:disabled):hover { color: var(--text-primary); }
.cb.sug { box-shadow: inset 0 0 0 1.5px var(--text-tertiary); color: var(--text-primary); }
.cb.on { background: var(--ink); color: var(--ink-inverse); }

/* 가운데 폭: 지도를 위에 넓게, 아래에 AI 제안 · 정하기 — 창 전체가 한 번에 스크롤 */
@media (max-width: 1179px) {
  .body { display: block; overflow-y: auto; scrollbar-width: thin; }
  .body > * + * { margin-top: 10px; }
  .grid, .maps { grid-template-rows: none; }
  .grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: 'look look' 'ai decide'; align-items: start; }
  .area, .area.look { overflow: visible; }
  .mapbox { flex: none; height: 440px; }
  .mapbox.big { height: 480px; }
}
/* 폰: 한 줄로 — AI 제안 → 살펴보기(지도는 위아래로) → 정하기 */
@media (max-width: 760px) {
  .top { flex-wrap: wrap; gap: 6px 12px; padding: 12px 16px 4px; }
  .tt { flex: 1; }
  .tt b { font-size: 18px; }
  .lead { order: 3; flex-basis: 100%; font-size: 12px; }
  .steps { padding: 6px 16px 8px; }
  .top-err { padding: 0 16px 6px; }
  .body { padding: 0 12px 28px; }
  .q span { display: block; margin: 2px 0 0; }
  .grid { grid-template-columns: minmax(0, 1fr); grid-template-areas: 'ai' 'look' 'decide'; }
  .area { padding: 12px; }
  .maps { grid-template-columns: minmax(0, 1fr); }
  .mapbox { height: 380px; }
  .mapbox.big { height: 420px; }
  .legend .hint { display: none; }
}
</style>
