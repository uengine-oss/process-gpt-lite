// Panel apps: secure by default (기본 보안·개인정보).
// Every field gets a sensitivity — public | internal | personal | sensitive. The final level is the
// strictest of three (decision 1, 2026-11-21):
//   1. the model's proposal — the designer's own "sensitivity", and a reviewer model's (proposeLevels)
//   2. the policy words (policies/privacy.json: every language, a company can add words — data, not code)
//   3. the field type floor: email · phone · person are personal whatever the label says
// so a field can be classified higher than proposed but never lower; lowering is the folder owner's
// explicit act (panelApps/service.js setSensitivity: confirmed and audited). Who may read a restricted
// field follows from its level:
//   public / internal → every folder member
//   personal          → the subject (the person the record is about), the record's author, folder owner
//   sensitive         → the subject and the folder owner (the author only when there is no subject)
// The subject is the record's person field (list apps) or the entity key (event apps). The subject
// itself stays visible to members — a team app has to show whose record it is.
// Any restricted field puts the app in the database tier: a shared xlsx cannot hide a column from
// the members who can open it. Aggregates over restricted numbers are shown as a team total only when
// at least K_ANON different subjects contribute.
import { config } from '../../config.js'
import { L, isEn } from '../lang.js'
import * as POL from '../policies.js'

export const LEVELS = ['public', 'internal', 'personal', 'sensitive']
export const K_ANON = 3
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]))
// a type that holds a person or a way to reach one (a schema fact, not a word)
const PERSON_TYPES = new Set(['email', 'phone', 'person'])
const said = (list, text) => POL.anyWord('privacy', 'words', list, text, { tenant: config.tenantId })

export const levelOf = (f) => (LEVELS.includes(f?.sensitivity) ? f.sensitivity : 'internal')
export const restricted = (f) => RANK[levelOf(f)] >= RANK.personal

// the person a record is about: a person field the model named, else the first person field
export function subjectOf(def) {
  if (def.kind === 'events') return def.entity?.type === 'person' ? def.entity.key : null
  const named = def.fields.find((f) => f.key === def.subject && f.type === 'person')
  return (named || def.fields.find((f) => f.type === 'person'))?.key || null
}

// the floor: what a field is at least, whatever the model said — the policy words read the label
// and the key in every language, the type floor reads no words
export function floorOf(def, f, subject) {
  const text = `${f.label || ''} ${f.key || ''}`
  if (said('sensitive', text)) return 'sensitive'
  if (f.key === subject) return 'internal'
  if (said('personal', text) || PERSON_TYPES.has(f.type)) return 'personal'
  if (subject && (f.type === 'longtext' || said('note', text))) return 'personal'
  return 'public'
}

export function classify(def, { proposals = {} } = {}) {
  const subject = subjectOf(def)
  const fields = def.fields.map((f) => {
    const own = LEVELS.includes(f.sensitivity) ? f.sensitivity : 'internal'
    const review = LEVELS.includes(proposals[f.key]) ? proposals[f.key] : 'public'
    const floor = floorOf(def, f, subject)
    return { ...f, sensitivity: [own, review, floor].reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) }
  })
  return { ...def, fields, subject: subject || undefined }
}

// A second model's proposal, field by field (the designer named the fields and proposed levels in one
// go; a label the policy words do not know is caught here). One call for
// the whole app; {} when no model answers (the designer's proposal and the floors still hold).
export async function proposeLevels(def, { timeoutMs = 20000 } = {}) {
  if (!config.llm?.apiKey || !def?.fields?.length) return {}
  const { chatJson } = await import('../llm.js')
  const list = def.fields.map((f) => `- ${f.key}: "${String(f.label || '').slice(0, 80)}" (${f.type || 'text'})`).join('\n')
  const system = 'You classify the fields of a team app by how private the data in them is. Levels: '
    + 'public (nothing about a person), internal (work data for the team), personal (identifies or reaches a person: contact, address, birth date, employee or personal number, age), '
    + 'sensitive (pay and money a person receives, evaluations, health or medical facts and the reasons for an absence, national or bank or card numbers, family, discipline, criminal record, disability, religion, politics, union, sexual orientation, biometrics, passwords). '
    + 'Judge by what a value would reveal about a person, in any language: part of an identifier (its last digits) counts as the identifier, and a field telling whether a person is under a disciplinary or similar personal proceeding counts as that proceeding. '
    + 'When torn between two levels, choose the higher. Answer JSON only: {"levels": {"<field key>": "<level>"}}.'
  try {
    const j = await chatJson(system, `App: ${String(def.title || '').slice(0, 80)}\nFields:\n${list}`, { model: config.llm.fastModel, temperature: 0, timeoutMs, maxTokens: 2048, effort: 'low' })
    const out = {}
    for (const f of def.fields) if (LEVELS.includes(j?.levels?.[f.key])) out[f.key] = j.levels[f.key]
    return out
  } catch (e) { console.warn('[privacy] proposeLevels', e.message); return {} }
}
// the classification with the reviewer's proposal in it (what a new or changed design should go through)
export async function classifyReviewed(def) {
  return classify(def, { proposals: await proposeLevels(def) })
}

// who may read a field, as rule terms (the database compiles the same terms)
export function readersOf(def, f) {
  const lvl = levelOf(f)
  if (RANK[lvl] < RANK.personal) return null // every member
  const subject = subjectOf(def)
  if (lvl === 'personal') return [...(subject ? ['subject_is_me'] : []), 'owner_of_row', 'role>=owner']
  return [...(subject ? ['subject_is_me'] : ['owner_of_row']), 'role>=owner']
}

// the safer storage: any restricted field (or row-level rule) → database
export const needsDb = (def) => def.fields.some(restricted) || !!def.access || !!def.fieldRules || def.tier === 'db'

// writes about someone else need editor; history is never edited (events) — list apps get the same
// "your own records unless you manage the folder" default
export function defaultAccess(def) {
  const subject = subjectOf(def)
  if (def.kind === 'events') return { read: ['member'] }
  const mine = subject ? ['subject_is_me', 'owner_of_row'] : ['owner_of_row']
  return {
    read: ['member'],
    create: subject ? ['subject_is_me', 'role>=editor'] : ['member'],
    update: [...mine, 'role>=owner'],
    delete: [...mine, 'role>=owner'],
  }
}

const WHO = { 'subject_is_me': '본인(기록의 대상)', owner_of_row: '기록한 사람', 'role>=owner': '폴더 소유자(관리자)' }
const LV_KO = { public: '공개', internal: '팀 내부', personal: '개인정보', sensitive: '민감 정보' }
const WHO_EN = { 'subject_is_me': 'the person themselves (the subject)', owner_of_row: 'whoever recorded it', 'role>=owner': 'the folder owner (manager)' }
const LV_EN = { public: 'public', internal: 'team-internal', personal: 'personal information', sensitive: 'sensitive information' }
// the "Security & privacy defaults" card in English (glossary: masked values read 'Private')
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
function describePrivacyEn(def) {
  const subject = subjectOf(def)
  const subjLabel = subject ? (def.kind === 'events' ? def.entity.label : def.fields.find((f) => f.key === subject)?.label) : null
  const lines = []
  lines.push({ kind: 'who', text: "Only members of the folder can see this app. Anyone else sees no list, no data and no counts." })
  if (subjLabel) lines.push({ kind: 'subject', text: `Each record is about the '${subjLabel}' field. Every member can see whose record it is.` })
  for (const f of def.fields) {
    const r = readersOf(def, f)
    if (!r) continue
    lines.push({ kind: levelOf(f), field: f.key, text: `'${f.label}' is ${LV_EN[levelOf(f)]}, so only ${andList(r.map((t) => WHO_EN[t]))} can see it. Other members see 'Private'.` })
  }
  if (def.kind === 'events') lines.push({ kind: 'history', text: "Records can't be deleted or changed. If one is wrong, add a cancellation or correction (the whole history stays)." })
  else if (subjLabel) lines.push({ kind: 'write', text: "You can create and edit only your own records. Other people's records are handled by editors and up (create) and the folder owner (edit)." })
  if (def.fields.some(restricted)) lines.push({ kind: 'tier', text: 'Some fields must stay hidden, so the data is kept in the database rather than in the shared folder\'s sheet. Opening it as a sheet gives you a copy with only what you may see.' })
  if (def.fields.some((f) => levelOf(f) === 'sensitive' && f.type === 'number')) lines.push({ kind: 'kanon', text: `Team totals of sensitive numbers are shown only when at least ${K_ANON} people contribute.` })
  return lines
}
// the "보안·개인정보 기본값" card
export function describePrivacy(def) {
  if (isEn()) return describePrivacyEn(def)
  const subject = subjectOf(def)
  const subjLabel = subject ? (def.kind === 'events' ? def.entity.label : def.fields.find((f) => f.key === subject)?.label) : null
  const lines = []
  lines.push({ kind: 'who', text: '폴더 구성원만 이 앱을 볼 수 있어요. 구성원이 아니면 목록·데이터·건수 모두 보이지 않아요.' })
  if (subjLabel) lines.push({ kind: 'subject', text: `기록의 대상은 '${subjLabel}' 항목이에요. 누구의 기록인지는 구성원 모두에게 보여요.` })
  for (const f of def.fields) {
    const r = readersOf(def, f)
    if (!r) continue
    lines.push({ kind: levelOf(f), field: f.key, text: `'${f.label}'은(는) ${LV_KO[levelOf(f)]}라 ${r.map((t) => WHO[t]).join('·')}만 봐요. 다른 구성원에게는 '비공개'로 보여요.` })
  }
  if (def.kind === 'events') lines.push({ kind: 'history', text: '기록은 지우거나 고칠 수 없어요. 잘못 넣었으면 취소·정정 기록을 더해요(모든 이력이 남아요).' })
  else if (subjLabel) lines.push({ kind: 'write', text: `자기 기록만 만들고 고칠 수 있어요. 다른 사람의 기록은 편집 권한 이상(만들기)·폴더 소유자(고치기)만 다뤄요.` })
  if (def.fields.some(restricted)) lines.push({ kind: 'tier', text: '숨겨야 할 항목이 있어 데이터는 공유 폴더의 시트가 아니라 데이터베이스에 저장돼요. 시트로 열면 내가 볼 수 있는 것만 담긴 사본이 열려요.' })
  if (def.fields.some((f) => levelOf(f) === 'sensitive' && f.type === 'number')) lines.push({ kind: 'kanon', text: `민감한 숫자의 팀 합계는 ${K_ANON}명 이상일 때만 보여요.` })
  return lines
}
