// Process mining over ad-hoc work: process-gpt's process-miner (services/process-miner, branch
// feat/handover-process-identification + feat/pgpt-lite-mining) finds the repeated flow in the
// handover records; an admin sees it as a recommendation, opens the mined flow and decides. On
// 정식 등록 the definition is generated from the mined model (steps, order, roles, agents) plus the
// catalog (forms, skills) and saved with process-gpt's own save path (save_contract + BPMN XML);
// the next similar mail starts it (routeMail).
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { chatJson } from '../llm.js'
import { saveGenerated } from '../generated.js'
import { mainThread, addMessage } from '../store.js'
import { AGENTS, ORCH, STEPS, TOOL_FORMAT, stepOf } from './catalog.js'

const T = () => config.tenantId
// unset: the local miner; set but empty (an install without the mining profile): no scans, no new
// recommendations (registered processes still take matching mail)
const MINER = (process.env.PRO_MINER_URL ?? 'http://127.0.0.1:8014').replace(/\/$/, '')
export const minerEnabled = () => !!MINER
const err = (status, message) => Object.assign(new Error(message), { status })

async function miner(path, body) {
  if (!MINER) throw new Error('process-miner is not configured (PRO_MINER_URL)')
  const r = await fetch(`${MINER}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const t = await r.text()
  if (!r.ok) throw new Error(`process-miner ${r.status}: ${t.slice(0, 200)}`)
  return JSON.parse(t)
}

export async function isAdmin(me) {
  const [u] = await q('select is_admin from users where id::text=$1 and tenant_id=$2', [String(me.id), T()])
  return !!u?.is_admin
}

// ---------- 찾기: 반복 패턴 → 추천 ----------
const NAME = `프로세스 마이닝이 사람·에이전트의 인계 기록에서 반복되는 업무 흐름을 찾았어요. 이 흐름에 이름을 붙이세요.
JSON {"name","summary","keywords"} 로 답하세요.
- name: 한국어 명사구 14자 이내, 가운뎃점(·)으로 두 일을 잇는 형식. 예: "설계 제안·견적 대응", "입사 서류·계정 발급"
- summary: 이 흐름이 무엇인지 해요체 한 문장
- keywords: 다음에 같은 일을 요청하는 메일에 나올 한국어 낱말 3~6개`

async function nameOf(p, cases) {
  try {
    const r = await chatJson(NAME, JSON.stringify({ steps: p.main_variant, examples: cases.map((c) => c.subject).filter(Boolean).slice(0, 5) }))
    if (r?.name) return { name: String(r.name).slice(0, 30), summary: String(r.summary || ''), keywords: (r.keywords || []).map(String).slice(0, 6) }
  } catch (e) { console.warn('[mining] name', e.message) }
  return { name: `${p.main_variant[0]} 이후 반복 흐름`, summary: '', keywords: [] }
}

let scanning = null
export function scan() { return (scanning ||= doScan().finally(() => { scanning = null })) }

async function doScan() {
  if (!MINER) return []
  const { patterns } = await miner(`/patterns?tenant_id=${encodeURIComponent(T())}&min_cases=${Number(process.env.PRO_MINING_MIN_CASES || 4)}`)
  const made = []
  for (const p of patterns) {
    // only work pgpt-pro recorded (one case = one mail); other tenants' demos are not ours to suggest
    const cases = await q('select * from pro_mining_cases where tenant_id=$1 and case_id = any($2) order by created_at', [T(), p.case_ids])
    if (cases.length * 2 < p.case_ids.length) continue
    const [have] = await q('select id, status from pro_mining_suggestions where tenant_id=$1 and pattern_key=$2', [T(), p.key])
    if (have) {
      // more cases of a pattern already suggested: the evidence grows, the decision stays
      // (still undecided: the mined model is drawn again from all the cases)
      const again = have.status === 'suggested' ? await miner('/discover', { tenant_id: T(), process_id: p.process_id, name: p.process_id, case_ids: p.case_ids }).catch(() => null) : null
      await q('update pro_mining_suggestions set pattern=$2, definition=coalesce($3, definition), updated_at=now() where id=$1', [have.id, p, again?.definition || null])
      continue
    }
    // a case still under way is not evidence yet: each case must have reached the flow's usual last
    // step (or sat idle for a while), and none may have moved in the last moments
    const last = p.main_variant.at(-1)
    const [open] = await q(`select 1 from (select distinct on (case_id) case_id, norm_activity_label as l, occurred_at from handover_events
                              where tenant_id=$1 and case_id = any($2) order by case_id, occurred_at desc) x
                            where occurred_at > now() - make_interval(secs => $4) or (l <> $3 and occurred_at > now() - make_interval(secs => $5)) limit 1`,
    [T(), p.case_ids, last, Number(process.env.PRO_MINING_SETTLE_SEC || 20), Number(process.env.PRO_MINING_IDLE_SEC || 1800)])
    if (open) continue
    const named = await nameOf(p, cases)
    // the miner proposes it as process-gpt does: a draft version + an open PR (live proc_def untouched)
    const mined = await miner('/mine', { tenant_id: T(), process_id: p.process_id, name: named.name, case_ids: p.case_ids })
    const formats = [...new Set(p.steps.flatMap((s) => s.tools.map((t) => TOOL_FORMAT[t]).filter(Boolean)))]
    const [s] = await q(`insert into pro_mining_suggestions (tenant_id, pattern_key, process_id, name, summary, pattern, definition, pr_id, version_uuid, match)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id, pattern_key) do nothing returning *`, [
      T(), p.key, p.process_id, named.name, named.summary, p, mined.definition, mined.pr?.pr_id || null, mined.pr?.version_uuid || null,
      { formats, keywords: named.keywords }])
    if (!s) continue
    made.push(s)
    await notifyAdmins(s)
  }
  return made
}

async function notifyAdmins(s) {
  const admins = await q(`select u.id::text as id from users u join pro_team_members m on m.user_id=u.id and m.tenant_id=u.tenant_id
                          where u.tenant_id=$1 and u.is_admin and not coalesce(u.is_agent,false)`, [T()])
  const n = s.pattern.case_count
  for (const a of admins) {
    await q(`insert into notifications (id, user_id, title, type, description, url, tenant_id) values (gen_random_uuid(),$1,$2,'mining',$3,$4,$5)`,
      [a.id, `반복되는 흐름을 찾았어요: ${s.name}`, `최근 ${n}건의 메일 업무가 같은 순서(${s.pattern.main_variant.join(' → ')})로 처리됐어요. 정식 프로세스로 등록할지 정해 주세요.`, `/mining/${s.id}`, T()])
    emit(a.id, 'notifications', {})
    emit(a.id, 'mining', { id: s.id })
  }
}

// ---------- 보기 ----------
export async function list() {
  return q(`select id, name, summary, status, proc_def_id, pattern->'case_count' as case_count, pattern->'main_variant' as steps, created_at, decided_at
            from pro_mining_suggestions where tenant_id=$1 order by created_at desc limit 20`, [T()])
}

export async function get(id) {
  const [s] = await q('select * from pro_mining_suggestions where id=$1 and tenant_id=$2', [id, T()])
  if (!s) return null
  const cases = await q('select case_id, customer, subject, demo, created_at from pro_mining_cases where tenant_id=$1 and case_id = any($2) order by created_at', [T(), s.pattern.case_ids])
  const evs = await q(`select case_id, norm_activity_label as activity, to_user_name as who, to_is_agent as agent, occurred_at, artifact_refs
                       from handover_events where tenant_id=$1 and case_id = any($2) order by occurred_at`, [T(), s.pattern.case_ids])
  for (const c of cases) {
    const mine = evs.filter((e) => e.case_id === c.case_id)
    c.steps = mine.map((e) => ({ activity: e.activity, who: e.who, agent: e.agent, at: e.occurred_at, files: (e.artifact_refs || []).map((r) => r.name).filter(Boolean) }))
    c.minutes = mine.length > 1 ? Math.round((new Date(mine.at(-1).occurred_at) - new Date(mine[0].occurred_at)) / 60000) : 0
  }
  const steps = s.pattern.steps.map((x) => ({ ...x, kind: x.by_agent * 2 >= x.total ? 'agent' : 'human', catalog: stepOf(x.activity) }))
  const pr = s.pr_id ? (await q('select id, title, status, branch_name, created_at, merged_at from resource_pull_requests where id=$1', [s.pr_id]))[0] : null
  const runs = s.proc_def_id ? await q(`select r.proc_inst_id, r.mail, r.created_at, i.status, i.proc_inst_name from pro_mining_runs r
                                         left join bpm_proc_inst i on i.proc_inst_id=r.proc_inst_id where r.suggestion_id=$1 order by r.created_at desc`, [s.id]) : []
  return { ...s, steps, cases, pr, runs }
}

// ---------- 결정 ----------
const tag = { text: 'text-field', select: 'select-field', radio: 'radio-field', textarea: 'textarea-field', file: 'file-field' }
const html = (id, alias, fs) => `<section>\n${fs.map((f) => {
  const t = tag[f.type] || 'text-field'
  const items = f.items ? ` is_dynamic_load='fixed' items='${JSON.stringify(f.items)}'` : ''
  const type = t === 'text-field' ? " type='text'" : ''
  return `  <row-layout name="${id}" alias="${alias}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><${t} name='${f.key}' alias='${f.text}'${type}${items} disabled='false' readonly='false' v-model="slotProps.modelValue['${f.key}']"></${t}></div></div></row-layout>`
}).join('\n')}\n</section>`

// mined definition (flattened) → process-gpt generation contract (elements[] + forms + agents + skills)
export function buildContract(s) {
  const d = s.definition
  const PID = s.process_id
  const formId = (a) => `${PID}_${(stepOf(a.name)?.key || a.id)}_form`
  const roles = new Map()
  const elements = []
  const forms = []
  const agentSkills = new Map()
  const firstHumanRole = d.activities.map((a) => stepOf(a.name)).find((c) => c?.kind === 'human')?.role || d.roles[0]?.name || '담당자'
  for (const e of d.events) elements.push({ elementType: 'Event', id: e.id, name: e.type === 'startEvent' ? '요청 메일 도착' : '회신 완료', role: firstHumanRole, type: e.type === 'startEvent' ? 'StartEvent' : 'EndEvent' })
  for (const a of d.activities) {
    const c = stepOf(a.name)
    const role = c?.role || a.role || '담당자'
    const agent = c?.kind === 'agent' ? AGENTS[c.agent] : (a.agent ? { id: a.agent } : null)
    if (!roles.has(role)) roles.set(role, { name: role, endpoint: agent?.id || '', default: agent?.id || '', resolutionRule: agent ? '' : '프로세스 마이닝: 인계 기록에서 이 일을 맡아 온 역할', origin: agent ? 'used' : 'created' })
    const skills = [...new Set([...(c ? [c.skill] : []), ...(a.skills || [])])]
    const fields = c?.fields || [{ key: 'result', text: `${a.name} 결과`, type: 'textarea' }]
    const fid = formId(a)
    forms.push({ activity_id: a.id, form_id: fid, html: html(fid, a.name, fields) })
    const base = { elementType: 'Activity', id: a.id, name: a.name, role, type: 'UserActivity', tool: `formHandler:${fid}`, duration: 1, inputData: [], outputData: [a.name],
      checkpoints: [], skills, description: c?.description || a.description || '', instruction: c?.instruction || '' }
    if (agent) {
      elements.push({ ...base, agent: agent.id, agentMode: 'complete', orchestration: c ? ORCH : (a.orchestration || 'deepagents'), duration: 1 })
      agentSkills.set(agent.id, [...new Set([...(agentSkills.get(agent.id) || []), ...skills])])
    } else elements.push({ ...base, agentMode: 'none' })
  }
  for (const g of d.gateways) elements.push({ elementType: 'Gateway', id: g.id, name: g.name || '', type: g.type === 'parallelGateway' ? 'ParallelGateway' : 'ExclusiveGateway' })
  for (const x of d.sequences) elements.push({ elementType: 'Sequence', id: x.id, source: x.source, target: x.target, condition: x.condition || '', ...(x.condition ? { name: x.condition } : {}) })
  const cases = s.pattern.case_count
  return {
    type: 'process-definition-result',
    processDefinition: {
      processDefinitionId: PID, processDefinitionName: s.name, isHorizontal: true, data: [],
      description: `${s.summary ? `${s.summary} ` : ''}프로세스 마이닝이 인계 기록 ${s.pattern.event_count}건(케이스 ${cases}건)에서 찾은 흐름을 정식 등록했어요.`,
      roles: [...roles.values()], elements,
    },
    forms,
    agents: [...agentSkills].map(([id, skills]) => ({ id, skills })),
    skills: [...new Set([...agentSkills.values()].flat())],
  }
}

export async function ensureAgents() {
  for (const a of Object.values(AGENTS)) {
    await q(`insert into users (id, username, email, tenant_id, is_agent, is_admin, is_draft, agent_type, alias, goal, persona, permission_ids)
             values ($1,$2,$3,$4,true,false,false,'agent',$5,$6,$7,'{}')
             on conflict (id, tenant_id) do update set username=$2, alias=$5, goal=$6, persona=$7`,
    [a.id, a.name, `${a.alias}@${T()}`, T(), a.alias, a.goal, a.persona])
  }
}

export async function register(me, id) {
  if (!(await isAdmin(me))) throw err(403, '관리자만 정식 등록할 수 있어요.')
  const [s] = await q('select * from pro_mining_suggestions where id=$1 and tenant_id=$2', [id, T()])
  if (!s) throw err(404, '추천을 찾지 못했어요.')
  if (s.status === 'registered') return get(id)
  await ensureAgents()
  // the evidence may have grown since the recommendation: draw the model again from the cases as they are now
  const again = await miner('/discover', { tenant_id: T(), process_id: s.process_id, name: s.name, case_ids: s.pattern.case_ids }).catch((e) => { console.warn('[mining] rediscover', e.message); return null })
  if (again?.definition) { s.definition = again.definition; await q('update pro_mining_suggestions set definition=$2 where id=$1', [id, again.definition]) }
  const contract = buildContract(s)
  const saved = await saveGenerated(contract)
  const defId = saved.proc_def_id || s.process_id
  // save_contract keeps activities' own fields, but make sure each step carries its skills and runner
  const byId = Object.fromEntries(contract.processDefinition.elements.filter((e) => e.elementType === 'Activity').map((e) => [e.id, e]))
  const [row] = await q('select definition from proc_def where id=$1 and tenant_id=$2', [defId, T()])
  if (row?.definition?.activities) {
    const acts = row.definition.activities.map((a) => ({ ...a, skills: byId[a.id]?.skills || a.skills || [], ...(byId[a.id]?.agent ? { orchestration: byId[a.id].orchestration, agentMode: 'complete', agent: byId[a.id].agent } : {}) }))
    await q(`update proc_def set definition = jsonb_set(definition, '{activities}', $3::jsonb) where id=$1 and tenant_id=$2`, [defId, T(), JSON.stringify(acts)])
  }
  // people roles go to whoever did that step before (when they are on the team)
  for (const r of s.definition.roles || []) {
    const c = Object.values(STEPS).find((x) => x.role === r.name) || null
    const roleName = c?.role || r.name
    if (!r.endpoint || c?.kind === 'agent') continue
    const [m] = await q('select 1 from pro_team_members where tenant_id=$1 and user_id::text=$2', [T(), String(r.endpoint)])
    if (m) await q(`insert into pro_role_assignments(tenant_id,proc_def_id,role,user_id,updated_by) values ($1,$2,$3,$4,$5)
                    on conflict (tenant_id,proc_def_id,role) do update set user_id=excluded.user_id, updated_by=excluded.updated_by, updated_at=now()`,
    [T(), defId.toLowerCase(), roleName, r.endpoint, me.id])
  }
  if (s.pr_id) await q(`update resource_pull_requests set status='MERGED', merged_at=now(), reviewer_id=$2, updated_at=now() where id=$1`, [s.pr_id, me.id]).catch((e) => console.warn('[mining] pr', e.message))
  await q(`update pro_mining_suggestions set status='registered', proc_def_id=$2, saved=$3, decided_by=$4, decided_at=now(), updated_at=now() where id=$1`,
    [id, defId, { ...saved, forms: contract.forms.length }, me.id])
  await q(`update notifications set is_checked=true where tenant_id=$1 and url=$2`, [T(), `/mining/${id}`])
  return get(id)
}

export async function hold(me, id) {
  if (!(await isAdmin(me))) throw err(403, '관리자만 정할 수 있어요.')
  const [s] = await q(`update pro_mining_suggestions set status='held', decided_by=$2, decided_at=now(), updated_at=now() where id=$1 and tenant_id=$3 and status='suggested' returning *`, [id, me.id, T()])
  if (!s) throw err(409, '이미 정한 추천이에요.')
  if (s.pr_id) await q(`update resource_pull_requests set status='CLOSED', updated_at=now() where id=$1`, [s.pr_id]).catch(() => {})
  await q(`update notifications set is_checked=true where tenant_id=$1 and url=$2`, [T(), `/mining/${id}`])
  return get(id)
}

// ---------- 다음 메일: 등록된 프로세스로 ----------
export function matches(m, mail, d) {
  const formats = new Set((d?.items || []).map((i) => i.format))
  if (/평면도|설계도|도면|배치도|인테리어|설계\s*제안/.test(`${mail.subject} ${mail.text}`)) formats.add('dxf')
  const hit = (m?.formats || []).filter((f) => formats.has(f)).length
  const words = (m?.keywords || []).filter((k) => k && `${mail.subject} ${mail.text}`.includes(k)).length
  return (m?.formats?.length >= 2 && hit >= 2) || words >= 2
}

// called by lib/mail.js for a mail asking for documents: true when a registered process took it
export async function routeMail(userId, mail, d) {
  const regs = await q(`select * from pro_mining_suggestions where tenant_id=$1 and status='registered' and proc_def_id is not null order by decided_at desc`, [T()])
  const s = regs.find((r) => matches(r.match, mail, d))
  if (!s) return false
  const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
  if (!p?.email) return false
  const { startProcess } = await import('../engine.js')
  const customer = d?.customer || (String(mail.from || '').split('<')[0].trim()) || '고객'
  const values = { customer, sender: mail.from || '', subject: mail.subject || '', body: String(mail.text || '').slice(0, 3000), requested: (d?.items || []).map((i) => i.kind).join('·') }
  const t = await mainThread(userId)
  await addMessage(userId, t.id, 'system', 'divider', { text: `메일 · ${customer} ${values.requested || '요청'}` })
  const { instId, instName } = await startProcess({ me: { id: userId, email: p.email }, defId: s.proc_def_id, values })
  await q(`insert into pro_mining_runs (proc_inst_id, tenant_id, suggestion_id, user_id, mail) values ($1,$2,$3,$4,$5) on conflict do nothing`,
    [instId, T(), s.id, userId, { id: mail.id, from: mail.from, subject: mail.subject, text: String(mail.text || '').slice(0, 3000), customer, items: d?.items || [] }])
  await addMessage(userId, t.id, 'agent', 'text', { text: `${customer} 메일은 정식 등록된 '${s.name}' 프로세스로 처리할게요. 평면도·제안서·견적서는 단계별 에이전트가 만들고, 재무 검토는 재무 담당에게 넘어가요.`, mail: { from: mail.from, subject: mail.subject } })
  await addMessage(userId, t.id, 'agent', 'process', { defId: s.proc_def_id, name: s.name, state: 'started', instId, instName })
  console.log(`[mining] mail ${mail.id} → ${s.proc_def_id} ${instId}`)
  return { instId, suggestion: s.id }
}

export const newId = () => crypto.randomUUID()
