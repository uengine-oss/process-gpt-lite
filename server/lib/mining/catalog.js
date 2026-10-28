// The steps a design-proposal request goes through when nobody has modelled it yet: the mail
// assistant drafts across tools (lib/mail.js), the person shares the drafts with a teammate (team
// share) and replies. Each step leaves a handover record under one name, so process-gpt's miner sees
// the same activity every time; the same table tells how a registered step runs (worker.js) and
// which form and skill it gets (service.js → save_contract).
import { lang, normLang } from '../lang.js'

export const ORCH = 'pgpt-pro-skill'

// agents (public.users is_agent): the ones that did the drafts, so the mined roles point at them
export const AGENTS = {
  drawing: { id: '3a6f0c1e-8d2b-4f4a-9c61-0d5e7b2a9f11', name: '도면 에이전트', alias: 'pro-drawing-agent',
    goal: '고객 요구사항으로 캐드크래프트에서 평면도를 그리고 실별 면적을 정리해요.', persona: '치수·면적은 메일에 적힌 값을 그대로 써요.' },
  proposal: { id: '4b7e1d2f-9e3c-4a5b-8d72-1e6f8c3b0a22', name: '제안서 에이전트', alias: 'pro-proposal-agent',
    goal: '평면도를 넣은 아래아한글 제안서를 회사 양식으로 채워요.', persona: '양식의 표와 그림 칸을 그대로 두고 내용만 채워요.' },
  quote: { id: '5c8f2e30-af4d-4b6c-9e83-2f7a9d4c1b33', name: '견적 에이전트', alias: 'pro-quote-agent',
    goal: '실별 면적으로 엑셀 견적서를 수식과 함께 만들어요.', persona: '금액은 모두 수식으로, 가정한 단가는 따로 적어요.' },
}
// English mode (lib/lang.js): the same agents (same ids) under English names
export const AGENTS_EN = {
  drawing: { ...AGENTS.drawing, name: 'Drawing agent',
    goal: "Draws the floor plan in CADCraft from the customer's requirements and lists the area of each room.", persona: 'Uses the dimensions and areas exactly as the mail gives them.' },
  proposal: { ...AGENTS.proposal, name: 'Proposal agent',
    goal: 'Writes the proposal as a Word document with the floor plan in it.', persona: "Keeps the company proposal's layout and fills in the content only." },
  quote: { ...AGENTS.quote, name: 'Quote agent',
    goal: 'Builds the Excel quote with formulas from the room areas.', persona: 'Every amount is a formula; the unit prices it assumed are listed separately.' },
}
export const agentsIn = (l = lang()) => (normLang(l) === 'en' ? AGENTS_EN : AGENTS)

// label → how the step looks and runs. kind: human | agent
export const STEPS = {
  '요청 메일 접수': {
    kind: 'human', role: '영업 담당', tool: '메일', skill: 'mail-intake', key: 'intake',
    description: '고객 요청 메일을 받아 고객·요청 문서·기한을 정리해요(메일이 오면 자동으로 채워져요).',
    fields: [
      { key: 'customer', text: '고객사', type: 'text' },
      { key: 'sender', text: '보낸 사람', type: 'text' },
      { key: 'subject', text: '메일 제목', type: 'text' },
      { key: 'body', text: '요청 내용', type: 'textarea' },
      { key: 'requested', text: '요청 문서', type: 'text' },
    ],
  },
  '평면도 작성': {
    kind: 'agent', agent: 'drawing', role: '도면 에이전트', tool: '캐드크래프트', skill: 'cadcraft-floor-plan', key: 'plan',
    description: '요청의 치수·실 구성으로 캐드크래프트에서 평면도(DXF)를 그려요.',
    instruction: '요청 메일의 가로·세로 치수와 필요한 실(홀·주방·창고·화장실 등), 출입문 방향으로 평면도를 그린다. 캐드크래프트 MCP 로 벽·문·실 이름·치수를 넣고 DXF 로 저장한 뒤 실별 면적을 정리한다.',
    fields: [{ key: 'floor_plan', text: '평면도(DXF)', type: 'file' }, { key: 'rooms', text: '실별 면적', type: 'textarea' }],
  },
  '제안서 작성': {
    kind: 'agent', agent: 'proposal', role: '제안서 에이전트', tool: '아래아한글', skill: 'hwpx-proposal', key: 'proposal',
    description: '평면도를 넣어 회사 양식의 아래아한글 제안서를 채워요.',
    instruction: '앞 단계 평면도를 제안서 양식의 설계 평면도 그림 칸에 넣고, 공간 구성 표를 실별 면적으로 채운다. 메일의 요구사항을 모두 반영한다.',
    fields: [{ key: 'proposal', text: '제안서(한글)', type: 'file' }],
  },
  '견적서 작성': {
    kind: 'agent', agent: 'quote', role: '견적 에이전트', tool: '엑셀', skill: 'xlsx', key: 'quote',
    description: '실별 면적으로 엑셀 견적서를 수식과 함께 만들어요.',
    instruction: '설계비, 실별 인테리어 공사(면적 × ㎡당 단가), 가구·집기, 전기·설비 행과 공급가액·부가세·합계를 모두 수식으로 넣은 견적서를 만든다. 가정한 단가를 적는다.',
    fields: [{ key: 'quote', text: '견적서(엑셀)', type: 'file' }, { key: 'assumptions', text: '가정한 단가', type: 'textarea' }],
  },
  '재무 검토': {
    kind: 'human', role: '재무 담당', tool: '팀 공유', skill: 'team-share-review', key: 'finance',
    description: '견적 금액과 조건을 확인하고 승인하거나 수정을 요청해요.',
    fields: [
      { key: 'decision', text: '검토 결과', type: 'radio', items: [{ 승인: '승인 — 이대로 회신' }, { '수정 요청': '수정 요청' }] },
      { key: 'comment', text: '검토 의견', type: 'textarea' },
    ],
  },
  '고객 회신': {
    kind: 'human', role: '영업 담당', tool: '메일', skill: 'mail-reply', key: 'reply',
    description: '제안서와 견적서를 붙여 고객에게 회신해요.',
    fields: [{ key: 'reply', text: '회신 메일', type: 'textarea' }],
  },
}

// tool → what a document of that tool is (mail triage formats), for matching the next mail
export const TOOL_FORMAT = { 캐드크래프트: 'dxf', 아래아한글: 'hwpx', 엑셀: 'xlsx', CADCraft: 'dxf', Word: 'docx', Excel: 'xlsx' }

// English mode: the same steps under English labels (an English case is recorded with these, so the
// miner groups English cases with English cases). The design proposal is a Word document there.
const REVIEW_FIELDS_EN = [
  { key: 'decision', text: 'Review result', type: 'radio', items: [{ Approve: 'Approve — reply as is' }, { 'Request changes': 'Request changes' }] },
  { key: 'comment', text: 'Review comment', type: 'textarea' },
]
export const STEPS_EN = {
  'Receive request mail': {
    kind: 'human', role: 'Sales', tool: 'Mail', skill: 'mail-intake', key: 'intake',
    description: "Takes the customer's request mail and notes the customer, the documents asked for and the deadline (filled in automatically when the mail arrives).",
    fields: [
      { key: 'customer', text: 'Customer', type: 'text' },
      { key: 'sender', text: 'Sender', type: 'text' },
      { key: 'subject', text: 'Mail subject', type: 'text' },
      { key: 'body', text: 'Request', type: 'textarea' },
      { key: 'requested', text: 'Requested documents', type: 'text' },
    ],
  },
  'Draw floor plan': {
    kind: 'agent', agent: 'drawing', role: 'Drawing agent', tool: 'CADCraft', skill: 'cadcraft-floor-plan', key: 'plan',
    description: 'Draws the floor plan (DXF) in CADCraft from the requested dimensions and rooms.',
    instruction: 'Draw the floor plan from the width and depth in the request mail, the rooms it needs (hall, kitchen, storage, restroom …) and the side of the entrance. Put in the walls, doors, room names and dimensions with the CADCraft MCP, save it as DXF and list the area of each room.',
    fields: [{ key: 'floor_plan', text: 'Floor plan (DXF)', type: 'file' }, { key: 'rooms', text: 'Room areas', type: 'textarea' }],
  },
  'Write proposal': {
    kind: 'agent', agent: 'proposal', role: 'Proposal agent', tool: 'Word', skill: 'docx-proposal', key: 'proposal',
    description: 'Writes the proposal as a Word document with the floor plan in it.',
    instruction: 'Put the floor plan from the previous step into the proposal, fill the space plan table with the room areas and cover everything the mail asks for.',
    fields: [{ key: 'proposal', text: 'Proposal (Word)', type: 'file' }],
  },
  'Prepare quote': {
    kind: 'agent', agent: 'quote', role: 'Quote agent', tool: 'Excel', skill: 'xlsx', key: 'quote',
    description: 'Builds the Excel quote with formulas from the room areas.',
    instruction: 'Build a quote with rows for the design fee, interior work per room (area × price per ㎡), furniture and fixtures, and electrical and equipment, then subtotal, VAT and total — all as formulas. List the unit prices you assumed.',
    fields: [{ key: 'quote', text: 'Quote (Excel)', type: 'file' }, { key: 'assumptions', text: 'Assumed unit prices', type: 'textarea' }],
  },
  'Finance review': {
    kind: 'human', role: 'Finance', tool: 'Team share', skill: 'team-share-review', key: 'finance',
    description: 'Checks the quoted amounts and terms and approves or asks for changes.',
    fields: REVIEW_FIELDS_EN,
  },
  'Reply to customer': {
    kind: 'human', role: 'Sales', tool: 'Mail', skill: 'mail-reply', key: 'reply',
    description: 'Replies to the customer with the proposal and the quote attached.',
    fields: [{ key: 'reply', text: 'Reply mail', type: 'textarea' }],
  },
}

// A teammate's review of shared drafts is named for what the review is for, so the mined roles are
// right (a designer checking the floor plan is not '재무 검토'). The recipient's role decides first,
// then the share note; a role outside these kinds names its own '<역할> 검토'.
const REVIEW_FIELDS = [
  { key: 'decision', text: '검토 결과', type: 'radio', items: [{ 승인: '승인 — 이대로 회신' }, { '수정 요청': '수정 요청' }] },
  { key: 'comment', text: '검토 의견', type: 'textarea' },
]
export const REVIEWS = [
  { label: '재무 검토', role: '재무 담당', key: 'finance', re: /재무|회계|경리|금액|단가|부가세|예산|비용|원가|세금|정산/ },
  { label: '디자인 검토', role: '디자인 담당', key: 'design', re: /디자인|디자이너|도면|평면도|설계|배치|인테리어|레이아웃/ },
  { label: '계약 검토', role: '법무 담당', key: 'contract', re: /계약|법무|약관|조항/ },
  { label: '제안서 검토', role: '제안 담당', key: 'proposal_review', re: /제안서|문안|문구|오탈자/ },
]
for (const r of REVIEWS) {
  STEPS[r.label] ||= { kind: 'human', role: r.role, tool: '팀 공유', skill: 'team-share-review', key: r.key,
    description: `공유받은 초안을 확인하고 승인하거나 수정을 요청해요(${r.label}).`, fields: REVIEW_FIELDS }
}
// the same kinds for English roles and notes ("Finance", "please check the drawing")
export const REVIEWS_EN = [
  { label: 'Finance review', role: 'Finance', key: 'finance', re: /financ|account|amount|price|vat|budget|cost|tax|settle/i },
  { label: 'Design review', role: 'Design', key: 'design', re: /design|drawing|floor ?plan|layout|interior/i },
  { label: 'Contract review', role: 'Legal', key: 'contract', re: /contract|legal|terms|clause/i },
  { label: 'Proposal review', role: 'Proposals', key: 'proposal_review', re: /proposal|wording|copy|typo/i },
]
for (const r of REVIEWS_EN) {
  STEPS_EN[r.label] ||= { kind: 'human', role: r.role, tool: 'Team share', skill: 'team-share-review', key: r.key,
    description: `Checks the shared drafts and approves or asks for changes (${r.label}).`, fields: REVIEW_FIELDS_EN }
}
export const reviewsIn = (l = lang()) => (normLang(l) === 'en' ? REVIEWS_EN : REVIEWS)

// a step label in the other language (the code names steps by their Korean label; an English case
// records the English one)
const PAIRS = [
  ['요청 메일 접수', 'Receive request mail'], ['평면도 작성', 'Draw floor plan'], ['제안서 작성', 'Write proposal'],
  ['견적서 작성', 'Prepare quote'], ['재무 검토', 'Finance review'], ['고객 회신', 'Reply to customer'],
  ['디자인 검토', 'Design review'], ['계약 검토', 'Contract review'], ['제안서 검토', 'Proposal review'], ['팀원 검토', 'Teammate review'],
]
const TO_EN = new Map(PAIRS), TO_KO = new Map(PAIRS.map(([k, e]) => [e, k]))
export function labelIn(label, l = lang()) {
  const s = String(label || '')
  if (normLang(l) === 'en') return TO_EN.get(s) || s.replace(/^(.+?)\s*검토$/, (m, who) => (/[가-힣]/.test(who) ? m : `${who} review`))
  return TO_KO.get(s) || s
}
// both spellings of a step (matching records of either language)
export const labelsOf = (label) => [...new Set([labelIn(label, 'ko'), labelIn(label, 'en')])]
// the language a step label (or a mined flow) is in
export const labelLang = (label) => (/[가-힣]/.test(String(label || '')) ? 'ko' : 'en')

// '<역할> 검토' for a recipient whose role is none of the kinds above (role from the record)
function reviewOf(label) {
  const m = /^(.+?)\s*검토$/.exec(String(label || ''))
  if (!m) {
    // English: '<role> review'
    const e = /^(.+?)\s+review$/i.exec(String(label || ''))
    if (!e) return null
    return { kind: 'human', role: null, tool: 'Team share', skill: 'team-share-review', key: null,
      description: `Checks the shared drafts from the ${e[1]} side and approves or asks for changes.`, fields: REVIEW_FIELDS_EN }
  }
  return { kind: 'human', role: null, tool: '팀 공유', skill: 'team-share-review', key: null,
    description: `공유받은 초안을 ${m[1]} 입장에서 확인하고 승인하거나 수정을 요청해요.`, fields: REVIEW_FIELDS }
}

export const stepOf = (label) => STEPS[label] || STEPS_EN[label] || reviewOf(label)
