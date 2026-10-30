<script setup>
// Settings → 사용량·요금제: how much of each window I have used (this session, this week or month, the
// company's pool and extra usage), the plans (Process GPT's in credits and won, or Claude's / Hark's in
// dollars — server lib/plans/catalog.js),
// and for administrators the company: seats, per-person limits, requests, the month's estimated bill.
// Changing a plan applies it to LiteLLM at once; anyone else asks and the administrators are notified.
import { ref, computed, onMounted } from 'vue'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'

const b = ref(null)
const err = ref('')
const note = ref('')
const extra = ref('')
const busy = ref(false)
const sent = ref('')

async function load() {
  err.value = ''
  try {
    b.value = await api('/billing')
    const x = b.value?.subscription?.extra_usage_usd
    extra.value = x == null ? '' : String(credit.value ? Math.round(x / b.value.catalog.usdPerCredit) : x)
  } catch (e) { err.value = e.message }
}
onMounted(load)

const admin = computed(() => !!b.value?.admin)
const plans = computed(() => b.value?.catalog?.plans || [])
const current = computed(() => plans.value.find((p) => p.code === b.value?.subscription?.plan))
const loc = isEnglish ? 'en-US' : 'ko-KR'
const pct = (w) => (w && w.limit ? Math.min(100, Math.round((w.spent / w.limit) * 100)) : 0)
// amounts are model cost (USD); a credit catalog shows them as credits, its prices in won
const credit = computed(() => b.value?.catalog?.unit === 'credit')
const krw = computed(() => b.value?.catalog?.currency === 'KRW')
const usd = (n) => (credit.value ? `${Math.round(Number(n || 0) / b.value.catalog.usdPerCredit).toLocaleString(loc)}크레딧`
  : `$${Number(n || 0).toFixed(Number(n) < 1 ? 3 : 2)}`)
const money = (n) => (krw.value ? `₩${Math.round(Number(n || 0)).toLocaleString(loc)}` : `$${Number(n || 0).toFixed(2)}`)
const at = (t) => (t ? new Date(t).toLocaleString(loc, { month: 'short', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '')
const periodName = (w) => (w?.byAdmin ? '이번 달 (관리자 한도)' : b.value?.catalog?.pooled ? '이번 달 내 사용' : w?.duration === '30d' ? '이번 결제 기간' : '이번 주')
const price = (s) => {
  const p = s.price
  if (!p) return '협의'
  if (p.month == null && p.year != null) return `${money(p.year)}/월 (연간)`
  if (!p.month) return '무료'
  return p.year != null ? `${money(p.month)}/월 · 연간 ${money(p.year)}` : `${money(p.month)}/월`
}
const times = (s) => (s.credits != null ? `${s.credits.toLocaleString(loc)}크레딧/월` : s.x == null ? '사용량만큼' : `${s.x}배`)
const span = (l) => (l.from ? ` (${new Date(l.from).toLocaleDateString(loc, { month: 'numeric', day: 'numeric' })}–${new Date(new Date(l.to) - 1).toLocaleDateString(loc, { month: 'numeric', day: 'numeric' })}, ${Math.round(l.days)}일)` : '')
const billLine = (l) => (l.kind === 'seat' ? `${l.name} × ${l.count}석${span(l)}`
  : l.kind === 'vat' ? '부가세 (10%)'
  : l.kind === 'extra' ? (l.credits != null ? `충전 크레딧 ${l.credits.toLocaleString(loc)}` : '추가 사용량 (원가)')
  : (l.credits != null ? `사용량 ${l.credits.toLocaleString(loc)}크레딧` : '사용량 (원가)'))
// a Team seat without the plan's name in front (Team · Standard)
const short = (n) => String(n || '').replace(/^Team /, '')
// a window nobody has used yet has no reset time: it starts with the first use
const resets = (w) => (w.resetsAt ? `${at(w.resetsAt)}에 초기화` : '아직 사용 전')

async function choose(p) {
  busy.value = true; err.value = ''; sent.value = ''
  try {
    if (admin.value) await api('/billing/plan', { method: 'PUT', body: { plan: p.code } })
    else { await api('/billing/requests', { method: 'POST', body: { kind: 'plan', wanted: p.name, note: note.value } }); sent.value = p.code }
    await load()
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function askExtra() {
  err.value = ''
  try { await api('/billing/requests', { method: 'POST', body: { kind: 'extra_usage', wanted: '', note: note.value } }); sent.value = 'extra' } catch (e) { err.value = e.message }
}
async function saveExtra() {
  busy.value = true; err.value = ''
  const n = Number(extra.value) || 0
  try { await api('/billing/plan', { method: 'PUT', body: { plan: b.value.subscription.plan, ...(credit.value ? { extraCredits: n } : { extraUsageUsd: n }) } }); await load() } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function setSeat(p, seat, limit) {
  err.value = ''
  try { await api(`/billing/seats/${p.id}`, { method: 'PUT', body: { seat, ...(credit.value ? { limitCredits: limit } : { limitUsd: limit }) } }); await load() } catch (e) { err.value = e.message }
}
async function decide(r, ok) {
  err.value = ''
  try {
    if (!ok) await api(`/billing/requests/${r.id}/decline`, { method: 'POST' })
    else if (r.kind === 'plan') { const p = plans.value.find((x) => x.name === r.wanted); if (p) await api('/billing/plan', { method: 'PUT', body: { plan: p.code } }) }
    await load()
  } catch (e) { err.value = e.message }
}
</script>

<template>
  <div class="up">
    <p v-if="b && !b.enabled" class="hint">이 서버는 사용량 한도를 쓰지 않아요 (PRO_LLM_KEYS=litellm 으로 켭니다).</p>
    <template v-if="b?.enabled">
      <router-link v-if="b.operator" to="/backoffice" class="bo-link glass press">빌링 백오피스 (운영자) →</router-link>
      <p class="cap">내 사용량 <span class="chip">{{ current?.name }}{{ short(b.me.seatName) !== current?.name ? ` · ${short(b.me.seatName)}` : '' }}</span></p>
      <div class="card glass">
        <div v-if="b.me.session" class="win">
          <div class="row"><b>현재 세션</b><span>{{ pct(b.me.session) }}% 사용</span></div>
          <div class="bar"><i :style="{ width: pct(b.me.session) + '%' }" :class="{ full: pct(b.me.session) >= 100 }" /></div>
          <small>{{ resets(b.me.session) }} · 5시간마다</small>
        </div>
        <div v-if="b.me.period" class="win">
          <div class="row"><b>{{ periodName(b.me.period) }}</b><span>{{ pct(b.me.period) }}% 사용</span></div>
          <div class="bar"><i :style="{ width: pct(b.me.period) + '%' }" :class="{ full: pct(b.me.period) >= 100 }" /></div>
          <small>{{ resets(b.me.period) }}</small>
        </div>
        <div v-if="b.me.usageBased && !b.me.period" class="win"><b>사용한 만큼</b><small>한도는 회사 관리자가 정해요.</small></div>
        <div v-if="b.me.company" class="win">
          <div class="row"><b>회사 포함 크레딧 (이번 달)</b><span>{{ usd(b.me.company.spent) }} / {{ usd(b.me.company.limit) }}</span></div>
          <div class="bar"><i :style="{ width: pct(b.me.company) + '%' }" :class="{ full: pct(b.me.company) >= 100 }" /></div>
          <small>좌석마다 들어오는 크레딧을 회사가 함께 써요 · {{ resets(b.me.company) }}</small>
        </div>
        <div v-if="b.me.extra" class="win">
          <div class="row"><b>{{ b.catalog.pooled ? '충전 크레딧' : '회사 추가 사용량' }}</b><span>{{ usd(b.me.extra.spent) }} / {{ usd(b.me.extra.limit) }}</span></div>
          <div class="bar"><i :style="{ width: pct(b.me.extra) + '%' }" :class="{ full: pct(b.me.extra) >= 100 }" /></div>
          <small>{{ b.catalog.pooled ? '회사 포함 크레딧을 다 쓰면 이어서 써요' : '내 한도를 다 쓰면 이어서 써요' }} · 나는 {{ usd(b.me.extra.mine) }} 사용</small>
        </div>
        <p class="hint in">예약 작업·브라우저 에이전트·마이닝 같은 백그라운드 작업도 같은 한도를 써요.</p>
      </div>

      <p class="cap">요금제
        <small v-if="b.catalog.source" class="src">{{ b.catalog.title }} 요금제 기준 · <a :href="b.catalog.source" target="_blank" rel="noopener">출처</a></small>
        <small v-else-if="krw" class="src">1크레딧 = ₩10 · 부가세 별도</small>
      </p>
      <div class="plans">
        <div v-for="p in plans" :key="p.code" class="plan glass" :class="{ on: p.code === b.subscription.plan }">
          <div class="pn"><b>{{ p.name }}</b><span v-if="p.code === b.subscription.plan" class="chip">지금 요금제</span></div>
          <p class="pnote">{{ p.note }}</p>
          <ul>
            <li v-for="s in p.seats" :key="s.code"><span v-if="p.seats.length > 1" class="sn">{{ short(s.name) }}</span><span class="pr">{{ price(s) }}</span><span v-if="!p.fixedPool" class="x">{{ times(s) }}</span></li>
          </ul>
          <small v-if="p.fixedPool" class="seats">회사 전체 {{ p.fixedPool.toLocaleString() }}크레딧/월</small>
          <small v-if="p.minSeats" class="seats">{{ p.minSeats }}석부터{{ p.maxSeats ? ` · 최대 ${p.maxSeats}석` : '' }}</small>
          <button v-if="p.code !== b.subscription.plan" class="pill-btn" :disabled="busy || sent === p.code" @click="choose(p)">
            {{ admin ? '이 요금제로 변경' : sent === p.code ? '요청했어요' : '변경 요청' }}
          </button>
        </div>
      </div>
      <template v-if="!admin">
        <input v-model="note" class="note" placeholder="관리자에게 남길 말 (선택)" />
        <button v-if="current?.extraUsage && !b.me.extra" class="link" :disabled="sent === 'extra'" @click="askExtra">{{ sent === 'extra' ? '추가 사용량을 요청했어요' : '추가 사용량 요청' }}</button>
      </template>

      <template v-if="admin && b.company">
        <p class="cap">회사</p>
        <div v-if="current?.extraUsage || current?.usageBased" class="card glass">
          <div class="row"><b>{{ current.usageBased ? '회사 월 지출 한도' : credit ? '충전 크레딧 (월)' : '추가 사용량 (월 풀)' }}</b><small>0이면 {{ current.usageBased ? '한도 없음' : '꺼짐' }}</small></div>
          <form class="add" @submit.prevent="saveExtra"><input v-model="extra" type="number" min="0" :step="credit ? 100 : 0.01" :placeholder="credit ? '크레딧' : 'USD'" /><button class="pill-btn" :disabled="busy">저장</button></form>
          <small v-if="credit && Number(extra)">{{ money(Number(extra) * 10) }} 상당 · 쓴 만큼 청구</small>
        </div>

        <div v-if="b.requests?.length" class="list glass">
          <div v-for="r in b.requests" :key="r.id" class="li">
            <div class="main"><b>{{ r.name || r.email }}</b><small>{{ r.kind === 'plan' ? `요금제 → ${r.wanted}` : r.kind === 'seat' ? `좌석 → ${r.wanted}` : '추가 사용량' }}{{ r.note ? ` · ${r.note}` : '' }}</small></div>
            <button v-if="r.kind === 'plan'" class="pill-btn sm" @click="decide(r, true)">승인</button>
            <button class="rm" @click="decide(r, false)">거절</button>
          </div>
        </div>

        <div class="list glass people">
          <div v-for="p in b.company.people" :key="p.id" class="li">
            <div class="av">{{ (p.name || p.email).slice(0, 1) }}</div>
            <div class="main">
              <b>{{ p.name }}</b>
              <small>이번 달 {{ usd(p.month.spend) }} · {{ p.month.calls }}회<template v-if="p.session"> · 세션 {{ pct(p.session) }}%</template><template v-if="p.period"> · {{ periodName(p.period) }} {{ pct(p.period) }}%</template></small>
            </div>
            <select v-if="current?.seats.length > 1" :value="p.seat" @change="setSeat(p, $event.target.value, null)">
              <option v-for="s in current.seats" :key="s.code" :value="s.code">{{ short(s.name) }}</option>
            </select>
            <input v-if="current?.adminLimits" class="lim" type="number" min="0" :step="credit ? 100 : 0.01" :placeholder="credit ? '월 한도' : '월 한도 $'"
              :value="p.period?.byAdmin ? (credit ? Math.round(p.period.limit / b.catalog.usdPerCredit) : p.period.limit) : ''" @change="setSeat(p, p.seat, $event.target.value)" />
          </div>
        </div>

        <div class="card glass bill">
          <div class="row"><b>이번 달 예상 청구</b><b>{{ money(b.company.bill.total) }}</b></div>
          <div v-for="(l, i) in b.company.bill.lines" :key="i" class="row sm">
            <span>{{ billLine(l) }}</span><span>{{ l.contract ? '협의' : money(l.amount) }}</span>
          </div>
          <small>결제 대행 연동 전이라 실제 청구는 하지 않아요. 좌석은 {{ b.subscription.billing === 'year' ? '연간' : '월간' }} 단가예요.</small>
        </div>
      </template>
    </template>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
.cap { margin: 18px 4px 8px; color: var(--text-secondary); font-size: 14px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.src { color: var(--text-tertiary); font-size: 12px; }
.src a { color: inherit; text-decoration: underline; }
.hint { margin: -2px 4px 10px; color: var(--text-tertiary); font-size: 13px; line-height: 1.5; }
.hint.in { margin: 4px 0 0; }
.chip { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: rgba(0, 0, 0, .06); color: var(--text-secondary); }
.card { border-radius: 20px; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.win { display: flex; flex-direction: column; gap: 6px; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; font-size: 14px; }
.row b { font-weight: 500; }
.row.sm { font-size: 13px; color: var(--text-secondary); }
.win small, .card small { color: var(--text-tertiary); font-size: 12px; }
.bar { height: 8px; border-radius: 4px; background: rgba(0, 0, 0, .07); overflow: hidden; }
.bar i { display: block; height: 100%; border-radius: 4px; background: var(--ink); transition: width .4s; }
.bar i.full { background: #c62828; }
.plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; }
.plan { border-radius: 18px; padding: 14px; display: flex; flex-direction: column; gap: 6px; }
.plan.on { outline: 2px solid var(--ink); }
.pn { display: flex; justify-content: space-between; align-items: center; }
.pn b { font-size: 16px; font-weight: 600; }
.pnote { margin: 0; color: var(--text-secondary); font-size: 13px; line-height: 1.4; }
.plan ul { list-style: none; margin: 4px 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.plan li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; font-size: 13px; }
.plan li .sn { flex: 1 0 100%; color: var(--text-secondary); }
.plan li .pr, .plan li .x { white-space: nowrap; }
.plan .x { color: var(--text-tertiary); }
.seats { color: var(--text-tertiary); font-size: 12px; }
.plan .pill-btn { margin-top: auto; }
.note { width: 100%; height: 38px; border-radius: 12px; padding: 0 12px; margin-top: 10px; border: 1px solid rgba(0, 0, 0, .12); background: rgba(255, 255, 255, .7); }
.link { margin: 8px 4px; color: var(--text-secondary); font-size: 13px; text-decoration: underline; }
.list { border-radius: 20px; overflow: hidden; margin-top: 10px; }
.li { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid rgba(0, 0, 0, .06); }
.li:last-child { border-bottom: 0; }
.av { width: 34px; height: 34px; border-radius: 17px; background: var(--ink); color: var(--ink-inverse); display: grid; place-items: center; font-size: 15px; flex: none; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; text-align: left; }
.main b { font-weight: 500; font-size: 15px; }
.main small { color: var(--text-secondary); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.people { max-height: 420px; overflow-y: auto; }
select { max-width: 36%; height: 32px; border-radius: 10px; padding: 0 6px; background: rgba(255, 255, 255, .7); border: 1px solid rgba(0, 0, 0, .1); font-size: 13px; }
.lim { width: 86px; height: 32px; border-radius: 10px; padding: 0 8px; border: 1px solid rgba(0, 0, 0, .1); background: rgba(255, 255, 255, .7); font-size: 13px; }
.add { display: flex; gap: 8px; }
.add input { flex: 1; height: 36px; border-radius: 12px; padding: 0 12px; border: 1px solid rgba(0, 0, 0, .12); background: rgba(255, 255, 255, .7); }
.pill-btn.sm { padding: 4px 12px; font-size: 13px; }
.rm { color: var(--text-secondary); font-size: 13px; }
.bill { margin-top: 10px; gap: 6px; }
.err { color: #c62828; font-size: 13px; margin: 6px 4px; }
.bo-link { display: block; margin: 4px 0 6px; padding: 10px 14px; border-radius: 14px; font-size: 14px; text-decoration: none; color: var(--ink); }
</style>
