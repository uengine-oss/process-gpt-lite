// 「달빛커피 제안」 — the tutorial's process-improvement example (scripts/seed-improve-demo.mjs).
// The definition (saved with process-gpt's own save path) and a deterministic simulation of a few months
// of history: 달빛커피 opens stores one after another and asks for a store-design proposal each time.
// 요청 메일 접수 → 평면도 작성(김민지) ∥ 견적 초안(에이전트) → 제안서 작성(에이전트) → 재무 검토(박서연) → 고객 회신,
// with 재무 검토 sending some proposals back (보완 요청). 박서연 has about an hour a day for these reviews,
// so as requests grow her queue becomes the constraint — the shape the analysis is meant to find.
// English mode (lib/lang.js, `seed-improve-demo.mjs --lang en`): the same definition, ids, timings and
// numbers under English names and texts (i18n/GLOSSARY.md: Moonlight Coffee, Store #2, the English cast).
import crypto from 'node:crypto'
import { lang as currentLang, normLang } from '../lang.js'

export const DEF_ID = 'tutd_moonlight_proposal'
export const DEF_NAME = '달빛커피 제안'
export const DEF_NAME_EN = 'Moonlight Coffee proposal'
export const VERSION = '1.0'
export const AGENTS = {
  quote: { id: '7d1c0a52-3e4f-4b6a-9d21-6a0b5c7e1f01', name: '견적 에이전트', alias: 'pro-tut-d-quote-agent', goal: '매장 면적과 예산으로 인테리어 견적 초안을 만들어요.', persona: '금액은 원 단위 숫자로, 가정한 단가를 함께 적어요.' },
  proposal: { id: '7d1c0a52-3e4f-4b6a-9d21-6a0b5c7e1f02', name: '제안서 에이전트', alias: 'pro-tut-d-proposal-agent', goal: '평면도와 견적 초안으로 매장 설계 제안 요약을 써요.', persona: '고객이 바로 읽을 수 있게 짧고 분명하게 써요.' },
}
export const AGENTS_EN = {
  quote: { ...AGENTS.quote, name: 'Quote agent', goal: 'Drafts the interior quote from the store area and budget.', persona: 'Writes amounts as whole numbers of won, with the unit prices it assumed.' },
  proposal: { ...AGENTS.proposal, name: 'Proposal agent', goal: 'Writes the store design proposal summary from the floor plan and the draft quote.', persona: 'Short and clear, so the customer can read it right away.' },
}
const en = (l) => normLang(l ?? currentLang()) === 'en'
export const defName = (l) => (en(l) ? DEF_NAME_EN : DEF_NAME)
export const agentsIn = (l) => (en(l) ? AGENTS_EN : AGENTS)
const F = (id) => `${DEF_ID}_${id}_form`

export const FORMS = {
  intake: [{ key: 'customer', text: '고객사', type: 'text' }, { key: 'store', text: '매장', type: 'text' }, { key: 'area', text: '면적(㎡)', type: 'text' }, { key: 'budget', text: '예산(원)', type: 'text' }, { key: 'body', text: '요청 내용', type: 'textarea' }],
  floor_plan: [{ key: 'rooms', text: '실별 면적', type: 'textarea' }, { key: 'plan_note', text: '도면 메모', type: 'text' }],
  quote_draft: [{ key: 'amount', text: '견적 금액(원)', type: 'text' }, { key: 'items', text: '견적 내역', type: 'textarea' }],
  proposal: [{ key: 'summary', text: '제안 요약', type: 'textarea' }],
  finance_review: [{ key: 'decision', text: '검토 결과', type: 'radio', items: [{ 승인: '승인' }, { '수정 요청': '수정 요청' }] }, { key: 'comment', text: '검토 의견', type: 'textarea' }],
  reply: [{ key: 'reply', text: '회신 메일', type: 'textarea' }],
}
export const FORMS_EN = {
  intake: [{ key: 'customer', text: 'Customer', type: 'text' }, { key: 'store', text: 'Store', type: 'text' }, { key: 'area', text: 'Area (㎡)', type: 'text' }, { key: 'budget', text: 'Budget (₩)', type: 'text' }, { key: 'body', text: 'Request', type: 'textarea' }],
  floor_plan: [{ key: 'rooms', text: 'Room areas', type: 'textarea' }, { key: 'plan_note', text: 'Drawing note', type: 'text' }],
  quote_draft: [{ key: 'amount', text: 'Quote amount (₩)', type: 'text' }, { key: 'items', text: 'Quote items', type: 'textarea' }],
  proposal: [{ key: 'summary', text: 'Proposal summary', type: 'textarea' }],
  finance_review: [{ key: 'decision', text: 'Review result', type: 'radio', items: [{ Approve: 'Approve' }, { 'Request changes': 'Request changes' }] }, { key: 'comment', text: 'Review comment', type: 'textarea' }],
  reply: [{ key: 'reply', text: 'Reply mail', type: 'textarea' }],
}
export const formsIn = (l) => (en(l) ? FORMS_EN : FORMS)
export const FIELD_LABELS = Object.fromEntries(Object.values(FORMS).flat().map((f) => [f.key, f.text.replace(/\(.*\)/, '')]))
export const fieldLabels = (l) => Object.fromEntries(Object.values(formsIn(l)).flat().map((f) => [f.key, f.text.replace(/\s*\(.*\)/, '')]))

// the definition's words: [Korean, English]
const W_ = {
  start: ['요청 메일 도착', 'Request mail arrives'], end: ['회신 완료', 'Reply sent'],
  intake: ['요청 메일 접수', 'Receive request mail'], floor_plan: ['평면도 작성', 'Draw floor plan'], quote_draft: ['견적 초안', 'Draft quote'],
  proposal: ['제안서 작성', 'Write proposal'], finance_review: ['재무 검토', 'Finance review'], reply: ['고객 회신', 'Reply to customer'],
  sales: ['영업 담당', 'Sales'], designer: ['디자이너', 'Designer'], finance: ['재무 담당', 'Finance'], quoteAgent: ['견적 에이전트', 'Quote agent'], proposalAgent: ['제안서 에이전트', 'Proposal agent'],
  reviewResult: ['검토 결과', 'Review result'], approved: ['검토 결과가 승인', 'Review result is Approve'], back: ['검토 결과가 수정 요청', 'Review result is Request changes'],
  dIntake: ['달빛커피의 매장 설계 요청 메일에서 매장·면적·예산·요청 내용을 정리해요.', "Notes the store, area, budget and request from Moonlight Coffee's store design request mail."],
  dPlan: ['매장 면적과 요청으로 평면도를 그리고 실별 면적을 정리해요.', 'Draws the floor plan from the store area and the request, and lists the area of each room.'],
  dQuote: ['면적·예산으로 인테리어 견적 초안을 만들어요.', 'Drafts the interior quote from the area and budget.'],
  iQuote: ['요청 메일 접수의 면적(㎡)과 예산으로 인테리어 견적 초안을 만든다. amount 에는 부가세 포함 합계를 원 단위 숫자로만 적고(예: 48500000), items 에는 설계·공사·가구·설비 항목별 금액을 줄마다 적는다. ㎡당 공사 단가는 85만원을 기준으로 한다.',
    'Draft the interior quote from the area (㎡) and budget in Receive request mail. In amount write only the total including VAT as a whole number of won (e.g. 48500000); in items put the amount of each item (design, construction, furniture, equipment) on its own line. Use ₩850,000 per ㎡ as the construction unit price. Write in English.'],
  dProposal: ['평면도와 견적 초안으로 매장 설계 제안 요약을 써요.', 'Writes the store design proposal summary from the floor plan and the draft quote.'],
  iProposal: ['평면도 작성의 실별 면적과 견적 초안의 금액으로 달빛커피 매장 설계 제안 요약(콘셉트, 공간 구성, 일정, 견적 합계)을 8줄 이내로 쓴다. 재무 검토에서 수정 요청이 왔으면 그 의견을 반영한다.',
    "Write Moonlight Coffee's store design proposal summary (concept, space plan, schedule, quote total) in at most 8 lines from the room areas in Draw floor plan and the amount in Draft quote. If Finance review asked for changes, work its comments in. Write in English."],
  dFinance: ['견적 금액과 조건을 확인하고 승인하거나 수정을 요청해요.', 'Checks the quoted amounts and terms and approves or asks for changes.'],
  dReply: ['제안서와 견적서를 붙여 고객에게 회신해요.', 'Replies to the customer with the proposal and the quote attached.'],
  rSales: ['제안팀장', 'Proposal team lead'], rDesigner: ['매장 설계 디자이너', 'Store designer'], rFinance: ['견적·비용 검토', 'Quote and cost review'],
  desc: ['달빛커피 가맹 매장의 설계 제안·견적 요청을 받아 평면도·견적·제안서를 만들고 재무 검토를 거쳐 회신해요.', "Takes the store design proposal and quote requests from Moonlight Coffee's franchise stores, makes the floor plan, quote and proposal, and replies after a finance review."],
}
const wordsIn = (l) => Object.fromEntries(Object.entries(W_).map(([k, v]) => [k, v[en(l) ? 1 : 0]]))

const tag = { text: 'text-field', select: 'select-field', radio: 'radio-field', textarea: 'textarea-field', file: 'file-field' }
export const formHtml = (id, alias, fs) => `<section>\n${fs.map((f) => {
  const t = tag[f.type] || 'text-field'
  const items = f.items ? ` is_dynamic_load='fixed' items='${JSON.stringify(f.items)}'` : ''
  const type = t === 'text-field' ? " type='text'" : ''
  return `  <row-layout name="${id}" alias="${alias}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><${t} name='${f.key}' alias='${f.text}'${type}${items} disabled='false' readonly='false' v-model="slotProps.modelValue['${f.key}']"></${t}></div></div></row-layout>`
}).join('\n')}\n</section>`

/** process-gpt generation contract (elements[]) for save_contract; people = {jang, minji, seoyeon} user ids */
export function contract(people, { lang } = {}) {
  const w = wordsIn(lang)
  const AG = agentsIn(lang)
  const FORMS = formsIn(lang)
  const A = (id, name, role, extra = {}) => ({ elementType: 'Activity', id, name, role, type: 'UserActivity', tool: `formHandler:${F(id)}`, duration: 1, inputData: [], outputData: [name], checkpoints: [], skills: [], description: extra.description || '', instruction: extra.instruction || '', ...(extra.agent ? { agent: extra.agent, agentMode: 'complete', orchestration: 'deepagents' } : { agentMode: 'none' }) })
  const S = (id, source, target, condition = '') => ({ elementType: 'Sequence', id, source, target, condition, ...(condition ? { name: condition } : {}) })
  const elements = [
    { elementType: 'Event', id: 'start', name: w.start, role: w.sales, type: 'StartEvent' },
    A('intake', w.intake, w.sales, { description: w.dIntake }),
    { elementType: 'Gateway', id: 'gw_split', name: '', role: w.sales, type: 'ParallelGateway', gateWayType: 'bpmn:parallelGateway' },
    A('floor_plan', w.floor_plan, w.designer, { description: w.dPlan }),
    A('quote_draft', w.quote_draft, w.quoteAgent, { agent: AG.quote.id, description: w.dQuote,
      instruction: w.iQuote }),
    { elementType: 'Gateway', id: 'gw_join', name: '', role: w.designer, type: 'ParallelGateway', gateWayType: 'bpmn:parallelGateway' },
    A('proposal', w.proposal, w.proposalAgent, { agent: AG.proposal.id, description: w.dProposal,
      instruction: w.iProposal }),
    A('finance_review', w.finance_review, w.finance, { description: w.dFinance }),
    { elementType: 'Gateway', id: 'gw_review', name: w.reviewResult, role: w.finance, type: 'ExclusiveGateway', gateWayType: 'bpmn:exclusiveGateway' },
    A('reply', w.reply, w.sales, { description: w.dReply }),
    { elementType: 'Event', id: 'end', name: w.end, role: w.sales, type: 'EndEvent' },
    S('seq_start', 'start', 'intake'), S('seq_intake', 'intake', 'gw_split'),
    S('seq_split_plan', 'gw_split', 'floor_plan'), S('seq_split_quote', 'gw_split', 'quote_draft'),
    S('seq_plan_join', 'floor_plan', 'gw_join'), S('seq_quote_join', 'quote_draft', 'gw_join'),
    S('seq_join_proposal', 'gw_join', 'proposal'), S('seq_proposal_review', 'proposal', 'finance_review'),
    S('seq_review_gw', 'finance_review', 'gw_review'),
    S('seq_approved', 'gw_review', 'reply', w.approved),
    S('seq_back', 'gw_review', 'proposal', w.back),
    S('seq_end', 'reply', 'end'),
  ]
  const roles = [
    { name: w.sales, endpoint: [people.jang], default: [people.jang], resolutionRule: w.rSales, origin: 'created' },
    { name: w.designer, endpoint: [people.minji], default: [people.minji], resolutionRule: w.rDesigner, origin: 'created' },
    { name: w.finance, endpoint: [people.seoyeon], default: [people.seoyeon], resolutionRule: w.rFinance, origin: 'created' },
    { name: w.quoteAgent, endpoint: AG.quote.id, default: AG.quote.id, resolutionRule: '', origin: 'used' },
    { name: w.proposalAgent, endpoint: AG.proposal.id, default: AG.proposal.id, resolutionRule: '', origin: 'used' },
  ]
  return {
    type: 'process-definition-result',
    processDefinition: { processDefinitionId: DEF_ID, processDefinitionName: defName(lang), isHorizontal: true, data: [], description: w.desc, roles, elements },
    forms: Object.entries(FORMS).map(([id, fs]) => ({ activity_id: id, form_id: F(id), html: formHtml(F(id), elements.find((e) => e.id === id).name, fs) })),
    agents: [{ id: AG.quote.id, skills: [] }, { id: AG.proposal.id, skills: [] }],
    skills: [],
  }
}

// ---------- simulation ----------
function rng(seed) {
  let a = seed >>> 0
  const next = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const U = (lo, hi) => lo + (hi - lo) * next()
  const N = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next())
  const LN = (median, sigma, lo, hi) => Math.min(hi, Math.max(lo, median * Math.exp(sigma * N())))
  return { next, U, LN, pick: (xs) => xs[Math.floor(next() * xs.length)] }
}
const DAY = 86400000, KST = 9 * 3600000, MIN = 60000
const kday = (t) => Math.floor((t + KST) / DAY)
const at = (d, h, m = 0) => d * DAY - KST + (h * 60 + m) * MIN
const workday = (d) => { const w = new Date(d * DAY).getUTCDay(); return w >= 1 && w <= 5 }
// the first moment ≥ t inside one of the windows where `need` ms fits (or the window start if nothing fits)
function fit(t, need, windows) {
  for (let d = kday(t); d < kday(t) + 60; d++) {
    if (!workday(d)) continue
    for (const [[h1, m1], [h2, m2]] of windows) {
      const ws = at(d, h1, m1), we = at(d, h2, m2)
      const s = Math.max(t, ws)
      if (s + need <= we || (need > we - ws && s < we && s === ws)) return s
    }
  }
  return t
}
const W = {
  jang: [[[9, 0], [18, 0]]],
  minji: [[[10, 0], [12, 0]], [[13, 30], [17, 0]]],
  seoyeon: [[[10, 0], [11, 10]]],
}
const STORES_EN = ['Seongsu', 'Pangyo', 'Gwanggyo', 'Songdo', 'Magok', 'Munjeong', 'Hanam', 'Ilsan', 'Bundang', 'Pyeongchon', 'Dongtan', 'Cheongna', 'Wirye', 'Sangam', 'Yeouido', 'Jamsil', 'Mokdong', 'Seocho', 'Yeoksam', 'Hapjeong', 'Yeonnam', 'Mangwon', 'Bucheon', 'Anyang', 'Suwon Station', 'Yeongtong', 'Sanbon', 'Gimpo', 'Paju', 'Uijeongbu', 'Guri', 'Namyangju', 'Yongin', 'Giheung', 'Jukjeon', 'Incheon', 'Bupyeong', 'Jemulpo', 'Daejeon', 'Sejong', 'Cheongju', 'Cheonan', 'Jeonju', 'Gwangju', 'Daegu', 'Ulsan', 'Busan', 'Haeundae', 'Changwon', 'Jeju']
const won = (n) => `₩${Math.round(n).toLocaleString('en-US')}`
// the texts the simulated history writes into forms (same numbers in both languages)
const SIM = {
  ko: {
    store: (i, STORES) => `${STORES[i % STORES.length]} ${i + 2}호점`, customer: '달빛커피',
    body: (store, area, budget) => `달빛커피 ${store} 매장(${area}㎡) 설계 제안과 견적을 부탁드립니다. 예산은 ${Math.round(budget / 1e4).toLocaleString('ko-KR')}만원 안팎입니다.`,
    items: (amount) => `설계비 ${Math.round(amount * 0.08 / 1e4)}만\n인테리어 공사 ${Math.round(amount * 0.62 / 1e4)}만\n가구·집기 ${Math.round(amount * 0.18 / 1e4)}만\n전기·설비 ${Math.round(amount * 0.12 / 1e4)}만`,
    rooms: (area) => `홀 | ${Math.round(area * 0.55)}㎡\n바·주방 | ${Math.round(area * 0.22)}㎡\n창고 | ${Math.round(area * 0.08)}㎡\n화장실 | ${Math.round(area * 0.07)}㎡\n직원실 | ${Math.round(area * 0.08)}㎡`,
    note: (store) => `${store} 출입구 남측, 창가 좌석 우선`,
    summary: (store, area, amount, round) => `달빛커피 ${store} — 따뜻한 원목과 창가 좌석 중심의 매장. 홀 ${Math.round(area * 0.55)}㎡, 바·주방 ${Math.round(area * 0.22)}㎡. 공사 5주, 견적 합계 ${Math.round(amount / 1e4).toLocaleString('ko-KR')}만원.${round ? ' (재무 검토 의견 반영)' : ''}`,
    back: '수정 요청', ok: '승인',
    backComments: ['가구·집기 단가가 지난 매장보다 높아요. 다시 확인해 주세요.', '전기 증설 비용이 빠졌어요.', '설계비 비율을 표준(7%)에 맞춰 주세요.'],
    okComments: ['승인합니다.', '조건 확인했어요. 승인.', '단가 적정, 승인합니다.'],
    reply: (store, amount) => `안녕하세요, 달빛커피 담당자님. ${store} 설계 제안서와 견적서(합계 ${Math.round(amount / 1e4).toLocaleString('ko-KR')}만원)를 보내 드립니다.`,
  },
  en: {
    store: (i) => `${STORES_EN[i % STORES_EN.length]} Store #${i + 2}`, customer: 'Moonlight Coffee',
    body: (store, area, budget) => `Please send us a design proposal and a quote for Moonlight Coffee ${store} (${area} ㎡). Our budget is around ${won(budget)}.`,
    items: (amount) => `Design fee ${won(Math.round(amount * 0.08 / 1e4) * 1e4)}\nInterior work ${won(Math.round(amount * 0.62 / 1e4) * 1e4)}\nFurniture and fixtures ${won(Math.round(amount * 0.18 / 1e4) * 1e4)}\nElectrical and equipment ${won(Math.round(amount * 0.12 / 1e4) * 1e4)}`,
    rooms: (area) => `Hall | ${Math.round(area * 0.55)} ㎡\nBar & kitchen | ${Math.round(area * 0.22)} ㎡\nStorage | ${Math.round(area * 0.08)} ㎡\nRestroom | ${Math.round(area * 0.07)} ㎡\nStaff room | ${Math.round(area * 0.08)} ㎡`,
    note: (store) => `${store}: entrance on the south side, window seats first`,
    summary: (store, area, amount, round) => `Moonlight Coffee ${store} — a store built around warm wood and window seats. Hall ${Math.round(area * 0.55)} ㎡, bar & kitchen ${Math.round(area * 0.22)} ㎡. Construction 5 weeks, quote total ${won(Math.round(amount / 1e4) * 1e4)}.${round ? ' (finance review comments worked in)' : ''}`,
    back: 'Request changes', ok: 'Approve',
    backComments: ['Furniture and fixtures cost more than at the last store. Please check again.', 'The cost of the electrical upgrade is missing.', 'Please bring the design fee to the standard rate (7%).'],
    okComments: ['Approved.', 'Terms checked. Approved.', 'Unit prices look right. Approved.'],
    reply: (store, amount) => `Hello, Moonlight Coffee team. Please find attached the design proposal and the quote for ${store} (total ${won(Math.round(amount / 1e4) * 1e4)}).`,
  },
}
const STORES = ['성수', '판교', '광교', '송도', '마곡', '문정', '하남', '일산', '분당', '평촌', '동탄', '청라', '위례', '상암', '여의도', '잠실', '목동', '서초', '역삼', '합정', '연남', '망원', '부천', '안양', '수원역', '영통', '산본', '김포', '파주', '의정부', '구리', '남양주', '용인', '기흥', '죽전', '인천', '부평', '제물포', '대전', '세종', '청주', '천안', '전주', '광주', '대구', '울산', '부산', '해운대', '창원', '제주']

/**
 * simulate({ people: {jang, minji, seoyeon} ids + names, from, to, seed }) → [{ instId, name, start, end, steps, amount }]
 * FIFO per person (in request order; a proposal sent back is re-checked before the next new one).
 */
export function simulate({ people, names, from, to, seed = 20261027, defId = DEF_ID, lang }) {
  const r = rng(seed)
  const X = en(lang) ? SIM.en : SIM.ko
  const w = wordsIn(lang)
  const AGENTS = agentsIn(lang)
  // arrivals: requests on workdays 09:00–17:00, the rate growing as 달빛커피 expands (3 → 4 → 5.5 a week)
  const arrivals = []
  for (let d = kday(from); d <= kday(to); d++) {
    if (!workday(d)) continue
    const t = at(d, 12)
    const perDay = t < Date.UTC(2026, 8, 1) ? 0.6 : t < Date.UTC(2026, 9, 1) ? 0.8 : 1.1
    let n = 0
    let p = perDay
    while (p > 0) { if (r.next() < Math.min(p, 1)) n++; p -= 1 }
    for (let i = 0; i < n; i++) arrivals.push(at(d, 9) + r.U(0, 8 * 60) * MIN)
  }
  arrivals.sort((a, b) => a - b)
  const free = { minji: 0, seoyeon: 0, jangReply: 0 }
  const out = []
  arrivals.forEach((mail, i) => {
    const store = X.store(i, STORES)
    const instId = `${defId}.${crypto.randomUUID()}`
    const area = Math.round(r.LN(95, 0.28, 55, 180))
    const amount = Math.round(area * r.LN(520000, 0.25, 330000, 900000) / 100000) * 100000
    const budget = Math.round(amount * r.U(0.85, 1.15) / 1e6) * 1e6
    const steps = []
    const step = (activityId, activityName, who, human, s) => steps.push({ todoId: crypto.randomUUID(), activityId, activityName, human, userId: who.id, username: who.name, ...s })
    const jang = { id: people.jang, name: names.jang }, minji = { id: people.minji, name: names.minji }, seoyeon = { id: people.seoyeon, name: names.seoyeon }
    const quoteAgent = { id: AGENTS.quote.id, name: AGENTS.quote.name }, propAgent = { id: AGENTS.proposal.id, name: AGENTS.proposal.name }
    // 접수: 장진영 picks the mail up and submits the start form (that starts the instance)
    const start = fit(mail + r.U(10, 80) * MIN, 15 * MIN, W.jang)
    const t0 = start
    step('intake', w.intake, jang, true, { startForm: true, createdAt: t0, ready: t0, start: t0, finish: t0 + r.U(8, 16) * 1000,
      output: { [F('intake')]: { customer: X.customer, store, area: String(area), budget: String(budget), body: X.body(store, area, budget) } } })
    const after0 = steps[0].finish
    // 견적 초안 (agent) ∥ 평면도 작성 (김민지)
    const qs = after0 + 50 + r.U(3, 40) * 1000
    const qf = qs + r.U(70, 260) * 1000
    step('quote_draft', w.quote_draft, quoteAgent, false, { createdAt: t0 + 30, ready: after0, start: qs, finish: qf + 2000,
      output: { [F('quote_draft')]: { amount: String(amount), items: X.items(amount) } } })
    const pw = r.LN(95, 0.3, 50, 170) * MIN
    const ps = fit(Math.max(after0 + r.U(5, 40) * MIN, free.minji), pw, W.minji)
    const pf = ps + pw
    free.minji = pf
    step('floor_plan', w.floor_plan, minji, true, { createdAt: t0 + 20, ready: after0, start: ps, finish: pf,
      output: { [F('floor_plan')]: { rooms: X.rooms(area), plan_note: X.note(store) } } })
    // 제안서 작성 (agent) after both, then 재무 검토 (박서연), maybe 보완 → 제안서 again → 재무 검토 again
    let ready = Math.max(qf + 2000, pf)
    let created = t0 + 40
    let round = 0
    for (;;) {
      const as = ready + 50 + r.U(3, 30) * 1000
      const af = as + r.U(180, 520) * 1000
      step('proposal', w.proposal, propAgent, false, { createdAt: created, ready, start: as, finish: af + 2000,
        output: { [F('proposal')]: { summary: X.summary(store, area, amount, round) } } })
      const fr = af + 2000
      const fw = (round ? r.LN(20, 0.25, 12, 35) : r.LN(46, 0.22, 30, 70)) * MIN
      const fs = fit(Math.max(fr + r.U(1, 10) * MIN, free.seoyeon), fw, W.seoyeon)
      const ff = fs + fw
      free.seoyeon = ff
      const pBack = round ? 0.05 : amount >= 5e7 ? 0.3 : 0.07
      const back = r.next() < pBack
      step('finance_review', w.finance_review, seoyeon, true, { createdAt: round ? created : t0 + 50, ready: fr, start: fs, finish: ff,
        output: { [F('finance_review')]: { decision: back ? X.back : X.ok, comment: back ? r.pick(X.backComments) : r.pick(X.okComments) } } })
      round++
      if (!back) { ready = ff; break }
      ready = ff; created = ff
    }
    // 고객 회신 (장진영)
    const rw = r.LN(22, 0.25, 12, 40) * MIN
    const rs = fit(Math.max(ready + r.U(15, 150) * MIN, free.jangReply), rw, W.jang)
    const rf = rs + rw
    free.jangReply = rf
    step('reply', w.reply, jang, true, { createdAt: t0 + 60, ready, start: rs, finish: rf,
      output: { [F('reply')]: { reply: X.reply(store, amount) } } })
    out.push({ instId, name: `${defName(lang)} · ${store}`, start: t0, end: rf, steps, amount, store })
  })
  return out.filter((x) => x.end < to)
}
