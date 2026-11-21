// The steps ad-hoc mail work goes through, as process mining records them (recorder.js) and as a registered
// step runs (worker.js) with its form and skill (service.js → save_contract). Each step is recorded under
// one name in its case's language, so process-gpt's miner sees the same activity every time.
//
// Two sources, nothing else:
//   - core: the steps Lite's own mail work has in every company — the request mail, a teammate's review,
//     the reply — and the agent that makes a mail's drafts. No trade in them.
//   - the business packs the company turned on (skills/packs/<pack>/pack.json "mining"): a pack brings its
//     steps (labels in both languages, kind, role, tool, skill, form fields), agents and review kinds.
//     A company without a pack records only core steps and the drafts' own document kinds; no pack text
//     reaches a prompt (lib/skillInstallCatalog.js, design 4.5, 2026-11-21 decision 3).
// Sync lookups read the packs the tenant has on as packsReady() last read them: async entry points call
// `await packsReady()` first (recorder.js, service.js, worker.js, lib/mail.js).
import { lang, normLang } from '../lang.js'
import { activePacks, enabledNow, packsReady } from '../skillInstallCatalog.js'
import { config } from '../../config.js'

export { packsReady }
export const ORCH = 'pgpt-pro-skill'

const pick = (v, l) => (v && typeof v === 'object' && !Array.isArray(v) ? v[l] ?? v.ko ?? Object.values(v)[0] : v)
const REVIEW_FIELDS = {
  ko: [{ key: 'decision', text: '검토 결과', type: 'radio', items: [{ 승인: '승인 — 이대로 회신' }, { '수정 요청': '수정 요청' }] }, { key: 'comment', text: '검토 의견', type: 'textarea' }],
  en: [{ key: 'decision', text: 'Review result', type: 'radio', items: [{ Approve: 'Approve — reply as is' }, { 'Request changes': 'Request changes' }] }, { key: 'comment', text: 'Review comment', type: 'textarea' }],
}
const SHARE_TOOL = { ko: '팀 공유', en: 'Team share' }
const reviewText = (label, l) => (l === 'en' ? `Checks the shared drafts and approves or asks for changes (${label}).` : `공유받은 초안을 확인하고 승인하거나 수정을 요청해요(${label}).`)

// the agent that makes a mail's drafts when no pack step names one (same id in every tenant)
export const DRAFT_AGENT = {
  id: '6e2d9b47-1c3a-4f5e-8b90-3d7c5a1e2f44', alias: 'pro-draft-agent',
  name: { ko: '초안 에이전트', en: 'Draft agent' },
  goal: { ko: '메일이 요청한 문서의 초안을 만들어요.', en: 'Makes drafts of the documents a mail asks for.' },
  persona: { ko: '요청에 적힌 값을 그대로 쓰고, 가정한 값은 따로 적어요.', en: 'Uses the values the request gives as they are and lists what it assumed.' },
}
const CORE_ROLES = { intake: { ko: '담당자', en: 'Assignee' }, reply: { ko: '담당자', en: 'Assignee' }, reviewer: { ko: '검토 담당', en: 'Reviewer' } }
const CORE = [
  { key: 'intake', kind: 'human', roleKey: 'intake', skill: 'mail-intake', tool: { ko: '메일', en: 'Mail' },
    label: { ko: '요청 메일 접수', en: 'Receive request mail' },
    description: { ko: '고객 요청 메일을 받아 고객·요청 문서·기한을 정리해요(메일이 오면 자동으로 채워져요).', en: "Takes the customer's request mail and notes the customer, the documents asked for and the deadline (filled in automatically when the mail arrives)." },
    fields: {
      ko: [{ key: 'customer', text: '고객사', type: 'text' }, { key: 'sender', text: '보낸 사람', type: 'text' }, { key: 'subject', text: '메일 제목', type: 'text' }, { key: 'body', text: '요청 내용', type: 'textarea' }, { key: 'requested', text: '요청 문서', type: 'text' }],
      en: [{ key: 'customer', text: 'Customer', type: 'text' }, { key: 'sender', text: 'Sender', type: 'text' }, { key: 'subject', text: 'Mail subject', type: 'text' }, { key: 'body', text: 'Request', type: 'textarea' }, { key: 'requested', text: 'Requested documents', type: 'text' }],
    } },
  { key: 'reply', kind: 'human', roleKey: 'reply', skill: 'mail-reply', tool: { ko: '메일', en: 'Mail' },
    label: { ko: '고객 회신', en: 'Reply to customer' },
    description: { ko: '만든 문서를 붙여 고객에게 회신해요.', en: 'Replies to the customer with the documents attached.' },
    fields: { ko: [{ key: 'reply', text: '회신 메일', type: 'textarea' }], en: [{ key: 'reply', text: 'Reply mail', type: 'textarea' }] } },
  { key: null, kind: 'human', roleKey: 'reviewer', review: 'teammate', label: { ko: '팀원 검토', en: 'Teammate review' } },
]

function stepIn(def, l, roles, pack = null, id = null) {
  const label = pick(def.label, l)
  const review = !!def.review || !!def.formats
  return {
    id, label, kind: def.kind, key: def.key ?? null, pack,
    role: pick(def.role, l) || pick(roles[def.roleKey], l) || null,
    tool: pick(def.tool, l) || (review ? pick(SHARE_TOOL, l) : null),
    skill: def.skill || (review ? 'team-share-review' : null),
    format: pick(def.format, l) || null,
    document: pick(def.document, l) || null,
    agent: def.agent || null,
    description: pick(def.description, l) || (review ? reviewText(label, l) : ''),
    instruction: pick(def.instruction, l) || '',
    fields: pick(def.fields, l) || (review ? REVIEW_FIELDS[l] : null),
    total_field: def.total_field || null,
    review: review ? (def.review || 'document') : null,
    formats: def.formats || null,
    judge: pick(def.judge, l) || null,
  }
}

// the catalog for a language, from core and the tenant's packs (rebuilt when the packs on change)
const built = new Map()
function catalog(l, tenant = config.tenantId) {
  l = normLang(l) === 'en' ? 'en' : 'ko'
  const packs = activePacks(tenant)
  const key = `${l}|${packs.map((p) => `${p.name}@${p.sha256}`).join(',')}`
  if (built.has(key)) return built.get(key)
  const roles = { ...CORE_ROLES }
  for (const p of packs) Object.assign(roles, p.mining?.roles || {})
  const steps = new Map()
  const agents = { draft: { ...DRAFT_AGENT, name: pick(DRAFT_AGENT.name, l), goal: pick(DRAFT_AGENT.goal, l), persona: pick(DRAFT_AGENT.persona, l) } }
  const docReviews = []
  for (const p of packs) {
    for (const [i, s] of (p.mining?.steps || []).entries()) { const st = stepIn(s, l, roles, p.name, `${p.name}:${i}`); if (!steps.has(st.label)) steps.set(st.label, st) }
    for (const [k, a] of Object.entries(p.mining?.agents || {})) agents[k] = { id: a.id, alias: a.alias, name: pick(a.name, l), goal: pick(a.goal, l), persona: pick(a.persona, l) }
    for (const ko of p.mining?.doc_reviews || []) {
      const def = (p.mining.steps || []).find((s) => pick(s.label, 'ko') === ko)
      if (def?.formats) docReviews.push({ label: pick(def.label, l), formats: def.formats })
    }
  }
  // a pack may word a core step for its trade (pack.json mining.core.<key>: description)
  const core = Object.assign({}, ...packs.map((p) => p.mining?.core || {}))
  for (const [i, c] of CORE.entries()) { const st = stepIn({ ...c, ...(c.key && core[c.key] ? core[c.key] : {}) }, l, roles, null, `core:${i}`); if (!steps.has(st.label)) steps.set(st.label, st) }
  // an agent's step is in that agent's lane (its role is the agent's name)
  for (const st of steps.values()) if (st.kind === 'agent' && !st.role && agents[st.agent]) st.role = agents[st.agent].name
  const byId = new Map([...steps.values()].map((st) => [st.id, st]))
  const out = { steps, byId, agents, docReviews, roles }
  built.set(key, out)
  return out
}

export const stepsIn = (l = lang()) => [...catalog(l).steps.values()]
export const agentsIn = (l = lang()) => catalog(l).agents
// a step by its label in either language; null for a label neither core nor an enabled pack has
export const stepOf = (label) => catalog('ko').steps.get(String(label || '')) || catalog('en').steps.get(String(label || '')) || null
// the pack step that runs a skill (pack.json "skill")
export const stepForSkill = (skill, l = lang()) => (skill ? stepsIn(l).find((s) => s.skill === skill && s.kind === 'agent') || null : null)
// a role as a person's step (either language): register gives that role to whoever did the step before
export const stepByRole = (role) => [...stepsIn('ko'), ...stepsIn('en')].find((s) => s.role === role) || null
// a role name in a language (core and the packs' "roles"): intake, reply, reviewer
export const roleIn = (key, l = lang()) => pick(catalog(l).roles[key], normLang(l) === 'en' ? 'en' : 'ko') || null

// a step label in the other language (the code names core steps by their Korean label; an English case
// records the English one). A label no catalog knows is kept as it is.
export function labelIn(label, l = lang()) {
  const s = String(label || '')
  const st = stepOf(s)
  if (!st) return s
  return catalog(normLang(l) === 'en' ? 'en' : 'ko').byId.get(st.id)?.label || s
}
// both spellings of a step (matching records of either language)
export const labelsOf = (label) => [...new Set([labelIn(label, 'ko'), labelIn(label, 'en')])]
// the language a step label (or a mined flow) is in (a character range, not a word)
export const labelLang = (label) => (/[가-힣]/.test(String(label || '')) ? 'ko' : 'en')

// a step for a draft no pack step makes: named for the document the mail asked for (its triage kind)
export function draftStep(kind, l = lang(), format = null) {
  const en = normLang(l) === 'en'
  const label = en ? `Write ${kind}` : `${kind} 작성`
  return { label, kind: 'agent', key: null, pack: null, role: agentsIn(l).draft.name, tool: format, skill: null, format, document: kind, agent: 'draft',
    description: en ? `Makes the draft of the ${kind} the request asks for.` : `요청한 ${kind} 초안을 만들어요.`, instruction: '',
    fields: [{ key: 'document', text: kind, type: 'file' }], total_field: null, review: null, formats: null, judge: null }
}
// a review named for what was reviewed (a document kind, a role): recorded as a person's step
export function reviewStep(label, l = lang(), role = null) {
  const en = normLang(l) === 'en'
  return { label, kind: 'human', key: null, pack: null, role, tool: pick(SHARE_TOOL, en ? 'en' : 'ko'), skill: 'team-share-review', format: null, agent: null,
    description: reviewText(label, en ? 'en' : 'ko'), instruction: '', fields: REVIEW_FIELDS[en ? 'en' : 'ko'], total_field: null, review: 'document', formats: null, judge: null }
}
export const reviewLabel = (what, l = lang()) => (normLang(l) === 'en' ? `${what} review` : `${what} 검토`)

// The review a shared set of files is, by the pack's document reviews: the first kind whose format is
// among them (an enabled pack only — a company without one names reviews after the case's own documents)
export function docReview(names = [], l = lang()) {
  const exts = new Set(names.map((n) => String(n || '').toLowerCase().split('.').pop()).filter(Boolean))
  return catalog(l).docReviews.find((r) => r.formats.some((e) => exts.has(e)))?.label || ''
}
// the review kinds a pack names after a reviewer's role (the judge's options when no document decides)
export const roleReviews = (l = lang()) => stepsIn(l).filter((s) => s.review === 'role')

// what a document of a step's tool is (a pack step's tool → its format; a draft step records its format as the tool)
const FORMATS = new Set(['xlsx', 'docx', 'pptx', 'hwpx', 'dxf', 'pdf'])
export function formatOfTool(tool) {
  const t = String(tool || '')
  const st = [...stepsIn('ko'), ...stepsIn('en')].find((s) => s.tool === t && s.format)
  return st ? st.format : FORMATS.has(t.toLowerCase()) ? t.toLowerCase() : null
}
export const packsOn = () => [...enabledNow()]
