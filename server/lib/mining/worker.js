// Runs the agent steps of a process registered from mining (orchestration 'pgpt-pro-skill'): each step
// is the business pack skill its activity names (pack.json, lib/skillInstallCatalog.js), run the same way
// as the mail's drafts (runners.js: the CADCraft drawing, the Hangul template, the agent with the skill
// pinned). Same protocol as browserWorker.js (processgpt_agent_sdk): fetch_pending_task →
// record_events_bulk → save_task_result. A step runs in its owner's saved language (lib/lang.js).
import crypto from 'node:crypto'
import { admin, q } from '../supa.js'
import { config } from '../../config.js'
import { servesTenant, withTenant } from '../tenant.js'
import { addMessage } from '../store.js'
import { emit } from '../bus.js'
import { ORCH, stepOf, stepsIn, labelLang, packsReady } from './catalog.js'
import { L, langOf, withLang } from '../lang.js'
import { packSkill, outputOf } from '../skillInstallCatalog.js'
import { runSkill, fieldLabels, quoteTotal } from './runners.js'

export { quoteTotal }
const CONSUMER = `pgpt-pro-skill-${process.pid}`
let busy = false

async function events(list) {
  const { error } = await admin.rpc('record_events_bulk', { p_events: list })
  if (error) console.warn('[skill-worker] events', error.message)
}

async function ownerOf(row) {
  const [t] = await q(`select user_id from todolist where proc_inst_id=$1 and coalesce(agent_orch,'') = '' order by start_date asc nulls last limit 1`, [row.proc_inst_id])
  return (t?.user_id || '').split(',')[0].trim() || null
}
async function instanceThread(userId, instId) {
  let [t] = await q('select id from pro_threads where user_id=$1 and ref=$2', [userId, instId])
  if (!t) {
    const [i] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId])
    ;[t] = await q(`insert into pro_threads(user_id,kind,title,ref) values ($1,'process',$2,$3) returning id`, [userId, i?.proc_inst_name, instId])
  }
  return t.id
}
// values of the steps done so far in this instance, flat ({customer, subject, body, floor_plan, rooms, …})
async function earlier(instId) {
  const rows = await q(`select output from todolist where proc_inst_id=$1 and status in ('DONE','SUBMITTED') order by end_date asc nulls last`, [instId])
  const out = {}
  for (const r of rows) for (const v of Object.values(r.output || {})) if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, v)
  return out
}

// The skill a step runs: the first of its activity's skills an enabled pack has (an old name too — pack.json
// aliases), else the skill its pack step names
export function stepSkill(act, label) {
  const named = (act?.skills || []).map((k) => packSkill(k)).find(Boolean)
  return named || packSkill(stepOf(label)?.skill) || null
}

// a step runs in the language of the person it acts for (their saved language)
async function handle(row) {
  const owner = await ownerOf(row)
  return withLang(await langOf(owner), () => handleIn(row))
}
async function handleIn(row) {
  await packsReady()
  const job = crypto.randomUUID()
  const base = { job_id: job, todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: ORCH }
  const [a] = await q(`select a as act from proc_def, jsonb_array_elements(definition->'activities') a where id=$1 and tenant_id=$2 and a->>'id'=$3`, [row.proc_def_id, row.tenant_id, row.activity_id])
  const act = a?.act || {}
  const label = act.name || row.activity_name
  const step = stepOf(label)
  const skill = stepSkill(act, label)
  if (!skill) throw new Error(L(`이 단계의 스킬을 찾지 못했어요(업무 팩이 꺼져 있을 수 있어요): ${(act.skills || []).join(', ') || step?.skill || '(없음)'}`, `I couldn't find this step's skill (its business pack may be off): ${(act.skills || []).join(', ') || step?.skill || '(none)'}`))
  const owner = await ownerOf(row)
  if (!owner) throw new Error('no human participant to act for')
  const threadId = await instanceThread(owner, row.proc_inst_id)
  const status = (text) => emit(owner, 'status', { threadId, text })
  await events([{ ...base, event_type: 'task_started', data: { goal: L(`${row.activity_name} — 스킬 ${skill.name}`, `${row.activity_name} — skill ${skill.name}`), name: act.role || row.activity_name, role: row.activity_name } }])
  await events([{ ...base, event_type: 'tool_usage_started', data: { tool: skill.name, tool_name: skill.name, args: { step: row.activity_name } } }])
  const prev = await earlier(row.proc_inst_id)
  const l = labelLang(label)
  const format = step?.format || outputOf(skill, l)
  const doc = step?.document || row.activity_name
  const name = L(`${prev.customer || '고객'} ${doc}.${format}`, `${prev.customer || 'Customer'} ${doc}.${format}`)
  let r
  try {
    r = await runSkill({ skill, step, format, owner, threadId, prev, name, kind: doc, labels: fieldLabels(stepsIn(l)),
      intro: L(`프로세스 '${row.activity_name}' 단계예요. 아래 고객 메일에 회신할 문서를 만드세요. 다른 단계가 만드는 문서는 만들지 마세요.`,
        `This is the '${row.activity_name}' step of a process. Make the document that answers the customer mail below. Do not make the documents other steps make.`),
      status })
  } finally { status(null) }
  await events([{ ...base, event_type: 'tool_usage_finished', data: { tool: skill.name, tool_name: skill.name, result: JSON.stringify(r.values).slice(0, 500) } }])
  const formId = (act.tool || '').startsWith('formHandler:') ? act.tool.slice(12) : `${row.activity_id}_form`
  const payload = { [formId]: r.values }
  const { error } = await admin.rpc('save_task_result', { p_todo_id: row.id, p_payload: payload, p_final: true })
  if (error) throw new Error('save_task_result: ' + error.message)
  await events([
    { ...base, crew_type: 'result', event_type: 'task_completed', data: payload },
    { job_id: 'CREW_FINISHED', todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: 'crew', event_type: 'crew_completed', data: 'Task completed successfully' },
  ])
  if (r.say) await addMessage(owner, threadId, 'agent', 'text', { text: `${act.role || L('에이전트', 'Agent')} · ${row.activity_name}: ${r.say}` })
  emit(owner, 'process', { instId: row.proc_inst_id, type: 'changed' })
}

// A person's step keeps its skill too: the reply step (skill mail-reply) opens with a draft written
// from the earlier steps, which the person edits and sends.
const drafting = new Set()
async function draftReplies() {
  const rows = await q(`select t.id, t.proc_inst_id, t.user_id, a->>'tool' as tool from todolist t
                        join proc_def d on d.id=t.proc_def_id and d.tenant_id=t.tenant_id
                        join jsonb_array_elements(d.definition->'activities') a on a->>'id' = t.activity_id
                        where t.tenant_id=$1 and t.status='IN_PROGRESS' and t.agent_orch is null and t.draft is null
                          and a->'skills' ? 'mail-reply' limit 3`, [config.tenantId])
  for (const r of rows) {
    if (drafting.has(r.id)) continue
    drafting.add(r.id)
    try {
      const p = await earlier(r.proc_inst_id)
      const { chat } = await import('../llm.js')
      // in the language of the person who sends it, signed with their own name (their profile)
      const who = String(r.user_id || '').split(',')[0].trim()
      const en = (await langOf(who)) === 'en'
      const [me] = await q(`select coalesce(p.name, u.username) as name from users u left join pro_profile p on p.user_id::text = u.id::text
                            where (u.id::text = $1 or u.email = $1) and u.tenant_id = $2 limit 1`, [who, config.tenantId]).catch(() => [])
      const name = me?.name || ''
      // the documents earlier steps made, and the review a teammate gave (the review form's own fields)
      const attachments = Object.values(p).filter((v) => v && typeof v === 'object' && v.name && v.url).map((v) => v.name)
      const out = await withLang(en ? 'en' : 'ko', () => chat({ messages: en ? [
        { role: 'system', content: `You write the body of an English e-mail replying to a customer's request. Polite and professional, at most 8 lines, in this order: greeting, the attachments, what the review changed if anything, and asking them to reply.${name ? ` Sign it "Best regards,\n${name}".` : ''} Write the body only.` },
        { role: 'user', content: JSON.stringify({ customer: p.customer, sender: p.sender, subject: p.subject, request: String(p.body || '').slice(0, 800), attachments, review: p.decision || '', review_comment: p.comment || '' }) },
      ] : [
        { role: 'system', content: `고객 요청 메일에 회신하는 한국어 메일 본문을 씁니다. 정중한 존댓말(습니다체), 8줄 이내, 인사·첨부 안내·검토 의견 반영·회신 요청 순서.${name ? ` 서명은 "${name} 드림".` : ''} 본문만 쓰세요.` },
        { role: 'user', content: JSON.stringify({ 고객: p.customer, 보낸사람: p.sender, 제목: p.subject, 요청: String(p.body || '').slice(0, 800), 첨부: attachments, 검토결과: p.decision || '', 검토의견: p.comment || '' }) },
      ] }))
      const text = String(out?.choices?.[0]?.message?.content || out?.content || out || '').trim()
      const formId = (r.tool || '').startsWith('formHandler:') ? r.tool.slice(12) : 'defaultform'
      if (text) await q('update todolist set draft=$2 where id=$1 and draft is null', [r.id, { [formId]: { reply: text } }])
    } catch (e) { console.warn('[skill-worker] reply draft', e.message) } finally { drafting.delete(r.id) }
  }
}

async function tick() {
  draftReplies().catch((e) => console.warn('[skill-worker] drafts', e.message))
  if (busy) return
  busy = true
  try {
    const { data, error } = await admin.rpc('fetch_pending_task', { p_agent_orch: ORCH, p_consumer: CONSUMER, p_limit: 1, p_env: 'dev' })
    if (error) throw new Error(error.message)
    const row = data?.[0]
    if (!row) return
    // one install serves one tenant; behind the ProcessGPT gateway a step runs as the tenant it belongs to
    if (!servesTenant(row.tenant_id)) {
      await admin.from('todolist').update({ draft_status: null, consumer: null }).eq('id', row.id)
      return
    }
    console.log('[skill-worker] claimed', row.id, row.activity_name)
    try { await withTenant(row.tenant_id, () => handle(row)) } catch (e) {
      console.warn('[skill-worker] failed', e.message)
      await admin.from('todolist').update({ draft_status: 'FAILED', consumer: null }).eq('id', row.id)
      await events([{ job_id: crypto.randomUUID(), todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: ORCH, event_type: 'error', data: { message: e.message } }])
    }
  } catch (e) { console.warn('[skill-worker]', e.message) } finally { busy = false }
}

export async function startSkillWorker() {
  const freed = await q(`update todolist set consumer=null, draft_status=null
                         where agent_orch=$1 and status='IN_PROGRESS' and consumer like 'pgpt-pro-skill-%' and consumer <> $2 returning id, activity_name`, [ORCH, CONSUMER]).catch(() => [])
  for (const r of freed) console.log('[skill-worker] released', r.id, r.activity_name)
  setInterval(tick, 4000)
  console.log(`[skill-worker] polling agent_orch=${ORCH} as ${CONSUMER}`)
}
