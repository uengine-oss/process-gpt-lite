<script setup>
// A decision brief or a hand-over package (server lib/scenarios/purchase/brief.js), prepared before the person
// opens the work item: the request in a few lines, where it stands in the approval queue (live critical path),
// the options with what each changes (extra approvals from a policy dry run, the remaining lead time if decided
// now), the recommendation with its evidence, and what already ran before approval (the order draft and a stock
// check — demo data). One click decides, or places the order from the draft. Shown as a chat card (kind 'brief'),
// in Settings › 승인함 and above the work item's form.
import { computed, ref, onMounted } from 'vue'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'

const props = defineProps({ msg: Object, brief: Object, compact: Boolean, actions: { type: Boolean, default: true } })
const emit = defineEmits(['decided'])
const b = ref(props.brief || props.msg?.content?.brief || null)
const todoId = computed(() => b.value?.todoId || props.msg?.content?.todoId)
const busy = ref(false)
const err = ref('')
const comment = ref('')
const qty = ref(null)
const loc = isEnglish ? 'en-US' : 'ko-KR'

onMounted(async () => {
  // a chat card shows what it was posted with, then the brief as it is now (decided, draft cancelled …)
  if (props.msg && todoId.value) {
    try { const r = await api(`/purchase/briefs/${todoId.value}`); if (r.brief) b.value = r.brief } catch { /* keep the snapshot */ }
  }
  qty.value = b.value?.options?.find((o) => o.id === 'adjust')?.quantity ?? null
})

const s = computed(() => b.value?.summary || {})
const won = (n) => (n == null ? '-' : `₩${Math.round(n).toLocaleString(loc)}`)
const dur = (sec) => {
  const x = Math.max(0, sec || 0)
  if (x >= 86400) return isEnglish ? `${(x / 86400).toFixed(1)} days` : `${(x / 86400).toFixed(1)}일`
  if (x >= 3600) return isEnglish ? `${Math.round(x / 3600)} hrs` : `${Math.round(x / 3600)}시간`
  return isEnglish ? `${Math.max(1, Math.round(x / 60))} min` : `${Math.max(1, Math.round(x / 60))}분`
}
const time = (t) => (t ? new Date(t).toLocaleString(loc, { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const handover = computed(() => b.value?.kind === 'handover')
const recId = computed(() => b.value?.recommendation?.option)
const labelOf = (id) => b.value?.options?.find((o) => o.id === id)?.label || id
const decided = computed(() => b.value?.decidedOption || b.value?.decision?.option || null)
const canAct = computed(() => props.actions && !decided.value && b.value?.state === 'ready')
const STATUS = { done: '준비됨', used: '발주에 사용', cancelled: '취소됨', blocked: '막힘' }
const DECIDED = { approve: '승인했어요', adjust: '수량을 조정해 승인했어요', reject: '반려했어요', place: '발주했어요' }

async function choose(o) {
  busy.value = true; err.value = ''
  try {
    const r = await api(`/purchase/briefs/${todoId.value}/decide`, { method: 'POST', body: { option: o.id, quantity: o.id === 'adjust' ? qty.value : undefined, comment: comment.value } })
    b.value = r.brief
    emit('decided', r)
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function place() {
  busy.value = true; err.value = ''
  try {
    const r = await api(`/purchase/orders/${encodeURIComponent(b.value.instId)}/place`, { method: 'POST', body: { note: comment.value || undefined } })
    const fresh = await api(`/purchase/briefs/${todoId.value}`)
    if (fresh.brief) b.value = fresh.brief
    emit('decided', r)
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div v-if="b && b.state === 'ready'" class="bc glass" :class="{ compact, handover, crit: b.live?.critical, closed: decided, rejected: decided === 'reject' }">
    <div class="hd">
      <span class="chip kind">{{ handover ? '인계 꾸러미' : '결정 브리프' }}</span>
      <b>{{ b.stepName }}</b>
      <span class="inst">{{ b.instName }}</span>
    </div>
    <p v-if="b.live && !decided" class="live" :class="{ crit: b.live.critical }"><span class="dot" />{{ b.live.reason }}</p>

    <div class="sum">
      <div class="big"><b>{{ s.item }}</b><span class="x">×</span><span>{{ s.quantity }}</span><span class="sep">·</span><b>{{ won(s.amount) }}</b></div>
      <small>
        <span>{{ s.supplier }}</span><span v-if="s.supplierNew" class="chip warn">신규 공급사</span>
        <span class="sep">·</span><span>요청자 {{ s.requester }}</span><template v-if="s.reason"><span class="sep">·</span><span>{{ s.reason }}</span></template>
      </small>
      <small v-if="handover && s.requestedQuantity && s.requestedQuantity !== s.quantity" class="adj">요청 {{ s.requestedQuantity }}개 → 승인 {{ s.quantity }}개</small>
    </div>

    <ul v-if="(b.previous || b.decisions || []).length" class="prev">
      <li v-for="(d, i) in b.previous || b.decisions" :key="i">
        <span class="chip" :class="d.decision === '반려' ? 'bad' : 'ok'">{{ d.decision }}</span>
        <span><b>{{ d.step }}</b> · {{ d.by }}<template v-if="d.at"> · {{ time(d.at) }}</template></span>
        <small v-if="d.comment">“{{ d.comment }}”</small>
      </li>
    </ul>

    <!-- decision brief: recommendation, then the options -->
    <div v-if="!handover && b.recommendation" class="rec">
      <div class="rh"><span class="chip ok">추천</span><b>{{ labelOf(b.recommendation.option) }}</b><small class="by">{{ b.recommendation.by === 'model' ? 'AI가 쓴 문장 · 근거 숫자는 기록에서 계산' : '규칙 기반 추천' }}</small></div>
      <p>{{ b.recommendation.text }}</p>
      <ul v-if="!compact" class="ev"><li v-for="(e, i) in b.recommendation.evidence" :key="i">{{ e }}</li></ul>
    </div>

    <div v-if="!handover" class="opts">
      <div v-for="o in b.options" :key="o.id" class="opt" :class="{ rec: o.id === recId, chosen: decided === o.id, faded: decided && decided !== o.id }">
       <div class="oc">
        <div class="ot">
          <b>{{ o.label }}</b>
          <span v-if="o.amount" class="amt">{{ o.quantity }}개 · {{ won(o.amount) }}</span>
        </div>
        <small v-if="o.basis" class="basis">{{ o.basis }}</small>
        <div class="eff">
          <span v-if="o.id === 'reject'">지금 끝나요</span>
          <span v-else-if="o.effects.remainingSec != null">남은 리드타임 <b>{{ dur(o.effects.remainingSec) }}</b></span>
          <span v-if="o.id !== 'reject' && o.effects.savedSec > 600" class="good">평소보다 {{ dur(o.effects.savedSec) }} 빨리</span>
          <span v-if="o.effects.next?.length">다음: {{ o.effects.next.join(' → ') }}</span>
          <span v-for="a in o.effects.approvals.filter((x) => !x.current)" :key="a.policy" class="chip warn" :title="a.explain?.[isEnglish ? 1 : 0]">+ {{ a.role }}{{ a.when ? ` · ${a.when}` : '' }}</span>
          <span v-if="o.id !== 'reject' && !o.effects.approvals.filter((x) => !x.current).length" class="chip muted">추가 승인 없음</span>
          <span v-if="o.effects.compensation" class="chip muted">{{ o.effects.compensation }}</span>
        </div>
       </div>
        <div v-if="canAct" class="act">
          <label v-if="o.id === 'adjust'" class="qty"><input v-model.number="qty" type="number" min="1" :max="s.quantity" aria-label="승인 수량" />개</label>
          <button class="pill-btn sm" :class="{ primary: o.id === recId, danger: o.id === 'reject' }" :disabled="busy" @click="choose(o)">{{ o.label }}</button>
        </div>
      </div>
    </div>

    <!-- hand-over: the reasons, the checks, the draft, one click -->
    <template v-if="handover">
      <div v-if="b.reasons?.length" class="rec why-box"><div class="rh"><span class="chip ok">결정 근거</span><small class="by">앞 단계 결정 브리프의 추천</small></div><ul class="ev"><li v-for="(r, i) in b.reasons" :key="i">{{ r }}</li></ul></div>
      <ul v-if="b.checks?.length" class="checks"><li v-for="(c, i) in b.checks" :key="i"><span class="chip warn">확인</span>{{ c.text }}</li></ul>
      <div v-if="b.draft" class="po">
        <div class="ot"><b>{{ b.draft.poNo }}</b><span class="chip" :class="b.draft.status">{{ { draft: '초안', placed: '발주됨', cancelled: '취소됨' }[b.draft.status] }}</span></div>
        <small>{{ b.draft.item }} {{ b.draft.quantity }}개 · {{ won(b.draft.amount) }} · {{ b.draft.supplier }}<template v-if="b.draft.stock"> · 납기 {{ b.draft.stock.deliveryBy }}</template></small>
      </div>
      <div v-if="canAct" class="act end">
        <span v-if="b.options?.[0]?.effects?.remainingSec != null && b.options[0].effects.remainingSec >= 300" class="hint">지금 발주하면 남은 리드타임 <b>{{ dur(b.options[0].effects.remainingSec) }}</b></span>
        <span v-else class="hint">지금 발주하면 요청이 끝나요</span>
        <button class="pill-btn sm primary" :disabled="busy" @click="place">초안대로 발주</button>
      </div>
    </template>

    <div v-if="b.speculative?.length" class="spec">
      <p class="cap">{{ handover ? '승인 전에 미리 해 둔 일' : '승인 전에 미리 해 둔 일 (되돌릴 수 있는 준비)' }}</p>
      <div v-for="x in b.speculative" :key="x.id" class="sx" :class="x.status">
        <span class="chip" :class="x.status">{{ STATUS[x.status] || x.status }}</span>
        <div class="sm"><b>{{ x.title }}</b><small>{{ x.text }}</small>
          <small v-if="x.status === 'cancelled' && x.cancelReason" class="why">{{ x.cancelReason }} — 보상으로 취소</small>
          <small v-else-if="x.undo && x.status === 'done'" class="why">{{ x.undo }}</small>
          <small v-if="x.note" class="demo">{{ x.note }}</small>
        </div>
      </div>
    </div>

    <input v-if="canAct && !compact" v-model="comment" class="cmt" :placeholder="handover ? '발주 메모 (선택)' : '의견 (선택)'" />
    <p v-if="decided" class="done"><span class="chip ok">결정됨</span>{{ DECIDED[decided] || decided }}<template v-if="b.decision?.by"> · {{ b.decision.by }}</template><template v-if="b.decision?.at"> · {{ time(b.decision.at) }}</template><template v-if="b.decision?.via === 'form'"> · 양식에서</template></p>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
  <div v-else-if="b" class="bc glass building"><span class="shimmer-text">결정 브리프를 만드는 중</span></div>
</template>

<style scoped>
.bc { border-radius: 20px; padding: 14px 16px; max-width: 560px; display: flex; flex-direction: column; gap: 10px; border-left: 4px solid rgba(0, 0, 0, .12); text-align: left; container-type: inline-size; }
.bc.crit { border-left-color: #e67e22; }
.bc.handover { border-left-color: #1565c0; }
.bc.closed { border-left-color: #2e7d32; }
.bc.rejected { border-left-color: #c62828; }
.bc.compact { max-width: 100%; }
.hd { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 15px; }
.hd b { font-weight: 600; }
.inst { color: var(--text-secondary); font-size: 13px; }
.live { margin: -2px 0 0; display: flex; align-items: center; gap: 7px; font-size: 13px; color: var(--text-secondary); }
.live.crit { color: #b35c00; font-weight: 500; }
.dot { width: 7px; height: 7px; border-radius: 4px; background: currentColor; opacity: .7; flex: none; }
.sum { display: flex; flex-direction: column; gap: 3px; }
.big { font-size: 17px; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.big b { font-weight: 600; }
.x, .sep { color: var(--text-tertiary); }
.sum small { color: var(--text-secondary); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.adj { color: #1565c0 !important; }
.chip { display: inline-block; font-size: 11.5px; padding: 1px 8px; border-radius: 9px; background: rgba(0, 0, 0, .06); color: var(--text-secondary); white-space: nowrap; }
.chip.kind { background: var(--ink); color: var(--ink-inverse); }
.chip.ok, .chip.done, .chip.used, .chip.placed { background: rgba(46, 125, 50, .12); color: #2e7d32; }
.chip.warn { background: rgba(230, 126, 34, .15); color: #b35c00; }
.chip.bad, .chip.cancelled, .chip.blocked { background: rgba(198, 40, 40, .1); color: #c62828; }
.chip.draft { background: rgba(21, 101, 192, .12); color: #1565c0; }
.chip.muted { background: rgba(0, 0, 0, .05); }
.prev, .ev, .checks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.prev li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; font-size: 13px; }
.prev small { flex: 1 0 100%; color: var(--text-secondary); padding-left: 2px; }
.rec { border-radius: 14px; padding: 10px 12px; background: rgba(46, 125, 50, .06); display: flex; flex-direction: column; gap: 6px; }
.rh { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rh b { font-weight: 600; font-size: 14.5px; }
.rh .by { margin-left: auto; color: var(--text-tertiary); font-size: 11.5px; }
.rec p { margin: 0; font-size: 14px; line-height: 1.5; }
.ev li { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; padding-left: 12px; position: relative; }
.ev li::before { content: '·'; position: absolute; left: 3px; }
.opts { display: flex; flex-direction: column; border-radius: 14px; overflow: hidden; border: 1px solid rgba(0, 0, 0, .07); }
.opt { padding: 10px 12px; display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 6px 14px; border-bottom: 1px solid rgba(0, 0, 0, .06); }
.oc { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.opt:last-child { border-bottom: 0; }
.opt.rec { background: rgba(46, 125, 50, .045); }
.opt.chosen { background: rgba(46, 125, 50, .1); }
.opt.faded { opacity: .45; }
.ot { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.ot b { font-weight: 600; font-size: 14.5px; }
.amt { font-size: 13px; color: var(--text-secondary); }
.basis { color: var(--text-tertiary); font-size: 12px; }
.eff { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; font-size: 12.5px; color: var(--text-secondary); }
.eff b { color: var(--text-primary); font-weight: 600; }
.good { color: #2e7d32; }
.act { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.act.end { justify-content: space-between; }
.hint { font-size: 12.5px; color: var(--text-secondary); }
.qty { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--text-secondary); }
.qty input { width: 64px; height: 32px; border-radius: 10px; padding: 0 8px; border: 1px solid var(--hairline); background: var(--field-bg); font-size: 14px; }
/* a narrow card (the work item's, a phone): the buttons go under the option */
@container (max-width: 400px) {
  .opt { grid-template-columns: 1fr; }
  .act { justify-content: flex-start; }
}
.pill-btn.sm { height: 34px; padding: 0 16px; font-size: 13.5px; }
.pill-btn.primary { background: #1d1d1f; color: #f5f5f7; }
:root[data-theme="dark"] .pill-btn.primary { background: #f5f5f7; color: #1d1d1f; }
.pill-btn.danger { color: #c62828; }
.pill-btn:disabled { opacity: .45; cursor: default; }
.checks li { font-size: 13px; display: flex; gap: 6px; align-items: baseline; }
.po { border-radius: 14px; padding: 10px 12px; border: 1px dashed rgba(21, 101, 192, .35); display: flex; flex-direction: column; gap: 3px; }
.po small { color: var(--text-secondary); font-size: 13px; }
.po .ot { align-items: center; }
.why-box { background: rgba(21, 101, 192, .06); }
.spec { display: flex; flex-direction: column; gap: 6px; border-top: 1px solid rgba(0, 0, 0, .06); padding-top: 8px; }
.cap { margin: 0; color: var(--text-secondary); font-size: 12.5px; }
.sx { display: flex; gap: 8px; align-items: flex-start; }
.sx .chip { margin-top: 2px; }
.sx .sm { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.sx b { font-size: 13.5px; font-weight: 500; }
.sx small { font-size: 12.5px; color: var(--text-secondary); }
.sx.cancelled b, .sx.cancelled small:first-of-type { text-decoration: line-through; text-decoration-color: rgba(198, 40, 40, .5); }
.sx .why { color: var(--text-tertiary); }
.sx .demo { color: #b35c00; font-size: 11.5px; }
.cmt { height: 36px; border-radius: 12px; padding: 0 12px; border: 1px solid var(--hairline); background: var(--field-bg); font-size: 14px; }
.done { margin: 0; font-size: 13.5px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.err { color: #c62828; font-size: 13px; margin: 0; }
.building { padding: 14px 16px; font-size: 14px; }
</style>
