<script setup>
// Settings › 승인함: my approvals (and hand-overs) across the approval processes, in live critical-path order
// (server lib/improve/live.js): an item with no slack against its process's lead-time target — delaying it delays
// its request — comes first, whoever asked first. Each 구매 요청 item opens on its decision brief (BriefCard);
// other processes' approvals open on their form (TodoCard). Below: my own purchase requests, a form to raise one,
// and the before/after measurements of the scenario.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'
import BriefCard from './BriefCard.vue'
import TodoCard from './TodoCard.vue'

const items = ref(null)
const open = ref(null)
const err = ref('')
const mine = ref([])
const m = ref(null)
const showNew = ref(false)
const showMeasure = ref(false)
const form = ref({ item: '', quantity: 1, unitPrice: null, supplier: '', supplierNew: false, reason: '' })
const sending = ref(false)
const sent = ref('')
const loc = isEnglish ? 'en-US' : 'ko-KR'
const won = (n) => (n == null ? '-' : `₩${Math.round(n).toLocaleString(loc)}`)
const hrs = (s) => (s == null ? '-' : s >= 86400 ? (isEnglish ? `${(s / 86400).toFixed(1)} days` : `${(s / 86400).toFixed(1)}일`) : s >= 3600 ? (isEnglish ? `${(s / 3600).toFixed(1)} hrs` : `${(s / 3600).toFixed(1)}시간`) : isEnglish ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.max(1, Math.round(s / 60))}분`)
const hours = (s) => (isEnglish ? `${(s / 3600).toFixed(1)} hrs` : `${(s / 3600).toFixed(1)}시간`)
const amount = computed(() => (Number(form.value.quantity) || 0) * (Number(form.value.unitPrice) || 0))

async function load({ keepOpen = true } = {}) {
  err.value = ''
  try {
    const r = await api('/purchase/inbox')
    items.value = r.items
    if (!keepOpen || !r.items.some((x) => x.todoId === open.value)) open.value = r.items[0]?.todoId || null
  } catch (e) { err.value = e.message }
  try { mine.value = (await api('/purchase/requests')).requests } catch { /* none */ }
}
let timer = null
onMounted(() => { load({ keepOpen: false }); timer = setInterval(() => load(), 15000) })
onUnmounted(() => clearInterval(timer))

async function loadMeasure() {
  showMeasure.value = !showMeasure.value
  if (showMeasure.value && !m.value) m.value = await api('/purchase/measure').catch((e) => ({ error: e.message }))
}
async function submitRequest() {
  sending.value = true; err.value = ''; sent.value = ''
  try {
    const r = await api('/purchase/requests', { method: 'POST', body: form.value })
    sent.value = r.instName || '요청했어요'
    form.value = { item: '', quantity: 1, unitPrice: null, supplier: '', supplierNew: false, reason: '' }
    showNew.value = false
    setTimeout(() => load(), 4000)
  } catch (e) { err.value = e.message } finally { sending.value = false }
}
const where = (r) => (r.status === 'COMPLETED' ? (r.rejected ? '반려됨' : r.order?.status === 'placed' ? `발주 완료 · ${r.order.poNo}` : '끝남')
  : r.current?.includes('finance_approval') ? '재무 승인 대기' : r.current?.includes('order') ? '발주 대기' : '팀장 승인 대기')
const isPurchase = (x) => x.defId?.toLowerCase() === 'agentic_purchase_request'
</script>

<template>
  <div class="ai">
    <p class="hint">주공정 위에 있는 승인부터 보여 줘요. 순서는 진행 중인 요청마다 남은 주공정(기록된 단계 시간으로 계산한 크리티컬 패스)과 목표 리드타임의 여유로 정해요 — 먼저 온 순서가 아니에요.</p>

    <p class="cap">내 승인 <span v-if="items" class="chip">{{ items.length }}</span></p>
    <div v-if="!items" class="list glass"><div class="li"><span class="shimmer-text">불러오는 중</span></div></div>
    <div v-else-if="!items.length" class="list glass"><div class="li"><div class="main"><b>지금 결정할 일이 없어요</b><small>새 승인이 오면 결정 브리프와 함께 여기와 채팅에 와요.</small></div></div></div>
    <div v-else class="list glass">
      <div v-for="x in items" :key="x.todoId" class="row" :class="{ on: open === x.todoId }">
        <button class="li press" @click="open = open === x.todoId ? null : x.todoId">
          <div class="rank" :class="{ crit: x.critical }">{{ x.rank }}</div>
          <div class="main">
            <b>{{ x.brief?.summary?.item || x.instName }}<span v-if="x.brief?.summary?.amount" class="amt">{{ won(x.brief.summary.amount) }}</span></b>
            <small class="why" :class="{ crit: x.critical }">{{ x.reason }}</small>
          </div>
          <span class="chip step">{{ x.activityName }}</span>
        </button>
        <div v-if="open === x.todoId" class="body blur-in">
          <BriefCard v-if="isPurchase(x) && x.brief" :brief="x.brief" compact @decided="load()" />
          <p v-else-if="isPurchase(x) && x.briefError" class="err">{{ x.briefError }}</p>
          <TodoCard v-else :todo-id="x.todoId" @submitted="load()" />
          <small class="path">남은 주공정: {{ x.pathNames.join(' → ') || '—' }} · 목표 리드타임 {{ hrs(x.targetSec) }} · {{ x.defName }}</small>
        </div>
      </div>
    </div>
    <p v-if="err" class="err">{{ err }}</p>

    <template v-if="mine.length">
      <p class="cap">내 구매 요청</p>
      <div class="list glass">
        <div v-for="r in mine" :key="r.instId" class="li">
          <div class="main"><b>{{ r.item }} × {{ r.quantity }}<span class="amt">{{ won(r.amount) }}</span></b><small>{{ r.supplier }}</small></div>
          <span class="chip" :class="{ ok: r.order?.status === 'placed', bad: r.rejected }">{{ where(r) }}</span>
        </div>
      </div>
    </template>

    <button class="pill-btn add" @click="showNew = !showNew">{{ showNew ? '닫기' : '+ 구매 요청 올리기' }}</button>
    <p v-if="sent" class="hint ok">{{ sent }} — 팀장에게 결정 브리프가 갔어요.</p>
    <form v-if="showNew" class="card glass new" @submit.prevent="submitRequest">
      <input v-model="form.item" placeholder="품목 (예: 27인치 모니터)" required />
      <div class="two">
        <label>수량<input v-model.number="form.quantity" type="number" min="1" required /></label>
        <label>단가(원)<input v-model.number="form.unitPrice" type="number" min="1" required /></label>
      </div>
      <div class="two">
        <input v-model="form.supplier" placeholder="공급사" required />
        <label class="ck"><input v-model="form.supplierNew" type="checkbox" />신규 공급사</label>
      </div>
      <input v-model="form.reason" placeholder="구매 사유" />
      <div class="foot"><small>금액 {{ won(amount) }}{{ amount > 10000000 ? ' · 1,000만 원 초과: 재무 승인까지' : '' }}</small><button class="pill-btn sm primary" :disabled="sending">요청</button></div>
    </form>

    <button class="link" @click="loadMeasure">{{ showMeasure ? '측정 닫기' : '승인 대기·리드타임 측정 보기' }}</button>
    <div v-if="showMeasure && m && !m.error" class="card glass meas">
      <div class="mr head"><span /><b>기존 이력</b><b>브리프·선행 실행 후</b></div>
      <div class="mr"><span>인스턴스</span><span>{{ m.before.instances }}</span><span>{{ m.after.instances }}</span></div>
      <div class="mr"><span>리드타임 중앙값</span><span>{{ hrs(m.before.leadTime.median) }}</span><span>{{ hrs(m.after.leadTime.median) }}</span></div>
      <div class="mr"><span>승인 대기 중앙값 (건당 합)</span><span>{{ hrs(m.before.approvalWait.perInstance.median) }}</span><span>{{ hrs(m.after.approvalWait.perInstance.median) }}</span></div>
      <div class="mr"><span>팀장 승인 대기</span><span>{{ hrs(m.before.approvalWait.lead.median) }}</span><span>{{ hrs(m.after.approvalWait.lead.median) }}</span></div>
      <div class="mr"><span>재무 승인 대기</span><span>{{ hrs(m.before.approvalWait.finance.median) }}</span><span>{{ hrs(m.after.approvalWait.finance.median) }}</span></div>
      <div class="mr"><span>what-if 「사전 초안」 예측</span><span class="wide">{{ hours(m.prediction.all.beforeSec) }} → {{ hours(m.prediction.all.afterSec) }} ({{ Math.round((m.prediction.all.afterSec / m.prediction.all.beforeSec - 1) * 1000) / 10 }}%)</span></div>
      <small>시드한 이력으로 만든 PoC 예요. 「후」는 스크립트·시연으로 돌린 건이라 사람이 몇 초 만에 결정해요 — 동작을 보여 줄 뿐, 실제 승인자가 얼마나 빨라질지는 아니에요.</small>
    </div>
  </div>
</template>

<style scoped>
.cap { margin: 18px 4px 8px; color: var(--text-secondary); font-size: 14px; display: flex; align-items: center; gap: 8px; }
.hint { margin: 2px 4px 6px; color: var(--text-tertiary); font-size: 13px; line-height: 1.5; }
.hint.ok { color: #2e7d32; }
.chip { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: rgba(0, 0, 0, .06); color: var(--text-secondary); white-space: nowrap; }
.chip.ok { background: rgba(46, 125, 50, .12); color: #2e7d32; }
.chip.bad { background: rgba(198, 40, 40, .1); color: #c62828; }
.list { border-radius: 20px; overflow: hidden; }
.row { border-bottom: 1px solid rgba(0, 0, 0, .06); }
.row:last-child { border-bottom: 0; }
.row.on { background: rgba(255, 255, 255, .25); }
.li { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 14px; text-align: left; border-bottom: 1px solid rgba(0, 0, 0, .06); }
.row .li, .li:last-child { border-bottom: 0; }
.rank { width: 30px; height: 30px; border-radius: 15px; flex: none; display: grid; place-items: center; font-size: 14px; font-weight: 600; background: rgba(0, 0, 0, .07); color: var(--text-secondary); }
.rank.crit { background: #e67e22; color: #fff; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.main b { font-weight: 500; font-size: 15px; display: flex; gap: 8px; align-items: baseline; }
.amt { color: var(--text-secondary); font-weight: 400; font-size: 13px; }
.main small { color: var(--text-secondary); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.why.crit { color: #b35c00; font-weight: 500; }
.step { flex: none; }
.body { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.path { color: var(--text-tertiary); font-size: 12px; padding: 0 4px; }
.err { color: #c62828; font-size: 13px; margin: 6px 4px; }
.add { margin-top: 14px; height: 40px; font-size: 14px; }
.card { border-radius: 20px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.new input:not([type="checkbox"]) { width: 100%; height: 38px; border-radius: 12px; padding: 0 12px; border: 1px solid var(--hairline); background: var(--field-bg); }
.two { display: flex; gap: 8px; }
.two > * { flex: 1; }
.two label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--text-secondary); }
.two label input { color: var(--text-primary); font-size: 15px; }
.ck { flex-direction: row !important; align-items: center; gap: 6px !important; font-size: 14px !important; }
.foot { display: flex; justify-content: space-between; align-items: center; }
.foot small { color: var(--text-secondary); font-size: 13px; }
.pill-btn.sm { height: 34px; padding: 0 16px; font-size: 13.5px; }
.pill-btn.primary { background: #1d1d1f; color: #f5f5f7; }
:root[data-theme="dark"] .pill-btn.primary { background: #f5f5f7; color: #1d1d1f; }
.link { margin: 14px 4px 0; color: var(--text-secondary); font-size: 13px; text-decoration: underline; }
.meas { gap: 6px; }
.mr { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 8px; font-size: 13.5px; }
.mr span:first-child { color: var(--text-secondary); }
.mr.head b { font-weight: 500; font-size: 12.5px; color: var(--text-secondary); }
.mr .wide { grid-column: span 2; }
.meas small { color: var(--text-tertiary); font-size: 12px; line-height: 1.5; margin-top: 4px; white-space: normal; overflow: visible; text-overflow: clip; }
</style>
