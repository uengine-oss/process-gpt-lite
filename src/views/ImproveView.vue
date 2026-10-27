<script setup>
// 프로세스 개선 — 진단 → 가치 흐름 → 병목(제약) → 에이전트·자동화 → 재설계 (AX 컨설팅의 흐름을 화면 하나로)
//   /improve           실행 기록이 있는 프로세스 목록
//   /improve/:defId    병목 · 가치 흐름 · 제약 · 크리티컬 패스 · 개선 실행 (?tab=)
// 숫자는 모두 서버의 결정적 계산(lib/improve) — 이 화면은 보여 주고, what-if 를 다시 계산하게 하고, 적용을 확인받는다.
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import Icon from '../components/Icon.vue'
import HeatBpmn from '../components/improve/HeatBpmn.vue'
import LeadBar from '../components/improve/LeadBar.vue'
import CpmGantt from '../components/improve/CpmGantt.vue'
import VsmMap from '../components/improve/VsmMap.vue'
import { dur, pct, won, day, SEG, METRICS, CHANGE_LABEL } from '../components/improve/fmt.js'
import { useApp } from '../stores/app.js'
import { api } from '../api.js'

const app = useApp()
const route = useRoute()
const router = useRouter()
const defId = computed(() => route.params.defId || '')
const TABS = [['bottleneck', '병목'], ['value', '가치 흐름'], ['constraint', '제약'], ['path', '크리티컬 패스'], ['improve', '개선 실행']]
const tab = computed(() => route.query.tab || 'bottleneck')
const go = (t) => router.replace({ query: { ...route.query, tab: t } })

const list = ref([])
const o = ref(null)
const err = ref('')
const loading = ref(false)
const version = ref('')
const basis = ref('median')
const metric = ref('bottleneck')

async function load() {
  err.value = ''
  loading.value = true
  try {
    if (!defId.value) { list.value = await api('/improve'); o.value = null; return }
    const v = version.value || route.query.version || ''
    o.value = await api(`/improve/${encodeURIComponent(defId.value)}${v ? `?version=${encodeURIComponent(v)}` : ''}`)
    version.value = o.value.version
    if (tab.value === 'improve') loadCompare()
  } catch (e) { err.value = e.message } finally { loading.value = false }
}
watch(defId, () => { version.value = ''; changes.value = []; wi.value = null; prof.value = null; load() })
watch(version, (v, old) => { if (old && v !== old) load() })
watch(tab, (t) => { if (t === 'improve' && o.value && !cmp.value) loadCompare() })
onMounted(async () => {
  app.mode = 'improve'
  if (!app.me) app.me = await api('/me').catch(() => null)
  load()
})

const stepName = computed(() => Object.fromEntries((o.value?.steps || []).map((s) => [s.id, s.name])))
const c = computed(() => o.value?.toc?.constraint || null)

// ---------- 병목 ----------
const heat = computed(() => {
  const m = METRICS[metric.value]
  const steps = (o.value?.steps || []).filter((s) => s.frequency)
  const max = Math.max(...steps.map((s) => m.value(s) || 0), 0) || 1
  return Object.fromEntries(steps.map((s) => [s.id, { v: (m.value(s) || 0) / max, label: m.show(s) }]))
})
const stepRows = computed(() => (o.value?.steps || []).filter((s) => s.frequency))
const segTotals = (s) => ({ queue_wait: s.sums.queue_wait, review_wait: s.sums.review_wait, human_work: s.sums.human_work, agent_work: s.sums.agent_work, rework: s.sums.rework, idle_gap: s.sums.idle_gap })
const prof = ref(null)
async function openInstance(id) {
  prof.value = { loading: true, id }
  try { prof.value = await api(`/improve/${encodeURIComponent(defId.value)}/instances/${encodeURIComponent(id)}`) } catch (e) { prof.value = { error: e.message } }
}
const wf = computed(() => {
  const p = prof.value
  if (!p?.steps) return null
  const t0 = p.start, t1 = Math.max(...p.steps.map((x) => x.finish || Date.now()), p.end || 0)
  const span = Math.max(t1 - t0, 1)
  return { span, rows: p.steps.map((x) => ({ ...x, segs: x.segments.map((g) => ({ ...g, l: ((g.start - t0) / span) * 100, w: Math.max(0.3, ((g.end - g.start) / span) * 100), color: SEG.find((k) => k.key === g.type)?.color })) })) }
})

// ---------- 크리티컬 패스 ----------
const cp = computed(() => o.value?.cpm?.[basis.value])
const critical = computed(() => ({ nodes: cp.value?.criticalNodes || [], edges: cp.value?.criticalEdges || [] }))
const badges = computed(() => Object.fromEntries((cp.value?.rows || []).filter((r) => !r.loop).map((r) => [r.id, r.critical ? dur(r.d, { short: true }) : `여유 ${dur(r.slack, { short: true })}`])))

// ---------- 개선 실행 (what-if) ----------
const changes = ref([])
const draft = ref({ type: 'predraft', step: '', saving: 50, field: '', threshold: null, add: 1, factor: 50 })
const wi = ref(null)
const wiBusy = ref(false)
const wiErr = ref('')
const humanSteps = computed(() => stepRows.value.filter((s) => s.kind === 'human' && (s.medianWork || 0) > 60))
watch(o, (v) => {
  if (!v) return
  const st = v.toc?.step || humanSteps.value[0]?.id || ''
  draft.value.step ||= st
  if (v.suggestedThreshold) { draft.value.field ||= v.suggestedThreshold.field; draft.value.threshold ??= v.suggestedThreshold.threshold }
  else if (v.numeric?.length) { draft.value.field ||= v.numeric.at(-1).field; draft.value.threshold ??= Math.round(v.numeric.at(-1).median) }
})
function toChange(d) {
  const x = { type: d.type, step: d.step }
  if (d.type === 'predraft') x.saving = d.saving / 100
  if (d.type === 'skip') { x.field = d.field; x.threshold = Number(d.threshold); x.label = o.value.numeric.find((f) => f.field === d.field)?.label }
  if (d.type === 'capacity') x.add = Number(d.add) || 1
  if (d.type === 'rework') x.factor = 1 - d.factor / 100
  return x
}
function addChange() {
  const x = toChange(draft.value)
  changes.value = [...changes.value.filter((y) => !(y.type === x.type && y.step === x.step)), x]
}
function useAction(a) {
  for (const x of a.changes || []) changes.value = [...changes.value.filter((y) => !(y.type === x.type && y.step === x.step)), { ...x }]
  go('improve')
}
const removeChange = (i) => { changes.value = changes.value.filter((_, k) => k !== i) }
let timer
watch(changes, () => { clearTimeout(timer); timer = setTimeout(runWhatIf, 150) }, { deep: true })
watch(basis, () => { if (changes.value.length) runWhatIf() })
async function runWhatIf() {
  wiErr.value = ''
  if (!changes.value.length) { wi.value = null; return }
  wiBusy.value = true
  try { wi.value = await api(`/improve/${encodeURIComponent(defId.value)}/whatif`, { method: 'POST', body: { changes: changes.value, version: version.value, basis: basis.value } }) }
  catch (e) { wiErr.value = e.message } finally { wiBusy.value = false }
}
const changeText = (x) => {
  const n = stepName.value[x.step] || x.step
  if (x.type === 'predraft') return `${n} · 에이전트 사전 초안 (작업 ${Math.round(x.saving * 100)}% 절감 가정)`
  if (x.type === 'skip') return `${n} · ${x.label || x.field} ${won(x.threshold)} 미만이면 건너뛰기`
  if (x.type === 'capacity') return `${n} · 담당 ${x.add}명 추가`
  if (x.type === 'rework') return `${n} · 보완 요청 ${Math.round((1 - x.factor) * 100)}% 줄이기`
  return `${n} · ${CHANGE_LABEL[x.type]}`
}
const stepDelta = computed(() => {
  if (!wi.value) return []
  const b = wi.value.before.steps, a = wi.value.after.steps
  return Object.keys(a).filter((id) => b[id] || a[id]).map((id) => ({ id, name: wi.value.names[id] || stepName.value[id] || id, b: b[id], a: a[id] }))
    .filter((r) => (r.b?.dur || 0) + (r.a?.dur || 0) > 0)
})
const definitionChange = computed(() => changes.value.some((x) => !['capacity', 'rework'].includes(x.type)))
const nextVersion = computed(() => `${Math.max(0, ...(o.value?.versions || []).map((v) => parseInt(v.version, 10) || 0)) + 1}.0`)
const applyOpen = ref(false)
const applying = ref(false)
const applied = ref(null)
async function apply() {
  applying.value = true
  wiErr.value = ''
  try {
    applied.value = await api(`/improve/${encodeURIComponent(defId.value)}/apply`, { method: 'POST', body: { changes: changes.value, confirm: true, basis: basis.value } })
    applyOpen.value = false
    // applied: the list starts over on the new version (the result stays in the banner and the comparison)
    changes.value = []
    await load()
    await loadCompare()
  } catch (e) { wiErr.value = e.message } finally { applying.value = false }
}
const cmp = ref(null)
async function loadCompare() { try { cmp.value = await api(`/improve/${encodeURIComponent(defId.value)}/compare`) } catch { cmp.value = null } }
const cmpSteps = computed(() => {
  const vs = (cmp.value?.versions || []).filter((v) => v.instances)
  const ids = [...new Set(vs.flatMap((v) => v.steps.map((s) => s.id)))]
  return ids.map((id) => ({ id, name: vs.flatMap((v) => v.steps).find((s) => s.id === id)?.name || id, by: Object.fromEntries(vs.map((v) => [v.version, v.steps.find((s) => s.id === id)])) }))
})
const stageIcon = { identify: '1', exploit: '2', subordinate: '3', elevate: '4', repeat: '5' }
</script>

<template>
  <div class="improve">
    <TopBar />
    <div class="content scroll">
      <div class="iv">
        <!-- 목록 -->
        <template v-if="!defId">
          <div class="head">
            <h1>프로세스 개선</h1>
            <span class="sub">실행 기록으로 병목·가치 흐름·제약·크리티컬 패스를 찾고, 개선안을 미리 계산해 새 버전으로 바꿔요.</span>
          </div>
          <p v-if="err" class="err">{{ err }}</p>
          <p v-else-if="!loading && !list.length" class="first glass">아직 분석할 실행 기록이 있는 프로세스가 없어요. 프로세스를 몇 번 끝까지 돌리면 여기에 나와요.</p>
          <button v-for="x in list" :key="x.id" class="row glass press" @click="router.push(`/improve/${encodeURIComponent(x.id)}`)">
            <b>{{ x.name }}</b>
            <small>완료 {{ x.completed }}건 · 전체 {{ x.instances }}건</small>
            <span v-if="x.step_name" class="cst">제약 {{ x.step_name }} · {{ x.resource_name }} {{ pct(x.rho) }}</span>
            <span v-else class="cst none">제약 아직 없음</span>
            <Icon name="chevron" :size="16" />
          </button>
        </template>

        <template v-else>
          <button class="back press" @click="router.push('/improve')"><Icon name="back" :size="16" /> 프로세스 개선</button>
          <p v-if="err" class="err">{{ err }}</p>
          <template v-if="o">
            <div class="hero">
              <h1 class="serif">{{ o.def.name }}</h1>
              <p class="desc">{{ o.def.description }}</p>
              <div class="stats">
                <span>완료 <b>{{ o.counts.completed }}</b>건<template v-if="o.counts.running"> · 진행 중 <b>{{ o.counts.running }}</b>건</template></span>
                <span>리드타임 중앙값 <b>{{ dur(o.observed.leadMedian) }}</b> <small>p80 {{ dur(o.observed.leadP80) }}</small></span>
                <span>흐름 효율 <b>{{ pct(o.vsm.flowEfficiency, 1) }}</b></span>
                <span v-if="o.counts.completed < 10" class="vtag low">완료 {{ o.counts.completed }}건 — 표본이 적어 숫자는 참고만</span>
                <span v-else-if="c" class="cpill">제약 · {{ c.steps[0] }}({{ c.name }}) 가동률 {{ pct(c.rho) }}</span>
                <span class="sp" />
                <label v-if="o.versions.length > 1" class="vsel">버전
                  <select v-model="version">
                    <option value="all">전체</option>
                    <option v-for="v in o.versions" :key="v.version" :value="v.version">v{{ v.version }} · 완료 {{ v.completed }}건</option>
                  </select>
                </label>
                <span v-else class="vtag">v{{ o.version }}</span>
              </div>
            </div>

            <nav class="tabs glass-thin">
              <button v-for="[k, l] in TABS" :key="k" :class="{ on: tab === k }" @click="go(k)">{{ l }}</button>
            </nav>

            <!-- 병목 -->
            <section v-if="tab === 'bottleneck'">
              <div class="card glass">
                <div class="ch">어디서 시간이 새는가 <small>단계마다 {{ METRICS[metric].label }} — 빨갈수록 큼</small>
                  <span class="seg">
                    <button v-for="(m, k) in METRICS" :key="k" :class="{ on: metric === k }" @click="metric = k">{{ m.label }}</button>
                  </span>
                </div>
                <HeatBpmn :def-id="defId" :version="version" mode="heat" :heat="heat" :height="330" />
                <p class="formula"><b>{{ METRICS[metric].label }}</b> = {{ METRICS[metric].formula }}</p>
              </div>

              <div class="card glass">
                <div class="ch">단계별 리드타임 분해 <small>도달 → 착수 → 끝, 상태 전이 이력과 이벤트로 나눈 시간</small></div>
                <div class="tbl">
                  <div class="tr th"><span>단계</span><span>담당</span><span>실행</span><span>소요 중앙값 · p80</span><span>어디에 쓰였나 (합계)</span><span>재작업률</span><span>병목 점수</span></div>
                  <div v-for="s in stepRows" :key="s.id" class="tr" :class="{ hot: c && c.stepIds.includes(s.id) }">
                    <span><b>{{ s.name }}</b></span>
                    <span class="who"><i :class="s.kind">{{ s.kind === 'agent' ? '에이전트' : '사람' }}</i>{{ s.people.map((p) => p.name).join(', ') || s.role }}</span>
                    <span class="num">{{ s.frequency }}</span>
                    <span class="num">{{ dur(s.medianDuration) }} · {{ dur(s.p80Duration) }}</span>
                    <span><LeadBar :totals="segTotals(s)" /></span>
                    <span class="num">{{ s.reworkRate.toFixed(1) }}%</span>
                    <span class="num"><b>{{ Math.round(s.normalizedBottleneck) }}%</b></span>
                  </div>
                </div>
                <div class="legend"><span v-for="g in SEG" :key="g.key"><i :style="{ background: g.color }" />{{ g.label }}</span></div>
              </div>

              <div class="card glass">
                <div class="ch">인스턴스별 프로파일 <small>한 건을 누르면 그 건의 시간이 어디에 쓰였는지</small></div>
                <div class="insts">
                  <button v-for="i in o.instances.slice(0, 14)" :key="i.id" class="inst press" :class="{ on: prof?.id === i.id }" @click="openInstance(i.id)">
                    <span class="iname">{{ i.name.replace(`${o.def.name} · `, '') }}</span>
                    <small>{{ i.status === 'COMPLETED' ? dur(i.leadSec) : `진행 중 ${dur(i.elapsedSec)}` }}</small>
                    <LeadBar :totals="i.totals" :height="6" />
                  </button>
                </div>
                <div v-if="prof && !prof.loading && !prof.error" class="prof">
                  <div class="ph"><b>{{ prof.name }}</b><small>{{ day(prof.start) }} 시작 · {{ prof.status === 'COMPLETED' ? `리드타임 ${dur(prof.leadSec)}` : `진행 중 ${dur(prof.elapsedSec)}` }} · 흐름 효율 {{ pct(prof.flowEff, 1) }}</small></div>
                  <LeadBar :totals="prof.totals" :height="14" legend />
                  <div class="wf">
                    <div v-for="x in wf.rows" :key="x.todoId" class="wr">
                      <span class="wn">{{ x.name }}<small v-if="x.seq"> ({{ x.seq + 1 }}회차)</small></span>
                      <span class="wt"><i v-for="(g, k) in x.segs" :key="k" :style="{ left: g.l + '%', width: g.w + '%', background: g.color }" :title="`${g.type}`" /></span>
                      <span class="wd">{{ dur(x.duration) }}</span>
                    </div>
                  </div>
                  <div v-if="prof.remaining" class="remain">
                    <b>남은 크리티컬 패스</b> {{ prof.remaining.path.map((id) => prof.remaining.names[id]).join(' → ') }} · 앞으로 약 {{ dur(prof.remaining.remainingSec) }}, 예상 완료 {{ day(prof.remaining.expectedEnd) }}
                  </div>
                </div>
                <p v-else-if="prof?.error" class="err">{{ prof.error }}</p>
              </div>
            </section>

            <!-- 가치 흐름 -->
            <section v-if="tab === 'value'">
              <div class="card glass">
                <div class="ch">가치 흐름 지도 <small>단계마다 실제로 일한 시간과 기다린 시간 (완료 {{ o.vsm.instances }}건 평균)</small></div>
                <VsmMap :vsm="o.vsm" :path="o.cpm.median.path" />
              </div>
              <div class="note glass">
                <b>흐름 효율 {{ pct(o.vsm.flowEfficiency, 1) }}</b> — 한 건이 들어와 끝나기까지 걸린 시간 100시간 중 실제로 누군가 일한 시간은 {{ (o.vsm.flowEfficiency * 100).toFixed(1) }}시간이고, 나머지는 기다린 시간이에요.
                <template v-if="c"> 가장 오래 기다리는 곳은 <b>{{ c.steps[0] }}</b> 앞(리드타임의 {{ pct(c.waitShare) }})이고, 그 기다림의 {{ pct(c.behindShare) }}는 앞 건이 끝나기를 기다린 시간(차례), 나머지는 담당자가 이 일을 하는 시간을 기다린 것이에요.</template>
              </div>
            </section>

            <!-- 제약 -->
            <section v-if="tab === 'constraint'">
              <div class="card glass">
                <div class="ch">사람·에이전트별 수요와 처리 능력 <small>처리 능력 = 일이 쌓인 날 실제로 쓴 시간 ÷ 건당 작업 시간</small></div>
                <div class="tbl res">
                  <div class="tr th"><span>담당</span><span>맡은 단계</span><span>도착/일</span><span>처리 능력/일</span><span>가동률</span><span>대기 건수 (전 → 최근 2주)</span><span>리드타임 중 대기</span></div>
                  <div v-for="r in o.toc.resources" :key="r.key" class="tr" :class="{ hot: c && r.key === c.key }">
                    <span class="who"><i :class="r.kind">{{ r.kind === 'agent' ? '에이전트' : '사람' }}</i><b>{{ r.name }}</b></span>
                    <span>{{ r.steps.join(', ') }}</span>
                    <span class="num">{{ r.lambdaPerDay.toFixed(2) }}</span>
                    <span class="num">{{ r.muPerDay ? r.muPerDay.toFixed(2) : '여유' }}</span>
                    <span><span class="ubar"><i :style="{ width: Math.min(100, r.rho * 100) + '%' }" :class="{ high: r.rho >= 0.8 }" /></span> <b class="num">{{ r.muPerDay ? pct(r.rho) : '–' }}</b></span>
                    <span class="num">{{ r.wipBefore.toFixed(1) }} → <b :class="{ up: r.growing }">{{ r.wipRecent.toFixed(1) }}</b><small v-if="r.growing"> 늘어남</small></span>
                    <span class="num">{{ pct(r.waitShare) }}</span>
                  </div>
                </div>
              </div>
              <div class="focus">
                <div v-for="s in o.toc.focus" :key="s.stage" class="fs glass" :class="s.stage">
                  <div class="fh"><span class="fno">{{ stageIcon[s.stage] }}</span><b>{{ s.title.replace(/^\d\.\s*/, '') }}</b></div>
                  <p v-if="s.text" class="ft">{{ s.text }}</p>
                  <div v-for="(a, k) in s.actions || []" :key="k" class="fa">
                    <b>{{ a.title }}</b>
                    <p>{{ a.text }}</p>
                    <div v-if="a.after" class="fx">
                      <span>리드타임 <b>{{ dur(a.before.leadSec) }} → {{ dur(a.after.leadSec) }}</b></span>
                      <span>흐름 효율 <b>{{ pct(a.before.flowEfficiency, 1) }} → {{ pct(a.after.flowEfficiency, 1) }}</b></span>
                      <span v-if="a.after.rho != null">가동률 <b>{{ pct(a.before.rho) }} → {{ pct(a.after.rho) }}</b></span>
                      <button v-if="a.changes?.length" class="mini press" @click="useAction(a)">개선 실행에서 보기 →</button>
                    </div>
                  </div>
                  <div v-if="s.best" class="fx"><button class="mini press" @click="useAction(s.best)">이 안으로 개선 실행 →</button></div>
                </div>
              </div>
            </section>

            <!-- 크리티컬 패스 -->
            <section v-if="tab === 'path'">
              <div class="card glass">
                <div class="ch">전체 기간을 정하는 경로 <small>잰 단계 시간(대기 포함)으로 계산 · 대표 경로 확률 {{ pct(cp.pathProb) }}</small>
                  <span class="seg"><button :class="{ on: basis === 'median' }" @click="basis = 'median'">보통(중앙값)</button><button :class="{ on: basis === 'p80' }" @click="basis = 'p80'">늦을 때(p80)</button></span>
                </div>
                <div class="cpsum">
                  <span>기대 리드타임 <b>{{ dur(cp.expectedSec) }}</b></span>
                  <span>실측 {{ basis === 'p80' ? 'p80' : '중앙값' }} <b>{{ dur(basis === 'p80' ? o.observed.leadP80 : o.observed.leadMedian) }}</b></span>
                  <span class="cpp">{{ cp.path.map((id) => stepName[id]).join(' → ') }}</span>
                </div>
                <HeatBpmn :def-id="defId" :version="version" mode="path" :critical="critical" :badges="badges" :height="300" />
              </div>
              <div class="card glass">
                <div class="ch">간트 <small>빗금 = 기다린 시간, 진한 막대 = 작업, 점선 = 여유 시간(늦어져도 전체가 늦지 않는 만큼)</small></div>
                <CpmGantt :rows="cp.rows" :total="cp.mainSec" />
                <div class="tbl cpm">
                  <div class="tr th"><span>단계</span><span>가장 이른 시작 ES</span><span>가장 이른 끝 EF</span><span>가장 늦은 시작 LS</span><span>가장 늦은 끝 LF</span><span>여유</span><span>크리티컬 확률</span></div>
                  <div v-for="r in cp.rows" :key="r.id + r.name" class="tr" :class="{ hot: r.critical }">
                    <span><b>{{ r.name }}</b></span><span class="num">{{ dur(r.es) }}</span><span class="num">{{ dur(r.ef) }}</span><span class="num">{{ dur(r.ls) }}</span><span class="num">{{ dur(r.lf) }}</span>
                    <span class="num">{{ r.critical ? '0 (크리티컬)' : dur(r.slack) }}</span><span class="num">{{ pct(r.criticality) }}</span>
                  </div>
                </div>
                <p v-if="cp.loops.length" class="formula">보완 요청 루프: {{ cp.loops.map((l) => `${pct(l.share)}가 되돌아가 평균 ${l.passes.toFixed(2)}번 더 거침 → 기대 ${dur(l.extra)}`).join(' · ') }}</p>
              </div>
              <div v-if="o.running.length" class="card glass">
                <div class="ch">진행 중인 건의 남은 크리티컬 패스</div>
                <div v-for="r in o.running" :key="r.id" class="run">
                  <b>{{ r.name }}</b><small>{{ dur(r.elapsedSec) }} 지남 · 앞으로 약 {{ dur(r.remainingSec) }} · 예상 완료 {{ day(r.expectedEnd) }}</small>
                  <span class="cpp">{{ r.path.map((id) => stepName[id]).join(' → ') }}</span>
                </div>
              </div>
            </section>

            <!-- 개선 실행 -->
            <section v-if="tab === 'improve'">
              <div class="card glass">
                <div class="ch">바꿔 보기 <small>단계를 바꾸면 리드타임·크리티컬 패스·흐름 효율을 바로 다시 계산해요</small></div>
                <div class="builder">
                  <select v-model="draft.type" aria-label="개선 종류">
                    <option v-for="(l, k) in CHANGE_LABEL" :key="k" :value="k">{{ l }}</option>
                  </select>
                  <select v-model="draft.step" aria-label="단계">
                    <option v-for="s in stepRows" :key="s.id" :value="s.id">{{ s.name }}</option>
                  </select>
                  <label v-if="draft.type === 'predraft'">작업 절감 <input v-model.number="draft.saving" type="number" min="10" max="90" step="10" />%</label>
                  <template v-if="draft.type === 'skip'">
                    <select v-model="draft.field" aria-label="기준 항목"><option v-for="f in o.numeric" :key="f.field" :value="f.field">{{ f.label }}</option></select>
                    <label><input v-model.number="draft.threshold" type="number" step="1000000" class="wide" /> 미만이면</label>
                  </template>
                  <label v-if="draft.type === 'capacity'">+ <input v-model.number="draft.add" type="number" min="1" max="5" />명</label>
                  <label v-if="draft.type === 'rework'">보완 요청 <input v-model.number="draft.factor" type="number" min="10" max="90" step="10" />% 줄이기</label>
                  <button class="add press" @click="addChange">담기</button>
                </div>
                <div class="presets">
                  <span>제약 이론 5단계에서:</span>
                  <template v-for="s in o.toc.focus" :key="s.stage">
                    <button v-for="(a, k) in (s.actions || []).filter((x) => x.changes?.length)" :key="s.stage + k" class="chip press" @click="useAction(a)">{{ a.title }}</button>
                  </template>
                </div>
                <div v-if="changes.length" class="chips">
                  <span v-for="(x, i) in changes" :key="i" class="cchip">{{ changeText(x) }}<button aria-label="빼기" @click="removeChange(i)">×</button></span>
                </div>
                <p v-else class="muted">위에서 고르거나 제약 이론 5단계의 안을 담아 보세요.</p>
              </div>

              <template v-if="wi">
                <div class="kpis">
                  <div class="kpi glass"><span>기대 리드타임</span><b>{{ dur(wi.before.leadSec) }} → {{ dur(wi.after.leadSec) }}</b><small :class="{ good: wi.after.leadSec < wi.before.leadSec }">{{ wi.after.leadSec < wi.before.leadSec ? `${pct(1 - wi.after.leadSec / wi.before.leadSec)} 짧아짐` : '그대로' }}</small></div>
                  <div class="kpi glass"><span>흐름 효율</span><b>{{ pct(wi.before.flowEfficiency, 1) }} → {{ pct(wi.after.flowEfficiency, 1) }}</b><small>작업 합 {{ dur(wi.before.workSec) }} → {{ dur(wi.after.workSec) }}</small></div>
                  <div class="kpi glass"><span>제약 가동률</span><b>{{ wi.before.constraint ? `${wi.before.constraint.name} ${pct(wi.before.constraint.rho)}` : '–' }} → {{ wi.after.constraint ? `${wi.after.constraint.name} ${pct(wi.after.constraint.rho)}` : '–' }}</b><small>{{ wi.after.constraint && wi.before.constraint && wi.after.constraint.key !== wi.before.constraint.key ? '제약이 옮겨 가요' : '' }}</small></div>
                </div>
                <div class="card glass">
                  <div class="ch">크리티컬 패스 전 → 후</div>
                  <p class="cpp">전: {{ wi.before.pathNames.join(' → ') }}</p>
                  <p class="cpp after">후: {{ wi.after.pathNames.join(' → ') }}</p>
                  <div class="tbl wi">
                    <div class="tr th"><span>단계</span><span>대기</span><span>작업</span><span>단계 시간</span><span>거치는 비율</span></div>
                    <div v-for="r in stepDelta" :key="r.id" class="tr" :class="{ hot: r.a?.critical }">
                      <span><b>{{ r.name }}</b></span>
                      <span class="num">{{ dur(r.b?.wait) }} → <b>{{ dur(r.a?.wait) }}</b></span>
                      <span class="num">{{ dur(r.b?.work) }} → <b>{{ dur(r.a?.work) }}</b></span>
                      <span class="num">{{ dur(r.b?.dur) }} → <b>{{ dur(r.a?.dur) }}</b></span>
                      <span class="num">{{ pct(r.b?.p ?? 0) }} → <b>{{ pct(r.a?.p ?? 0) }}</b></span>
                    </div>
                  </div>
                  <p v-for="n in wi.notes" :key="n" class="formula">{{ n }}</p>
                  <p v-for="(s, k) in wi.skip" :key="k" class="formula">기준 미만 비율은 지난 기록 {{ s.n }}건 중 {{ s.under }}건({{ pct(s.share) }}). 그 건들의 보완 요청률 {{ pct(s.reworkUnder) }}, 기준 이상은 {{ pct(s.reworkOver) }}.</p>
                </div>
                <div class="decide glass">
                  <div class="dt">
                    <b>{{ definitionChange ? `이 개선안으로 새 버전 v${nextVersion}을 만들까요?` : '고른 안은 프로세스 정의를 바꾸지 않아요' }}</b>
                    <small>{{ definitionChange ? '적용하면 BPMN·단계 설정이 바뀐 새 버전이 저장되고 새로 시작하는 건부터 새 버전으로 돌아요. 이미 진행 중인 건도 엔진이 다음 단계부터 새 정의를 따를 수 있어요(비교는 시작한 때의 버전으로 묶어요).' : '인원 추가는 설정 → 팀·역할에서, 보완 줄이기는 앞 단계 지시를 고쳐서 해요.' }}</small>
                  </div>
                  <button v-if="o.canApply" class="go press" :disabled="!definitionChange || applying" @click="applyOpen = true">개선안 적용</button>
                  <small v-else class="muted">적용은 프로세스 담당자·관리자만 할 수 있어요.</small>
                </div>
              </template>
              <p v-if="wiBusy" class="muted">다시 계산하는 중…</p>
              <p v-if="wiErr" class="err">{{ wiErr }}</p>
              <div v-if="applied" class="ok glass">v{{ applied.version }} 저장됨 · {{ applied.message }}<template v-if="applied.notes?.length"> · {{ applied.notes.join(' ') }}</template></div>

              <div v-if="cmp" class="card glass">
                <div class="ch">버전별 전후 비교 <small>각 버전으로 돈 건만, 그 버전의 정의로 계산</small></div>
                <div class="tbl ver">
                  <div class="tr th"><span>버전</span><span>건수(완료)</span><span>리드타임 중앙값</span><span>평균 · p80</span><span>흐름 효율</span><span>제약</span></div>
                  <div v-for="v in cmp.versions" :key="v.version" class="tr">
                    <span><b>v{{ v.version }}</b><small class="vm">{{ v.message }}</small></span>
                    <span class="num">{{ v.instances }} ({{ v.completed ?? 0 }})<small v-if="v.lowSample && v.instances" class="low"> 표본 적음</small></span>
                    <span class="num">{{ dur(v.leadMedian) }}</span>
                    <span class="num">{{ dur(v.leadMean) }} · {{ dur(v.leadP80) }}</span>
                    <span class="num">{{ pct(v.flowEfficiency, 1) }}</span>
                    <span>{{ v.constraint && !v.lowSample ? `${v.constraint.step}(${v.constraint.name}) ${pct(v.constraint.rho)}` : '–' }}</span>
                  </div>
                </div>
                <div v-if="cmpSteps.length && cmp.versions.filter((v) => v.instances).length > 1" class="tbl ver steps" :style="{ '--n': cmp.versions.filter((v) => v.instances).length }">
                  <div class="tr th"><span>단계</span><span v-for="v in cmp.versions.filter((x) => x.instances)" :key="v.version">v{{ v.version }}: 거친 비율 · 소요 중앙값</span></div>
                  <div v-for="s in cmpSteps" :key="s.id" class="tr">
                    <span><b>{{ s.name }}</b></span>
                    <span v-for="v in cmp.versions.filter((x) => x.instances)" :key="v.version" class="num">{{ s.by[v.version] ? `${pct(s.by[v.version].probability)} · ${dur(s.by[v.version].medianDuration)}` : '–' }}</span>
                  </div>
                </div>
                <p v-for="r in cmp.runs" :key="r.id" class="formula">v{{ r.to_version }} 적용({{ day(r.applied_at) }}) 때 예측: 기대 리드타임 {{ dur(r.predicted?.before?.leadSec) }} → {{ dur(r.predicted?.after?.leadSec) }}, 흐름 효율 {{ pct(r.predicted?.before?.flowEfficiency, 1) }} → {{ pct(r.predicted?.after?.flowEfficiency, 1) }}</p>
              </div>
            </section>
          </template>
          <p v-else-if="loading" class="muted">기록을 읽고 계산하는 중…</p>
        </template>
      </div>
    </div>

    <div v-if="applyOpen" class="scrim" @click.self="applyOpen = false">
      <div class="dlg glass">
        <b class="serif">새 버전 v{{ nextVersion }}으로 적용할까요?</b>
        <ul><li v-for="(x, i) in changes" :key="i">{{ changeText(x) }}</li></ul>
        <p>예상: 기대 리드타임 {{ dur(wi?.before.leadSec) }} → {{ dur(wi?.after.leadSec) }}, 흐름 효율 {{ pct(wi?.before.flowEfficiency, 1) }} → {{ pct(wi?.after.flowEfficiency, 1) }}</p>
        <p class="muted">process-gpt 의 저장 경로로 정의·BPMN 을 저장하고 버전 기록을 남겨요. 바뀐 단계에는 개선 기록(PI Flag)이 붙어요.</p>
        <div class="dbtn"><button class="hold press" :disabled="applying" @click="applyOpen = false">취소</button><button class="go press" :disabled="applying" @click="apply">{{ applying ? '저장하는 중…' : '적용' }}</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.improve { position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.content.scroll { overflow-y: auto; }
.iv { max-width: 1160px; margin: 0 auto; padding: 0 24px 80px; }
.head { display: flex; align-items: baseline; gap: 14px; margin: 6px 0 18px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 30px; font-weight: 500; letter-spacing: -0.02em; }
.sub, .muted { color: var(--text-secondary); font-size: 14.5px; }
.first { border-radius: 22px; padding: 36px; text-align: center; color: var(--text-secondary); }
.row { width: 100%; display: grid; grid-template-columns: 1.2fr 1fr 1.4fr 20px; gap: 14px; align-items: center; text-align: left; padding: 16px 20px; border-radius: 20px; margin-bottom: 8px; }
.row small { color: var(--text-secondary); }
.cst { font-size: 13px; color: #e0613f; }
.cst.none { color: var(--text-tertiary); }
.back { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary); font-size: 14px; margin: 2px 0 10px; }
.hero h1 { font-size: 38px; margin: 2px 0 2px; }
.desc { margin: 0 0 10px; color: var(--text-secondary); font-size: 15px; }
.stats { display: flex; gap: 18px; flex-wrap: wrap; align-items: center; color: var(--text-secondary); font-size: 14px; }
.stats b { color: var(--text-primary); font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
.stats small { font-size: 12px; color: var(--text-tertiary); }
.cpill { background: #e0613f; color: #fff; padding: 4px 12px; border-radius: 9999px; font-size: 13px; font-weight: 500; }
.sp { flex: 1; }
.vsel select, .builder select, .builder input { height: 34px; border-radius: 10px; border: 1px solid var(--hairline); background: var(--field-bg); color: var(--text-primary); padding: 0 10px; font: inherit; font-size: 13.5px; }
.vtag { font-size: 12.5px; padding: 3px 10px; border-radius: 9999px; background: var(--chip-bg); }
.vtag.low { color: #e0613f; }
.tabs { position: sticky; top: 0; z-index: 3; display: flex; gap: 2px; padding: 3px; border-radius: 9999px; margin: 16px 0 14px; width: fit-content; }
.tabs button { height: 38px; padding: 0 18px; border-radius: 9999px; font-size: 14.5px; font-weight: 500; color: var(--text-secondary); }
.tabs button.on { background: var(--ink); color: var(--text-primary-on); }
section { display: flex; flex-direction: column; gap: 14px; animation: blur-in .4s var(--spring) both; }
.card { border-radius: 22px; padding: 16px 18px; }
.ch { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 16.5px; font-weight: 500; margin-bottom: 12px; }
.ch small { font-size: 12.5px; font-weight: 400; color: var(--text-tertiary); }
.seg { margin-left: auto; display: flex; gap: 2px; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg button { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 12.5px; color: var(--text-secondary); }
.seg button.on { background: var(--regular-solid-bg); color: var(--text-primary); box-shadow: 0 1px 4px rgba(0 0 0 / .12); }
.formula { margin: 10px 2px 0; font-size: 12.5px; color: var(--text-secondary); }
.tbl { display: flex; flex-direction: column; }
.tr { display: grid; grid-template-columns: 1.1fr 1.1fr .5fr 1fr 2fr .7fr .7fr; gap: 10px; padding: 9px 8px; align-items: center; font-size: 13.5px; border-top: 1px solid var(--hairline); }
.tr.th { border-top: 0; font-size: 12px; color: var(--text-tertiary); }
.tr.hot { background: color-mix(in srgb, #e0613f 9%, transparent); border-radius: 10px; }
.res .tr { grid-template-columns: 1fr 1.3fr .6fr .8fr 1.2fr 1.1fr .7fr; }
.cpm .tr { grid-template-columns: 1.3fr repeat(4, .8fr) .9fr .8fr; }
.wi .tr { grid-template-columns: 1.2fr 1fr 1fr 1fr .8fr; }
.ver .tr { grid-template-columns: 1.6fr .8fr .8fr 1fr .7fr 1.4fr; }
.ver.steps .tr { grid-template-columns: 1.2fr repeat(var(--n, 2), minmax(0, 1fr)); }
.tr > span { min-width: 0; }
.num { font-variant-numeric: tabular-nums; }
.who { display: flex; align-items: center; gap: 6px; }
.who i { font-style: normal; font-size: 11px; padding: 1px 6px; border-radius: 7px; background: var(--chip-bg); color: var(--text-secondary); }
.who i.agent { background: rgba(161 208 255 / .25); color: var(--color-info); }
.legend { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 12px; color: var(--text-secondary); }
.legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 5px; }
.insts { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.inst { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 9px 11px; border-radius: 14px; background: var(--field-bg); }
.inst.on { outline: 2px solid #e0613f; }
.iname { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.inst small { font-size: 11.5px; color: var(--text-secondary); }
.prof { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
.ph { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.ph small { color: var(--text-secondary); font-size: 13px; }
.wf { display: flex; flex-direction: column; gap: 4px; }
.wr { display: grid; grid-template-columns: 140px 1fr 70px; gap: 10px; align-items: center; font-size: 12.5px; }
.wn small { color: var(--text-tertiary); }
.wt { position: relative; height: 14px; border-radius: 4px; background: var(--field-bg); }
.wt i { position: absolute; top: 0; bottom: 0; border-radius: 2px; }
.wd { text-align: right; font-variant-numeric: tabular-nums; color: var(--text-secondary); }
.remain { font-size: 13.5px; padding: 10px 12px; border-radius: 12px; background: color-mix(in srgb, #e0613f 10%, transparent); }
.note { border-radius: 20px; padding: 14px 18px; font-size: 14.5px; line-height: 1.6; }
.ubar { display: inline-block; vertical-align: middle; width: 70px; height: 7px; border-radius: 4px; background: var(--field-bg); overflow: hidden; }
.ubar i { display: block; height: 100%; background: var(--text-tertiary); }
.ubar i.high { background: #e0613f; }
.up { color: #e0613f; }
.focus { display: grid; grid-template-columns: 1fr; gap: 10px; }
.fs { border-radius: 20px; padding: 14px 18px; }
.fs.identify { border: 1.5px solid #e0613f; }
.fh { display: flex; align-items: center; gap: 10px; font-size: 16px; }
.fno { width: 26px; height: 26px; border-radius: 13px; display: grid; place-items: center; background: #e0613f; color: #fff; font-size: 13px; font-weight: 600; }
.ft { margin: 8px 0 0 36px; font-size: 14px; line-height: 1.6; }
.fa { margin: 10px 0 0 36px; padding: 10px 14px; border-radius: 14px; background: var(--field-bg); }
.fa b { font-size: 14px; }
.fa p { margin: 4px 0 0; font-size: 13.5px; line-height: 1.55; color: var(--text-secondary); }
.fx { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
.fx b { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.mini { margin-left: auto; height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--ink); color: var(--text-primary-on); font-size: 12.5px; }
.cpsum { display: flex; gap: 18px; flex-wrap: wrap; align-items: baseline; margin-bottom: 10px; font-size: 14px; color: var(--text-secondary); }
.cpsum b { font-size: 19px; color: var(--text-primary); }
.cpp { font-size: 13.5px; color: #e0613f; font-weight: 500; margin: 2px 0; }
.cpp.after { color: var(--color-success); }
.run { display: flex; flex-direction: column; gap: 2px; padding: 8px 0; border-top: 1px solid var(--hairline); }
.run small { color: var(--text-secondary); }
.builder { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.builder label { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; color: var(--text-secondary); }
.builder input { width: 70px; }
.builder input.wide { width: 130px; }
.add { height: 34px; padding: 0 16px; border-radius: 9999px; background: var(--ink); color: var(--text-primary-on); font-size: 13.5px; }
.presets { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 12px; font-size: 12.5px; color: var(--text-tertiary); }
.chip { height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--field-bg); font-size: 12.5px; color: var(--text-primary); }
.chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.cchip { display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 6px 0 14px; border-radius: 9999px; background: color-mix(in srgb, #e0613f 16%, var(--field-bg)); font-size: 13px; }
.cchip button { width: 22px; height: 22px; border-radius: 11px; background: var(--chip-bg); }
.kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.kpi { border-radius: 20px; padding: 14px 18px; display: flex; flex-direction: column; gap: 4px; }
.kpi span { font-size: 12.5px; color: var(--text-secondary); }
.kpi b { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.kpi small { font-size: 12.5px; color: var(--text-tertiary); }
.kpi small.good { color: var(--color-success); }
.decide { border-radius: 24px; padding: 14px 14px 14px 22px; display: flex; align-items: center; gap: 12px; }
.dt { flex: 1; display: flex; flex-direction: column; gap: 3px; }
.dt small { color: var(--text-secondary); font-size: 13px; }
.go { height: 44px; padding: 0 22px; border-radius: 22px; font-size: 15.5px; background: var(--color-attention); color: #fff; font-weight: 500; }
.hold { height: 44px; padding: 0 22px; border-radius: 22px; font-size: 15.5px; background: var(--button-bg); }
.go:disabled { opacity: .5; }
.ok { border-radius: 16px; padding: 12px 16px; font-size: 14px; border: 1px solid var(--color-success); }
.vm { display: block; font-size: 11.5px; color: var(--text-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.low { color: #e0613f; }
.err { color: var(--color-error); }
.scrim { position: fixed; inset: 0; z-index: 70; background: rgba(5 7 13 / .45); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); display: grid; place-items: center; }
.dlg { width: min(520px, calc(100vw - 32px)); border-radius: 24px; padding: 22px 24px; display: flex; flex-direction: column; gap: 10px; background: var(--regular-solid-bg); }
.dlg b { font-size: 22px; }
.dlg ul { margin: 0; padding-left: 18px; font-size: 14.5px; line-height: 1.6; }
.dlg p { margin: 0; font-size: 14px; }
.dbtn { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
@media (max-width: 760px) {
  .tr, .res .tr, .cpm .tr, .wi .tr, .ver .tr { grid-template-columns: 1fr 1fr; }
  .tr.th { display: none; }
  .kpis { grid-template-columns: 1fr; }
  .row { grid-template-columns: 1fr; }
}
</style>
