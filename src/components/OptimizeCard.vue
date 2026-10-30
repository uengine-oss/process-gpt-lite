<script setup>
// The path optimizer's card (server lib/optimize, scenario: release): a request the policies blocked and why, then
// the alternatives the agents made — each checked by the policies as a dry run, simulated (days, value delivered,
// residual risk) and scored by strategic value. The best one either ran on its own, or the accountable person
// (릴리스 책임자) chooses here; when every alternative breaks a must constraint it went to the exception holder,
// or stopped. The server keeps every copy of this card up to date (pro_optimization_cards).
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'

const props = defineProps({ msg: Object })
const router = useRouter()
const c = computed(() => props.msg.content || {})
const pick = (pair) => (Array.isArray(pair) ? pair[isEnglish ? 1 : 0] : pair)
const DECISION = { allow: '허용', allow_audit: '기록', require_approval: '승인 필요', deny: '차단' }
const AUD = { public: '일반 공개', beta: '베타 그룹', internal: '사내 사용자' }
const CAT = { privacy: '개인정보', security: '보안', quality: '품질' }
const SEV = { high: '높음', medium: '보통', low: '낮음' }

const state = computed(() => {
  const s = c.value.status
  if (s === 'proposed') return c.value.chooser ? { cls: 'wait', text: `대안을 골라 주세요 · ${c.value.role}` } : { cls: 'wait', text: `${c.value.role} 선택을 기다려요` }
  if (s === 'executed' && c.value.auto) return { cls: 'ok', text: '가장 나은 대안을 자동으로 실행했어요' }
  if (s === 'executed') return { cls: 'ok', text: `${c.value.decidedBy || ''}님이 고른 대안을 실행했어요` }
  if (s === 'chosen') return { cls: 'audit', text: '고른 대안을 진행하고 있어요' }
  if (s === 'escalated') return { cls: 'wait', text: `예외 권한자 판단을 기다려요 · ${(c.value.exception?.holders || []).map((h) => h.name).join(', ')}` }
  if (s === 'stopped' && c.value.next) return { cls: 'muted', text: '다시 계산해 새 대안으로 바뀌었어요' }
  return { cls: 'bad', text: '멈췄어요' }
})
const alts = computed(() => c.value.alternatives || [])
const may = computed(() => c.value.chooser && c.value.status === 'proposed')
const best = computed(() => alts.value.find((a) => a.rank === 1))
const maxScore = computed(() => Math.max(0.001, ...alts.value.map((a) => a.score || 0)))
const pct = (x) => `${Math.round((x || 0) * 100)}%`
const riskText = (r) => {
  const xs = Object.entries(r || {}).filter(([, v]) => v > 0)
  return xs.length ? xs.map(([k, v]) => `${CAT[k]} 위험 ${v.toFixed(3)}`).join(' · ') : '위험 노출 없음'
}
const phaseText = (p) => `${p.day ? `+${p.day}일` : '지금'} · ${AUD[p.audience]}${p.rollout < 100 ? ` ${p.rollout}%` : ''} · ${p.items.join(', ')}`
const showFinding = ref(false)
const busy = ref('')
const err = ref('')
async function choose(a) {
  busy.value = a.id; err.value = ''
  try { await api(`/release/optimizations/${c.value.optimizationId}/choose`, { method: 'POST', body: { alternative: a.id } }) } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function stopIt() {
  busy.value = 'stop'; err.value = ''
  try { await api(`/release/optimizations/${c.value.optimizationId}/stop`, { method: 'POST' }) } catch (e) { err.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div class="optc glass" :class="state.cls">
    <div class="hd"><span class="dot" /><b>{{ state.text }}</b><small class="tag">경로 최적화</small></div>

    <!-- the blocked request and why -->
    <div class="blocked">
      <p class="subj">{{ c.subject }}</p>
      <div v-if="c.blockedBy?.length" class="why">
        <span v-for="m in c.blockedBy" :key="m.id" class="pol"><i class="chip" :class="m.decision">{{ DECISION[m.decision] }}</i>{{ pick(m.title) }}</span>
      </div>
      <button v-if="c.finding" class="finding press" @click="showFinding = !showFinding">
        <span class="fh"><i class="chip sev" :class="c.finding.severity">{{ CAT[c.finding.category] }} · {{ SEV[c.finding.severity] }}</i><b>{{ c.finding.title }}</b></span>
        <small>{{ c.finding.by || 'QA 에이전트' }} · {{ c.finding.feature }}<template v-if="c.finding.fix_days != null"> · 조치 추정 {{ c.finding.fix_days }}일</template></small>
        <small v-if="showFinding" class="detail">{{ c.finding.detail }}</small>
      </button>
    </div>

    <!-- the alternatives: dry-run decision, simulation, strategic score -->
    <p class="cap">에이전트가 만든 대안 {{ alts.length }}개 · 정책 사전 검증 → 시뮬레이션 → 전략 점수</p>
    <div class="alts">
      <div v-for="a in alts" :key="a.id" class="alt" :class="{ excluded: a.excluded, chosen: a.id === c.chosen, top: a.rank === 1 && !c.chosen }">
        <div class="ah">
          <span class="rank">{{ a.rank || '–' }}</span>
          <span class="al"><b>{{ a.label }}</b><small v-if="a.source === 'model'" class="src">에이전트 제안</small></span>
          <i class="chip" :class="a.decision">{{ DECISION[a.decision] }}</i>
          <i v-if="a.id === c.chosen" class="badge ok">{{ c.auto ? '자동 실행' : '선택됨' }}</i>
          <i v-else-if="a.excluded" class="badge bad">제외</i>
        </div>
        <!-- an excluded alternative: its name and the policy that stops it are enough -->
        <small v-if="a.rationale && !a.excluded" class="ra">{{ a.rationale }}</small>
        <ul v-if="!a.excluded" class="ph"><li v-for="(p, i) in a.phases" :key="i"><i class="dot2" :class="p.decision" />{{ phaseText(p) }}<small v-if="p.decision !== a.decision || i > 0"> · {{ DECISION[p.decision] }}</small></li></ul>
        <p v-if="a.excluded" class="reason">{{ a.reason }}</p>
        <template v-else>
          <div class="metrics">
            <span><small>모두 공개까지</small><b>{{ a.days }}일</b></span>
            <span><small>2주 가치 전달</small><b>{{ pct(a.delivered) }}</b></span>
            <span><small>잔여 위험</small><b class="rk" :class="{ zero: riskText(a.risk) === '위험 노출 없음' }">{{ riskText(a.risk) }}</b></span>
          </div>
          <div class="score"><span class="bar"><i :style="{ width: Math.max(3, (a.score / maxScore) * 100) + '%' }" /></span><b>{{ a.score.toFixed(2) }}</b></div>
          <small v-if="a.why" class="whyline">{{ a.why }}</small>
        </template>
        <div v-if="may && !a.excluded" class="act">
          <button class="pill-btn sm" :class="{ primary: a.id === best?.id }" :disabled="!!busy" @click="choose(a)">{{ busy === a.id ? '실행 중…' : a.decision === 'require_approval' ? '승인하고 이 대안으로' : '이 대안으로' }}</button>
        </div>
      </div>
    </div>

    <p v-if="c.explain" class="explain">{{ c.explain }}</p>
    <div class="ft">
      <button class="lnk" @click="router.push('/strategy')">전략맵에서 보기</button>
      <button v-if="may || c.status === 'escalated'" class="lnk" :disabled="!!busy" @click="stopIt">멈추기</button>
    </div>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
/* theme tokens (styles/base.css): readable on the dark default and the light theme */
.optc { --ok: var(--color-success); --bad: var(--color-error); --info: var(--color-info); --warn: #e8912d;
  border-radius: 20px; padding: 14px 16px; max-width: 640px; display: flex; flex-direction: column; gap: 8px; border-left: 4px solid var(--hairline); }
.optc.ok { border-left-color: var(--ok); } .optc.audit { border-left-color: var(--info); } .optc.wait { border-left-color: var(--warn); } .optc.bad { border-left-color: var(--bad); }
.hd { display: flex; align-items: center; gap: 8px; font-size: 15px; }
.hd b { font-weight: 600; }
.hd .tag { margin-left: auto; color: var(--text-tertiary); font-size: 12px; white-space: nowrap; }
.dot { width: 8px; height: 8px; border-radius: 4px; background: currentColor; opacity: .5; flex: none; }
.optc.ok .dot { background: var(--ok); opacity: 1; } .optc.wait .dot { background: var(--warn); opacity: 1; } .optc.bad .dot { background: var(--bad); opacity: 1; }
.blocked { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 14px; background: color-mix(in srgb, var(--bad) 9%, transparent); }
.subj { margin: 0; font-size: 13.5px; color: var(--text-secondary); }
.why { display: flex; flex-direction: column; gap: 4px; }
.pol { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.finding { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left; padding: 8px 10px; border-radius: 12px; background: var(--cell-bg); }
.fh { display: flex; align-items: center; gap: 6px; font-size: 13.5px; }
.fh b { font-weight: 600; }
.finding small { color: var(--text-secondary); font-size: 12px; }
.finding .detail { color: var(--text-primary); line-height: 1.5; font-size: 12.5px; }
.cap { margin: 4px 0 0; color: var(--text-secondary); font-size: 12.5px; }
.alts { display: flex; flex-direction: column; gap: 6px; }
.alt { padding: 10px 12px; border-radius: 14px; background: var(--cell-bg); display: flex; flex-direction: column; gap: 5px; border: 1px solid transparent; }
.alt.top { border-color: color-mix(in srgb, var(--text-primary) 28%, transparent); }
.alt.chosen { border-color: var(--ok); background: color-mix(in srgb, var(--ok) 8%, transparent); }
.alt.excluded { opacity: .7; }
.ah { display: flex; align-items: center; gap: 8px; }
.rank { width: 22px; height: 22px; border-radius: 11px; display: grid; place-items: center; font-size: 12px; font-weight: 600; background: var(--button-bg); flex: none; }
.alt.top .rank, .alt.chosen .rank { background: var(--ink); color: var(--ink-inverse); }
.al { display: flex; align-items: baseline; gap: 6px; min-width: 0; flex: 1; }
.al b { font-weight: 600; font-size: 14px; }
.al .src { color: var(--text-tertiary); font-size: 11.5px; white-space: nowrap; }
.ra { color: var(--text-secondary); font-size: 12.5px; line-height: 1.45; }
.ph { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12.5px; }
.ph li { display: flex; align-items: center; gap: 6px; }
.ph small { color: var(--text-tertiary); }
.dot2 { width: 6px; height: 6px; border-radius: 3px; background: var(--ok); flex: none; }
.dot2.allow_audit { background: var(--info); } .dot2.require_approval { background: var(--warn); } .dot2.deny { background: var(--bad); }
.reason { margin: 0; color: var(--bad); font-size: 12.5px; }
.metrics { display: grid; grid-template-columns: .8fr .9fr 1.5fr; gap: 8px; }
.metrics span { display: flex; flex-direction: column; gap: 1px; }
.metrics small { color: var(--text-tertiary); font-size: 11.5px; }
.metrics b { font-size: 13.5px; font-weight: 600; }
.metrics .rk { color: var(--warn); font-weight: 500; font-size: 12.5px; }
.metrics .rk.zero { color: var(--ok); }
.score { display: flex; align-items: center; gap: 8px; }
.score b { font-size: 13px; font-variant-numeric: tabular-nums; width: 34px; text-align: right; }
.bar { flex: 1; display: block; height: 7px; border-radius: 4px; background: var(--button-bg); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 4px; background: var(--ink); }
.whyline { color: var(--text-tertiary); font-size: 11.5px; }
.chip { font-style: normal; align-self: center; font-size: 11.5px; padding: 1px 8px; border-radius: 9px; white-space: nowrap; flex: none;
  color: var(--ok); background: color-mix(in srgb, var(--ok) 16%, transparent); }
.chip.allow_audit { color: var(--info); background: color-mix(in srgb, var(--info) 16%, transparent); }
.chip.require_approval, .chip.sev.medium { color: var(--warn); background: color-mix(in srgb, var(--warn) 18%, transparent); }
.chip.deny, .chip.sev { color: var(--bad); background: color-mix(in srgb, var(--bad) 16%, transparent); }
.chip.sev.low { color: var(--text-secondary); background: var(--button-bg); }
.badge { font-style: normal; font-size: 11.5px; padding: 1px 8px; border-radius: 9px; white-space: nowrap; flex: none; }
.badge.ok { background: var(--ok); color: var(--ink-inverse); font-weight: 600; }
.badge.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 16%, transparent); }
.act { display: flex; justify-content: flex-end; }
.pill-btn.sm { padding: 5px 14px; font-size: 13px; }
.pill-btn.primary { background: var(--ink); color: var(--ink-inverse); }
.explain { margin: 2px 0 0; font-size: 13.5px; line-height: 1.5; }
.ft { display: flex; gap: 14px; }
.lnk { font-size: 12.5px; color: var(--text-secondary); text-decoration: underline; }
.err { margin: 0; color: var(--bad); font-size: 13px; }
</style>
