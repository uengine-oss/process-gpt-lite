<script setup>
// Agentic BPM 리포트 (administrators, server lib/policy/insights.js): the month's decisions — what ran
// unattended, what ran and was recorded (Human-on-the-Loop), what waited for a person (Human-in-the-Loop) and
// how long, what was stopped and by which kind of policy, the optimizer's outcomes, the approvals that had a
// decision brief — and the suggestions to retune policies from that record, each applied with one click.
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'

const router = useRouter()
const r = ref(null)
const err = ref('')
const days = ref(30)
const busy = ref('')
const pick = (pair) => (Array.isArray(pair) ? pair[isEnglish ? 1 : 0] : pair)
const loc = isEnglish ? 'en-US' : 'ko-KR'

async function load() {
  err.value = ''
  try { r.value = await api(`/agentic/report?days=${days.value}`) } catch (e) { err.value = e.message }
}
onMounted(load)

const decisionName = { allow: '자동 실행', allow_audit: '실행 후 기록·감사', require_approval: '사전 승인', deny: '차단' }
const categoryName = { security: '보안', privacy: '개인정보', legal: '법률', ethics: '윤리', authority: '승인 권한', audit: '감사', cost: '비용', quality: '품질' }
const optimName = { proposed: '선택 대기', chosen: '선택됨', executed: '자동 실행', stopped: '중단', escalated: '예외 승인 요청' }
const cats = computed(() => {
  const by = {}
  for (const x of r.value?.byCategory || []) {
    const c = (by[x.category] ||= { category: x.category, allow: 0, allow_audit: 0, require_approval: 0, deny: 0, total: 0 })
    c[x.decision] += x.n; c.total += x.n
  }
  return Object.values(by).sort((a, b) => b.total - a.total)
})
const maxCat = computed(() => Math.max(1, ...cats.value.map((c) => c.total)))

async function apply(s) {
  busy.value = s.policy + s.kind; err.value = ''
  try { await api('/agentic/suggestions/apply', { method: 'POST', body: { policy: s.policy, kind: s.kind, days: days.value } }); await load() } catch (e) { err.value = e.message } finally { busy.value = '' }
}
</script>

<template>
  <div class="ar">
    <TopBar />
    <div class="content scroll">
      <div class="mv">
        <div class="head">
          <h1>Agentic BPM 리포트</h1>
          <span class="sub">정책이 무엇을 맡기고, 무엇을 기다리게 하고, 무엇을 막았는지 — 그리고 고칠 곳</span>
          <span class="sp" />
          <select v-model.number="days" @change="load"><option :value="7">최근 7일</option><option :value="30">최근 30일</option><option :value="90">최근 90일</option></select>
          <button class="hbtn glass press" @click="router.push('/settings/policies')">정책·가드레일</button>
        </div>
        <template v-if="r">
          <div class="kpis">
            <div class="kpi glass"><small>판단</small><b>{{ r.totals.decisions.toLocaleString(loc) }}</b></div>
            <div class="kpi glass ok"><small>사람 없이 실행</small><b>{{ (r.totals.unattended + r.totals.audited).toLocaleString(loc) }}</b><i>기록·감사 {{ r.totals.audited }} · 되돌림 {{ r.totals.undone }}</i></div>
            <div class="kpi glass wait"><small>사람 승인</small><b>{{ r.totals.approvals }}</b><i>대기 중앙값 {{ r.approvalWaitMedianHours ?? '—' }}시간 · 대기 {{ r.totals.pending }} · 반려 {{ r.totals.rejected }}</i></div>
            <div class="kpi glass bad"><small>막은 일</small><b>{{ r.totals.blocked }}</b></div>
          </div>

          <div class="grid">
            <div class="card glass">
              <p class="ct">정책 종류별 판단</p>
              <div v-for="c in cats" :key="c.category" class="cat">
                <span class="cn">{{ categoryName[c.category] || c.category }}</span>
                <span class="stack" :style="{ width: (c.total / maxCat * 100) + '%' }">
                  <i v-for="d in ['allow', 'allow_audit', 'require_approval', 'deny']" :key="d" :class="d" :style="{ flex: c[d] }" :title="`${decisionName[d]} ${c[d]}`" />
                </span>
                <small>{{ c.total }}</small>
              </div>
              <div class="legend"><span v-for="d in ['allow', 'allow_audit', 'require_approval', 'deny']" :key="d"><i :class="d" />{{ decisionName[d] }}</span></div>
              <p v-if="!cats.length" class="hint">아직 판단 기록이 없어요.</p>
            </div>
            <div class="card glass">
              <p class="ct">대안 최적화</p>
              <div v-for="o in r.optimizations" :key="o.status" class="r2"><span>{{ optimName[o.status] || o.status }}</span><b>{{ o.n }}</b></div>
              <p v-if="!r.optimizations.length" class="hint">아직 막힌 일을 대안으로 푼 기록이 없어요.</p>
              <p class="ct mt">결정 브리프</p>
              <div class="r2"><span>브리프를 미리 준비한 승인</span><b>{{ r.briefs.n }}</b></div>
              <div class="r2"><span>브리프 → 결정 중앙값</span><b>{{ r.briefs.medianHours ?? '—' }}시간</b></div>
            </div>
          </div>

          <p class="cap">정책 조정 제안 <small>최근 {{ days }}일 원장에서</small></p>
          <div v-if="r.suggestions.length" class="list glass">
            <div v-for="s in r.suggestions" :key="s.policy + s.kind" class="li">
              <span class="chip" :class="s.kind">{{ { loosen: '완화', tighten: '강화', alternative: '대안 경로' }[s.kind] }}</span>
              <div class="main">
                <b>{{ pick(s.title) || s.policy }}<template v-if="s.to"> · {{ decisionName[s.from] }} → {{ decisionName[s.to] }}</template></b>
                <small>{{ pick(s.reason) }}</small>
                <small class="ev">{{ Object.entries(s.evidence).map(([k, v]) => `${k} ${v}`).join(' · ') }}</small>
              </div>
              <button v-if="s.to" class="pill-btn sm" :disabled="busy === s.policy + s.kind" @click="apply(s)">적용</button>
            </div>
          </div>
          <p v-else class="hint">지금 원장으로는 바꿀 만한 정책이 없어요.</p>
        </template>
        <p v-if="err" class="err glass">{{ err }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ar { position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.content.scroll { overflow-y: auto; }
.mv { max-width: 1120px; margin: 0 auto; padding: 0 24px 60px; }
.head { display: flex; align-items: baseline; gap: 14px; margin: 6px 0 18px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 30px; font-weight: 500; letter-spacing: -0.02em; }
.sub { color: var(--text-secondary); font-size: 14.5px; }
.sp { flex: 1; }
.head select { height: 36px; border-radius: 12px; padding: 0 10px; border: 1px solid rgba(0, 0, 0, .12); background: rgba(255, 255, 255, .75); }
.hbtn { height: 36px; padding: 0 14px; border-radius: 18px; font-size: 14px; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
.kpi { border-radius: 18px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; border-top: 3px solid rgba(0, 0, 0, .12); }
.kpi.ok { border-top-color: #2e7d32; } .kpi.wait { border-top-color: #e67e22; } .kpi.bad { border-top-color: #c62828; }
.kpi small { color: var(--text-secondary); font-size: 13px; }
.kpi b { font-size: 24px; font-weight: 600; }
.kpi i { font-style: normal; color: var(--text-tertiary); font-size: 12px; }
.grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 12px; }
.card { border-radius: 20px; padding: 16px 18px; display: flex; flex-direction: column; gap: 8px; }
.ct { margin: 0; font-weight: 600; font-size: 15px; }
.ct.mt { margin-top: 10px; }
.cat { display: grid; grid-template-columns: 80px 1fr 40px; gap: 8px; align-items: center; font-size: 13px; }
.stack { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: rgba(0, 0, 0, .05); gap: 2px; }
.stack i, .legend i { display: block; height: 100%; }
.allow { background: #9e9e9e; } .allow_audit { background: #1565c0; } .require_approval { background: #e67e22; } .deny { background: #c62828; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 5px; }
.legend i { width: 10px; height: 10px; border-radius: 3px; }
.cat small { text-align: right; color: var(--text-secondary); }
.r2 { display: flex; justify-content: space-between; font-size: 14px; }
.cap { margin: 22px 4px 8px; color: var(--text-secondary); font-size: 14px; }
.cap small { color: var(--text-tertiary); margin-left: 6px; }
.list { border-radius: 20px; overflow: hidden; }
.li { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid rgba(0, 0, 0, .06); }
.li:last-child { border-bottom: 0; }
.main { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.main b { font-weight: 500; font-size: 14.5px; }
.main small { color: var(--text-secondary); font-size: 13px; }
.main .ev { color: var(--text-tertiary); font-size: 12px; }
.chip { font-size: 12px; padding: 2px 9px; border-radius: 10px; background: rgba(0, 0, 0, .06); }
.chip.loosen { background: rgba(46, 125, 50, .14); color: #2e7d32; } .chip.tighten { background: rgba(198, 40, 40, .12); color: #c62828; } .chip.alternative { background: rgba(21, 101, 192, .12); color: #1565c0; }
.pill-btn.sm { padding: 4px 14px; font-size: 13px; }
.hint { color: var(--text-tertiary); font-size: 13px; margin: 4px; }
.err { margin-top: 14px; padding: 12px 16px; border-radius: 14px; color: #c62828; font-size: 14px; }
@media (max-width: 760px) { .kpis, .grid { grid-template-columns: 1fr 1fr; } }
</style>
