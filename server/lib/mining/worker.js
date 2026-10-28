// Runs the agent steps of a process registered from mining (orchestration 'pgpt-pro-skill'): each
// step is the skill the ad-hoc drafts already used — CADCraft floor plan, the 한글 proposal filled by
// office-mcp, the Excel quote by the agent's xlsx skill. Same protocol as browserWorker.js
// (processgpt_agent_sdk): fetch_pending_task → record_events_bulk → save_task_result.
import crypto from 'node:crypto'
import { admin, q, sessionFor } from '../supa.js'
import { config } from '../../config.js'
import { withTenant } from '../tenant.js'
import { addMessage } from '../store.js'
import { emit } from '../bus.js'
import { ORCH, stepOf } from './catalog.js'

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
async function newFile(threadId, since, ext) {
  const [m] = await q(`select content from pro_messages where thread_id=$1 and kind='file' and created_at >= $2 and lower(content->>'name') like $3 order by created_at desc limit 1`,
    [threadId, since, `%.${ext}`])
  return m ? { name: m.content.name, url: m.content.url } : null
}

const SKILLS = {
  // CADCraft through its MCP (lib/floorPlan.js), the same drawing the mail drafts make
  async 'cadcraft-floor-plan'({ owner, threadId, prev, status }) {
    const { layoutFromMail, drawFloorPlan } = await import('../floorPlan.js')
    const { publish } = await import('../office.js')
    const mail = { subject: prev.subject, text: prev.body }
    status('도면 배치 정하는 중')
    const layout = await layoutFromMail(mail)
    const drawn = await drawFloorPlan(owner, layout, `${prev.customer || '고객'} 평면도.dxf`, (step) => status(`캐드크래프트로 도면 그리는 중 · ${step}`))
    const doc = await publish(owner, drawn.path)
    await addMessage(owner, threadId, 'agent', 'file', { ...doc, path: drawn.path })
    const rooms = drawn.rooms.map((r) => `${r.name} | ${r.area}㎡ | ${r.use}`).join('\n')
    return { values: { floor_plan: { name: doc.name, url: doc.url }, rooms }, say: `캐드크래프트로 평면도(${drawn.width}m × ${drawn.depth}m)를 그렸어요. ${drawn.rooms.map((r) => `${r.name} ${r.area}㎡`).join(', ')}.` }
  },
  // the proposal template with the drawing in its picture, filled by office-mcp generate_hwpx
  async 'hwpx-proposal'({ owner, threadId, prev, status }) {
    const mail = await import('../mail.js')
    const since = new Date()
    let templateUrl
    if (prev.floor_plan?.url) { status('제안서 양식에 평면도 넣는 중'); templateUrl = await mail.designTemplate(owner, prev.floor_plan.url).catch(() => undefined) }
    status('아래아한글 제안서 채우는 중')
    const rooms = String(prev.rooms || '').split('\n').join(' / ')
    await mail.hwpxDraft(owner, threadId, { from: prev.sender, subject: prev.subject, text: prev.body }, { kind: '제안서', name: `${prev.customer || '고객'} 제안서.hwpx` }, prev.customer,
      { templateUrl, extra: rooms ? `평면도(${prev.floor_plan?.name || ''})를 2번 '설계 평면도' 그림으로 그대로 두고, '공간 구성' 표는 평면도의 실별 면적으로 채우세요: ${rooms}` : '' })
    const f = await newFile(threadId, since, 'hwpx')
    if (!f) throw new Error('제안서 파일을 찾지 못했어요')
    return { values: { proposal: f }, say: `평면도를 넣은 아래아한글 제안서(${f.name})를 채웠어요.` }
  },
  // the agent's xlsx skill (deepagents), in the instance's conversation
  async xlsx({ owner, threadId, prev, status }) {
    const { delegate } = await import('../agent.js')
    const [p] = await q('select email, name from pro_profile where user_id=$1', [owner])
    const { user, session } = await sessionFor(p.email, p.name)
    const name = `${prev.customer || '고객'} 견적서.xlsx`
    const since = new Date()
    status('엑셀 견적서 만드는 중')
    const msg = await delegate({ user, session, threadId, silent: true,
      text: `프로세스 '견적서 작성' 단계예요. 고객 메일(${prev.subject})에 회신할 견적서를 만드세요. 평면도의 실별 면적: ${String(prev.rooms || '').split('\n').join(' / ')}\n메일 본문: ${String(prev.body || '').slice(0, 2000)}\n\n` +
        `엑셀(xlsx) 스킬로 /workspace/${name} 를 만드세요: 위에 제목·수신·발신·견적일·유효기간, 품목 표(구분·품목·수량·단위·단가·금액, 금액은 =수량*단가 수식) — 설계비(평면·마감 설계, 1식), 실별 인테리어 공사(면적 ㎡ × ㎡당 단가, 실마다 한 줄), 가구·집기(좌석 수 기준), 전기·설비(1식), 그 아래 공급가액 소계·부가세(10%)·합계 행(모두 수식), 천 단위 쉼표, 머리글 색 구분. 단가는 합리적인 가정값.\n\n` +
        `(평면도와 제안서는 앞 단계에서 이미 만들었으니 만들지 마세요.) 다 만들면 파일 이름과 가정한 단가를 두세 줄로 적으세요. 모두 한국어(해요체)로 쓰세요.` })
    const f = await newFile(threadId, since, 'xlsx')
    if (!f) throw new Error('견적서 파일을 찾지 못했어요')
    // the agent's answer streams its progress first; the last paragraphs are the summary (file, assumed prices)
    const text = String(msg?.content?.text || '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean).slice(-3).join('\n\n').slice(0, 1500)
    return { values: { quote: f, assumptions: text }, say: null }
  },
}

async function handle(row) {
  const job = crypto.randomUUID()
  const base = { job_id: job, todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: ORCH }
  const [a] = await q(`select a as act from proc_def, jsonb_array_elements(definition->'activities') a where id=$1 and tenant_id=$2 and a->>'id'=$3`, [row.proc_def_id, row.tenant_id, row.activity_id])
  const act = a?.act || {}
  const skill = (act.skills || []).find((k) => SKILLS[k]) || stepOf(act.name || row.activity_name)?.skill
  if (!SKILLS[skill]) throw new Error(`이 단계의 스킬을 찾지 못했어요: ${skill || '(없음)'}`)
  const owner = await ownerOf(row)
  if (!owner) throw new Error('no human participant to act for')
  const threadId = await instanceThread(owner, row.proc_inst_id)
  const status = (text) => emit(owner, 'status', { threadId, text })
  await events([{ ...base, event_type: 'task_started', data: { goal: `${row.activity_name} — 스킬 ${skill}`, name: act.role || row.activity_name, role: row.activity_name } }])
  await events([{ ...base, event_type: 'tool_usage_started', data: { tool: skill, tool_name: skill, args: { step: row.activity_name } } }])
  let r
  try { r = await SKILLS[skill]({ owner, threadId, prev: await earlier(row.proc_inst_id), status }) } finally { status(null) }
  await events([{ ...base, event_type: 'tool_usage_finished', data: { tool: skill, tool_name: skill, result: JSON.stringify(r.values).slice(0, 500) } }])
  const formId = (act.tool || '').startsWith('formHandler:') ? act.tool.slice(12) : `${row.activity_id}_form`
  const payload = { [formId]: r.values }
  const { error } = await admin.rpc('save_task_result', { p_todo_id: row.id, p_payload: payload, p_final: true })
  if (error) throw new Error('save_task_result: ' + error.message)
  await events([
    { ...base, crew_type: 'result', event_type: 'task_completed', data: payload },
    { job_id: 'CREW_FINISHED', todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: 'crew', event_type: 'crew_completed', data: 'Task completed successfully' },
  ])
  if (r.say) await addMessage(owner, threadId, 'agent', 'text', { text: `${act.role || '에이전트'} · ${row.activity_name}: ${r.say}` })
  emit(owner, 'process', { instId: row.proc_inst_id, type: 'changed' })
}

// A person's step keeps its skill too: the reply step (skill mail-reply) opens with a draft written
// from the earlier steps, which the person edits and sends.
const drafting = new Set()
async function draftReplies() {
  const rows = await q(`select t.id, t.proc_inst_id, a->>'tool' as tool from todolist t
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
      const out = await chat({ messages: [
        { role: 'system', content: '고객 요청 메일에 회신하는 한국어 메일 본문을 씁니다. 정중한 존댓말(습니다체), 8줄 이내, 인사·첨부 안내(제안서·견적서)·검토 의견 반영·회신 요청 순서. 서명은 "김지수 드림". 본문만 쓰세요.' },
        { role: 'user', content: JSON.stringify({ 고객: p.customer, 보낸사람: p.sender, 제목: p.subject, 요청: String(p.body || '').slice(0, 800), 첨부: [p.floor_plan?.name, p.proposal?.name, p.quote?.name].filter(Boolean), 재무검토: p.decision, 검토의견: p.comment || '' }) },
      ] })
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
    if (!config.tenantFromHeader && row.tenant_id !== config.tenantId) {
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
