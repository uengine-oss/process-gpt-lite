<script setup>
// 빌링 백오피스 (operators: PRO_BILLING_OPERATORS, server routes/backoffice.js): every company's plan, the
// month's usage and estimated bill; one company: switch its plan, record purchased credits once the money is
// in, see its usage by feature and person, issue the month's invoice and mark it paid. No payment provider yet.
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import TopBar from '../components/TopBar.vue'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'

const route = useRoute()
const router = useRouter()
const tenant = computed(() => route.params.tenant || '')
const board = ref(null)
const one = ref(null)
const err = ref('')
const busy = ref('')
const form = ref({ plan: '', billing: 'month', credits: '', ref: '' })
const loc = isEnglish ? 'en-US' : 'ko-KR'

async function load() {
  err.value = ''
  try {
    if (tenant.value) {
      one.value = await api(`/backoffice/billing/${encodeURIComponent(tenant.value)}`)
      const s = one.value.company.subscription
      form.value = { plan: s.plan, billing: s.billing, credits: '', ref: '' }
    } else board.value = await api('/backoffice/billing')
  } catch (e) { err.value = e.message }
}
onMounted(load)
watch(tenant, load)

// amounts are model cost (USD): credits on a credit catalog; money in its currency
const upc = computed(() => board.value?.usdPerCredit || one.value?.catalog?.usdPerCredit || 1)
const creditsOf = (usd) => Math.round(Number(usd || 0) / upc.value)
const amount = (usd, unit) => (unit === 'credit' ? `${creditsOf(usd).toLocaleString(loc)}크레딧` : `$${Number(usd || 0).toFixed(2)}`)
const money = (n, cur) => (cur === 'KRW' ? `₩${Math.round(Number(n || 0)).toLocaleString(loc)}` : `$${Number(n || 0).toFixed(2)}`)
const pct = (w) => (w && w.limit ? Math.min(100, Math.round((w.spent / w.limit) * 100)) : 0)
const utcDay = (t) => (t ? new Date(t).toLocaleDateString(loc, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '')
const day = (t) => (t ? new Date(t).toLocaleDateString(loc, { month: 'short', day: 'numeric' }) : '')
const statusText = { issued: '발행됨', paid: '입금 확인', void: '무효' }

const totals = computed(() => {
  const list = board.value?.companies || []
  const krw = list.filter((c) => c.currency === 'KRW')
  return {
    count: list.length,
    revenue: krw.reduce((a, c) => a + (c.bill?.total || 0), 0),
    usage: list.reduce((a, c) => a + (c.month?.spend || 0), 0),
    unpaid: (board.value?.invoices || []).filter((i) => i.status === 'issued' && i.currency === 'KRW').reduce((a, i) => a + Number(i.total), 0),
  }
})

const c = computed(() => one.value?.company)
const unit = computed(() => one.value?.catalog?.unit)
const cur = computed(() => c.value?.bill?.currency)
const plans = computed(() => one.value?.catalog?.plans || [])
const topPeople = computed(() => [...(c.value?.people || [])].sort((a, b) => b.month.spend - a.month.spend).slice(0, 5))
const featureMax = computed(() => Math.max(...(one.value?.features || []).map((f) => f.spend), 1e-9))
const featureName = { chat: '채팅', mission: '예약 작업', browser: '브라우저 에이전트', mining: '프로세스 마이닝', meeting: '회의', skill: '스킬', mail: '메일', panel_app: '패널 앱', process: '프로세스', workroom: '작업실', knowledge: '공유 폴더', office_doc: '문서', craft: '크래프트', improve: '프로세스 개선', team: '팀', other: '기타' }
// the month is cut in UTC (LiteLLM's monthly reset), so its days are shown in UTC
const span = (l) => (l.from ? ` (${new Date(l.from).toLocaleDateString(loc, { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}–${new Date(new Date(l.to) - 1).toLocaleDateString(loc, { month: 'numeric', day: 'numeric', timeZone: 'UTC' })}, ${Math.round(l.days)}일)` : '')
const billLine = (l) => (l.kind === 'seat' ? `${l.name} × ${l.count}석${span(l)}`
  : l.kind === 'vat' ? '부가세 (10%)'
  : l.kind === 'extra' ? (l.credits != null ? `충전 크레딧 ${l.credits.toLocaleString(loc)}` : '추가 사용량 (원가)')
  : (l.credits != null ? `사용량 ${l.credits.toLocaleString(loc)}크레딧` : '사용량 (원가)'))

async function act(name, fn) {
  busy.value = name; err.value = ''
  try { await fn(); await load() } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const switchPlan = () => act('plan', () => api(`/backoffice/billing/${tenant.value}/plan`, { method: 'PUT', body: { plan: form.value.plan, billing: form.value.billing } }))
const addCredits = () => act('credits', () => api(`/backoffice/billing/${tenant.value}/credits`, { method: 'POST', body: { credits: Number(form.value.credits), ref: form.value.ref } }))
const issue = () => act('issue', () => api(`/backoffice/billing/${tenant.value}/invoices`, { method: 'POST' }))
const paid = (i) => act(`paid-${i.id}`, () => api(`/backoffice/billing/invoices/${i.id}/paid`, { method: 'POST', body: { ref: `입금 ${new Date().toLocaleDateString(loc)}` } }))
const voidIt = (i) => act(`void-${i.id}`, () => api(`/backoffice/billing/invoices/${i.id}/void`, { method: 'POST' }))
const time = (t) => (t ? new Date(t).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')
const lag = (m) => (m?.newest && m?.lastAt ? Math.max(0, Math.round((new Date(m.newest) - new Date(m.lastAt)) / 1000)) : 0)
// the company's usage events while the page is open (the consumer writes them every few seconds)
let poll = null
watch(tenant, (t) => { clearInterval(poll); if (t) poll = setInterval(async () => { try { const x = await api(`/backoffice/billing/${encodeURIComponent(t)}`); if (one.value) Object.assign(one.value, { events: x.events, meter: x.meter, company: x.company, features: x.features }) } catch { /* next time */ } }, 5000) }, { immediate: true })
onUnmounted(() => clearInterval(poll))
const liveInvoice = computed(() => (one.value?.invoices || []).find((i) => i.period === one.value.period && i.status !== 'void'))
</script>

<template>
  <div class="bo">
    <TopBar />
    <div class="content scroll">
      <div class="mv">
        <!-- every company -->
        <template v-if="!tenant">
          <div class="head">
            <h1>빌링 백오피스</h1>
            <span class="sub">회사마다 요금제·이번 달 사용량·예상 청구를 보고, 청구서를 발행해요. 결제 대행 연동 전이라 입금은 운영자가 확인해요.</span>
          </div>
          <div v-if="board" class="kpis">
            <div class="kpi glass"><small>이번 달 예상 청구 (원화)</small><b>{{ money(totals.revenue, 'KRW') }}</b></div>
            <div class="kpi glass"><small>미수금 (발행 · 입금 전)</small><b>{{ money(totals.unpaid, 'KRW') }}</b></div>
            <div class="kpi glass"><small>이번 달 AI 사용</small><b>{{ amount(totals.usage, 'credit') }}</b></div>
            <div class="kpi glass"><small>회사</small><b>{{ totals.count }}곳</b></div>
          </div>
          <div v-if="board" class="table glass">
            <div class="tr th"><span>회사</span><span>요금제</span><span>좌석</span><span>이번 달 사용</span><span>회사 풀</span><span>충전 크레딧</span><span class="r">예상 청구</span><span>청구서</span></div>
            <button v-for="x in board.companies" :key="x.tenant" class="tr press" @click="router.push(`/backoffice/${encodeURIComponent(x.tenant)}`)">
              <span><b>{{ x.name }}</b><small>{{ x.tenant }}</small></span>
              <span><i class="chip">{{ x.planName }}</i></span>
              <span>{{ x.people }}명</span>
              <span>{{ amount(x.month.spend, x.unit) }}<small>{{ x.month.calls.toLocaleString(loc) }}회</small></span>
              <span><template v-if="x.pool"><span class="bar"><i :style="{ width: pct(x.pool) + '%' }" /></span><small>{{ pct(x.pool) }}%</small></template><small v-else>—</small></span>
              <span><template v-if="x.extra">{{ amount(x.extra.spent, x.unit) }}<small>/ {{ amount(x.extra.limit, x.unit) }}</small></template><small v-else>—</small></span>
              <span class="r"><b>{{ money(x.bill.total, x.currency) }}</b></span>
              <span><i v-if="x.invoice" class="chip" :class="x.invoice.status">{{ statusText[x.invoice.status] }}</i><small v-else>미발행</small></span>
            </button>
          </div>
          <template v-if="board?.invoices?.length">
            <p class="cap">최근 청구서</p>
            <div class="table glass">
              <div v-for="i in board.invoices" :key="i.id" class="tr inv">
                <span><b>{{ i.company_name || i.tenant_id }}</b><small>{{ i.period }}</small></span>
                <span>{{ i.plan }}</span>
                <span class="r">{{ money(i.total, i.currency) }}</span>
                <span><i class="chip" :class="i.status">{{ statusText[i.status] }}</i><small v-if="i.paid_ref"> {{ i.paid_ref }}</small></span>
              </div>
            </div>
          </template>
        </template>

        <!-- one company -->
        <template v-else-if="c">
          <div class="head">
            <button class="back glass press" @click="router.push('/backoffice')">←</button>
            <h1>{{ c.subscription.company_name || tenant }}</h1>
            <span class="sub">{{ tenant }} · {{ c.people.length }}명 · {{ one.period }}</span>
          </div>
          <div class="grid">
            <div class="card glass">
              <p class="ct">요금제 전환</p>
              <div class="row">
                <select v-model="form.plan"><option v-for="p in plans" :key="p.code" :value="p.code">{{ p.name }}</option></select>
                <select v-model="form.billing"><option value="month">월간</option><option value="year">연간</option></select>
                <button class="pill-btn" :disabled="busy === 'plan' || (form.plan === c.subscription.plan && form.billing === c.subscription.billing)" @click="switchPlan">{{ busy === 'plan' ? '적용 중…' : '적용' }}</button>
              </div>
              <small class="hint">바꾸면 곧바로 LiteLLM 한도(좌석·회사 풀·모델)에 적용돼요.</small>
              <ul class="plist">
                <li v-for="p in plans" :key="p.code" :class="{ on: p.code === c.subscription.plan }"><b>{{ p.name }}</b><small>{{ p.note }}</small></li>
              </ul>
              <template v-if="one.history?.length">
                <p class="st">이번 달 요금제 구간 (일할 계산)</p>
                <div v-for="(g, i) in c.segments" :key="i" class="r2 sm"><span>{{ plans.find((p) => p.code === g.plan)?.name || g.plan }}</span><span>{{ utcDay(g.from) }} – {{ utcDay(new Date(new Date(g.to) - 1)) }} · {{ Math.round(g.days) }}일</span></div>
              </template>
            </div>

            <div class="card glass">
              <p class="ct">이번 달 사용</p>
              <div v-if="c.pool" class="win"><div class="r2"><span>회사 포함 크레딧</span><span>{{ amount(c.pool.spent, unit) }} / {{ amount(c.pool.limit, unit) }}</span></div><span class="bar wide"><i :style="{ width: pct(c.pool) + '%' }" /></span></div>
              <div v-if="c.extra" class="win"><div class="r2"><span>충전 크레딧</span><span>{{ amount(c.extra.spent, unit) }} / {{ amount(c.extra.limit, unit) }}</span></div><span class="bar wide"><i :style="{ width: pct(c.extra) + '%' }" /></span></div>
              <p class="st">기능별</p>
              <div v-for="f in one.features" :key="f.feature" class="hb">
                <span>{{ featureName[f.feature] || f.feature }}</span><span class="bar wide"><i :style="{ width: Math.max(2, (f.spend / featureMax) * 100) + '%' }" /></span><small>{{ amount(f.spend, unit) }}</small>
              </div>
              <p class="st">많이 쓴 사람</p>
              <div v-for="p in topPeople" :key="p.id" class="r2 sm"><span>{{ p.name }}</span><span>{{ amount(p.month.spend, unit) }} · {{ p.month.calls }}회</span></div>
            </div>

            <div class="card glass wide2">
              <p class="ct">사용 이벤트 <small class="live">● 실시간</small></p>
              <small class="hint">AI 호출이 끝날 때마다 LiteLLM이 남긴 기록을 소비자 루프가 몇 초마다 읽어 원장에 한 줄씩 적어요. 호출은 이 기록을 기다리지 않아요.</small>
              <div class="ev th"><span>시각</span><span>사람</span><span>기능</span><span>모델</span><span>토큰</span><span class="r">크레딧</span><span>요금제</span></div>
              <div v-for="e in one.events" :key="e.request_id" class="ev">
                <span>{{ time(e.at) }}</span><span>{{ e.name || (e.user_id || '').slice(0, 8) }}</span><span>{{ featureName[e.feature] || e.feature || '—' }}{{ e.pool === 'extra' ? ' · 충전' : '' }}</span>
                <span><i v-if="e.status && e.status !== 'success'" class="chip refused">거절됨</i><template v-else>{{ e.model }}</template></span><span>{{ (e.prompt_tokens || 0).toLocaleString(loc) }} → {{ (e.completion_tokens || 0).toLocaleString(loc) }}</span>
                <span class="r">{{ Number(e.credits).toFixed(1) }}</span><span>{{ e.plan }}</span>
              </div>
              <small class="hint">소비자: 지금까지 {{ one.meter.events.toLocaleString(loc) }}건 · 마지막 읽기 {{ time(one.meter.passAt) }} · 밀린 시간 {{ lag(one.meter) }}초</small>
            </div>

            <div class="card glass">
              <p class="ct">충전 크레딧 등록</p>
              <small class="hint">입금을 확인한 뒤 등록하면 회사의 충전 크레딧(월 풀)에 더해져요.</small>
              <div class="row">
                <input v-model="form.credits" type="number" min="0" step="1000" placeholder="크레딧" />
                <input v-model="form.ref" placeholder="입금 참조 (예: 10/30 국민은행)" />
                <button class="pill-btn" :disabled="busy === 'credits' || !(Number(form.credits) > 0)" @click="addCredits">등록</button>
              </div>
              <small v-if="Number(form.credits) > 0" class="hint">{{ money(Number(form.credits) * 10, 'KRW') }} 상당</small>
              <div v-for="l in one.ledger" :key="l.id" class="r2 sm"><span>{{ day(l.created_at) }} · {{ Number(l.credits).toLocaleString(loc) }}크레딧</span><span>{{ l.ref || '' }}</span></div>
            </div>

            <div class="card glass">
              <p class="ct">이번 달 청구서</p>
              <div v-for="(l, i) in c.bill.lines" :key="i" class="r2 sm"><span>{{ billLine(l) }}</span><span>{{ l.contract ? '협의' : money(l.amount, cur) }}</span></div>
              <div class="r2 total"><b>합계</b><b>{{ money(c.bill.total, cur) }}</b></div>
              <button v-if="!liveInvoice" class="pill-btn" :disabled="busy === 'issue'" @click="issue">청구서 발행</button>
              <p class="st">청구서</p>
              <div v-for="i in one.invoices" :key="i.id" class="r2 sm inv">
                <span>{{ i.period }} · {{ money(i.total, i.currency) }}</span>
                <span>
                  <i class="chip" :class="i.status">{{ statusText[i.status] }}</i>
                  <button v-if="i.status === 'issued'" class="lnk" :disabled="busy === `paid-${i.id}`" @click="paid(i)">입금 확인</button>
                  <button v-if="i.status === 'issued'" class="lnk" @click="voidIt(i)">무효</button>
                  <small v-if="i.paid_ref"> {{ i.paid_ref }}</small>
                </span>
              </div>
            </div>
          </div>
        </template>
        <p v-if="err" class="err glass">{{ err }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.bo { position: absolute; inset: 0; }
.content { position: absolute; top: 84px; left: 0; right: 0; bottom: 0; }
.content.scroll { overflow-y: auto; }
.mv { max-width: 1180px; margin: 0 auto; padding: 0 24px 60px; }
.head { display: flex; align-items: baseline; gap: 14px; margin: 6px 0 18px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 30px; font-weight: 500; letter-spacing: -0.02em; }
.sub { color: var(--text-secondary); font-size: 14.5px; }
.back { width: 38px; height: 38px; border-radius: 19px; align-self: center; }
.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 14px; }
.kpi { border-radius: 18px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; }
.kpi small { color: var(--text-secondary); font-size: 13px; }
.kpi b { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
.table { border-radius: 20px; overflow: hidden; }
.tr { width: 100%; display: grid; grid-template-columns: 1.6fr .8fr .5fr 1fr 1fr 1.1fr .9fr .7fr; gap: 10px; align-items: center; padding: 12px 16px; border-bottom: 1px solid rgba(0, 0, 0, .06); text-align: left; font-size: 14px; }
.tr:last-child { border-bottom: 0; }
.tr.th { font-size: 12.5px; color: var(--text-secondary); }
.tr.inv { grid-template-columns: 1.6fr 1fr 1fr 1.6fr; }
.tr span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.tr small { color: var(--text-tertiary); font-size: 12px; }
.r { text-align: right; align-items: flex-end; }
.chip { font-style: normal; font-size: 12px; padding: 2px 9px; border-radius: 10px; background: rgba(0, 0, 0, .06); color: var(--text-secondary); align-self: flex-start; }
.chip.paid { background: rgba(46, 125, 50, .14); color: #2e7d32; }
.chip.issued { background: rgba(230, 126, 34, .16); color: #b35c00; }
.chip.void { text-decoration: line-through; }
.chip.refused { background: rgba(198, 40, 40, .12); color: #c62828; }
.bar { display: block; height: 7px; border-radius: 4px; background: rgba(0, 0, 0, .07); overflow: hidden; width: 100%; }
.bar i { display: block; height: 100%; border-radius: 4px; background: var(--ink); }
.cap { margin: 22px 4px 8px; color: var(--text-secondary); font-size: 14px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.card { border-radius: 20px; padding: 16px 18px; display: flex; flex-direction: column; gap: 9px; }
.ct { margin: 0; font-weight: 600; font-size: 15px; }
.st { margin: 8px 0 0; color: var(--text-secondary); font-size: 13px; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
.row select, .row input { height: 38px; border-radius: 12px; padding: 0 10px; border: 1px solid rgba(0, 0, 0, .12); background: rgba(255, 255, 255, .75); font-size: 14px; }
.row input { flex: 1; min-width: 120px; }
.hint { color: var(--text-tertiary); font-size: 12.5px; }
.plist { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.plist li { display: flex; gap: 8px; align-items: baseline; font-size: 13px; padding: 4px 8px; border-radius: 10px; }
.plist li.on { background: rgba(0, 0, 0, .06); }
.plist small { color: var(--text-secondary); }
.win { display: flex; flex-direction: column; gap: 5px; }
.r2 { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; }
.r2.sm { font-size: 13px; color: var(--text-secondary); }
.r2.total { border-top: 1px solid rgba(0, 0, 0, .08); padding-top: 8px; font-size: 15px; }
.hb { display: grid; grid-template-columns: 110px 1fr 90px; gap: 8px; align-items: center; font-size: 13px; }
.hb small { text-align: right; color: var(--text-secondary); }
.lnk { font-size: 12.5px; color: var(--text-secondary); text-decoration: underline; margin-left: 6px; }
.wide2 { grid-column: 1 / -1; }
.live { color: #2e7d32; font-weight: 500; font-size: 12px; margin-left: 6px; }
.ev { display: grid; grid-template-columns: 90px 110px 150px 120px 150px 70px 90px; gap: 8px; font-size: 13px; padding: 4px 0; border-bottom: 1px solid rgba(0, 0, 0, .05); }
.ev.th { color: var(--text-secondary); font-size: 12px; }
.ev span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.err { margin-top: 14px; padding: 12px 16px; border-radius: 14px; color: #c62828; font-size: 14px; }
@media (max-width: 760px) { .kpis, .grid { grid-template-columns: 1fr 1fr; } .tr { grid-template-columns: 1.4fr 1fr 1fr; } .tr > span:nth-child(n+4):not(.r) { display: none; } }
</style>
