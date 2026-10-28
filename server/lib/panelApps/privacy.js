// Panel apps: secure by default (기본 보안·개인정보).
// Every field gets a sensitivity — public | internal | personal | sensitive. The designer (model)
// proposes it; this module applies a deterministic floor (keywords and types), so a field can be
// classified higher than proposed but never lower. Who may read a restricted field follows from it:
//   public / internal → every folder member
//   personal          → the subject (the person the record is about), the record's author, folder owner
//   sensitive         → the subject and the folder owner (the author only when there is no subject)
// The subject is the record's person field (list apps) or the entity key (event apps). The subject
// itself stays visible to members — a team app has to show whose record it is.
// Any restricted field puts the app in the database tier: a shared xlsx cannot hide a column from
// the members who can open it. Aggregates over restricted numbers are shown as a team total only when
// at least K_ANON different subjects contribute.
import { L, isEn } from '../lang.js'

export const LEVELS = ['public', 'internal', 'personal', 'sensitive']
export const K_ANON = 3
const RANK = Object.fromEntries(LEVELS.map((l, i) => [l, i]))
const SENSITIVE = /급여|연봉|월급|보수|상여|성과급|평가|고과|건강|질병|병명|진단|병가|사유|주민|계좌|통장|카드\s*번호|가족|징계|상벌|장애|종교|비밀번호|정치|노조/
const PERSONAL = /연락처|전화|휴대폰|핸드폰|이메일|메일|주소|생년월일|생일|나이|사번|사원\s*번호|개인|자택|집\s*주소/
const NOTE = /메모|비고|사유|내용|설명|코멘트|의견/
// the same floor for an English label (an English-mode app); a label with Hangul keeps the Korean words only
const SENSITIVE_EN = /salary|wage|pay\b|payroll|compensation|bonus|incentive|evaluation|appraisal|review score|performance|health|illness|\bsick\b|medical|diagnos|reason|resident (registration )?no|ssn|social security|\bbank\b|account (no|number)|card (no|number)|family|disciplin|disabilit|religio|password|politic|\bunion\b/i
const PERSONAL_EN = /contact|phone|mobile|\bcell\b|e-?mail|address|birth|birthday|\bage\b|employee (id|no|number)|staff (id|no)|personal|\bhome\b/i
const NOTE_EN = /note|memo|remark|reason|detail|description|comment|opinion/i
const hangul = (s) => /[가-힣]/.test(s)

export const levelOf = (f) => (LEVELS.includes(f?.sensitivity) ? f.sensitivity : 'internal')
export const restricted = (f) => RANK[levelOf(f)] >= RANK.personal

// the person a record is about: a person field the model named, else the first person field
export function subjectOf(def) {
  if (def.kind === 'events') return def.entity?.type === 'person' ? def.entity.key : null
  const named = def.fields.find((f) => f.key === def.subject && f.type === 'person')
  return (named || def.fields.find((f) => f.type === 'person'))?.key || null
}

// the floor: what a field is at least, whatever the model said
export function floorOf(def, f, subject) {
  const text = `${f.label} ${f.key}`
  const en = !hangul(String(f.label || ''))
  if (SENSITIVE.test(f.label) || (en && SENSITIVE_EN.test(f.label))) return 'sensitive'
  if (f.key === subject) return 'internal'
  if (PERSONAL.test(f.label) || (en && PERSONAL_EN.test(f.label)) || ['email', 'phone'].includes(f.type)) return 'personal'
  if (f.type === 'person') return 'personal'
  if (subject && (f.type === 'longtext' || NOTE.test(text) || (en && NOTE_EN.test(text)))) return 'personal'
  return 'public'
}

export function classify(def) {
  const subject = subjectOf(def)
  const fields = def.fields.map((f) => {
    const proposed = LEVELS.includes(f.sensitivity) ? f.sensitivity : 'internal'
    const floor = floorOf(def, f, subject)
    return { ...f, sensitivity: RANK[floor] > RANK[proposed] ? floor : proposed }
  })
  return { ...def, fields, subject: subject || undefined }
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
