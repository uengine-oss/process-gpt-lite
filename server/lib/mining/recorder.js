// Ad-hoc work leaves handover records the way process-gpt's chat handover does
// (ProcessGPTBackend.createChatHandover → handover_events): one row per step, who it went to and
// what they did, keyed by the thread root (origin_room_id). Here the thread root is the mail: every
// draft and share that answers one customer mail is one case. process-miner reads these rows.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { agentsIn, stepOf, labelIn, labelsOf, labelLang, docReview, roleReviews, stepForSkill, draftStep, reviewStep, reviewLabel, roleIn, packsReady } from './catalog.js'
import { lang, isEn, langOf } from '../lang.js'
import { judge, judgeAvailable } from '../judge.js'

const T = () => config.tenantId
// (a case id is unique across tenants — pro_mining_cases.case_id — and the same demo mail reaches
// people of every tenant: outside the default tenant the id names the tenant too, lib/tenant.js)
export const caseOf = (mailId) => (T() === config.defaultTenantId ? `mail:${mailId}` : `mail:${T()}:${mailId}`)

// items: the documents the mail asked for, as the mail's triage named them ({kind, skill, name, format},
// lib/mail.js) — the case's draft steps are named after them (recordDrafts)
export async function openCase({ userId, mail, customer, files = [], items = null, demo = false, at }) {
  const caseId = caseOf(mail.id)
  await q(`insert into pro_mining_cases (case_id, tenant_id, user_id, mail_id, customer, subject, files, items, demo, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10::timestamptz, now()))
           on conflict (case_id) do update set files = (select array(select distinct unnest(pro_mining_cases.files || excluded.files))),
             items = coalesce(excluded.items, pro_mining_cases.items)`,
  [caseId, T(), userId, mail.id, customer || null, mail.subject || null, files, items ? JSON.stringify(items) : null, demo, at || null])
  return caseId
}

async function last(caseId) {
  const [r] = await q(`select to_user_id, to_user_name, to_is_agent, to_room_id, occurred_at from handover_events
                       where tenant_id=$1 and case_id=$2 order by occurred_at desc limit 1`, [T(), caseId])
  return r || null
}

const REPLY = '고객 회신'
// replying to the customer ends the case: nothing recorded after it belongs to it (a later share
// would otherwise become an extra branch after the reply in the mined definition)
export async function caseClosed(caseId) {
  const [r] = await q('select 1 from handover_events where tenant_id=$1 and case_id=$2 and norm_activity_label = any($3) limit 1', [T(), caseId, labelsOf(REPLY)])
  return !!r
}

// The language a case is recorded in (English mode, lib/lang.js): the language of its first step, so
// every step of one case keeps one language; a new case takes the language of the person whose work
// it is (this request's English, else their saved language). The miner then groups English cases
// with English cases and Korean with Korean.
export async function caseLang(caseId, userId) {
  const [r] = await q('select norm_activity_label as l from handover_events where tenant_id=$1 and case_id=$2 order by occurred_at limit 1', [T(), caseId]).catch(() => [])
  if (r?.l) return labelLang(r.l)
  if (isEn()) return 'en'
  if (userId) return langOf(userId)
  const [c] = await q('select user_id from pro_mining_cases where case_id=$1', [caseId]).catch(() => [])
  return c?.user_id ? langOf(c.user_id) : lang()
}

// to: {id, name, isAgent} — or omitted for an agent step (the catalog names the agent);
// role: the recipient's role when the step's kind does not fix one (a '<역할> 검토')
// step: the step itself when no catalog has it (a draft named for its document, a review named for a role)
// failed: the step was reached but its work made nothing (an agent that could not be reached): the case
// still went through it — the flow is what mining reads, whatever came of the work
export async function recordStep(caseId, label, { to, role, step = null, artifacts = [], note = '', at, demo = false, groupId = null, baseCommitId = null, failed = false } = {}) {
  await packsReady()
  // the code names steps by their Korean label; an English case records the English one
  const cl = await caseLang(caseId)
  label = labelIn(label, cl)
  const st = stepOf(label) || (step?.label === label ? step : null)
  if (!st) return null
  const agent = st.kind === 'agent' ? agentsIn(cl)[st.agent] : null
  const who = agent ? { id: agent.id, name: agent.name, isAgent: true } : to
  if (!who?.id) return null
  if (await caseClosed(caseId)) return null
  const prev = await last(caseId)
  const when = at ? new Date(at) : new Date()
  const latency = prev ? Math.max(0, Math.round((when - new Date(prev.occurred_at)) / 1000)) : null
  const refs = (artifacts.length ? artifacts : [{}]).map((a) => ({ type: 'file', ...a, tool: st.tool, skill: st.skill, ...(failed ? { outcome: 'failed' } : {}) }))
  const [row] = await q(`insert into handover_events (tenant_id, case_id, origin_room_id, source, is_explicit,
             from_room_id, to_room_id, from_user_id, from_user_name, from_is_agent, to_user_id, to_user_name, to_role, to_is_agent, agent_orch,
             activity_label, next_activity_label, norm_activity_label, instruction, reason, artifact_refs, occurred_at, returned_at, handover_latency_sec,
             group_id, base_commit_id)
           values ($1,$2,$2,$3,$4,$2,$2,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13,$14,$15,$16,$17,$17,$18,$19,$20) returning id`, [
    T(), caseId, agent ? 'agent_delegation' : 'chat_handover', !agent,
    prev?.to_user_id || null, prev?.to_user_name || null, !!prev?.to_is_agent,
    String(who.id), who.name, role || st.role || null, !!who.isAgent, agent ? 'deepagents' : null,
    label, note || st.description, cl === 'en' ? (demo ? 'pgpt-pro demo past case' : 'pgpt-pro mail work') : demo ? 'pgpt-pro 시연용 과거 사례' : 'pgpt-pro 메일 업무',
    JSON.stringify(refs), when.toISOString(), latency, groupId, baseCommitId])
  return row?.id
}

// the drafts a mail's case made (file cards in the chat since the case opened), one step per document the
// mail asked for: the pack step that makes it (its skill), else a step named for the document itself
const extOf = (n) => String(n || '').toLowerCase().split('.').pop()
export async function recordDrafts(threadId, mailId) {
  await packsReady()
  const caseId = caseOf(mailId)
  const [c] = await q('select created_at, user_id, files, items from pro_mining_cases where case_id=$1', [caseId])
  if (!c) return
  // only this mail's drafts: the cards its draft jobs marked with its mail id (lib/mail.js). Drafts of
  // other mails made at the same time in the same chat are theirs, not this case's.
  const files = await q(`select content->>'name' as name, content->>'url' as url from pro_messages
                         where thread_id=$1 and kind='file' and created_at >= $2 and content->>'mail_id' = $3 order by created_at`, [threadId, c.created_at, String(mailId)])
  const done = new Set((await q('select norm_activity_label as l from handover_events where tenant_id=$1 and case_id=$2', [T(), caseId])).map((r) => r.l))
  const cl = await caseLang(caseId, c.user_id)
  const taken = new Set()
  for (const it of Array.isArray(c.items) ? c.items : []) {
    const ext = it.format || extOf(it.name)
    const pack = stepForSkill(it.skill, cl)
    const st = pack || draftStep(it.kind || ext, cl, ext)
    if (labelsOf(st.label).some((l) => done.has(l))) continue
    // the card of this document: its file name, else the first not yet taken in its format
    const mine = files.filter((f) => !taken.has(f.name) && (f.name === it.name || extOf(f.name) === ext)).slice(0, 1)
    for (const f of mine) taken.add(f.name)
    if (mine.length) {
      await recordStep(caseId, st.label, { step: st, artifacts: mine.map((f) => ({ name: f.name, url: f.url })) })
      await q(`update pro_mining_cases set files = (select array(select distinct unnest(files || $2::text[]))) where case_id=$1`, [caseId, mine.map((f) => f.name)])
    } else {
      // asked for and tried, but no draft came of it: the case reached the step all the same
      await recordStep(caseId, st.label, { step: st, failed: true, note: cl === 'en' ? 'The draft could not be made.' : '초안을 만들지 못했어요.' })
    }
    done.add(st.label)
  }
}

// the pack's review kind the recipient's role and the share note ask for (the judge's pick), or null
// throws: let a failed judge call through (evaluation counts it; the server falls back to the next rule)
export async function judgeReview(kinds, roles = [], note = '', l = lang(), { throws = false } = {}) {
  if (!kinds.length || !(roles.length || String(note || '').trim()) || !judgeAvailable()) return null
  const en = l === 'en'
  const options = [...kinds.map((k, i) => ({ key: `r${i}`, label: `${k.label} — ${k.judge || k.description}` })), { key: 'none', label: en ? 'none of these: a general look, a schedule check, or just for reference' : '해당 없음: 일반 확인·일정 확인·참고용' }]
  const r = await judge({ state: JSON.stringify({ reviewer_roles: roles, share_note: String(note || '').slice(0, 500) }),
    question: en ? 'Which kind of review does this share ask the recipient for? The note says what is asked; the roles only say who receives it.' : '이 공유가 받는 사람에게 부탁하는 검토는 어느 종류인가? 메모가 부탁한 일이고, 역할은 받는 사람이 누구인지일 뿐이다.', options }).catch((e) => { if (throws) throw e; return null })
  const [best, p] = Object.entries(r?.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || []
  return best && best !== 'none' && p >= 0.5 ? kinds[Number(best.slice(1))] : null
}

// What a recipient's review is (each a fact, never a word read off a name or a note):
//   1. the review the share itself names (a structured field, `review`)
//   2. the document they were given: an enabled pack's review for its format (평면도·제안서·견적서 …), else
//      the document the case's mail asked for ('<kind> 검토')
//   3. no document to go by: the pack's review kinds judged against the recipient's role and the share note
//   4. '<their role> 검토', else '팀원 검토'
// The document comes first because the role names the reviewer, not the review: one person reviewing a
// floor plan and a quote left two different step names, and the mined flows differed for no reason.
export async function shareStep(recipient, note = '', l = lang(), files = [], { review = '', items = [] } = {}) {
  await packsReady()
  const en = l === 'en'
  const roles = (await q(`select distinct role from pro_role_assignments where tenant_id=$1 and user_id::text=$2 order by role`, [T(), String(recipient.id)])).map((r) => r.role)
  const reviewer = roles[0] || roleIn('reviewer', l)
  if (String(review || '').trim()) { const label = String(review).trim().slice(0, 40); return { label, role: reviewer, step: stepOf(label) || reviewStep(label, l, reviewer) } }
  const byDoc = docReview(files, l)
  if (byDoc) return { label: byDoc, role: roles[0] || stepOf(byDoc)?.role || reviewer, step: stepOf(byDoc) }
  const names = new Set(files.map((n) => String(n || '')))
  const asked = items.find((it) => names.has(it.name)) || items.find((it) => files.some((n) => extOf(n) === (it.format || extOf(it.name))))
  if (asked?.kind) {
    const label = reviewLabel(asked.kind, l)
    return { label, role: reviewer, step: stepOf(label) || reviewStep(label, l, reviewer) }
  }
  const k = await judgeReview(roleReviews(l), roles, note, l)
  if (k) return { label: k.label, role: roles[0] || k.role, step: k }
  if (roles[0]) { const label = reviewLabel(roles[0], l); return { label, role: roles[0], step: stepOf(label) || reviewStep(label, l, roles[0]) } }
  const label = en ? 'Teammate review' : '팀원 검토'
  return { label, role: reviewer, step: stepOf(label) }
}

// the mail case whose drafts these are: the mail the cards were made for (mailIds, lib/mail.js), else —
// a card from before that mark — the newest of mine that made a file of that name
export async function caseOfFiles(me, names, mailIds = []) {
  for (const m of [...new Set(mailIds.filter(Boolean))]) {
    const [c] = await q('select case_id from pro_mining_cases where tenant_id=$1 and user_id=$2 and case_id=$3', [T(), me.id, caseOf(m)])
    if (c) return c.case_id
  }
  names = names.filter(Boolean)
  if (!names.length) return null
  const [c] = await q(`select case_id from pro_mining_cases where tenant_id=$1 and user_id=$2 and files && $3::text[]
                       order by created_at desc limit 1`, [T(), me.id, names])
  return c?.case_id || null
}

// a team share of a case's drafts is the case's next handover: the recipient reviews them. Only a
// case still open takes it — once the customer was answered, a later share is new work, not a step
// of that case (it is not recorded).
// fork: the share's batch (group_id) and the commit every recipient's branch started from.
// review: the kind of review the share asked for, when the screen sends one (a structured field)
export async function recordShare(me, files, recipients, note, fork = null, { review = '' } = {}) {
  const names = files.map((f) => f.name).filter(Boolean)
  if (!names.length) return
  // the case is the mail the shared draft was made for (its card says, lib/mail.js); only a card from
  // before that mark is matched by file name (the newest of my cases that made a file of that name)
  const mails = [...new Set(files.map((f) => f.card?.content?.mail_id).filter(Boolean))]
  const cases = mails.length
    ? await q('select case_id from pro_mining_cases where tenant_id=$1 and user_id=$2 and case_id = any($3) order by created_at desc', [T(), me.id, mails.map(caseOf)])
    : await q(`select case_id from pro_mining_cases where tenant_id=$1 and user_id=$2 and files && $3::text[]
               order by created_at desc limit 5`, [T(), me.id, names])
  let open = null
  for (const c of cases) if (!(await caseClosed(c.case_id))) { open = c; break }
  if (!open) return
  const cl = await caseLang(open.case_id, me.id)
  const [c] = await q('select items from pro_mining_cases where case_id=$1', [open.case_id])
  for (const p of recipients) {
    const { label, role, step } = await shareStep(p, note, cl, names, { review, items: Array.isArray(c?.items) ? c.items : [] })
    await recordStep(open.case_id, label, { to: { id: p.id, name: p.name }, role, step, artifacts: names.map((name) => ({ name })), note: note || '',
      groupId: fork?.batchId, baseCommitId: fork?.baseCommitId })
  }
}

// replying to the customer closes the case
export async function recordReply(me, action) {
  const mailId = action?.source?.mail_id
  if (!mailId) return
  const caseId = caseOf(mailId)
  const [c] = await q('select 1 from pro_mining_cases where case_id=$1', [caseId])
  if (!c) return
  const [p] = await q('select name from pro_profile where user_id=$1', [me.id])
  await recordStep(caseId, REPLY, { to: { id: me.id, name: p?.name || me.email } })
}
