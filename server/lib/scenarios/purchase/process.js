// 「구매 요청」 — the Agentic BPM PoC's purchase scenario (pgpt-pro/docs/agentic-bpm/plan.md §5 P2, §6 scenario 2).
// The definition (saved with process-gpt's own save path by scripts/seed-purchase-demo.mjs) and a deterministic
// simulation of three months of history, the shape seed-improve-demo.mjs writes:
//   구매 요청(요청자) → 팀장 승인(팀장) → [승인 · 1,000만 원 초과] 재무 승인(재무 책임자) → 발주(구매 담당)
//                                     → [승인 · 1,000만 원 이하] 발주          → [반려] 반려 종료
// The gateways carry an expression (sequence properties.conditionFunction) that process-gpt's polling service
// evaluates without a model call, so a ₩15M request goes to finance every time. The approvers are busy people:
// 장진영 looks at approvals at the start and the end of his day, 이도윤 twice a day, so requests wait — the wait
// the decision brief and the speculative preparation (lib/scenarios/purchase/brief.js) are meant to cut.
import crypto from 'node:crypto'

export const DEF_ID = 'agentic_purchase_request'
export const DEF_NAME = '구매 요청'
export const VERSION = '1.0'
export const FINANCE_THRESHOLD = 10_000_000
export const ACT = { request: 'request', lead: 'lead_approval', finance: 'finance_approval', order: 'order' }
export const APPROVAL_STEPS = [ACT.lead, ACT.finance]
export const ROLES = { requester: '요청자', lead: '팀장', finance: '재무 책임자', buyer: '구매 담당' }
export const formId = (act) => `${DEF_ID}_${act}_form`
export const SEED_MARK = { seed: 'purchase-demo' }
export const APPROVE = '승인'
export const REJECT = '반려'

export const FORMS = {
  request: [
    { key: 'item', text: '품목', type: 'text' },
    { key: 'quantity', text: '수량', type: 'number' },
    { key: 'unit_price', text: '단가(원)', type: 'number' },
    { key: 'amount', text: '금액(원)', type: 'number' },
    { key: 'supplier', text: '공급사', type: 'text' },
    { key: 'supplier_new', text: '신규 공급사 여부', type: 'radio', items: [{ 예: '예' }, { 아니오: '아니오' }] },
    { key: 'reason', text: '구매 사유', type: 'textarea' },
  ],
  lead_approval: [
    { key: 'lead_decision', text: '결정', type: 'radio', items: [{ 승인: '승인' }, { 반려: '반려' }] },
    { key: 'approved_quantity', text: '승인 수량', type: 'number' },
    { key: 'approved_amount', text: '승인 금액(원)', type: 'number' },
    { key: 'lead_comment', text: '의견', type: 'textarea' },
  ],
  finance_approval: [
    { key: 'finance_decision', text: '결정', type: 'radio', items: [{ 승인: '승인' }, { 반려: '반려' }] },
    { key: 'finance_comment', text: '의견', type: 'textarea' },
  ],
  order: [
    { key: 'po_number', text: '발주 번호', type: 'text' },
    { key: 'order_quantity', text: '발주 수량', type: 'number' },
    { key: 'order_amount', text: '발주 금액(원)', type: 'number' },
    { key: 'delivery_date', text: '납기 예정일', type: 'text' },
    { key: 'order_note', text: '발주 메모', type: 'textarea' },
  ],
}

const tag = { text: 'text-field', number: 'text-field', radio: 'radio-field', textarea: 'textarea-field' }
function formHtml(id, alias, fs) {
  return `<section>\n${fs.map((f) => {
    const t = tag[f.type] || 'text-field'
    const items = f.items ? ` is_dynamic_load='fixed' items='${JSON.stringify(f.items)}'` : ''
    const type = t === 'text-field' ? ` type='${f.type === 'number' ? 'number' : 'text'}'` : ''
    return `  <row-layout name="${id}" alias="${alias}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><${t} name='${f.key}' alias='${f.text}'${type}${items} disabled='false' readonly='false' v-model="slotProps.modelValue['${f.key}']"></${t}></div></div></row-layout>`
  }).join('\n')}\n</section>`
}

// the branch rules: a Python expression over the forms' values (polling evaluates it with no builtins);
// the condition text is what people read on the diagram
const RULES = {
  seq_lead_reject: [`lead_decision == '${REJECT}'`, '반려'],
  seq_lead_finance: [`lead_decision == '${APPROVE}' and approved_amount > ${FINANCE_THRESHOLD}`, '승인 · 1,000만 원 초과'],
  seq_lead_order: [`lead_decision == '${APPROVE}' and approved_amount <= ${FINANCE_THRESHOLD}`, '승인 · 1,000만 원 이하'],
  seq_fin_order: [`finance_decision == '${APPROVE}'`, '재무 승인'],
  seq_fin_reject: [`finance_decision == '${REJECT}'`, '재무 반려'],
}

/** process-gpt generation contract (elements[]) for save_contract; people = {requester, lead, finance, buyer} ids */
export function contract(people = {}) {
  const A = (id, name, role, description) => ({ elementType: 'Activity', id, name, role, type: 'UserActivity', tool: `formHandler:${formId(id)}`, duration: 1, inputData: [], outputData: [name], checkpoints: [], skills: [], description, instruction: '', agentMode: 'none' })
  const S = (id, source, target) => {
    const r = RULES[id]
    return { elementType: 'Sequence', id, source, target, condition: r?.[1] || '', ...(r ? { name: r[1], properties: { conditionFunction: r[0] } } : {}) }
  }
  const elements = [
    { elementType: 'Event', id: 'start', name: '구매 필요', role: ROLES.requester, type: 'StartEvent' },
    A(ACT.request, '구매 요청', ROLES.requester, '품목·수량·금액·공급사와 구매 사유를 적어 요청해요.'),
    A(ACT.lead, '팀장 승인', ROLES.lead, '요청 내용과 예산을 보고 승인하거나 수량을 조정하거나 반려해요.'),
    { elementType: 'Gateway', id: 'gw_lead', name: '팀장 결정', role: ROLES.lead, type: 'ExclusiveGateway', gateWayType: 'bpmn:exclusiveGateway' },
    A(ACT.finance, '재무 승인', ROLES.finance, '1,000만 원을 넘는 구매를 예산·회계 기준으로 확인해 승인하거나 반려해요.'),
    { elementType: 'Gateway', id: 'gw_finance', name: '재무 결정', role: ROLES.finance, type: 'ExclusiveGateway', gateWayType: 'bpmn:exclusiveGateway' },
    A(ACT.order, '발주', ROLES.buyer, '승인된 요청으로 공급사에 발주서를 보내요.'),
    { elementType: 'Event', id: 'end', name: '발주 완료', role: ROLES.buyer, type: 'EndEvent' },
    { elementType: 'Event', id: 'end_rejected', name: '반려 종료', role: ROLES.lead, type: 'EndEvent' },
    S('seq_start', 'start', ACT.request), S('seq_request', ACT.request, ACT.lead), S('seq_lead_gw', ACT.lead, 'gw_lead'),
    S('seq_lead_reject', 'gw_lead', 'end_rejected'), S('seq_lead_finance', 'gw_lead', ACT.finance), S('seq_lead_order', 'gw_lead', ACT.order),
    S('seq_fin_gw', ACT.finance, 'gw_finance'), S('seq_fin_order', 'gw_finance', ACT.order), S('seq_fin_reject', 'gw_finance', 'end_rejected'),
    S('seq_end', ACT.order, 'end'),
  ]
  const role = (name, id, rule) => ({ name, endpoint: id ? [id] : '', default: id ? [id] : '', resolutionRule: rule, origin: 'created' })
  const roles = [
    role(ROLES.requester, null, '구매를 요청한 사람'),
    role(ROLES.lead, people.lead, '요청자의 팀장'),
    role(ROLES.finance, people.finance, '1,000만 원 초과 구매 승인'),
    role(ROLES.buyer, people.buyer, '발주·공급사 관리'),
  ]
  return {
    type: 'process-definition-result',
    processDefinition: { processDefinitionId: DEF_ID, processDefinitionName: DEF_NAME, isHorizontal: true, data: [], roles, elements,
      description: '구매 요청을 팀장이 승인하고, 1,000만 원을 넘으면 재무 책임자가 한 번 더 승인한 뒤 구매 담당이 발주해요.' },
    forms: Object.entries(FORMS).map(([id, fs]) => ({ activity_id: id, form_id: formId(id), html: formHtml(formId(id), elements.find((e) => e.id === id).name, fs) })),
    agents: [], skills: [],
  }
}

// ---------- the catalogue the history and the demo requests draw from ----------
export const ITEMS = [
  { item: '노트북 (개발용)', unit: 1_850_000, qty: [1, 8] },
  { item: '27인치 모니터', unit: 420_000, qty: [2, 16] },
  { item: '사무용 의자', unit: 380_000, qty: [3, 20] },
  { item: '소프트웨어 라이선스(연간)', unit: 1_200_000, qty: [5, 30] },
  { item: '회의실 디스플레이', unit: 3_900_000, qty: [1, 4] },
  { item: '네트워크 스위치', unit: 2_300_000, qty: [1, 6] },
  { item: '서버 랙', unit: 6_800_000, qty: [1, 3] },
  { item: 'GPU 워크스테이션', unit: 12_500_000, qty: [1, 2] },
  { item: '측정 장비', unit: 8_700_000, qty: [1, 2] },
]
export const SUPPLIERS = ['한빛컴퓨터', '대성오피스', '누리네트웍스', '세진테크', '오피스플러스', '미래솔루션']
export const NEW_SUPPLIERS = ['에이원상사', '스카이디바이스', '그린테크유통', '하늘정보통신']

// ---------- simulation ----------
function rng(seed) {
  let a = seed >>> 0
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const N = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())
  return { next, U: (lo, hi) => lo + (hi - lo) * next(), LN: (median, sigma, lo, hi) => Math.min(hi, Math.max(lo, median * Math.exp(sigma * N()))), pick: (xs) => xs[Math.floor(next() * xs.length)] }
}
const DAY = 86400000, KST = 9 * 3600000, MIN = 60000
const kday = (t) => Math.floor((t + KST) / DAY)
const at = (d, h, m = 0) => d * DAY - KST + (h * 60 + m) * MIN
const workday = (d) => { const w = new Date(d * DAY).getUTCDay(); return w >= 1 && w <= 5 }
// the first moment ≥ t inside one of the person's windows where `need` fits (a long job starts at a window's start)
function fit(t, need, windows) {
  for (let d = kday(t); d < kday(t) + 60; d++) {
    if (!workday(d)) continue
    for (const [[h1, m1], [h2, m2]] of windows) {
      const ws = at(d, h1, m1), we = at(d, h2, m2)
      const s = Math.max(t, ws)
      if (s + need <= we || (need > we - ws && s === ws)) return s
    }
  }
  return t
}
// when each person looks at this process's work: 장진영 before and after his meetings, 이도윤 twice a day,
// 김민지 through her day
const WINDOWS = {
  lead: [[[8, 40], [9, 30]], [[17, 40], [18, 30]]],
  finance: [[[10, 30], [11, 0]], [[15, 30], [16, 10]]],
  buyer: [[[10, 0], [12, 0]], [[13, 30], [17, 30]]],
}
const LEAD_OK = ['예산 범위 안이라 승인해요.', '필요성 확인했어요. 승인.', '분기 계획에 있던 구매예요. 승인합니다.']
const LEAD_ADJUST = ['이번 분기에는 수량을 줄여서 진행해요.', '우선 필요한 만큼만 사고 나머지는 다음 분기에.']
const LEAD_NO = ['이번 분기 예산을 넘어요. 다음 분기에 다시 올려 주세요.', '기존 장비로 대체 가능해 보여요.', '신규 공급사는 견적 비교 후 다시 요청해 주세요.']
const FIN_OK = ['예산 코드 확인, 승인합니다.', '자산 등록 대상으로 승인해요.']
const FIN_NO = ['감가상각 일정과 맞지 않아요. 다음 회계연도에.', '리스 검토 후 다시 올려 주세요.']

/**
 * simulate({ people: {requester, lead, finance, buyer} ids, names, from, to }) → [{ instId, name, start, end, steps, amount }]
 * FIFO per person, each working only in their windows.
 */
export function simulate({ people, names, from, to, seed = 20261030 }) {
  const r = rng(seed)
  const arrivals = []
  for (let d = kday(from); d <= kday(to); d++) {
    if (!workday(d)) continue
    const t = at(d, 12)
    let p = t < Date.UTC(2026, 8, 1) ? 1.2 : t < Date.UTC(2026, 9, 1) ? 1.5 : 1.8
    while (p > 0) { if (r.next() < Math.min(p, 1)) arrivals.push(at(d, 9) + r.U(0, 8.5 * 60) * MIN); p -= 1 }
  }
  arrivals.sort((a, b) => a - b)
  const free = { lead: 0, finance: 0, buyer: 0 }
  const who = (k) => ({ id: people[k], name: names[k] })
  const out = []
  for (const [i, arrival] of arrivals.entries()) {
    const it = ITEMS[Math.floor(r.next() * ITEMS.length)]
    const quantity = Math.round(r.U(it.qty[0], it.qty[1]))
    const amount = quantity * it.unit
    const supplierNew = r.next() < 0.2
    const supplier = supplierNew ? r.pick(NEW_SUPPLIERS) : r.pick(SUPPLIERS)
    const instId = `${DEF_ID}.${crypto.randomUUID()}`
    const steps = []
    const step = (activityId, activityName, k, s) => steps.push({ todoId: crypto.randomUUID(), activityId, activityName, human: true, userId: who(k).id, username: who(k).name, ...s })
    const t0 = arrival
    step(ACT.request, '구매 요청', 'requester', { startForm: true, createdAt: t0, ready: t0, start: t0, finish: t0 + r.U(8, 20) * 1000,
      output: { [formId(ACT.request)]: { item: it.item, quantity, unit_price: it.unit, amount, supplier, supplier_new: supplierNew ? '예' : '아니오', reason: `${it.item} ${quantity}대 — 팀 업무용 (요청 #${i + 1})` } } })
    let ready = steps[0].finish
    // 팀장 승인: reading the request, checking the budget sheet; a new supplier or a large amount takes longer
    const lw = (r.LN(12, 0.4, 5, 35) + (amount > FINANCE_THRESHOLD ? 5 : 0) + (supplierNew ? 6 : 0)) * MIN
    const ls = fit(Math.max(ready + r.U(1, 15) * MIN, free.lead), lw, WINDOWS.lead)
    const lf = ls + lw
    free.lead = lf
    const reject = r.next() < (supplierNew ? 0.15 : amount > 2e7 ? 0.12 : 0.06)
    const adjust = !reject && r.next() < 0.12 && quantity > 1
    const approvedQty = adjust ? Math.max(1, Math.round(quantity * 0.6)) : quantity
    const approvedAmount = approvedQty * it.unit
    step(ACT.lead, '팀장 승인', 'lead', { createdAt: t0 + 30, ready, start: ls, finish: lf,
      output: { [formId(ACT.lead)]: { lead_decision: reject ? REJECT : APPROVE, approved_quantity: reject ? 0 : approvedQty, approved_amount: reject ? 0 : approvedAmount,
        lead_comment: reject ? r.pick(LEAD_NO) : adjust ? r.pick(LEAD_ADJUST) : r.pick(LEAD_OK) } } })
    ready = lf
    let end = lf
    let rejected = reject
    if (!reject && approvedAmount > FINANCE_THRESHOLD) {
      const fw = r.LN(20, 0.35, 8, 50) * MIN
      const fs = fit(Math.max(ready + r.U(2, 20) * MIN, free.finance), fw, WINDOWS.finance)
      const ff = fs + fw
      free.finance = ff
      const no = r.next() < 0.1
      step(ACT.finance, '재무 승인', 'finance', { createdAt: t0 + 40, ready, start: fs, finish: ff,
        output: { [formId(ACT.finance)]: { finance_decision: no ? REJECT : APPROVE, finance_comment: no ? r.pick(FIN_NO) : r.pick(FIN_OK) } } })
      ready = ff; end = ff; rejected = no
    }
    if (!rejected) {
      // 발주: re-typing the request into the order, calling the supplier about stock; a new supplier needs papers
      const ow = (r.LN(38, 0.3, 15, 90) + (supplierNew ? 25 : 0)) * MIN
      const os = fit(Math.max(ready + r.U(5, 40) * MIN, free.buyer), ow, WINDOWS.buyer)
      const of = os + ow
      free.buyer = of
      const delivery = new Date(of + r.U(3, 12) * DAY).toISOString().slice(0, 10)
      step(ACT.order, '발주', 'buyer', { createdAt: t0 + 50, ready, start: os, finish: of,
        output: { [formId(ACT.order)]: { po_number: `PO-2026-${String(1000 + i).padStart(4, '0')}`, order_quantity: approvedQty, order_amount: approvedAmount, delivery_date: delivery, order_note: `${supplier} 재고 확인 후 발주` } } })
      end = of
    }
    out.push({ instId, name: `${DEF_NAME} · ${it.item} ${approvedQty || quantity}대`, start: t0, end, steps, amount, rejected })
  }
  return out.filter((x) => x.end < to)
}
