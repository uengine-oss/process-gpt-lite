// Ad-hoc work leaves handover records the way process-gpt's chat handover does
// (ProcessGPTBackend.createChatHandover → handover_events): one row per step, who it went to and
// what they did, keyed by the thread root (origin_room_id). Here the thread root is the mail: every
// draft and share that answers one customer mail is one case. process-miner reads these rows.
import { config } from '../../config.js'
import { q } from '../supa.js'
import { AGENTS, stepOf } from './catalog.js'

const T = () => config.tenantId
export const caseOf = (mailId) => `mail:${mailId}`

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

// to: {id, name, isAgent} — or omitted for an agent step (the catalog names the agent)
export async function recordStep(caseId, label, { to, artifacts = [], note = '', at, demo = false } = {}) {
  const st = stepOf(label)
  if (!st) return null
  const agent = st.kind === 'agent' ? AGENTS[st.agent] : null
  const who = agent ? { id: agent.id, name: agent.name, isAgent: true } : to
  if (!who?.id) return null
  const prev = await last(caseId)
  const when = at ? new Date(at) : new Date()
  const latency = prev ? Math.max(0, Math.round((when - new Date(prev.occurred_at)) / 1000)) : null
  const refs = (artifacts.length ? artifacts : [{}]).map((a) => ({ type: 'file', ...a, tool: st.tool, skill: st.skill }))
  const [row] = await q(`insert into handover_events (tenant_id, case_id, origin_room_id, source, is_explicit,
             from_room_id, to_room_id, from_user_id, from_user_name, from_is_agent, to_user_id, to_user_name, to_role, to_is_agent, agent_orch,
             activity_label, next_activity_label, norm_activity_label, instruction, reason, artifact_refs, occurred_at, returned_at, handover_latency_sec)
           values ($1,$2,$2,$3,$4,$2,$2,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$13,$14,$15,$16,$17,$17,$18) returning id`, [
    T(), caseId, agent ? 'agent_delegation' : 'chat_handover', !agent,
    prev?.to_user_id || null, prev?.to_user_name || null, !!prev?.to_is_agent,
    String(who.id), who.name, st.role, !!who.isAgent, agent ? 'deepagents' : null,
    label, note || st.description, demo ? 'pgpt-pro 시연용 과거 사례' : 'pgpt-pro 메일 업무',
    JSON.stringify(refs), when.toISOString(), latency])
  return row?.id
}

// the drafts a mail's case made (file cards in the chat since the case opened), one step per tool
const DRAFTS = [['평면도 작성', 'dxf'], ['제안서 작성', 'hwpx'], ['견적서 작성', 'xlsx']]
export async function recordDrafts(threadId, mailId) {
  const caseId = caseOf(mailId)
  const [c] = await q('select created_at from pro_mining_cases where case_id=$1', [caseId])
  if (!c) return
  const files = await q(`select content->>'name' as name, content->>'url' as url from pro_messages
                         where thread_id=$1 and kind='file' and created_at >= $2 order by created_at`, [threadId, c.created_at])
  const done = new Set((await q('select norm_activity_label as l from handover_events where tenant_id=$1 and case_id=$2', [T(), caseId])).map((r) => r.l))
  for (const [label, ext] of DRAFTS) {
    const mine = files.filter((f) => String(f.name || '').toLowerCase().endsWith(`.${ext}`))
    if (!mine.length || done.has(label)) continue
    await recordStep(caseId, label, { artifacts: mine.map((f) => ({ name: f.name, url: f.url })) })
    await q(`update pro_mining_cases set files = (select array(select distinct unnest(files || $2::text[]))) where case_id=$1`, [caseId, mine.map((f) => f.name)])
  }
}

// a team share of a case's drafts is the case's next handover: the recipient reviews them
export async function recordShare(me, files, recipients, note) {
  const names = files.map((f) => f.name).filter(Boolean)
  if (!names.length) return
  const [c] = await q(`select case_id from pro_mining_cases where tenant_id=$1 and user_id=$2 and files && $3::text[]
                       order by created_at desc limit 1`, [T(), me.id, names])
  if (!c) return
  for (const p of recipients) {
    await recordStep(c.case_id, '재무 검토', { to: { id: p.id, name: p.name }, artifacts: names.map((name) => ({ name })), note: note || '' })
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
  await recordStep(caseId, '고객 회신', { to: { id: me.id, name: p?.name || me.email } })
}
