// Ad-hoc work leaves handover records the way process-gpt's chat handover does
// (ProcessGPTBackend.createChatHandover → handover_events): one row per step, who it went to and
// what they did, keyed by the thread root (origin_room_id). Here the thread root is the mail: every
// draft and share that answers one customer mail is one case. process-miner reads these rows.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { agentsIn, reviewsIn, stepOf, labelIn, labelsOf, labelLang } from './catalog.js'
import { lang, isEn, langOf } from '../lang.js'

const T = () => config.tenantId
// (a case id is unique across tenants — pro_mining_cases.case_id — and the same demo mail reaches
// people of every tenant: outside the default tenant the id names the tenant too, lib/tenant.js)
export const caseOf = (mailId) => (T() === config.defaultTenantId ? `mail:${mailId}` : `mail:${T()}:${mailId}`)

export async function openCase({ userId, mail, customer, files = [], demo = false, at }) {
  const caseId = caseOf(mail.id)
  await q(`insert into pro_mining_cases (case_id, tenant_id, user_id, mail_id, customer, subject, files, demo, created_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::timestamptz, now()))
           on conflict (case_id) do update set files = (select array(select distinct unnest(pro_mining_cases.files || excluded.files)))`,
  [caseId, T(), userId, mail.id, customer || null, mail.subject || null, files, demo, at || null])
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
export async function recordStep(caseId, label, { to, role, artifacts = [], note = '', at, demo = false, groupId = null, baseCommitId = null } = {}) {
  // the code names steps by their Korean label; an English case records the English one
  const cl = await caseLang(caseId)
  label = labelIn(label, cl)
  const st = stepOf(label)
  if (!st) return null
  const agent = st.kind === 'agent' ? agentsIn(cl)[st.agent] : null
  const who = agent ? { id: agent.id, name: agent.name, isAgent: true } : to
  if (!who?.id) return null
  if (await caseClosed(caseId)) return null
  const prev = await last(caseId)
  const when = at ? new Date(at) : new Date()
  const latency = prev ? Math.max(0, Math.round((when - new Date(prev.occurred_at)) / 1000)) : null
  const refs = (artifacts.length ? artifacts : [{}]).map((a) => ({ type: 'file', ...a, tool: st.tool, skill: st.skill }))
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

// the drafts a mail's case made (file cards in the chat since the case opened), one step per tool
// (an English case's proposal is a Word document)
const DRAFTS = [['평면도 작성', 'dxf'], ['제안서 작성', 'hwpx'], ['견적서 작성', 'xlsx']]
const DRAFTS_EN = [['평면도 작성', 'dxf'], ['제안서 작성', 'docx', 'hwpx'], ['견적서 작성', 'xlsx']]
export async function recordDrafts(threadId, mailId) {
  const caseId = caseOf(mailId)
  const [c] = await q('select created_at, user_id from pro_mining_cases where case_id=$1', [caseId])
  if (!c) return
  const files = await q(`select content->>'name' as name, content->>'url' as url from pro_messages
                         where thread_id=$1 and kind='file' and created_at >= $2 order by created_at`, [threadId, c.created_at])
  const done = new Set((await q('select norm_activity_label as l from handover_events where tenant_id=$1 and case_id=$2', [T(), caseId])).map((r) => r.l))
  const cl = await caseLang(caseId, c.user_id)
  for (const [label, ...exts] of cl === 'en' ? DRAFTS_EN : DRAFTS) {
    const mine = files.filter((f) => exts.some((ext) => String(f.name || '').toLowerCase().endsWith(`.${ext}`)))
    if (!mine.length || labelsOf(label).some((l) => done.has(l))) continue
    await recordStep(caseId, label, { artifacts: mine.map((f) => ({ name: f.name, url: f.url })) })
    await q(`update pro_mining_cases set files = (select array(select distinct unnest(files || $2::text[]))) where case_id=$1`, [caseId, mine.map((f) => f.name)])
  }
}

// What a recipient's review is: the kind their role says (재무 담당 → 재무 검토, 디자이너 → 디자인 검토),
// else the kind the share note asks for ("도면 확인 부탁해요"), else '<their role> 검토', else '팀원 검토'.
export async function shareStep(recipient, note = '', l = lang()) {
  const roles = (await q(`select distinct role from pro_role_assignments where tenant_id=$1 and user_id::text=$2 order by role`, [T(), String(recipient.id)])).map((r) => r.role)
  const REVIEWS = reviewsIn(l)
  for (const r of roles) {
    const k = REVIEWS.find((x) => x.re.test(r))
    if (k) return { label: k.label, role: r }
  }
  const k = REVIEWS.find((x) => x.re.test(note || ''))
  if (k) return { label: k.label, role: roles[0] || k.role }
  if (l === 'en') {
    if (roles[0]) return { label: `${roles[0].replace(/\s*(lead|owner|manager|team)$/i, '').trim() || roles[0]} review`, role: roles[0] }
    return { label: 'Teammate review', role: 'Reviewer' }
  }
  if (roles[0]) return { label: `${roles[0].replace(/\s*(담당자|담당|팀장|팀)$/u, '').trim() || roles[0]} 검토`, role: roles[0] }
  return { label: '팀원 검토', role: '검토 담당' }
}

// the mail case whose drafts these are (the newest of mine that made a file of that name)
export async function caseOfFiles(me, names) {
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
export async function recordShare(me, files, recipients, note, fork = null) {
  const names = files.map((f) => f.name).filter(Boolean)
  if (!names.length) return
  const cases = await q(`select case_id from pro_mining_cases where tenant_id=$1 and user_id=$2 and files && $3::text[]
                         order by created_at desc limit 5`, [T(), me.id, names])
  let open = null
  for (const c of cases) if (!(await caseClosed(c.case_id))) { open = c; break }
  if (!open) return
  const cl = await caseLang(open.case_id, me.id)
  for (const p of recipients) {
    const { label, role } = await shareStep(p, note, cl)
    await recordStep(open.case_id, label, { to: { id: p.id, name: p.name }, role, artifacts: names.map((name) => ({ name })), note: note || '',
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
