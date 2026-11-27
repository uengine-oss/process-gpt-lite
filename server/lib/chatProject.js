// 대화를 프로젝트로 — 채팅에서 하던 이야기를 진짜 Lite 프로젝트(「프로젝트」 탭)로 이어 간다. 스펙 openspec/specs/chat-to-project, 스킬 skills/chat-to-project.
// 2026-11-27 22:33 휴대폰 녹화: 받은 메일의 요청을 채팅에서 조사한 뒤 「이 내용을 기반으로 프로젝트를 하나 만들자」라고 했는데, 채팅 에이전트는 채팅 안에서
// 계획만 세웠고 「프로젝트」 탭에는 아무것도 생기지 않았다(「안 만들어질 것 같은데」). 사용자: 「여기로 프로젝트로 승격하겠다는 거거든 … 채팅을 좀 하다가
// 아 이거 좀 제대로 가야 되겠다 그래서 프로젝트로 갈 거잖아」 · 「이 프로젝트에 폴더 적절한 이 템플릿 폴더가 좀 우리가 추천이 좀 필요할 수도 있고 …
// 교육과정 만드는 템플릿 폴더가 있을 수 있겠지 그러면 걔네들의 자료들을 근간으로 해가지고 우리가 이 프로젝트를 하나를 시작할 수 있는 거겠지」.
//   offer    the confirm card in the chat (kind 'project_offer'): its name, purpose, background, what it will make, its source (the mail the
//            conversation is about, when there is one) and the template folders that fit, each with why — nothing is made yet.
//            By words: the chat's router picks start_project (lib/agent.js — the model reads the meaning, never a pattern of words); by a button:
//            「프로젝트로 시작」 on an answer (POST /messages/:id/project-offer).
//   make     「만들기」 (POST /project-offers/:id/make {title, template}): the project — from the template picked through the existing 「템플릿으로
//            시작」 (lib/folders/templates.js startProject: its own workspace), else an empty one; its plan (lib/projectNote.js) filled with the purpose,
//            what it will make and where it came from; the answer picked as its first document; a line in the chat 「프로젝트로 옮겼어요 · 열기」.
//            The conversation stays as it is (it is carried on, not moved).
//   decline  「아니요」: the card says so, nothing is made.
// The model writes the card (prompts/draft.md); the judge picks the templates (prompts/pick-template.md — first-token odds, lib/decide.js
// chooseSome) among the template folders this person may start from (runner and up) — by their name, description, TEMPLATE.md and agent
// assets. No template: no question, no row of recommendations.
import { config } from '../config.js'
import { q } from './supa.js'
import { emit } from './bus.js'
import { L, isEn } from './lang.js'
import { chatJson } from './llm.js'
import { chooseSome } from './decide.js'
import { addMessage, getThread } from './store.js'
import { skillPack, readSkillDir, bundledDir } from './skillPack.js'
import * as AS from './answerShare.js'

export const SKILL = 'chat-to-project'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code && { code }) })
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => { const t = clean(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t }
const DEFAULTS = { lines: 12, lineChars: 600, answerChars: 3000, draftTimeoutMs: 20000, draftMaxTokens: 1500,
  templates: { judge: 12, max: 3, minP: 0.3, timeoutMs: 8000, kitItems: 6 }, limits: { title: 40, intent: 200, background: 120, deliverables: 3 } }
export const STATES = ['offered', 'making', 'made', 'declined']
export const RUNNERS = ['owner', 'editor', 'runner']

// ---------- the skill ----------
let bundled = null
export async function projectSkill() {
  const s = await skillPack(SKILL).catch(() => ({ name: SKILL, source: 'bundled', ...(bundled ||= readSkillDir(bundledDir(SKILL)) || { rules: {}, prompts: {} }) }))
  const r = s.rules || {}
  return { ...s, rules: { ...DEFAULTS, ...r, templates: { ...DEFAULTS.templates, ...(r.templates || {}) }, limits: { ...DEFAULTS.limits, ...(r.limits || {}) } } }
}
const promptOf = (sk, name) => (isEn() && sk.prompts?.[`${name}-en`]) || sk.prompts?.[name] || ''

// ---------- pure ----------
// the model's card → in shape (lengths, counts; a template key that is not one of the options is dropped)
export function draftOf(j, { keys = [], limits = DEFAULTS.limits, fallbackTitle = '' } = {}) {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  const why = {}
  for (const t of Array.isArray(o.templates) ? o.templates : []) {
    const k = String(t?.key || '')
    if (keys.includes(k) && !why[k]) why[k] = clip(t?.why, 80)
  }
  return {
    title: clip(o.title, limits.title) || clip(fallbackTitle, limits.title) || L('새 프로젝트', 'New project'),
    intent: clip(o.intent, limits.intent), background: clip(o.background, limits.background),
    deliverables: (Array.isArray(o.deliverables) ? o.deliverables : []).map((x) => clip(typeof x === 'string' ? x : x?.text, 80)).filter(Boolean).slice(0, limits.deliverables),
    why,
  }
}
// the recommendations the card shows: the judge's picks (or, when it could not read, the model's own), the likeliest first, each with one line
// of why — the model's line for it, else what the template says it is for
export function recommend(templates, { picks = null, why = {}, max = 3 } = {}) {
  const by = new Map(templates.map((t) => [t.slug, t]))
  const chosen = picks ? picks.filter((x) => by.has(x.key)).map((x) => ({ slug: x.key, p: x.p })) : Object.keys(why).filter((k) => by.has(k)).map((k) => ({ slug: k, p: null }))
  return chosen.slice(0, max).map(({ slug, p }) => {
    const t = by.get(slug)
    return { slug, name: t.name, description: t.description || '', why: why[slug] || t.description || L('이 일과 관련된 템플릿이에요', 'A template that fits this work'), p: p == null ? null : Math.round(p * 1000) / 1000 }
  })
}
// what the judge reads about one template: its name, what it is for, TEMPLATE.md's description, its agent assets
export function templateLabel(t) {
  const kit = (t.kit || []).map((k) => `${k.type === 'skill' ? L('스킬', 'skill') : k.type} ${k.name}${k.description ? `(${clip(k.description, 60)})` : ''}`).join(', ')
  return [`「${clip(t.name, 40)}」`, t.description ? `${L('설명', 'about')}: ${clip(t.description, 120)}` : '', t.templateMd ? `TEMPLATE.md: ${clip(t.templateMd, 160)}` : '',
    kit ? `${L('에이전트 자산', 'agent assets')}: ${kit}` : ''].filter(Boolean).join(' · ')
}
// the plan the project starts with: the purpose, what it will make, and where it came from (the background, the source — kept: pinned)
export function planOf(offer) {
  const src = offer.source?.mail ? L(`출처: 받은 메일 「${clip(offer.source.mail.subject, 60)}」${offer.source.mail.from ? ` · ${clip(offer.source.mail.from, 40)}` : ''}`,
    `Source: the received mail "${clip(offer.source.mail.subject, 60)}"${offer.source.mail.from ? ` · ${clip(offer.source.mail.from, 40)}` : ''}`) : ''
  return { v: 1, intent: clean(offer.intent), deliverables: (offer.deliverables || []).map((text) => ({ text })), tools: [], constraints: [],
    decisions: [offer.background ? { text: clip(offer.background, 120) } : null, src ? { text: clip(src, 120), pinned: true } : null].filter(Boolean) }
}

// ---------- what the card is made from ----------
const lineText = (r, chars) => `${r.role === 'user' ? L('사람', 'Person') : L('비서', 'Assistant')}: ${clip(AS.answerText(r) || r.content?.text, chars)}`
// an answer worth carrying on: a document answer, or a text answer of some length — a short acknowledgement is not one (structure only)
export const ANSWER_MIN_CHARS = 80
const carries = (r) => r.role === 'agent' && (r.kind === 'doc' || (r.kind === 'text' && String(r.content?.text || '').trim().length >= ANSWER_MIN_CHARS)) && !r.content?.stopped && !r.content?.note
// Each message's conversation, oldest first, as the page files them (src/convOf.js): an answer by its own (content.conv · context), one filed
// aside (a scheduled run, a brief) its own without moving the chat, the person's words with the answer after them, the rest in the one the
// chat was in. → {conv: Map(id → conversation | null), cur: the one the chat is in at the end}
export function conversationsOf(rows) {
  const conv = new Map()
  let cur = null
  let pending = []
  for (const r of rows) {
    if (r.role === 'user') { if (r.content?.conv) conv.set(r.id, String(r.content.conv)); else pending.push(r); continue }
    const c = AS.convOfRow(r)
    if (AS.asideRow(r)) { conv.set(r.id, c); continue }
    if (c) cur = c
    for (const p of pending) conv.set(p.id, cur)
    pending = []
    conv.set(r.id, cur)
  }
  for (const p of pending) conv.set(p.id, cur)
  return { conv, cur }
}
// What the card is about (structure only — never a reading of the words):
//   a button   the answer pressed, its conversation, and that conversation's lines up to it
//   words      the conversation the turn was pinned to (the page narrowed to one — /chat/c/:cid, a project's sub-topic), else the one the chat was
//              in; in it the newest answer worth carrying on before the words that asked — a newer answer of another conversation (a scheduled
//              run that came meanwhile) is not it; the lines of that conversation only
// → {answer, rows (the conversation's lines, oldest first, the answer not among them), conv}
const WINDOW = 80
export function pickFrom(list, { pressed = null, conversationId = null, lines = DEFAULTS.lines } = {}) {
  const { conv, cur } = conversationsOf(list)
  const target = pressed ? AS.convOfRow(pressed) : conversationId || cur
  const inIt = (r) => (target ? conv.get(r.id) === target : !AS.asideRow(r))
  const answer = pressed || [...list].reverse().find((r) => carries(r) && inIt(r)) || null
  const upTo = answer && pressed ? list.findIndex((r) => r.id === answer.id) : list.length - 1
  const rows = list.slice(0, upTo + 1).filter((r) => r.id !== answer?.id && inIt(r)).slice(-lines)
  return { answer, rows, conv: target }
}
async function windowOf(threadId, { upTo, inclusive }) {
  const rows = await q(`select id, role, kind, content, created_at from pro_messages where thread_id=$1 and kind in ('text','doc')
    and created_at ${inclusive ? '<=' : '<'} coalesce((select created_at from pro_messages where id = $2::uuid and thread_id = $1), now() + interval '1 second')
    order by created_at desc, id desc limit $3`, [threadId, upTo && UUID.test(String(upTo)) ? String(upTo) : null, WINDOW])
  return rows.reverse()
}
// the mail the conversation is about (its newest mention — an answer's chips, a mail dragged into a message), as the owner's card says it
async function mailOf(user, rows) {
  const ids = []
  for (const r of [...rows].reverse()) {
    const c = r.content || {}
    for (const m of Array.isArray(c.mails) ? c.mails : []) if (m?.actionId) ids.push(m.actionId)
    if (c.mail?.actionId) ids.push(c.mail.actionId)
    for (const x of Array.isArray(c.refs) ? c.refs : []) if (x?.as === 'mail' && x.actionId) ids.push(x.actionId)
  }
  const id = ids.find((x) => UUID.test(String(x)))
  if (!id) return null
  const [a] = await q(`select id, source from pro_actions where id=$1 and user_id=$2 and status <> 'deleted'`, [id, user.id])
  if (!a?.source?.mail_id) return null
  const from = String(a.source.from || '').split('<')[0].replace(/"/g, '').trim() || String(a.source.from || '')
  return { actionId: a.id, subject: clip(a.source.subject, 120), from: clip(from, 60) }
}
// the template folders this person may start a project from (runner and up), with what the judge reads about each
export async function templatesFor(user, { judge = DEFAULTS.templates.judge, kitItems = DEFAULTS.templates.kitItems } = {}) {
  const S = await import('./folders/service.js')
  const TPL = await import('./folders/templates.js')
  const { kitOf } = await import('./folders/kit.js')
  const rows = (await S.listFolders(user).catch(() => [])).filter((f) => f.kind === 'managed' && f.settings?.template && RUNNERS.includes(f.role)).slice(0, judge)
  const out = []
  for (const f of rows) {
    const full = await S.folderBySlug(f.slug).catch(() => null)
    if (!full || !TPL.isTemplate(full)) continue
    const info = await TPL.infoOf(full).catch(() => null)
    const kit = (await kitOf(full).catch(() => [])).slice(0, kitItems).map((k) => ({ type: k.type, name: k.name, description: k.description || '' }))
    out.push({ slug: f.slug, name: f.name, description: clip(f.description, 160), templateMd: info?.description || '', kit })
  }
  return out
}

// ---------- offer ----------
// a few cards a minute per person (each asks the model and the judge)
const offered = new Map()
function offerBudget(userId, n = Number(process.env.PRO_PROJECT_OFFERS_PER_MIN) || 8, ms = 60_000) {
  const now = Date.now()
  const list = (offered.get(userId) || []).filter((t) => now - t < ms)
  if (list.length >= n) throw fail(429, L('잠시 후에 다시 해 주세요.', 'Please try again in a moment.'), 'busy')
  list.push(now)
  offered.set(userId, list)
}
// the card still open for this answer (one per answer: 「프로젝트로 시작」 twice, the words after the button — the same card)
async function openOfferFor(threadId, answerId) {
  const [m] = await q(`select * from pro_messages where thread_id=$1 and kind='project_offer' and content->'source'->'answer'->>'messageId' = $2
    and content->>'state' in ('offered','making') order by created_at desc limit 1`, [threadId, String(answerId)])
  return m || null
}
// → the card (a message of the chat). messageId: the answer picked (a button on it); said: what the person said (the words that asked for it);
// title: a name the router heard; before: the person's message that asked (words) — the answer is the newest one before it, never the turn's own
// acknowledgement; conversationId: the conversation the turn was pinned to (words); deps: {call, odds, json, templates} for tests
// The card is filed where the answer's conversation is (a button: aside, it never moves the one the chat is in — src/convOf.js), or where the
// turn's acknowledgement is (words: no tag of its own, as the acknowledgement has none).
export async function offer(user, { threadId, messageId = null, said = '', title = '', via = 'button', before = null, conversationId = null } = {}, deps = {}) {
  const t = await getThread(user.id, threadId)
  if (!t) throw fail(404, L('대화를 찾지 못했어요.', "I couldn't find that conversation."))
  const sk = deps.skill || await projectSkill()
  const R = sk.rules
  let pressed = null
  if (messageId) {
    pressed = await AS.answerOf(user, messageId)
    if (pressed.thread_id !== t.id) throw fail(404, L('답을 찾지 못했어요.', "I couldn't find that answer."))
  }
  const list = await windowOf(t.id, pressed ? { upTo: pressed.id, inclusive: true } : { upTo: before, inclusive: false })
  const { answer, rows } = pickFrom(list, { pressed, conversationId: conversationId ? String(conversationId) : null, lines: R.lines })
  if (answer) { const open = await openOfferFor(t.id, answer.id); if (open) return open }
  offerBudget(user.id)
  const [mail, templates] = await Promise.all([mailOf(user, [...rows, ...(answer ? [answer] : [])]).catch(() => null), deps.templates ? deps.templates() : templatesFor(user, R.templates)])
  const conversation = rows.map((r) => lineText(r, R.lineChars)).join('\n')
  const answerText = answer ? clip(AS.answerText(answer), R.answerChars) : ''
  const options = templates.map((x) => ({ key: x.slug, label: templateLabel(x) }))
  const material = [
    `${L('대화(오래된 것부터)', 'Conversation (oldest first)')}:\n${conversation || L('(없음)', '(none)')}`,
    `${L('사람이 고른 답', 'The answer the person picked')}${answer ? ` — ${AS.titleOf(answer)}` : ''}:\n${answerText || L('(없음)', '(none)')}`,
    mail ? `${L('출처 — 받은 메일', 'Source — a received mail')}: 「${mail.subject}」 · ${mail.from}` : '',
    said ? `${L('사람이 지금 한 말', 'What the person just said')}: ${clip(said, 400)}` : '',
    title ? `${L('사람이 말한 이름', 'The name the person said')}: ${clip(title, 60)}` : '',
  ].filter(Boolean).join('\n\n')
  const call = deps.call || chatJson
  const draftAsk = call(promptOf(sk, 'draft'), `${material}\n\n${L('템플릿 폴더', 'Template folders')}:\n${options.map((o) => `- key ${o.key}: ${o.label}`).join('\n') || L('(없음)', '(none)')}`,
    { model: R.model || config.llm.frontModel, temperature: 0, maxTokens: R.draftMaxTokens, effort: 'low', timeoutMs: R.draftTimeoutMs })
    .catch((e) => { console.warn('[chat-project] draft', e.message); return null })
  // (no template: no question — the card shows no row of recommendations; the JSON fallback keeps the skill's limit too)
  const T = R.templates
  const judged = options.length
    ? chooseSome(material, promptOf(sk, 'pick-template'), [...options, { key: 'none', label: L('어느 템플릿도 이 일과 맞지 않는다', 'None of these templates fits this work') }],
      { ...(deps.odds ? { odds: deps.odds } : {}), ...(deps.json ? { json: deps.json } : {}), answerJson: sk.prompts['answer-many-json'], timeoutMs: T.timeoutMs, jsonTimeoutMs: T.timeoutMs, max: T.max, min: T.minP })
      .catch((e) => { console.warn('[chat-project] judge', e.message); return null })
    : Promise.resolve(null)
  const [j, picked] = await Promise.all([draftAsk, judged])
  const d = draftOf(j, { keys: options.map((o) => o.key), limits: R.limits, fallbackTitle: title || (answer ? AS.titleOf(answer) : '') })
  if (title) d.title = clip(title, R.limits.title)
  const picks = picked ? picked.picks.filter((x) => x.key !== 'none') : null
  const recs = recommend(templates, { picks, why: d.why, max: T.max })
  const conv = AS.convOfRow(answer)
  const content = {
    text: L('이 대화로 프로젝트를 시작할까요?', 'Start a project from this conversation?'),
    title: d.title, intent: d.intent, background: d.background, deliverables: d.deliverables,
    source: { threadId: t.id, ...(conv ? { conversationId: conv } : {}), ...(answer ? { answer: { messageId: answer.id, title: AS.titleOf(answer) } } : {}), ...(mail ? { mail } : {}) },
    templates: recs, hasTemplates: templates.length > 0,
    read: { by: picked ? picked.strategy : templates.length ? 'model' : 'none', model: picked?.model || null, draft: !!j, skill: sk.version || null },
    via, state: 'offered',
    ...(pressed && conv ? { context: { conversationId: conv, action: 'aside' } } : {}),
  }
  const post = async () => {
    // (two at once for the same answer — two screens, the words right after the button: the second gets the first's card)
    if (answer) { const open = await openOfferFor(t.id, answer.id); if (open) return open }
    console.log(`[chat-project] offer thread=${String(t.id).slice(0, 8)} via=${via} conv=${conv ? String(conv).slice(0, 12) : '-'} templates=${templates.length} picks=${recs.map((r) => `${r.slug}:${r.p ?? '-'}`).join(',') || '-'} by=${content.read.by} draft=${!!j}`)
    return addMessage(user.id, t.id, 'agent', 'project_offer', content)
  }
  return answer ? AS.exclusive(`offer:${answer.id}`, post) : post()
}

// ---------- make ----------
async function offerRow(user, id) {
  if (!UUID.test(String(id || ''))) throw fail(404, L('카드를 찾지 못했어요.', "I couldn't find that card."))
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='project_offer'`, [id, user.id])
  if (!m) throw fail(404, L('카드를 찾지 못했어요.', "I couldn't find that card."))
  return m
}
// A card's state changes in one statement. from: only from that state; stale: a 「만들기」 claim older than MAKING_STALE_MS is no longer
// anyone's (the server went away in the middle — PR #118 review L6) and may be taken over
export const MAKING_STALE_MS = Number(process.env.PRO_PROJECT_MAKING_STALE_MS) || 120_000
async function setState(userId, id, patch, { from = null, stale = false } = {}) {
  const cond = !from ? '' : stale
    ? `and (content->>'state' = $3 or (content->>'state' = 'making' and coalesce((content->>'making_at')::timestamptz, to_timestamp(0)) < now() - make_interval(secs => $4)))`
    : `and content->>'state' = $3`
  const params = !from ? [id, JSON.stringify(patch)] : stale ? [id, JSON.stringify(patch), from, MAKING_STALE_MS / 1000] : [id, JSON.stringify(patch), from]
  const [m] = await q(`update pro_messages set content = content || $2::jsonb where id=$1 ${cond} returning *`, params)
  if (m) emit(userId, 'message', m)
  return m || null
}
const isStale = (c) => c?.state === 'making' && Date.now() - new Date(c.making_at || 0).getTime() > MAKING_STALE_MS

// What the person saw on the card and confirmed (PR #118 review M3): the name, the purpose, what it will make, the background — each as the card
// showed it, changed or not; a field the request leaves out is the card's own. Lengths as the plan keeps them.
export function confirmed(c, body = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined && body[k] !== null
  const list = has('deliverables') ? (Array.isArray(body.deliverables) ? body.deliverables : []) : c.deliverables || []
  return {
    title: clip(String((has('title') ? body.title : c.title) || '').replace(/[\u0000-\u001f]/g, ' '), 60),
    intent: clip(has('intent') ? body.intent : c.intent, DEFAULTS.limits.intent),
    background: clip(has('background') ? body.background : c.background, DEFAULTS.limits.background),
    deliverables: list.map((x) => clip(typeof x === 'string' ? x : x?.text, 80)).filter(Boolean).slice(0, 5),
  }
}

// POST /project-offers/:id/make {title, intent, background, deliverables, template} → {project: {id, title, kind}, offer}
// template: a template folder's slug — one this person may start from (runner and up); none: an empty project
// publish: the first document's bytes into storage (lib/office.js publishBuffer — a test passes its own)
export async function make(user, id, body = {}, deps = {}) {
  const row = await offerRow(user, id)
  const c = row.content || {}
  if (c.state === 'made') throw fail(409, L('이미 만든 프로젝트예요.', 'That project was already made.'), 'made')
  if (c.state === 'declined') throw fail(409, L('이미 닫은 카드예요.', 'This card was closed.'), 'declined')
  const said = confirmed(c, body)
  const name = said.title || L('새 프로젝트', 'New project')
  const template = body.template ? String(body.template) : null
  // the template is checked before anything is made: a refusal makes no project
  let folder = null
  if (template) {
    const S = await import('./folders/service.js')
    const TPL = await import('./folders/templates.js')
    ;({ folder } = await S.access(template, user, 'runner'))
    if (!TPL.isTemplate(folder)) throw fail(400, L('템플릿으로 지정된 폴더에서만 시작할 수 있어요.', 'You can start a project only from a folder marked as a template.'))
  }
  // one 「만들기」 makes one project (two presses, two screens): the card is claimed first — or taken over when an earlier claim went stale
  const claimed = await setState(user.id, row.id, { state: 'making', making_at: new Date().toISOString() }, { from: 'offered', stale: true })
  if (!claimed) throw fail(409, L('이미 만들고 있어요.', "It's being made already."), 'making')
  // (a stale claim that had made its project already: that project — never a second one)
  if (claimed.content?.project?.id) {
    const [p] = await q(`select * from pro_threads where id=$1 and user_id=$2 and kind='project'`, [claimed.content.project.id, user.id])
    if (p) {
      const made = await setState(user.id, row.id, { state: 'made' })
      return { project: { id: p.id, title: p.title, kind: 'project', ...(claimed.content.template ? { template: claimed.content.template } : {}) }, offer: made }
    }
  }
  let project
  try {
    if (folder) {
      // (the template's own 「템플릿으로 시작」: a failed workspace takes its room away again — lib/folders/templates.js startProject)
      const TPL = await import('./folders/templates.js')
      project = await TPL.startProject(user, folder, { title: name })
    } else {
      ;[project] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning *`, [user.id, name])
    }
  } catch (e) {
    await setState(user.id, row.id, { state: 'offered', making_at: null })
    throw e
  }
  const tpl = folder ? { slug: folder.slug, name: folder.name } : null
  // (the card points at it at once: a claim that goes stale from here on finishes with this project, not a new one)
  await setState(user.id, row.id, { project: { id: project.id, title: name }, ...(tpl ? { template: tpl } : {}) })
  // from here the project is there: what follows is said if it fails, and the card still says it was made
  const offerNow = { ...c, ...said, title: name }
  const PN = await import('./projectNote.js')
  try {
    const note = planOf(offerNow)
    if (!PN.isEmpty(note)) {
      const d = PN.diff(null, PN.normalize(note))
      const saved = await PN.saveNote(user.id, project.id, note, { editedBy: 'assistant', change: PN.changeOf(d, { kind: 'backfill', by: 'assistant', text: L(`채팅에서 옮겨 온 계획이에요${note.intent ? `: ${clip(note.intent, 80)}` : ''}`, `The plan brought from the chat${note.intent ? `: ${clip(note.intent, 80)}` : ''}`) }) })
      await addMessage(user.id, project.id, 'agent', 'chip', { icon: 'check', text: PN.changeText(d, { backfill: true }), planChange: { noteId: saved.id, prevId: null, backfill: true, intent: d.intent || null, added: d.added, removed: d.removed } })
    }
  } catch (e) { console.warn('[chat-project] plan', e.message) }
  // where it came from: the chat (its conversation) — 「원래 대화 열기」
  await addMessage(user.id, project.id, 'agent', 'chip', { icon: 'chat', text: L('채팅에서 이어 온 프로젝트예요', 'A project carried on from the chat'),
    fromChat: { threadId: c.source?.threadId || row.thread_id, ...(c.source?.conversationId ? { conversationId: c.source.conversationId } : {}), messageId: c.source?.answer?.messageId || row.id } })
    .catch((e) => console.warn('[chat-project] from chip', e.message))
  // the answer picked: the project's first document (Markdown — its paths and private addresses as the room would see them: lib/hidePaths.js)
  let doc = null
  const answerId = c.source?.answer?.messageId
  if (answerId) {
    try {
      const a = await AS.answerOf(user, answerId)
      const publish = deps.publish || (await import('./office.js')).publishBuffer
      const fname = AS.docName(a)
      const pub = await publish(user.id, fname, Buffer.from(AS.docBody(a), 'utf8'))
      doc = await addMessage(user.id, project.id, 'agent', 'file', { name: pub.name || fname, url: pub.url, type: 'text/markdown', fromChat: { threadId: a.thread_id, messageId: a.id } })
    } catch (e) { console.warn('[chat-project] first document', e.message) }
  }
  // the chat: one line — 「프로젝트로 옮겼어요 · 열기」, filed beside the card (the conversation stays as it is)
  await addMessage(user.id, row.thread_id, 'agent', 'chip', { icon: 'folder', text: L(`프로젝트로 옮겼어요 · ${name}`, `Moved to a project · ${name}`), project: { id: project.id, title: name },
    ...(c.context ? { context: c.context } : {}) }).catch((e) => console.warn('[chat-project] chat chip', e.message))
  const made = await setState(user.id, row.id, { state: 'made', ...said, title: name, project: { id: project.id, title: name }, ...(tpl ? { template: tpl } : {}), ...(doc ? { doc: { messageId: doc.id, name: doc.content.name } } : {}) })
  // (with its folder — a template's workspace: the project's bar shows it at once, as a project made from 새 프로젝트 does)
  const [fresh] = await q('select * from pro_threads where id=$1', [project.id])
  const TF = await import('./folders/threadFolders.js')
  emit(user.id, 'thread', { ...(fresh || project), folder: await TF.folderPayload(project.id).catch(() => null) })
  console.log(`[chat-project] made thread=${String(project.id).slice(0, 8)} template=${tpl?.slug || '-'} doc=${!!doc} from=${String(row.thread_id).slice(0, 8)}`)
  return { project: { id: project.id, title: name, kind: 'project', ...(tpl ? { template: tpl } : {}) }, offer: made }
}

// POST /project-offers/:id/decline → the card says so; nothing is made. A card whose 「만들기」 claim went stale (no project made) can be closed too.
export async function decline(user, id) {
  const row = await offerRow(user, id)
  const st = row.content?.state
  if (st !== 'offered' && !(isStale(row.content) && !row.content?.project?.id)) throw fail(409, L('이미 고른 카드예요.', 'This card was already answered.'), st || 'answered')
  const m = await setState(user.id, row.id, { state: 'declined' }, { from: 'offered', stale: true })
  if (!m) throw fail(409, L('이미 고른 카드예요.', 'This card was already answered.'))
  return { offer: m }
}
