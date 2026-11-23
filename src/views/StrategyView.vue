<script setup>
// 전략맵 (/strategy): the strategy graph the path optimizer scores against (server lib/strategy/graph.js) — objectives
// in the four BSC perspectives with their priority (→ weight), risk appetite per category, the policies they hold as
// must / should constraints, the KPI, and what links to them (features and process steps that contribute, policies
// that protect). Administrators change priority and risk appetite here; the last optimization is then scored again
// against the new graph (a preview — nothing written) so the effect on its ranking shows at once, and an undecided
// one can be re-run for real. The side also holds this demo's release plan (scenario 1 「금요일 출시」) and its request.
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'

const router = useRouter()
const loc = isEnglish ? 'en-US' : 'ko-KR'
const pick = (pair) => (Array.isArray(pair) ? pair[isEnglish ? 1 : 0] : pair)
const graph = ref(null)
const policies = ref({})
const admin = ref(false)
const last = ref(null)
const preview = ref(null)
const plan = ref(null)
const err = ref('')
const busy = ref('')

const LANES = [
  { id: 'financial', name: '재무', hint: '얻을 성과' },
  { id: 'customer', name: '고객', hint: '고객이 느끼는 것' },
  { id: 'process', name: '내부 프로세스', hint: '잘해야 할 일' },
  { id: 'learning', name: '학습·성장', hint: '키울 역량' },
]
const W = { 1: 1, 2: 0.7, 3: 0.45, 4: 0.25, 5: 0.1 }
const APP = ['low', 'medium', 'high']
const APP_TEXT = { low: '낮음', medium: '보통', high: '높음' }
const CAT = { privacy: '개인정보', security: '보안', quality: '품질', legal: '법률', cost: '비용' }
const DECISION = { allow: '허용', allow_audit: '기록', require_approval: '승인 필요', deny: '차단' }
const STATUS = { proposed: '선택 대기', chosen: '진행 중', executed: '실행함', stopped: '멈춤', escalated: '예외 판단 대기' }
const AUD = { public: '일반 공개', beta: '베타 그룹', internal: '사내 사용자' }
const DEP = { deployed: '배포됨(시연)', scheduled: '예약', planned: '계획', rolled_back: '되돌림' }

async function load() {
  err.value = ''
  try {
    const [g, p, o, r] = await Promise.all([api('/strategy'), api('/policies'), api('/release/optimizations?limit=1'), api('/release/plan').catch(() => null)])
    graph.value = g
    admin.value = !!p.admin
    policies.value = Object.fromEntries((p.policies || []).map((x) => [x.id, x.spec]))
    last.value = o.optimizations?.[0] || null
    plan.value = r
  } catch (e) { err.value = e.message }
}
onMounted(load)

const objectivesOf = (lane) => (graph.value?.objectives || []).filter((o) => o.perspective === lane)
const nameOf = (id) => graph.value?.objectives.find((o) => o.id === id)?.name || id
const linksOf = (o, rel) => (graph.value?.links || []).filter((l) => l.objective === o.id && l.relation === rel).sort((a, b) => b.weight - a.weight)
const sourceText = (s) => {
  const [kind, ...rest] = String(s).split(':')
  const v = rest.join(':')
  if (kind === 'feature') return { kind: '기능', text: v }
  if (kind === 'activity') return { kind: '단계', text: v.split('/').pop() }
  if (kind === 'policy') return { kind: '정책', text: pick(policies.value[v]?.title) || v }
  return { kind, text: v }
}
const STEP = { 'qa-review': 'QA 에이전트 검토', deploy: '배포', 'beta-feedback': '베타 피드백 수집' }
const stepName = (t) => STEP[t] || t
const policyTitle = (id) => pick(policies.value[id]?.title) || id
const kpiPct = (k) => (k && k.target ? Math.min(100, Math.round((Number(k.current || 0) / Number(k.target)) * 100)) : 0)

// change an objective (administrators): saved, then the last optimization is scored again as a preview
async function change(o, patch) {
  busy.value = o.id; err.value = ''
  try {
    graph.value = await api(`/strategy/objectives/${o.id}`, { method: 'PUT', body: { ...o, ...patch } })
    if (last.value) await again()
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const cycle = (o, cat) => change(o, { risk_appetite: { ...o.risk_appetite, [cat]: APP[(APP.indexOf(o.risk_appetite[cat]) + 1) % APP.length] } })

async function again() {
  if (!last.value) return
  busy.value = busy.value || 'preview'
  try { preview.value = await api(`/release/optimizations/${last.value.optimizationId}/rerun`, { method: 'POST', body: { preview: true } }) } catch (e) { err.value = e.message } finally { if (busy.value === 'preview') busy.value = '' }
}
async function apply() {
  busy.value = 'apply'; err.value = ''
  try {
    const o = await api(`/release/optimizations/${last.value.optimizationId}/rerun`, { method: 'POST', body: {} })
    last.value = o; preview.value = null
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}

// the ranking shown: the preview's when there is one, beside the optimization's own
const rows = computed(() => {
  if (!last.value) return []
  const pv = preview.value ? Object.fromEntries(preview.value.alternatives.map((a) => [a.id, a])) : null
  const list = last.value.alternatives.map((a) => ({ ...a, now: pv?.[a.id] || null }))
  const key = (a) => (pv ? a.now?.rank ?? 99 : a.rank ?? 99)
  return list.sort((x, y) => key(x) - key(y))
})
const maxScore = computed(() => Math.max(0.001, ...rows.value.map((a) => Math.max(a.score || 0, a.now?.score || 0))))
const move = (a) => (a.now && a.rank && a.now.rank ? a.rank - a.now.rank : 0)
const when = (t) => (t ? new Date(t).toLocaleString(loc, { month: 'short', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '')

// the demo's release request
const TIMES = [{ id: 'fri16', label: '금요일 16:00', weekday: 5, hour: 16 }, { id: 'fri11', label: '금요일 11:00', weekday: 5, hour: 11 }, { id: 'wed10', label: '수요일 10:00', weekday: 3, hour: 10 }]
const form = ref({ time: 'fri16', scanFailed: false, unheld: false, model: true })
const result = ref(null)
async function request() {
  busy.value = 'request'; err.value = ''; result.value = null
  const t = TIMES.find((x) => x.id === form.value.time)
  try {
    result.value = await api('/release/requests', { method: 'POST', body: {
      weekday: t.weekday, hour: t.hour, useModel: form.value.model,
      ...(form.value.scanFailed ? { security_scan: 'failed' } : {}), ...(form.value.unheld ? { unheldRoles: ['보안 담당자', '개인정보 책임자'] } : {}),
    } })
    await load(); preview.value = null
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div class="sv">
    <TopBar />
    <div class="content scroll">
      <div class="mv">
        <div class="head">
          <h1>전략맵</h1>
          <span class="sub">정책에 막힌 일을 에이전트가 대안으로 풀 때, 이 목표들의 우선순위와 위험 허용 수준이 대안을 고르는 기준이 돼요.</span>
        </div>
        <div v-if="graph" class="layout">
          <!-- the four perspectives -->
          <div class="lanes">
            <div v-for="lane in LANES" :key="lane.id" class="lane glass">
              <div class="lh"><b>{{ lane.name }}</b><small>{{ lane.hint }}</small></div>
              <div class="objs">
                <div v-for="o in objectivesOf(lane.id)" :key="o.id" class="obj" :class="{ busy: busy === o.id }">
                  <div class="oh">
                    <b>{{ o.name }}</b>
                    <small v-if="o.parent" class="up">↑ {{ nameOf(o.parent) }}</small>
                  </div>
                  <div class="ocol">
                  <div class="prio">
                    <small>우선순위</small>
                    <template v-if="admin"><button v-for="n in 5" :key="n" class="pn press" :class="{ on: o.priority === n }" :disabled="!!busy" @click="o.priority !== n && change(o, { priority: n })">{{ n }}</button></template>
                    <i v-else class="chip strong">{{ o.priority }}</i>
                    <small class="w">가중치 {{ W[o.priority] }}</small>
                  </div>
                  <div class="risk">
                    <small>위험 허용</small>
                    <template v-if="Object.keys(o.risk_appetite || {}).length">
                      <button v-for="(v, cat) in o.risk_appetite" :key="cat" class="chip ap" :class="v" :disabled="!admin || !!busy" @click="cycle(o, cat)">{{ CAT[cat] || cat }} · {{ APP_TEXT[v] }}</button>
                    </template>
                    <small v-else class="dim">기본(보통)</small>
                  </div>
                  <div v-if="o.constraints?.length" class="cons">
                    <span v-for="c in o.constraints" :key="c.policy" class="con"><i class="lv" :class="c.level">{{ c.level === 'must' ? '필수' : '권장' }}</i>{{ policyTitle(c.policy) }}</span>
                  </div>
                  <div v-if="o.kpi" class="kpi">
                    <span class="kn">KPI {{ o.kpi.name }}</span>
                    <span class="bar"><i :style="{ width: kpiPct(o.kpi) + '%' }" /></span>
                    <small>{{ o.kpi.current }} → {{ o.kpi.target }}{{ o.kpi.unit }}</small>
                  </div>
                  </div>
                  <div class="links">
                    <span v-for="l in linksOf(o, 'contributes')" :key="l.source" class="lk">
                      <i class="lt" :class="l.source.split(':')[0]">{{ sourceText(l.source).kind }}</i>
                      <span class="ln">{{ l.source.startsWith('activity:') ? stepName(sourceText(l.source).text) : sourceText(l.source).text }}</span>
                      <span class="wb"><i :style="{ width: l.weight * 100 + '%' }" /></span><small>{{ l.weight }}</small>
                    </span>
                    <span v-for="l in linksOf(o, 'protects')" :key="l.source" class="lk prot">
                      <i class="lt policy">보호</i><span class="ln">{{ sourceText(l.source).text }}</span>
                      <span class="wb"><i :style="{ width: l.weight * 100 + '%' }" /></span><small>{{ l.weight }}</small>
                    </span>
                  </div>
                </div>
                <p v-if="!objectivesOf(lane.id).length" class="empty">목표가 없어요</p>
              </div>
            </div>
          </div>

          <aside class="side">
            <!-- the last optimization's ranking, and the same alternatives against today's graph -->
            <div class="card glass">
              <p class="ct">최근 최적화 <i v-if="last" class="chip" :class="last.status">{{ STATUS[last.status] }}</i></p>
              <template v-if="last">
                <small class="hint">{{ last.subject }} · {{ when(last.created_at) }}</small>
                <div class="rk th"><span /><span>대안</span><span>정책</span><span>점수{{ preview ? ' (지금 기준)' : '' }}</span></div>
                <div v-for="a in rows" :key="a.id" class="rk" :class="{ ex: a.excluded, win: (preview ? a.now?.rank : a.rank) === 1, chosen: a.id === last.chosen }">
                  <span class="no">{{ (preview ? a.now?.rank : a.rank) || '–' }}</span>
                  <span class="lb"><b>{{ a.label }}</b>
                    <small v-if="a.excluded">제외 · {{ a.reason }}</small>
                    <small v-else-if="preview && move(a)" :class="move(a) > 0 ? 'upm' : 'down'">{{ move(a) > 0 ? '▲' : '▼' }} {{ a.rank }}위 → {{ a.now.rank }}위</small>
                    <small v-else-if="a.id === last.chosen">{{ last.auto ? '자동 실행' : '선택됨' }}</small>
                  </span>
                  <i class="chip" :class="a.decision">{{ DECISION[a.decision] }}</i>
                  <span class="sc">
                    <template v-if="!a.excluded">
                      <span class="bar"><i :style="{ width: Math.max(3, ((preview ? a.now?.score : a.score) || 0) / maxScore * 100) + '%' }" /></span>
                      <b>{{ ((preview ? a.now?.score : a.score) ?? 0).toFixed(2) }}</b>
                      <small v-if="preview && a.now && a.score != null" class="was">{{ a.score.toFixed(2) }}</small>
                    </template>
                  </span>
                </div>
                <p v-if="preview" class="pv">{{ preview.explain }}</p>
                <p v-else class="pv">{{ last.explain }}</p>
                <div class="row">
                  <button class="pill-btn sm" :disabled="!!busy" @click="again">{{ busy === 'preview' ? '계산 중…' : '지금 기준으로 다시 계산' }}</button>
                  <button v-if="preview && last.status === 'proposed'" class="pill-btn sm primary" :disabled="!!busy" @click="apply">{{ busy === 'apply' ? '실행 중…' : '이 순위로 다시 실행' }}</button>
                  <button class="lnk" @click="router.push('/chat')">대화에서 보기</button>
                </div>
                <small class="hint">점수 = Σ 목표 가중치 × 기여 − 위험 노출 × 위험 허용 − 지연. 미리 보기는 아무것도 기록하지 않아요.</small>
              </template>
              <small v-else class="hint">아직 최적화한 일이 없어요. 아래에서 출시를 요청해 보세요.</small>
            </div>

            <!-- scenario 1: the release plan, the QA agent's finding, the request -->
            <div v-if="plan" class="card glass">
              <p class="ct">이번 출시</p>
              <small class="hint">{{ plan.plan.title }} · {{ when(plan.plan.planned_for) }} · {{ AUD[plan.plan.audience] }} · 보안 점검 {{ plan.plan.security_scan === 'passed' ? '통과' : plan.plan.security_scan }}</small>
              <ul class="feat">
                <li v-for="f in plan.plan.features" :key="f.name"><b>{{ f.name }}</b><i v-if="f.pii" class="chip pii">개인정보</i><small>{{ f.summary }}</small></li>
              </ul>
              <div v-for="f in plan.findings" :key="f.id" class="fd" :class="f.status">
                <span class="fh"><i class="chip deny">{{ f.status === 'fixed' ? '조치됨' : `${CAT[f.category]} · ${APP_TEXT[f.severity] || f.severity}` }}</i><b>{{ f.title }}</b></span>
                <small>{{ f.found_by }} · {{ f.feature }} · 조치 추정 {{ f.fix_days }}일</small>
                <small class="dt">{{ f.detail }}</small>
              </div>
              <div class="req">
                <select v-model="form.time"><option v-for="t in TIMES" :key="t.id" :value="t.id">{{ t.label }}</option></select>
                <label><input v-model="form.model" type="checkbox" /> 에이전트(모델)가 대안 만들기</label>
                <label><input v-model="form.scanFailed" type="checkbox" /> 보안 점검 실패로 가정</label>
                <label><input v-model="form.unheld" type="checkbox" /> 예외 권한자가 없다고 가정</label>
                <button class="pill-btn primary" :disabled="!!busy" @click="request">{{ busy === 'request' ? '정책 확인·대안 계산 중…' : '출시 요청' }}</button>
              </div>
              <div v-if="result" class="res">
                <span><i class="chip" :class="result.decision.decision">{{ DECISION[result.decision.decision] }}</i> {{ result.optimization ? '대안을 계산했어요' : result.decision.status === 'executed' ? '그대로 출시했어요(시연)' : '승인을 기다려요' }}</span>
                <small v-if="result.optimization">{{ result.optimization.explain }}</small>
                <button class="lnk" @click="router.push('/chat')">대화에서 보기</button>
              </div>
              <template v-if="plan.deployments?.length">
                <p class="st">배포 기록 <small>시연용 — 실제로 배포하지 않아요</small></p>
                <div v-for="d in plan.deployments.slice(0, 6)" :key="d.id" class="dep">
                  <i class="chip" :class="d.status">{{ DEP[d.status] }}</i>
                  <span>{{ AUD[d.audience] }}{{ d.rollout < 100 ? ` ${d.rollout}%` : '' }} · {{ d.features.join(', ') }}</span>
                  <small>{{ when(d.scheduled_for || d.created_at) }}</small>
                </div>
              </template>
            </div>
          </aside>
        </div>
        <p v-if="err" class="err glass">{{ err }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* theme tokens (styles/base.css): readable on the dark default and the light theme */
.sv { --ok: var(--color-success); --bad: var(--color-error); --info: var(--color-info); --warn: #e8912d; position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.content.scroll { overflow-y: auto; }
.mv { max-width: 1240px; margin: 0 auto; padding: 0 24px 60px; }
.head { display: flex; align-items: baseline; gap: 14px; margin: 6px 0 16px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 30px; font-weight: 500; letter-spacing: -0.02em; }
.sub { color: var(--text-secondary); font-size: 14.5px; }
.layout { display: grid; grid-template-columns: minmax(0, 1fr) 390px; gap: 14px; align-items: start; }
.lanes { display: flex; flex-direction: column; gap: 10px; }
.lane { border-radius: 20px; padding: 12px 14px; display: grid; grid-template-columns: 96px 1fr; gap: 12px; }
.lh { display: flex; flex-direction: column; gap: 2px; padding-top: 4px; }
.lh b { font-size: 15px; font-weight: 600; }
.lh small { color: var(--text-tertiary); font-size: 12px; line-height: 1.35; }
.objs { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 8px; }
.obj { border-radius: 16px; padding: 12px 14px; background: var(--cell-bg); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 7px 18px; transition: opacity .2s; }
.obj.busy { opacity: .6; }
.oh { grid-column: 1 / -1; display: flex; align-items: baseline; gap: 8px; }
.oh b { font-size: 16px; font-weight: 600; }
.up { color: var(--text-tertiary); font-size: 12px; }
.ocol { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
.prio, .risk { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.prio > small:first-child, .risk > small:first-child { min-width: 56px; white-space: nowrap; color: var(--text-secondary); font-size: 12.5px; }
.pn { width: 24px; height: 24px; border-radius: 12px; font-size: 12.5px; background: var(--button-bg); }
.pn.on { background: var(--ink); color: var(--ink-inverse); font-weight: 600; }
.w { color: var(--text-tertiary); font-size: 12px; margin-left: 4px; }
.dim { color: var(--text-tertiary); font-size: 12.5px; }
.chip { font-style: normal; font-size: 12px; padding: 2px 9px; border-radius: 10px; background: var(--button-bg); color: var(--text-secondary); white-space: nowrap; }
.chip.strong { background: var(--ink); color: var(--ink-inverse); }
.chip.ap.low, .chip.deny, .chip.pii, .chip.stopped { color: var(--bad); background: color-mix(in srgb, var(--bad) 16%, transparent); }
.chip.ap.medium, .chip.require_approval, .chip.proposed, .chip.escalated, .chip.scheduled, .chip.planned { color: var(--warn); background: color-mix(in srgb, var(--warn) 18%, transparent); }
.chip.ap.high, .chip.allow, .chip.executed, .chip.deployed { color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
.chip.allow_audit, .chip.chosen { color: var(--info); background: color-mix(in srgb, var(--info) 16%, transparent); }
.chip.rolled_back { text-decoration: line-through; }
button.chip:not(:disabled):hover { outline: 1px solid currentColor; }
button.chip:disabled { cursor: default; }
.cons { display: flex; flex-direction: column; gap: 3px; }
.con { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
.lv { font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 8px; flex: none; }
.lv.must { background: var(--bad); color: var(--ink-inverse); font-weight: 600; }
.lv.should { color: var(--warn); background: color-mix(in srgb, var(--warn) 18%, transparent); }
.kpi { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; font-size: 12.5px; }
.kn { color: var(--text-secondary); }
.kpi small { color: var(--text-tertiary); font-size: 12px; }
.bar { display: block; height: 6px; border-radius: 3px; background: var(--button-bg); overflow: hidden; width: 100%; }
.bar i { display: block; height: 100%; border-radius: 3px; background: var(--ink); }
.links { display: flex; flex-direction: column; gap: 4px; border-left: 1px solid var(--hairline); padding-left: 14px; min-width: 0; }
.lk { display: grid; grid-template-columns: minmax(34px, auto) 1fr 50px 24px; gap: 6px; align-items: center; font-size: 12.5px; }
.lt { font-style: normal; font-size: 10.5px; text-align: center; padding: 1px 5px; white-space: nowrap; border-radius: 6px; color: var(--info); background: color-mix(in srgb, var(--info) 14%, transparent); }
.lt.activity { background: var(--button-bg); color: var(--text-secondary); }
.lt.policy { color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, transparent); }
.ln { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wb { display: block; height: 5px; border-radius: 3px; background: var(--button-bg); overflow: hidden; }
.wb i { display: block; height: 100%; background: var(--info); }
.prot .wb i { background: var(--bad); }
.lk small { color: var(--text-tertiary); font-size: 11.5px; text-align: right; }
.empty { color: var(--text-tertiary); font-size: 13px; margin: 6px 0; }
.side { display: flex; flex-direction: column; gap: 10px; }
.card { border-radius: 20px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.ct { margin: 0; font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 8px; }
.st { margin: 6px 0 0; color: var(--text-secondary); font-size: 13px; }
.st small { color: var(--text-tertiary); font-size: 11.5px; margin-left: 4px; }
.hint { color: var(--text-tertiary); font-size: 12.5px; line-height: 1.45; }
.rk { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto 100px; gap: 8px; align-items: center; font-size: 13px; padding: 5px 0; border-bottom: 1px solid var(--hairline); }
.rk.th { font-size: 11.5px; color: var(--text-tertiary); padding: 0; border: 0; }
.rk .no { width: 20px; height: 20px; border-radius: 10px; display: grid; place-items: center; font-size: 11.5px; font-weight: 600; background: var(--button-bg); }
.rk.win .no { background: var(--ink); color: var(--ink-inverse); }
.rk.ex { opacity: .65; }
.lb { display: flex; flex-direction: column; min-width: 0; }
.lb b { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb small { font-size: 11.5px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb .upm { color: var(--ok); font-weight: 600; } .lb .down { color: var(--bad); }
.sc { display: grid; grid-template-columns: 1fr 32px; gap: 4px; align-items: center; }
.sc b { font-size: 12.5px; text-align: right; font-variant-numeric: tabular-nums; }
.sc .was { grid-column: 2; font-size: 10.5px; color: var(--text-tertiary); text-align: right; text-decoration: line-through; }
.pv { margin: 2px 0 0; font-size: 13px; line-height: 1.5; }
.pv.ok { color: var(--ok); }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.pill-btn.sm { padding: 5px 13px; font-size: 13px; }
.pill-btn.primary { background: var(--ink); color: var(--ink-inverse); }
.lnk { font-size: 12.5px; color: var(--text-secondary); text-decoration: underline; }
.feat { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.feat li { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; font-size: 13.5px; }
.feat li small { flex: 1 0 100%; color: var(--text-tertiary); font-size: 12px; }
.fd { border-radius: 12px; padding: 8px 10px; background: color-mix(in srgb, var(--bad) 9%, transparent); display: flex; flex-direction: column; gap: 3px; }
.fd.fixed { background: color-mix(in srgb, var(--ok) 9%, transparent); }
.fh { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.fd small { color: var(--text-secondary); font-size: 12px; }
.fd .dt { color: var(--text-primary); line-height: 1.45; }
.req { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; }
.req select { height: 34px; border-radius: 11px; padding: 0 10px; border: 1px solid var(--hairline); background: var(--field-bg); color: var(--text-primary); font-size: 13.5px; }
.req label { font-size: 12.5px; color: var(--text-secondary); display: flex; align-items: center; gap: 4px; }
.req .pill-btn { margin-left: auto; }
.res { display: flex; flex-direction: column; gap: 4px; font-size: 13px; padding: 8px 10px; border-radius: 12px; background: var(--cell-bg); }
.res small { color: var(--text-secondary); line-height: 1.45; }
.dep { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: center; font-size: 12.5px; }
.dep small { color: var(--text-tertiary); font-size: 11.5px; }
.err { margin-top: 14px; padding: 12px 16px; border-radius: 14px; color: var(--bad); font-size: 14px; }
@media (max-width: 1100px) { .layout { grid-template-columns: 1fr; } .obj { grid-template-columns: 1fr; } .links { border-left: 0; padding-left: 0; border-top: 1px solid var(--hairline); padding-top: 7px; } }
@media (max-width: 640px) { .lane { grid-template-columns: 1fr; } .objs { grid-template-columns: 1fr; } }
</style>
