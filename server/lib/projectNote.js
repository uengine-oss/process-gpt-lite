// 프로젝트 계획 — 프로젝트의 목적과 약속을 그 방의 모든 대화가 먼저 읽는다 (설계 turnplan §4 「Project memory」 · §6 P2, 화면 이름 「프로젝트 계획」).
// 2026-11-27 녹화(운영, 프로젝트 「링크 슬라이드 팟캐스트」): 「이게 뭔가 해당 프로젝트에 공통적인 미션으로 초반에 넣어 놨기 때문에 … 이 프로젝트의 방향이
// 목적이 이렇다 라고 하는 것을 … 클로드MD처럼 뭔가 마스터 플랜 같은 이런게 있어야 되겠죠」. 그 방에서는 작업에 준 세부 지시(어느 사이트의 글은
// 내 계정으로 인쇄해 PDF 로 넣으라는 말)가 방의 규칙(원래 미션)을 덮어썼고, 링크만 보낸 다음 턴은 그 미션을 몰랐고, 목적을 다시 말한 「앞으로 …」는
// 후행 습관으로 갔다. (판단 코드라 사이트 · 서비스 이름은 여기 쓰지 않는다 — 그 지식은 스킬 모듈에만)
//
// 계획은 방의 메시지 행 하나다(role system, kind note, content.projectNote — SQL 없음). 가장 새 행이 계획이고, 그 앞의 행이 이력이다(20개).
//   { v: 1, intent, intentPinned?, deliverables: [{text, pinned?}], tools: [{name, kind, ref, how, pinned?}], constraints: [{text, pinned?}],
//     decisions: [{text, pinned?}], upTo: <이 계획이 읽은 마지막 메시지 id>, updatedAt, editedBy: 'person'|'assistant' }
// (설계의 문자열 목록 대신 항목마다 {text, pinned} — 사람이 고친 항목만 고정해 모델이 손대지 못하게 하려면 항목에 표시가 있어야 한다)
//   · 처음 채우기(backfill): 계획이 없는 프로젝트의 첫 턴 — 지난 40 메시지 · 하위 대화의 제목과 요지 · 지금 규칙 · 방 이름에서
//   · 고치기(update): 턴이 끝나고 앞단 계획이 「계획에 남길 말」이라고 했거나 5 턴이 지났을 때, 규칙을 정할 때(받아 적기 전에 기다림)
//   · 계획에 넣기(addFromMessage): 방 판정이 plan 을 고른 말 — 지킬 것 · 정한 것 한 항목으로(고정)
//   · 사람이 고침(editNote, PUT): 고친 항목은 고정. 고치는 사람은 방의 주인뿐(사용자 결정 11-25 「프로젝트 메모 = 주인만」)
// 바뀐 것은 방에 칩으로(「계획에 넣었어요: … · 되돌리기 · 계획 보기」), 되돌리기는 그 앞의 행으로.
// 바뀐 기록(2026-11-27 사용자: 「중간중간 방향을 개선하거나 수정한 내용 등이 이 파일에 관리되어야 한다」): 계획의 행마다 그 행을 만든 변경
// (content.projectNote.change — 언제 · 누가 · 무엇이 · 어느 메시지에서 · 바뀐 항목)이 남고, 시트의 「바뀐 기록」에서 하나씩 되돌린다(revertChange).
// 계획은 방의 기록과 따로 읽힌다(「뒤로 갈수록 휘발」 — 같은 날 사용자): 대화가 아무리 길어도 턴마다 계획의 행을 읽어 넘기고, 처음 채우기는
// 마지막 40개만이 아니라 방의 처음 메시지와 규칙을 정한 메시지도 읽는다.
// 계획은 배경이고 이번 메시지가 결정한다(설계의 위험 항목). 말의 뜻은 모델이 읽는다 — 질문 · 프롬프트는 스킬 project-plan(skills/project-plan).
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { L, isEn } from './lang.js'
import { chatJson } from './llm.js'
import { addMessage } from './store.js'
import { skillPack, readSkillDir, bundledDir } from './skillPack.js'
import { browserSkills } from './browserSkills.js'
import { taskLine } from './turnPlan.js'

export const SKILL = 'project-plan'
export const KINDS = ['browser_skill', 'connector', 'service', 'app', 'agent_skill', 'local_agent']
export const LISTS = { deliverables: [5, 80], constraints: [6, 120], decisions: [6, 120] }
export const LIMITS = { intent: 200, tools: 8, toolName: 60, how: 120, ref: 80 }
const DEFAULTS = { model: '', timeoutMs: 30000, maxTokens: 2000, backfillWaitMs: 8000, backfillMessages: 40, backfillFirst: 6, backfillTopics: 12, everyTurns: 5,
  sinceMessages: 12, sinceChars: 600, keepRows: 20, textCap: 1200 }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (status, message) => Object.assign(new Error(message), { status })
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const same = (a, b) => clean(a, 999).toLowerCase() === clean(b, 999).toLowerCase()

// ---------- the skill (questions, options, prompts — a company may change them) ----------
let bundled = null
const bundledSkill = () => (bundled ||= readSkillDir(bundledDir(SKILL)) || { rules: {}, prompts: {}, version: '-' })
export async function planSkill() {
  const s = await skillPack(SKILL).catch(() => ({ name: SKILL, source: 'bundled', ...bundledSkill() }))
  return { ...s, rules: { ...DEFAULTS, ...(s.rules || {}) } }
}
export const promptOf = (sk, name) => (isEn() && sk.prompts?.[`${name}-en`]) || sk.prompts?.[name] || ''
// the room judge's question and option labels in the language of the turn (lib/roomRules.js); the bundled ones when no skill is given
export function roomTexts(sk = null) {
  const r = (sk || bundledSkill()).rules?.room || bundledSkill().rules?.room || {}
  const lang = isEn() ? 'en' : 'ko'
  return { question: r.question?.[lang] || r.question?.ko || '', options: { ...(r.options?.ko || {}), ...(r.options?.[lang] || {}) } }
}

// ---------- pure: the note's shape ----------
export const emptyNote = () => ({ v: 1, intent: '', deliverables: [], tools: [], constraints: [], decisions: [] })
export const isEmpty = (n) => !n || (!n.intent && !n.deliverables?.length && !n.tools?.length && !n.constraints?.length && !n.decisions?.length)
// the registered names a tool's ref may be: the browser skills (lib/browserSkills.js) and any the caller adds (agent skills …)
export const refSet = (extra = []) => new Set([...browserSkills().map((s) => s.name), ...extra.filter(Boolean)])
// a browser skill's name as people know it (metadata.label in its SKILL.md), else its name
export const skillLabel = (name) => { const s = browserSkills().find((x) => x.name === name); return s ? s.label || s.name : '' }

// over the count: the oldest item that is not pinned goes first (a list is oldest first)
export function cut(list, max) {
  const out = [...list]
  while (out.length > max) {
    const i = out.findIndex((x) => !x.pinned)
    out.splice(i < 0 ? out.length - 1 : i, 1)
  }
  return out
}
function items(v, [max, n]) {
  const out = []
  for (const x of Array.isArray(v) ? v : []) {
    const text = clean(typeof x === 'string' ? x : x?.text, n)
    if (!text || out.some((o) => same(o.text, text))) continue
    out.push({ text, ...(x && typeof x === 'object' && x.pinned ? { pinned: true } : {}) })
  }
  return cut(out, max)
}
// any JSON → a note in shape (lengths, counts, kinds; a ref that is not a registered name is blanked — design §4.1)
export function normalize(raw, { refs = null } = {}) {
  const j = raw && typeof raw === 'object' ? raw : {}
  const known = refs || refSet()
  const tools = []
  for (const t of Array.isArray(j.tools) ? j.tools : []) {
    const name = clean(typeof t === 'string' ? t : t?.name, LIMITS.toolName)
    if (!name || tools.some((o) => same(o.name, name))) continue
    const ref0 = clean(t?.ref, LIMITS.ref)
    // (a tool named by a registered skill's own name or label, word for word, is that skill — format, not meaning)
    const byName = browserSkills().find((s) => same(s.name, name) || (s.label && same(s.label, name)))?.name || ''
    const ref = ref0 && known.has(ref0) ? ref0 : byName && known.has(byName) ? byName : ''
    const browser = ref && browserSkills().some((s) => s.name === ref)
    const kind = browser ? 'browser_skill' : KINDS.includes(t?.kind) ? t.kind : 'service'
    tools.push({ name, kind, ref, how: clean(t?.how, LIMITS.how), ...(t && typeof t === 'object' && t.pinned ? { pinned: true } : {}) })
  }
  const out = { v: 1, intent: clean(j.intent, LIMITS.intent), ...(j.intentPinned && clean(j.intent, 1) ? { intentPinned: true } : {}),
    deliverables: items(j.deliverables, LISTS.deliverables), tools: cut(tools, LIMITS.tools),
    constraints: items(j.constraints, LISTS.constraints), decisions: items(j.decisions, LISTS.decisions) }
  if (UUID.test(String(j.upTo || ''))) out.upTo = String(j.upTo)
  if (j.updatedAt) out.updatedAt = String(j.updatedAt)
  if (['person', 'assistant'].includes(j.editedBy)) out.editedBy = j.editedBy
  return out
}

// what the model reads of a note (the same shape, the pinned items marked)
export function noteForModel(n) {
  if (!n || isEmpty(n)) return L('(없음)', '(none)')
  const pin = L(' (고정)', ' (pinned)')
  return JSON.stringify({
    intent: n.intent + (n.intentPinned ? pin : ''),
    deliverables: n.deliverables.map((x) => x.text + (x.pinned ? pin : '')),
    tools: n.tools.map((t) => ({ name: t.name + (t.pinned ? pin : ''), kind: t.kind, ref: t.ref, how: t.how })),
    constraints: n.constraints.map((x) => x.text + (x.pinned ? pin : '')),
    decisions: n.decisions.map((x) => x.text + (x.pinned ? pin : '')),
  }, null, 1)
}
// the model may not change or drop a pinned item: they are put back where they were (design §4.2)
export function keepPinned(next, prev) {
  if (!prev) return next
  const strip = (s) => String(s || '').replace(/\s*\((고정|pinned)\)\s*$/i, '')
  const out = { ...next }
  if (prev.intentPinned) Object.assign(out, { intent: prev.intent, intentPinned: true })
  else out.intent = strip(out.intent)
  for (const k of Object.keys(LISTS)) {
    const pins = (prev[k] || []).map((x, i) => ({ x, i })).filter(({ x }) => x.pinned)
    const list = (next[k] || []).map((x) => ({ text: strip(x.text) })).filter((x) => x.text && !pins.some(({ x: p }) => same(p.text, x.text)))
    for (const { x, i } of pins) list.splice(Math.min(i, list.length), 0, { text: x.text, pinned: true })
    out[k] = cut(list, LISTS[k][0])
  }
  const tpins = (prev.tools || []).map((t, i) => ({ t, i })).filter(({ t }) => t.pinned)
  const tools = (next.tools || []).map((t) => ({ ...t, name: strip(t.name), pinned: undefined })).filter((t) => !tpins.some(({ t: p }) => same(p.name, t.name)))
    .map(({ pinned, ...t }) => t)
  for (const { t, i } of tpins) tools.splice(Math.min(i, tools.length), 0, t)
  out.tools = cut(tools, LIMITS.tools)
  return out
}

// what changed between two notes → {intent?: {from, to}, added: {k: [...]}, removed: {k: [...]}} (tools by name, the rest by text)
export function diff(prev, next) {
  const a = prev || emptyNote(), b = next || emptyNote()
  const out = { added: {}, removed: {} }
  if (clean(a.intent, 999) !== clean(b.intent, 999)) out.intent = { from: a.intent || '', to: b.intent || '' }
  for (const k of Object.keys(LISTS)) {
    const add = b[k].filter((x) => !a[k].some((y) => same(y.text, x.text))).map((x) => x.text)
    const rem = a[k].filter((x) => !b[k].some((y) => same(y.text, x.text)))
    if (add.length) out.added[k] = add
    if (rem.length) out.removed[k] = rem
  }
  const toolKey = (t) => `${clean(t.name, 99).toLowerCase()}|${t.ref}|${clean(t.how, 999)}`
  const tadd = b.tools.filter((t) => !a.tools.some((u) => toolKey(u) === toolKey(t)))
  const trem = a.tools.filter((t) => !b.tools.some((u) => toolKey(u) === toolKey(t)))
  if (tadd.length) out.added.tools = tadd
  if (trem.length) out.removed.tools = trem
  return out
}
export const changed = (d) => !!d && (!!d.intent || Object.keys(d.added).length > 0 || Object.keys(d.removed).length > 0)
// a change taken back: what it added goes, what it took out comes back, the purpose returns when it still is the one it set
export function undoOn(note, change) {
  const n = { ...normalize(note), upTo: note?.upTo }
  const d = change || {}
  for (const k of Object.keys(LISTS)) {
    n[k] = n[k].filter((x) => !(d.added?.[k] || []).some((t) => same(t, x.text)))
    for (const x of d.removed?.[k] || []) if (!n[k].some((y) => same(y.text, x.text))) n[k].push(x)
    n[k] = cut(n[k], LISTS[k][0])
  }
  n.tools = n.tools.filter((t) => !(d.added?.tools || []).some((u) => same(u.name, t.name) && u.how === t.how && u.ref === t.ref))
  for (const t of d.removed?.tools || []) if (!n.tools.some((u) => same(u.name, t.name))) n.tools.push(t)
  n.tools = cut(n.tools, LIMITS.tools)
  if (d.intent && same(n.intent, d.intent.to)) { n.intent = d.intent.from; delete n.intentPinned }
  return n
}
// the person's own edit (PUT): what they changed or added is pinned; what they left as it was keeps its mark (design §4.2)
export function markEdited(next, prev) {
  const p = prev || emptyNote()
  const out = { ...next }
  out.intentPinned = !!out.intent && (same(out.intent, p.intent) ? !!p.intentPinned : true)
  if (!out.intentPinned) delete out.intentPinned
  for (const k of Object.keys(LISTS)) {
    out[k] = next[k].map((x) => { const was = p[k].find((y) => same(y.text, x.text)); return { text: x.text, ...((was ? was.pinned : true) ? { pinned: true } : {}) } })
  }
  out.tools = next.tools.map(({ pinned, ...t }) => {
    const was = p.tools.find((u) => same(u.name, t.name) && same(u.how, t.how) && u.ref === t.ref)
    return { ...t, ...((was ? was.pinned : true) ? { pinned: true } : {}) }
  })
  return out
}

// ---------- the text every consumer gets (design §4.1: 1,200 characters at most) ----------
const toolText = (t) => {
  const where = t.kind === 'browser_skill' && t.ref ? L(`서버 브라우저 스킬 ${t.ref}`, `server browser skill ${t.ref}`) : t.ref ? `${t.kind} ${t.ref}` : t.kind
  return `${t.name} (${where})${t.how ? `: ${t.how}` : ''}`
}
function rawText(n) {
  const lines = [L('[프로젝트 계획] 이 프로젝트의 모든 대화가 먼저 읽는 배경이다. 이번 메시지가 무엇을 할지 정한다.', "[Project plan] The background every conversation of this project reads first. The message now decides what to do.")]
  if (n.intent) lines.push(`${L('목적', 'Purpose')}: ${n.intent}`)
  if (n.deliverables.length) lines.push(`${L('만들 것', 'Deliverables')}: ${n.deliverables.map((x) => x.text).join(' · ')}`)
  if (n.tools.length) lines.push(`${L('쓰는 도구', 'Tools')}:`, ...n.tools.map((t) => `- ${toolText(t)}`))
  if (n.constraints.length) lines.push(`${L('지킬 것', 'Keep to')}:`, ...n.constraints.map((x) => `- ${x.text}`))
  if (n.decisions.length) lines.push(`${L('정한 것', 'Decided')}:`, ...n.decisions.map((x) => `- ${x.text}`))
  return lines.join('\n')
}
// over the cap: the oldest unpinned decision goes first, then the oldest unpinned constraint, then deliverables (design §4.1)
export function fit(note, cap = DEFAULTS.textCap) {
  const n = normalize(note)
  for (;;) {
    if (rawText(n).length <= cap) return n
    const k = ['decisions', 'constraints', 'deliverables'].find((key) => n[key].some((x) => !x.pinned))
    if (!k) return n
    n[k].splice(n[k].findIndex((x) => !x.pinned), 1)
  }
}
export function noteText(note, { cap = DEFAULTS.textCap } = {}) {
  if (!note || isEmpty(note)) return ''
  const t = rawText(fit(note, cap))
  return t.length > cap ? `${t.slice(0, cap - 1)}…` : t
}
// the browser skills the plan names as this project's tools (what the router may take as the expected handler)
export const planSkills = (note) => (note?.tools || []).filter((t) => t.kind === 'browser_skill' && t.ref).map((t) => t.ref)

// ---------- the database ----------
export async function noteRow(userId, threadId) {
  if (!UUID.test(String(threadId || ''))) return null
  const [row] = await q(`select m.id, m.content, m.created_at from pro_messages m join pro_threads t on t.id = m.thread_id
    where m.thread_id=$1 and t.user_id=$2 and t.kind='project' and m.kind='note' and jsonb_typeof(m.content->'projectNote') = 'object'
    order by m.created_at desc, m.id desc limit 1`, [threadId, userId])
  return row ? { id: row.id, note: normalize(row.content.projectNote), at: row.created_at, change: row.content.projectNote.change || null } : null
}
// a new row (the older ones are its history, keepRows of them) — never through addMessage: it is not a chat message and does not move the room
// change: what made this row (changeOf) — the plan's history
export async function saveNote(userId, threadId, note, { editedBy = 'assistant', upTo, keep = DEFAULTS.keepRows, change = null } = {}) {
  const n = { ...fit(note), upTo: upTo !== undefined ? upTo : note?.upTo || null, updatedAt: new Date().toISOString(), editedBy, ...(change ? { change } : {}) }
  if (!n.upTo) delete n.upTo
  const [m] = await q(`insert into pro_messages(thread_id, role, kind, content) values ($1, 'system', 'note', $2) returning id, created_at`, [threadId, { projectNote: n }])
  await q(`delete from pro_messages where thread_id=$1 and kind='note' and id not in
    (select id from pro_messages where thread_id=$1 and kind='note' order by created_at desc, id desc limit $2)`, [threadId, keep])
  emit(userId, 'projectNote', { threadId, id: m.id, note: n })
  return { id: m.id, note: n, at: m.created_at }
}
const touchUpTo = (id, upTo) => (upTo ? q(`update pro_messages set content = jsonb_set(content, '{projectNote,upTo}', to_jsonb($2::text)) where id=$1`, [id, upTo]) : null)
async function ownedProject(userId, threadId) {
  if (!UUID.test(String(threadId || ''))) return null
  const [t] = await q(`select * from pro_threads where id=$1 and user_id=$2 and kind='project'`, [threadId, userId])
  return t || null
}

// the room's messages for the model, oldest first: the person's and the assistant's words, a task card as one line
const lineOf = (r, chars) => {
  if (r.kind === 'task' || r.kind === 'local_run') return `${L('작업 카드', 'Task card')}: ${taskLine(r)}`
  const t = clean(r.role !== 'user' && r.content?.detail ? r.content.detail : r.content?.text, chars)
  return t ? `${r.role === 'user' ? L('사람', 'Person') : L('비서', 'Assistant')}: ${t}` : ''
}
const asLine = (chars) => (r) => ({ id: r.id, role: r.role, text: clean(r.content?.text, 160), line: lineOf(r, chars) })
async function messages(threadId, { after = null, limit, chars }) {
  const rows = await q(`select id, role, kind, content, created_at from pro_messages where thread_id=$1 and kind in ('text','doc','task','local_run')
    and created_at > coalesce((select created_at from pro_messages where id = $2::uuid), to_timestamp(0)) order by created_at desc limit $3`,
  [threadId, after && UUID.test(after) ? after : null, limit])
  return rows.reverse().map(asLine(chars)).filter((x) => x.line)
}
// What the first plan is filled in from: the room's first messages (where a project's mission is usually set), every message that set a rule
// (turned off ones too — the rule's own history), and the last ones. A long room keeps its mission in view: the last 40 alone left out what
// was said at the start (2026-11-27 사용자: 「뒤로 갈수록 휘발되는 경우가 있다」). Which rows — by position and by the rule field — is structure.
export async function backfillMessages(threadId, { first = DEFAULTS.backfillFirst, last = DEFAULTS.backfillMessages, chars = DEFAULTS.sinceChars } = {}) {
  const cols = `id, role, kind, content, created_at`
  const kinds = `kind in ('text','doc','task','local_run')`
  const [head, rules, tail] = await Promise.all([
    q(`select ${cols} from pro_messages where thread_id=$1 and ${kinds} order by created_at, id limit $2`, [threadId, first]),
    q(`select ${cols} from pro_messages where thread_id=$1 and ${kinds} and jsonb_typeof(content->'roomRule') = 'object' order by created_at`, [threadId]),
    q(`select ${cols} from pro_messages where thread_id=$1 and ${kinds} order by created_at desc, id desc limit $2`, [threadId, last]),
  ])
  const [{ n }] = await q(`select count(*)::int as n from pro_messages where thread_id=$1 and ${kinds}`, [threadId])
  const byId = new Map([...head, ...rules, ...tail].map((r) => [r.id, r]))
  const rows = [...byId.values()].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
  const out = []
  const tailFrom = tail.length ? new Date(tail[tail.length - 1].created_at) : null
  let gapSaid = false
  for (const r of rows) {
    // (where the room's middle is left out: said once, so the model knows the first messages are much older)
    if (!gapSaid && n > byId.size && tailFrom && new Date(r.created_at) >= tailFrom && out.length) {
      out.push({ id: null, line: L(`(… 중간의 메시지 ${n - byId.size}개는 생략 …)`, `(… ${n - byId.size} messages in between left out …)`) })
      gapSaid = true
    }
    const x = asLine(chars)(r)
    if (x.line) out.push(r.content?.roomRule ? { ...x, line: `${x.line} ${L('[이 메시지가 방의 규칙을 정함', '[this message set the room\'s rule')}${r.content.roomRule.off ? L(' · 지금은 꺼짐', ' · now off') : ''}]` } : x)
  }
  return out
}
const lastMessageId = async (threadId) => (await q(`select id from pro_messages where thread_id=$1 and kind in ('text','doc','task','local_run') order by created_at desc limit 1`, [threadId]))[0]?.id || null
export async function turnsSince(threadId, upTo) {
  const [{ n }] = await q(`select count(*)::int as n from pro_messages where thread_id=$1 and role='user' and kind='text'
    and created_at > coalesce((select created_at from pro_messages where id = $2::uuid), to_timestamp(0))`, [threadId, upTo && UUID.test(upTo) ? upTo : null])
  return n
}
// the registered tools the model may name (name and description only — progressive disclosure, as the router sees them)
const toolCatalog = () => browserSkills().map((s) => `- ${s.name} (${L('서버 브라우저 스킬', 'server browser skill')}${s.label ? ` · ${s.label}` : ''}): ${clean(s.description, 200)}`).join('\n') || L('(없음)', '(none)')

// one serial lane per room: two updates never race on the same note
const lanes = new Map()
function serial(threadId, fn) {
  const prev = lanes.get(threadId) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  lanes.set(threadId, tail)
  tail.then(() => { if (lanes.get(threadId) === tail) lanes.delete(threadId) })
  return run
}

// the chip that says what changed, with 「되돌리기」 · 「계획 보기」 (Message.vue planChange)
const itemText = (k, x) => (k === 'tools' ? `${x.name}${x.how ? ` — ${x.how}` : ''}` : String(x))
export function changeText(d, { backfill = false, edit = false } = {}) {
  if (backfill) return L(`프로젝트 계획을 채웠어요${d?.intent?.to ? `: ${clean(d.intent.to, 80)}` : ''}`, `Filled in the project plan${d?.intent?.to ? `: ${clean(d.intent.to, 80)}` : ''}`)
  const added = Object.entries(d.added || {}).flatMap(([k, v]) => v.map((x) => itemText(k, x)))
  const removed = Object.entries(d.removed || {}).flatMap(([k, v]) => v.map((x) => itemText(k, k === 'tools' ? x : x.text)))
  const more = (n) => (n > 1 ? L(` 외 ${n - 1}개`, ` and ${n - 1} more`) : '')
  if (edit) {
    const what = added[0] || d.intent?.to || removed[0] || ''
    const n = added.length + removed.length + (d.intent ? 1 : 0)
    return L(`직접 고쳤어요${what ? `: ${clean(what, 90)}${more(n)}` : ''}`, `Edited by hand${what ? `: ${clean(what, 90)}${more(n)}` : ''}`)
  }
  if (added.length) return L(`계획에 넣었어요: ${clean(added[0], 90)}${more(added.length)}`, `Added to the plan: ${clean(added[0], 90)}${more(added.length)}`)
  if (d.intent) return L(`계획의 목적을 바꿨어요: ${clean(d.intent.to, 90)}`, `Changed the plan's purpose: ${clean(d.intent.to, 90)}`)
  if (removed.length) return L(`계획에서 뺐어요: ${clean(removed[0], 90)}${more(removed.length)}`, `Took out of the plan: ${clean(removed[0], 90)}${more(removed.length)}`)
  return ''
}
// The change a row of the plan records (its history entry): kind backfill · update · rule · add · edit · revert, by assistant | person, when,
// in words, the message it came from ({messageId, text} — none for a backfill or an edit), the row it was made from, and what it did (the diff
// a revert takes back)
export function changeOf(d, { kind, by, from = null, prevId = null, of = null, text = null }) {
  return { kind, by, at: new Date().toISOString(), text: text || changeText(d, { backfill: kind === 'backfill', edit: kind === 'edit' }), prevId: prevId || null,
    ...(from?.messageId ? { from: { messageId: from.messageId, text: clean(from.text, 160) } } : {}), ...(of ? { of } : {}),
    intent: d.intent || null, added: d.added || {}, removed: d.removed || {} }
}
async function postChange(userId, threadId, saved, prevId, d, { backfill = false } = {}) {
  const text = changeText(d, { backfill })
  if (!text) return null
  return addMessage(userId, threadId, 'agent', 'chip', { icon: 'check', text, planChange: { noteId: saved.id, prevId: prevId || null, ...(backfill ? { backfill: true } : {}),
    intent: d.intent || null, added: d.added, removed: d.removed } })
}

// ---------- the model writes the note ----------
// mode 'backfill' (no note yet) or 'update'. → the next note (not saved), or null when the model gave nothing usable
export async function draftNote({ user, threadId, mode = 'update', prev = null, reason = '', sk: given = null, call = chatJson }) {
  const sk = given || await planSkill()
  const R = sk.rules
  const [t] = await q('select title from pro_threads where id=$1', [threadId])
  const { ruleOf } = await import('./roomRules.js')
  const rule = await ruleOf(user.id, threadId).catch(() => null)
  const since = mode === 'backfill' ? await backfillMessages(threadId, { first: R.backfillFirst, last: R.backfillMessages, chars: R.sinceChars })
    : await messages(threadId, { after: prev?.upTo || null, limit: R.sinceMessages, chars: R.sinceChars })
  let topics = []
  if (mode === 'backfill') {
    const PT = await import('./projectTopics.js')
    topics = (await PT.topicsOf(user.id, threadId, R.backfillTopics).catch(() => [])).map((x) => `- ${clean(x.title, 80)}${x.gist ? ` — ${clean(x.gist, 200)}` : ''}${x.summary ? ` (${clean(String(x.summary).split('\n')[0], 160)})` : ''}`)
  }
  const content = [
    `${L('방 이름', "Room's name")}: ${clean(t?.title, 120) || L('(없음)', '(none)')}`,
    `${L('이 방의 규칙', "This room's rule")}: ${rule ? `${clean(rule.action, 400)}${rule.skill ? ` (${L('스킬', 'skill')} ${rule.skill})` : ''}` : L('없음', 'none')}`,
    `${L('등록된 도구', 'Registered tools')}:\n${toolCatalog()}`,
    ...(mode === 'backfill' ? [`${L('하위 대화(제목 — 요지)', 'Sub-conversations (title — gist)')}:\n${topics.join('\n') || L('(없음)', '(none)')}`] : [`${L('지금 계획', 'Current plan')}:\n${noteForModel(prev)}`]),
    `${mode === 'backfill' ? L('메시지(오래된 것부터)', 'Messages (oldest first)') : L('그 뒤의 메시지(오래된 것부터)', 'Messages since (oldest first)')}:\n${since.map((m) => m.line).join('\n') || L('(없음)', '(none)')}`,
    reason ? `${L('방금 일', 'Just now')}: ${reason}` : '',
  ].filter(Boolean).join('\n\n')
  const j = await call(promptOf(sk, mode), content, { model: R.model || config.llm.frontModel, temperature: 0, maxTokens: R.maxTokens, effort: 'low', timeoutMs: R.timeoutMs })
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  // (an answer with nothing in it is no answer: it never empties a plan that has something — the model failing is not the person's word)
  if (isEmpty(normalize(j)) && !isEmpty(prev)) return null
  const next = keepPinned(normalize(j), prev)
  // (the message the change came from: the person's last one it read)
  const said = [...since].reverse().find((m) => m.role === 'user' && m.id)
  return { note: next, upTo: [...since].reverse().find((m) => m.id)?.id || prev?.upTo || await lastMessageId(threadId), from: said ? { messageId: said.id, text: said.text } : null }
}

// 처음 채우기 — the project has no note yet. → the saved row, or null (nothing to fill in from, or the model did not answer)
export async function backfill({ user, threadId, call } = {}) {
  return serial(threadId, async () => {
    if (!(await ownedProject(user.id, threadId))) return null
    const have = await noteRow(user.id, threadId)
    if (have) return have
    const d = await draftNote({ user, threadId, mode: 'backfill', call }).catch((e) => { console.warn('[project-plan] backfill', e.message); return null })
    if (!d) return null
    // (an empty note is kept too: the next turns do not fill it in again; the 5-turn update does)
    const saved = await saveNote(user.id, threadId, d.note, { editedBy: 'assistant', upTo: d.upTo, change: changeOf(diff(null, d.note), { kind: 'backfill', by: 'assistant' }) })
    console.log(`[project-plan] backfill thread=${String(threadId).slice(0, 8)} intent=${d.note.intent.length}ch tools=${d.note.tools.length} constraints=${d.note.constraints.length}`)
    if (!isEmpty(d.note)) await postChange(user.id, threadId, saved, null, diff(null, d.note), { backfill: true })
    return saved
  })
}
// 고치기 — the current note and the messages since. reason: what just happened (a rule set: the update is awaited before it is written down)
// from: the message that asked for it ({messageId, text} — a rule set); else the person's last message the update read
export async function update({ user, threadId, reason = '', from = null, call } = {}) {
  return serial(threadId, async () => {
    if (!(await ownedProject(user.id, threadId))) return null
    const cur = await noteRow(user.id, threadId)
    if (!cur) return null
    const d = await draftNote({ user, threadId, mode: 'update', prev: cur.note, reason, call }).catch((e) => { console.warn('[project-plan] update', e.message); return null })
    if (!d) return cur
    const change = diff(cur.note, d.note)
    if (!changed(change)) { await touchUpTo(cur.id, d.upTo); return { ...cur, note: { ...cur.note, upTo: d.upTo } } }
    const saved = await saveNote(user.id, threadId, d.note, { editedBy: 'assistant', upTo: d.upTo,
      change: changeOf(change, { kind: reason ? 'rule' : 'update', by: 'assistant', from: from || d.from, prevId: cur.id }) })
    console.log(`[project-plan] update thread=${String(threadId).slice(0, 8)} ${Object.keys(change.added).join(',') || '-'} added, ${Object.keys(change.removed).join(',') || '-'} removed${change.intent ? ', purpose' : ''}`)
    await postChange(user.id, threadId, saved, cur.id, change)
    return saved
  })
}

// The note this turn reads: the one there is, or — the first turn of a project with none — one filled in now (waited for waitMs at most;
// a slower one is saved when it comes and read from the next turn on). → {id, note} or null
const filling = new Map()
export async function ensureNote({ user, threadId, waitMs = null, call } = {}) {
  const cur = await noteRow(user.id, threadId).catch(() => null)
  if (cur) return cur
  let p = filling.get(threadId)
  if (!p) {
    p = backfill({ user, threadId, call }).catch((e) => { console.warn('[project-plan] backfill', e.message); return null }).finally(() => filling.delete(threadId))
    filling.set(threadId, p)
  }
  const wait = waitMs ?? (await planSkill()).rules.backfillWaitMs
  let timer
  const r = await Promise.race([p, new Promise((ok) => { timer = setTimeout(() => ok(null), wait) })])
  clearTimeout(timer)
  // (filled: made on this turn, from messages that include this one — the turn need not ask for it to be brought up to date again)
  return r ? { ...r, filled: true } : null
}
// the room's last messages as lines, oldest first (the rule's write-down reads the conversation, not one sentence — design §4.3)
export async function recentLines(threadId, { limit = 12, chars = 300 } = {}) {
  return (await messages(threadId, { limit, chars })).map((m) => m.line)
}
// A project turn ended: the note is rewritten when the front step said the message is one to keep (memory), or every few turns (design §4.2)
export async function afterTurn({ user, threadId, memory = false, call } = {}) {
  const cur = await noteRow(user.id, threadId).catch(() => null)
  if (!cur) return null
  const sk = await planSkill()
  if (!memory && await turnsSince(threadId, cur.note.upTo) < sk.rules.everyTurns) return null
  return update({ user, threadId, call })
}

// 계획에 넣기 — the room judge picked plan: the words become one item of 지킬 것 or 정한 것, pinned (the person said it). → {saved, chip, item}
// fromId: the person's message (the history says which message the change came from)
export async function addFromMessage({ user, threadId, text, fromId = null, call = chatJson } = {}) {
  return serial(threadId, async () => {
    if (!(await ownedProject(user.id, threadId))) return null
    const sk = await planSkill()
    const cur = await noteRow(user.id, threadId)
    const base = cur?.note || emptyNote()
    const marks = [...base.constraints.map((x, i) => `c${i + 1}. ${x.text}`), ...base.decisions.map((x, i) => `d${i + 1}. ${x.text}`)]
    const content = [`${L('지금 계획의 목적', "The plan's purpose now")}: ${base.intent || L('(없음)', '(none)')}`,
      `${L('지금 계획의 지킬 것 · 정한 것', 'What the plan keeps to and has decided now')}:\n${marks.join('\n') || L('(없음)', '(none)')}`,
      `${L('사람이 한 말', 'What the person said')}: ${clean(text, 800)}`].join('\n\n')
    const j = await call(promptOf(sk, 'add'), content, { model: sk.rules.model || config.llm.frontModel, temperature: 0, maxTokens: 1500, effort: 'low', timeoutMs: sk.rules.timeoutMs })
      .catch((e) => { console.warn('[project-plan] add', e.message); return null })
    // (no answer: the person's own words go in as they said them)
    const to = j?.to === 'decisions' ? 'decisions' : 'constraints'
    const item = clean(j?.text, LISTS[to][1]) || clean(text, LISTS[to][1])
    const next = normalize(base)
    // (replaces: a mark of our own list — c1, d2 — the format the prompt asked for)
    const m = /^([cd])(\d{1,2})$/.exec(String(j?.replaces || '').trim())
    const key = m ? (m[1] === 'c' ? 'constraints' : 'decisions') : null
    const at = m ? Number(m[2]) - 1 : -1
    if (key && next[key][at]) {
      if (key === to) next[key][at] = { text: item, pinned: true }
      else { next[key].splice(at, 1); next[to].push({ text: item, pinned: true }) }
    } else if (!next[to].some((x) => same(x.text, item))) next[to].push({ text: item, pinned: true })
    next[to] = cut(next[to], LISTS[to][0])
    const change = diff(base, next)
    if (!changed(change)) return { saved: cur, chip: null, item, to }
    const saved = await saveNote(user.id, threadId, next, { editedBy: 'person', upTo: cur?.note.upTo || await lastMessageId(threadId),
      change: changeOf(change, { kind: 'add', by: 'person', from: fromId ? { messageId: fromId, text } : null, prevId: cur?.id || null }) })
    const chip = await postChange(user.id, threadId, saved, cur?.id || null, change)
    return { saved, chip, item, to }
  })
}

// ---------- the person ----------
// the plan's history, newest first: one entry per row (the change that made it)
export async function historyOf(threadId, limit = DEFAULTS.keepRows) {
  const rows = await q(`select id, created_at, content->'projectNote'->'change' as change, content->'projectNote'->>'editedBy' as by from pro_messages
    where thread_id=$1 and kind='note' order by created_at desc, id desc limit $2`, [threadId, limit])
  return rows.map((r, i) => {
    const c = r.change || null
    return { id: r.id, at: c?.at || r.created_at, kind: c?.kind || 'saved', by: c?.by || r.by || 'assistant', text: c?.text || L('계획을 저장했어요', 'Saved the plan'),
      from: c?.from || null, of: c?.of || null, reverted: !!c?.reverted, current: i === 0, revertable: !!c && c.kind !== 'revert' && !c.reverted }
  })
}
export async function getNote(userId, threadId) {
  if (!(await ownedProject(userId, threadId))) throw fail(404, L('프로젝트를 찾지 못했어요.', "This project couldn't be found."))
  const row = await noteRow(userId, threadId)
  return { note: row?.note || emptyNote(), id: row?.id || null, at: row?.at || null, skills: browserSkills().map((s) => ({ name: s.name, label: s.label || s.name })),
    history: await historyOf(threadId) }
}
export async function editNote(userId, threadId, body) {
  if (!(await ownedProject(userId, threadId))) throw fail(404, L('프로젝트를 찾지 못했어요.', "This project couldn't be found."))
  return serial(threadId, async () => {
    const cur = await noteRow(userId, threadId)
    const next = markEdited(normalize(body?.note || body), cur?.note)
    const d = diff(cur?.note, next)
    // (nothing changed: no new row — the history only holds changes)
    if (cur && !changed(d)) return { note: cur.note, id: cur.id, at: cur.at, history: await historyOf(threadId) }
    const saved = await saveNote(userId, threadId, next, { editedBy: 'person', upTo: cur?.note.upTo || await lastMessageId(threadId), change: changeOf(d, { kind: 'edit', by: 'person', prevId: cur?.id || null }) })
    return { note: saved.note, id: saved.id, at: saved.at, history: await historyOf(threadId) }
  })
}
// 「되돌리기」 on one entry of the history (and on a change chip): the plan goes back to the row before that change when it is the newest;
// when later changes came after it, only what that change did is taken back. The revert is a change of its own in the history, the entry says
// it was reverted, and its chips say so. (design P2: 「the note returns to its previous row」; 2026-11-27: every change can be reverted)
export async function revertChange(userId, threadId, noteId) {
  if (!(await ownedProject(userId, threadId))) throw fail(404, L('프로젝트를 찾지 못했어요.', "This project couldn't be found."))
  if (!UUID.test(String(noteId || ''))) throw fail(404, L('바뀐 기록을 찾지 못했어요.', "This change couldn't be found."))
  return serial(threadId, async () => {
    const [row] = await q(`select id, content from pro_messages where id=$1 and thread_id=$2 and kind='note'`, [noteId, threadId])
    if (!row) throw fail(404, L('바뀐 기록을 찾지 못했어요.', "This change couldn't be found."))
    const ch = row.content.projectNote?.change
    if (!ch || ch.kind === 'revert') throw fail(400, L('되돌릴 수 없는 기록이에요.', "This entry can't be reverted."))
    if (ch.reverted) throw fail(409, L('이미 되돌렸어요.', 'Already undone.'))
    const cur = await noteRow(userId, threadId)
    let next
    if (cur?.id === row.id) {
      const [prev] = ch.prevId ? await q(`select content from pro_messages where id=$1 and kind='note'`, [ch.prevId]) : []
      next = prev ? normalize(prev.content.projectNote) : undoOn(cur.note, ch)
    } else next = undoOn(cur?.note || emptyNote(), ch)
    const d = diff(cur?.note, next)
    // (the messages that change read stay read: the next update does not put back what was just taken out — cur's upTo)
    const saved = changed(d) || !cur ? await saveNote(userId, threadId, next, { editedBy: 'person', upTo: cur?.note.upTo,
      change: changeOf(d, { kind: 'revert', by: 'person', prevId: cur?.id || null, of: row.id, text: L(`되돌렸어요: ${clean(ch.text, 100)}`, `Undid: ${clean(ch.text, 100)}`) }) }) : cur
    await q(`update pro_messages set content = jsonb_set(content, '{projectNote,change,reverted}', 'true'::jsonb) where id=$1`, [row.id])
    const chips = await q(`update pro_messages set content = jsonb_set(content, '{planChange,undone}', 'true'::jsonb) where thread_id=$1 and kind='chip'
      and content->'planChange'->>'noteId' = $2 returning *`, [threadId, row.id])
    for (const c of chips) emit(userId, 'message', c)
    if (saved === cur) emit(userId, 'projectNote', { threadId, id: cur.id, note: cur.note })
    return { note: saved.note, id: saved.id, chip: chips[0] || null, history: await historyOf(threadId) }
  })
}
// 「되돌리기」 on a change chip: the change that chip announced (revertChange)
export async function undoChange(userId, threadId, chipId) {
  if (!(await ownedProject(userId, threadId))) throw fail(404, L('프로젝트를 찾지 못했어요.', "This project couldn't be found."))
  if (!UUID.test(String(chipId || ''))) throw fail(404, L('칩을 찾지 못했어요.', "This chip couldn't be found."))
  const [chip] = await q(`select * from pro_messages where id=$1 and thread_id=$2 and kind='chip' and jsonb_typeof(content->'planChange') = 'object'`, [chipId, threadId])
  if (!chip) throw fail(404, L('칩을 찾지 못했어요.', "This chip couldn't be found."))
  if (chip.content.planChange.undone) throw fail(409, L('이미 되돌렸어요.', 'Already undone.'))
  return revertChange(userId, threadId, chip.content.planChange.noteId)
}

// tests: lanes and backfills in flight
export const _test = { lanes, filling, rawText }
