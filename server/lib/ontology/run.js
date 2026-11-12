// 스냅샷 실행(design-v0.2 §4): the ontology is not run as such. When a case comes in, its start task is chosen, and the
// bundle's graph is unfolded from there into an ordinary process definition (a snapshot: lanes per role, XOR splits
// with the learned conditions, AND splits for parallel work, pinned steps always in) that Process GPT's own engine
// runs. A snapshot with the same key (bundle · start task · θ · last structural change · statistics week) is reused.
// A case that jumps somewhere its snapshot does not go is moved: the running instance is closed and a new snapshot
// from the target task continues the same case. Agent steps run here (orchestration pgpt-pro-onto): the step's skills,
// and its checkpoints checked against what it produced.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import { emit } from '../bus.js'
import { oddsOf } from '../decide.js'
import { chatJson } from '../llm.js'
import { mainThread, addMessage } from '../store.js'
import { saveGenerated } from '../generated.js'
import { cypher, readGraph, ontologyEnabled } from './store.js'
import { taskDefinition } from './taskdef.js'
import { END } from './stats.js'

export const ORCH = 'pgpt-pro-onto'
const T = () => config.tenantId
const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex')
export const actId = (task) => `t_${sha(task).slice(0, 10)}`
const err = (status, message) => Object.assign(new Error(message), { status })
const fmtWon = (n) => new Intl.NumberFormat('ko-KR').format(n)
const isoDay = (d = new Date()) => new Date(d).toISOString()

// ---------- reading a bundle ----------
export async function bundleGraph(bundleKey, { validAt } = {}) {
  const g = await readGraph({ validAt })
  const bundle = g.bundles.find((b) => b.key === bundleKey)
  if (!bundle) throw err(404, '묶음을 찾지 못했어요.')
  const set = new Set(bundle.tasks)
  const tasks = new Map(g.tasks.filter((t) => set.has(t.key)).map((t) => [t.key, t]))
  const edges = g.edges.filter((e) => set.has(e.from) && (e.to === END || set.has(e.to)))
  return { bundle, tasks, edges, all: g }
}

// the usual way from the bundle's main entry to `entry` (most probable path) — what a case starting at `entry` skipped
export function skippedBefore(bundle, edges, entry) {
  const start = bundle.entries?.[0]
  if (!start || start === entry) return []
  const dist = new Map([[start, 0]]), prev = new Map(), todo = new Set([start])
  while (todo.size) {
    const x = [...todo].sort((a, b) => dist.get(a) - dist.get(b))[0]
    todo.delete(x)
    if (x === entry) break
    for (const e of edges.filter((y) => y.from === x && y.to !== END && y.p > 0)) {
      const d = dist.get(x) - Math.log(e.p)
      if (d < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, d); prev.set(e.to, x); todo.add(e.to) }
    }
  }
  if (!prev.has(entry)) return []
  const path = []
  for (let x = prev.get(entry); x; x = prev.get(x)) path.unshift(x)
  return path
}

// ---------- unfolding ----------
// → {nodes:[task], flows:[{from,to,cond,p,default}], gateways, band}
export function unfold({ bundle, tasks, edges }, entry, theta) {
  const retiredTask = (k) => tasks.get(k)?.status === 'retired'
  const pinnedTask = (k) => !!tasks.get(k)?.pinned
  let ok = edges.filter((e) => e.status !== 'retired' && !retiredTask(e.from) && !(e.to !== END && retiredTask(e.to)) && (e.p >= theta || e.pinned || (e.to !== END && pinnedTask(e.to))))
  // 고정: a split that can reach a pinned task goes through it — the ways around it are dropped
  for (const x of new Set(ok.map((e) => e.from))) {
    const outs = ok.filter((e) => e.from === x)
    const pin = outs.find((e) => e.to !== END && pinnedTask(e.to))
    if (pin && outs.length > 1) ok = ok.filter((e) => e.from !== x || e === pin || (e.to !== END && isUpstream(ok, e.to, x)))
  }
  if (bundle.band === 'open') ok = ok.filter((e) => e.from === entry && e.to === END)
  const nodes = [], seen = new Set([entry]), queue = [entry]
  while (queue.length) {
    const x = queue.shift()
    nodes.push(x)
    for (const e of ok.filter((y) => y.from === x)) if (e.to !== END && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to) }
  }
  const flows = ok.filter((e) => seen.has(e.from))
  // a task with no way out in the snapshot ends there
  for (const x of nodes) if (!flows.some((f) => f.from === x)) flows.push({ from: x, to: END, p: 1, synthetic: true })
  return { nodes, flows }
}
function isUpstream(edges, a, b) {
  // is `a` before `b` (a path a → … → b)? then an edge b → a is a loop back, not a way around
  const seen = new Set([a]), st = [a]
  while (st.length) { const x = st.pop(); if (x === b) return true; for (const e of edges.filter((y) => y.from === x && y.to !== END)) if (!seen.has(e.to)) { seen.add(e.to); st.push(e.to) } }
  return false
}

const tag = { text: 'text-field', textarea: 'textarea-field' }
const formHtml = (id, alias, fields) => `<section>\n${fields.map((f) => `  <row-layout name="${id}" alias="${alias}" is_multidata_mode="false" v-model="formValues" v-slot="slotProps"><div class="row"><div class="col-sm-12"><${tag[f.type] || 'text-field'} name='${f.key}' alias='${f.text}'${(tag[f.type] || 'text-field') === 'text-field' ? " type='text'" : ''} disabled='false' readonly='false' v-model="slotProps.modelValue['${f.key}']"></${tag[f.type] || 'text-field'}></div></div></row-layout>`).join('\n')}\n</section>`

export async function agentId() {
  const id = `${sha(`${T()}:onto-agent`).slice(0, 8)}-${sha('onto').slice(0, 4)}-4${sha(T()).slice(0, 3)}-a${sha('agent').slice(0, 3)}-${sha(`${T()}agent`).slice(0, 12)}`
  await q(`insert into users (id, username, email, tenant_id, is_agent, is_admin, is_draft, agent_type, alias, goal, persona, permission_ids)
           values ($1,'업무 에이전트',$2,$3,true,false,false,'agent','onto-agent','회사 프로세스 지도의 일 정의대로 에이전트 단계를 처리한다','일 정의의 스킬과 점검 항목을 따른다','{}')
           on conflict (id, tenant_id) do nothing`, [id, `onto-agent@${T()}`, T()])
  return id
}

// the snapshot's process definition contract (process-gpt's generation contract, saved with its own save path)
export async function contractOf(view, entry, theta, { starterRole = '담당자', key }) {
  const { nodes, flows } = unfold(view, entry, theta)
  const pid = `onto_${sha(key).slice(0, 12)}`
  const roles = new Map()
  const elements = [], forms = []
  const agent = await agentId()
  const role = (name, endpoint = '') => { if (!roles.has(name)) roles.set(name, { name, endpoint, default: endpoint, resolutionRule: endpoint ? '' : '프로세스 지도: 이 일을 해 온 역할', origin: endpoint ? 'used' : 'created' }) }
  role(starterRole)
  elements.push({ elementType: 'Event', id: 'start', name: '요청 도착', role: starterRole, type: 'StartEvent' })
  const intakeForm = `${pid}_intake_form`
  forms.push({ activity_id: 'intake', form_id: intakeForm, html: formHtml(intakeForm, '요청 접수', [{ key: 'subject', text: '제목' }, { key: 'body', text: '요청 내용', type: 'textarea' }]) })
  elements.push({ elementType: 'Activity', id: 'intake', name: '요청 접수', role: starterRole, type: 'UserActivity', tool: `formHandler:${intakeForm}`, duration: 1, inputData: [], outputData: ['요청'],
    checkpoints: [], skills: [], description: '들어온 메일 · 요청을 확인하고 이 건을 시작합니다.', instruction: '', agentMode: 'none' })
  const defs = new Map()
  for (const k of nodes) defs.set(k, await taskDefinition(k, view.tasks.get(k)))
  for (const k of nodes) {
    const t = view.tasks.get(k), d = defs.get(k)
    const id = actId(k)
    const fid = `${pid}_${id}_form`
    const runner = d.runner === 'agent'
    const r = runner ? '업무 에이전트' : (t?.role || '담당자')
    role(r, runner ? agent : '')
    forms.push({ activity_id: id, form_id: fid, html: formHtml(fid, k, [{ key: 'result', text: `${k} 결과`, type: 'textarea' }]) })
    const base = { elementType: 'Activity', id, name: k, role: r, type: 'UserActivity', tool: `formHandler:${fid}`, duration: 1, inputData: [], outputData: [k],
      checkpoints: d.checkpoints, skills: d.skills, description: d.description || '', instruction: d.instruction || '' }
    elements.push(runner ? { ...base, agent, agentMode: 'complete', orchestration: ORCH } : { ...base, agentMode: 'none' })
  }
  elements.push({ elementType: 'Event', id: 'end', name: '끝', role: starterRole, type: 'EndEvent' })
  const node = (k) => (k === END ? 'end' : actId(k))
  const seq = (source, target, extra = {}) => elements.push({ elementType: 'Sequence', id: `s_${source}_${target}`, source, target, condition: extra.condition || '', ...(extra.condition ? { name: extra.name || extra.condition } : {}), ...(extra.properties ? { properties: extra.properties } : {}) })
  seq('start', 'intake'); seq('intake', node(nodes[0]))
  // splits: two parallel siblings → AND (their links to each other dropped, a join waits for both), else XOR
  const parallel = new Map() // x → {targets, next}
  const sibling = new Set()
  for (const x of nodes) {
    const targets = flows.filter((f) => f.from === x).map((f) => f.to).filter((t) => t !== END)
    const pair = targets.length >= 2 && targets.find((a) => targets.find((b) => a !== b && view.edges.some((e) => e.from === a && e.to === b && e.parallel)))
    if (!pair) continue
    const other = targets.find((b) => b !== pair && view.edges.some((e) => e.from === pair && e.to === b && e.parallel))
    const two = [pair, other]
    const after = flows.filter((f) => two.includes(f.from) && !two.includes(f.to)).map((f) => f.to)
    const next = [...new Set(after)].sort((a, b) => after.filter((y) => y === b).length - after.filter((y) => y === a).length)[0] || END
    parallel.set(x, { targets: two, next })
    two.forEach((t) => sibling.add(t))
  }
  for (const x of nodes) {
    if (sibling.has(x)) continue
    const par = parallel.get(x)
    if (par) {
      const g = `g_and_${node(x)}`, j = `j_and_${node(x)}`
      elements.push({ elementType: 'Gateway', id: g, name: '', type: 'ParallelGateway', gateWayType: 'bpmn:parallelGateway' })
      elements.push({ elementType: 'Gateway', id: j, name: '', type: 'ParallelGateway', gateWayType: 'bpmn:parallelGateway' })
      seq(node(x), g)
      for (const a of par.targets) { seq(g, node(a)); seq(node(a), j) }
      seq(j, node(par.next))
      continue
    }
    const outs = flows.filter((f) => f.from === x)
    if (outs.length === 1) { seq(node(x), node(outs[0].to)); continue }
    const g = `g_${node(x)}`
    const best = [...outs].sort((a, b) => b.p - a.p)[0]
    const conds = outs.filter((f) => f.cond)
    elements.push({ elementType: 'Gateway', id: g, name: conds.length ? '견적 합계 기준' : `${x} 다음`, type: 'ExclusiveGateway', gateWayType: 'bpmn:exclusiveGateway' })
    seq(node(x), g)
    // a split with a learned condition uses it; without one, the most common branch is the default flow
    outs.forEach((f, i) => seq(g, node(f.to), {
      condition: conds.length ? (f.cond || '') : '',
      name: f.cond || (f === best ? `가장 흔함 ${Math.round(f.p * 100)}%` : `${Math.round(f.p * 100)}%`),
      properties: JSON.stringify({ priority: f === best ? 0 : i + 1, ...(f === best ? { default: true } : {}) }),
    }))
  }
  const els = elements
  return {
    pid, nodes, flows,
    contract: {
      type: 'process-definition-result',
      processDefinition: { processDefinitionId: pid, processDefinitionName: `${view.bundle.name} · ${entry}부터`, isHorizontal: true, data: [],
        description: `회사 프로세스 지도에서 뽑은 스냅샷(θ ${theta}, ${entry}부터). 일 ${nodes.length}개.`, roles: [...roles.values()], elements: els },
      forms,
      agents: [{ id: agent, skills: [...new Set(nodes.flatMap((k) => defs.get(k).runner === 'agent' ? defs.get(k).skills : []))] }],
      skills: [...new Set(nodes.flatMap((k) => defs.get(k).skills))],
    },
  }
}

// a snapshot for (bundle, entry, θ) as of validAt — reused when the key is the same
export async function snapshot({ bundleKey, entry, theta, validAt, starterRole }) {
  const view = await bundleGraph(bundleKey, { validAt })
  if (!view.tasks.has(entry)) throw err(400, '그 일은 이 묶음에 없어요.')
  const th = Number.isFinite(theta) ? theta : view.bundle.theta ?? 0.05
  const structural = [...view.tasks.values()].map((t) => `${t.key}:${t.pinned ? 1 : 0}:${t.status}:${t.definition_md ? sha(t.definition_md).slice(0, 6) : ''}`).join('|') +
    view.edges.map((e) => `${e.from}>${e.to}:${e.status}:${e.pinned ? 1 : 0}`).join('|')
  const week = Math.floor(new Date(validAt || Date.now()).getTime() / (7 * 86_400_000))
  const key = `${T()}|${bundleKey}|${entry}|${th}|${sha(structural).slice(0, 12)}|${week}|${starterRole || ''}`
  const [have] = await cypher(`MATCH (s:Snapshot {key:$key}) RETURN s.proc_def_id AS pid, s.tasks AS tasks`, { key })
  const cases = (await cypher(`MATCH (m:Meta {key:'meta'}) RETURN m.cases AS cases`))[0]?.cases || 1
  const isReceipt = (k) => { const t = view.tasks.get(k); return !!t?.n && (t.entry_share * cases) / t.n >= 0.9 && t.entry_share >= 0.2 }
  const skipped = skippedBefore(view.bundle, view.edges, entry).filter((k) => !isReceipt(k))
  if (have?.pid) {
    const [d] = await q('select 1 from proc_def where id=$1 and tenant_id=$2', [have.pid, T()])
    if (d) return { key, procDefId: have.pid, reused: true, nodes: have.tasks || [], skipped, theta: th, bundle: view.bundle }
  }
  const { pid, nodes, flows, contract } = await contractOf(view, entry, th, { starterRole, key })
  const saved = await saveGenerated(contract)
  const defId = saved.proc_def_id || pid
  // save_contract keeps the activities' own fields, but make sure each carries its skills, checkpoints and runner
  const byId = Object.fromEntries(contract.processDefinition.elements.filter((e) => e.elementType === 'Activity').map((e) => [e.id, e]))
  const [row] = await q('select definition from proc_def where id=$1 and tenant_id=$2', [defId, T()])
  if (row?.definition?.activities) {
    const acts = row.definition.activities.map((a) => ({ ...a, skills: byId[a.id]?.skills || [], checkpoints: byId[a.id]?.checkpoints || a.checkpoints || [], instruction: byId[a.id]?.instruction || a.instruction || '',
      ...(byId[a.id]?.agent ? { orchestration: ORCH, agentMode: 'complete', agent: byId[a.id].agent } : {}) }))
    await q(`update proc_def set definition = jsonb_set(definition, '{activities}', $3::jsonb) where id=$1 and tenant_id=$2`, [defId, T(), JSON.stringify(acts)])
  }
  // (two statements: Ontological does not take MERGE … WITH … MERGE of a relationship in one)
  await cypher(`MERGE (s:Snapshot {key:$key}) ON CREATE SET s.bundle=$bundle, s.entry=$entry, s.theta=$theta, s.made_at=$at, s.onto_at=$onto, s.proc_def_id=$pid, s.tasks=$tasks
                ON MATCH SET s.bundle=$bundle, s.entry=$entry, s.theta=$theta, s.made_at=$at, s.onto_at=$onto, s.proc_def_id=$pid, s.tasks=$tasks`,
  { key, bundle: bundleKey, entry, theta: th, at: isoDay(), onto: validAt || isoDay(), pid: defId, tasks: nodes })
  const [linked] = await cypher('MATCH (b:Bundle {key:$bundle})-[r:HAS_SNAPSHOT]->(s:Snapshot {key:$key}) RETURN s.key AS key', { bundle: bundleKey, key })
  if (!linked) await cypher('MATCH (b:Bundle {key:$bundle}), (s:Snapshot {key:$key}) CREATE (b)-[:HAS_SNAPSHOT]->(s)', { bundle: bundleKey, key }).catch((e) => console.warn('[ontology] snapshot link', e.message))
  return { key, procDefId: defId, reused: false, nodes, flows, skipped, theta: th, bundle: view.bundle }
}

// ---------- the start task ----------
// the request's text → which task it starts at: the model's first-token odds over the bundle's tasks, weighted by how
// often cases start there (smoothed); unsure (top < 0.5) → the person picks from the two best
export async function chooseEntry({ subject = '', text = '', bundleKey } = {}) {
  const g = await readGraph({})
  const bundles = g.bundles.filter((b) => (bundleKey ? b.key === bundleKey : b.status === 'adopted'))
  if (!bundles.length) return null
  const inBundles = (k) => bundles.some((b) => b.tasks.includes(k))
  const all = g.tasks.filter((t) => inBundles(t.key) && t.status !== 'retired' && !t.candidate)
  // the receipt (a task that is nearly always a case's first step, like 요청 메일 접수) is what every snapshot opens with
  // (요청 접수): the choice is the first work after it
  const cases = g.meta?.cases || 1
  const receipt = new Set(all.filter((t) => t.n && (t.entry_share * cases) / t.n >= 0.9 && t.entry_share >= 0.2).map((t) => t.key))
  const cand = all.filter((t) => !receipt.has(t.key))
  const after = (k) => cand.find((t) => t.key === k)?.entry_share || 0
  const prior = new Map(cand.map((t) => [t.key, after(t.key)]))
  for (const r of receipt) {
    const rs = all.find((t) => t.key === r)?.entry_share || 0
    for (const e of g.edges.filter((x) => x.from === r && prior.has(x.to))) prior.set(e.to, prior.get(e.to) + rs * e.p)
  }
  const options = cand.map((t) => ({ key: t.key, label: `${t.key}${t.role ? ` (${t.role})` : ''}` }))
  const state = `회사에 들어온 요청\n제목: ${String(subject).slice(0, 200)}\n내용: ${String(text).slice(0, 1500)}`
  const question = '이 요청을 받은 회사가 이어서 처음 해야 할 일은 무엇인가? 고객이 이미 끝난 앞 단계는 다시 하지 않는다.'
  const read = await oddsOf(state, question, options).catch(() => null)
  let probs
  if (read?.probabilities) probs = read.probabilities
  else {
    // no log-probabilities from this model: the model names one, without odds (marked as such)
    const r = await chatJson('JSON {"task"} 로만 답하세요. ' + question, JSON.stringify({ request: state, tasks: options.map((o) => o.key) }), { temperature: 0 }).catch(() => ({}))
    probs = Object.fromEntries(options.map((o) => [o.key, o.key === r.task ? 0.6 : 0.4 / Math.max(1, options.length - 1)]))
  }
  // the model's reading weighted by how often that work came first after a receipt (smoothed)
  const w = options.map((o) => ({ task: o.key, p: (probs[o.key] || 0) * ((prior.get(o.key) || 0) + 0.05) }))
  const sum = w.reduce((s2, x) => s2 + x.p, 0) || 1
  const ranked = w.map((x) => ({ ...x, p: x.p / sum })).sort((a, b) => b.p - a.p)
  const top = ranked[0]
  const bundle = bundles.find((b) => b.tasks.includes(top.task))
  return { task: top.task, p: top.p, ask: top.p < 0.5, options: ranked.slice(0, 3), bundle: bundle?.key, bundleName: bundle?.name, measured: !!read?.probabilities, receipt: [...receipt] }
}

// ---------- cases ----------
async function roleOfPerson(userId) {
  const [r] = await q(`select role from pro_role_assignments where tenant_id=$1 and proc_def_id='*' and user_id::text=$2 limit 1`, [T(), String(userId)])
  return r?.role || '담당자'
}

export async function startCase(me, { bundleKey, entry, subject = '', body = '', from = '', customer = '', odds = null, kind = 'manual', validAt }) {
  if (!ontologyEnabled()) throw err(503, 'Ontological DB 가 연결되지 않았어요.')
  const starterRole = await roleOfPerson(me.id)
  const snap = await snapshot({ bundleKey, entry, starterRole, validAt })
  const { startProcess } = await import('../engine.js')
  const values = { subject, body: String(body).slice(0, 3000), customer, sender: from }
  const [c] = await q(`insert into pro_po_cases (tenant_id, bundle, entry_task, started_by, trigger, entry_odds, snapshots, history)
                       values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [T(), bundleKey, entry, me.id, { kind, subject, from, customer }, odds, [snap.procDefId],
    JSON.stringify(snap.skipped.map((t) => ({ task: t, state: 'skipped', at: isoDay() })))])
  const { instId, instName } = await startProcess({ me, defId: snap.procDefId, values })
  await q(`update pro_po_cases set instances = array_append(instances, $2), updated_at=now() where id=$1`, [c.id, instId])
  return { caseId: c.id, instId, instName, snapshot: snap }
}

export async function getCase(id) {
  const [c] = await q('select * from pro_po_cases where id=$1 and tenant_id=$2', [id, T()])
  if (!c) throw err(404, '건을 찾지 못했어요.')
  const insts = c.instances.length ? await q(`select proc_inst_id, proc_inst_name, status, proc_def_id from bpm_proc_inst where proc_inst_id = any($1)`, [c.instances]) : []
  const todos = c.instances.length ? await q(`select id, proc_inst_id, activity_id, activity_name, status::text as status, user_id, agent_orch, end_date from todolist where proc_inst_id = any($1) order by start_date nulls last`, [c.instances]) : []
  return { ...c, instancesInfo: insts, todos }
}

// 옮기기: the case continues at `task` — the running instance is closed (its open work items cancelled) and a new
// snapshot from `task` takes over; the move is a fact the next build learns from (a todolist handover)
export async function moveCase(me, id, { task, reason = '' }) {
  const c = await getCase(id)
  const cur = c.instances.at(-1)
  if (cur) {
    await q(`update todolist set status='CANCELLED' where proc_inst_id=$1 and status::text not in ('DONE','CANCELLED')`, [cur])
    await q(`update bpm_proc_inst set status='COMPLETED' where proc_inst_id=$1`, [cur])
  }
  const starterRole = await roleOfPerson(me.id)
  const snap = await snapshot({ bundleKey: c.bundle, entry: task, starterRole })
  const { startProcess } = await import('../engine.js')
  const { instId, instName } = await startProcess({ me, defId: snap.procDefId, values: { subject: c.trigger?.subject || '', body: `${reason ? `옮긴 이유: ${reason}\n` : ''}`, customer: c.trigger?.customer || '' } })
  await q(`update pro_po_cases set instances = array_append(instances, $2), snapshots = array_append(snapshots, $3),
           history = history || $4::jsonb, updated_at=now() where id=$1`, [id, instId, snap.procDefId, JSON.stringify([{ task, state: 'moved', at: isoDay(), reason }])])
  await q(`insert into handover_events (tenant_id, case_id, source, is_explicit, from_user_id, from_user_name, to_user_id, activity_label, next_activity_label, reason, occurred_at)
           values ($1,$2,'todolist',true,$3,$4,$3,$5,$5,$6,now())`, [T(), `onto:${id}`, String(me.id), me.email || '', task, reason || '옮기기']).catch((e) => console.warn('[ontology] move event', e.message))
  return { caseId: id, instId, instName, snapshot: snap }
}

// ---------- mail: an adopted bundle takes the mail first (lib/mail.js), else process mining's registered flows ----------
export async function routeMail(userId, mail) {
  if (!ontologyEnabled()) return false
  const g = await readGraph({}).catch(() => null)
  if (!g?.bundles.some((b) => b.status === 'adopted')) return false
  const choice = await chooseEntry({ subject: mail.subject, text: mail.text })
  if (!choice) return false
  const [p] = await q('select email, name from pro_profile where user_id=$1', [userId])
  if (!p?.email) return false
  const me = { id: userId, email: p.email }
  const t = await mainThread(userId)
  const customer = String(mail.from || '').split('<')[0].trim() || '고객'
  if (choice.ask) {
    await addMessage(userId, t.id, 'agent', 'onto-entry', { state: 'ask', mail: { from: mail.from, subject: mail.subject, text: String(mail.text || '').slice(0, 1500) }, customer, choice })
    return { asked: true }
  }
  const r = await startCase(me, { bundleKey: choice.bundle, entry: choice.task, subject: mail.subject, body: mail.text, from: mail.from, customer, odds: choice, kind: 'mail' })
  await addMessage(userId, t.id, 'agent', 'onto-entry', { state: 'started', mail: { from: mail.from, subject: mail.subject }, customer, choice, caseId: r.caseId, instId: r.instId,
    skipped: r.snapshot.skipped, nodes: r.snapshot.nodes, procDefId: r.snapshot.procDefId })
  await addMessage(userId, t.id, 'agent', 'process', { defId: r.snapshot.procDefId, name: r.instName, state: 'started', instId: r.instId, instName: r.instName })
  return { instId: r.instId, caseId: r.caseId }
}

// ---------- agent steps (orchestration pgpt-pro-onto) ----------
async function checkOutputs(checkpoints, file) {
  if (!checkpoints?.length || !file?.url) return []
  let text = ''
  try {
    const ExcelJS = (await import('exceljs')).default
    const buf = Buffer.from(await (await fetch(file.url)).arrayBuffer())
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf)
    wb.eachSheet((ws) => ws.eachRow((row) => { text += row.values.filter((v) => v != null).map((v) => (typeof v === 'object' ? (v.result ?? v.text ?? v.formula ?? '') : v)).join(' | ') + '\n' }))
  } catch (e) { text = '' }
  if (!text) return checkpoints.map((c) => ({ checkpoint: c, ok: null, note: '파일을 읽지 못했어요' }))
  try {
    const r = await chatJson('산출물이 점검 항목을 지키는지 봅니다. JSON {"results":[{"i":번호,"ok":true|false,"note":"근거 한 줄"}]} 로만 답하세요.', JSON.stringify({ checkpoints: checkpoints.map((c, i) => ({ i, c })), output: text.slice(0, 6000) }), { temperature: 0, timeoutMs: 60000 })
    return checkpoints.map((c, i) => { const x = (r.results || []).find((y) => Number(y.i) === i) || {}; return { checkpoint: c, ok: x.ok === true ? true : x.ok === false ? false : null, note: String(x.note || '') } })
  } catch { return checkpoints.map((c) => ({ checkpoint: c, ok: null, note: '점검하지 못했어요' })) }
}

let busy = false
const CONSUMER = `pgpt-pro-onto-${process.pid}`
async function tick() {
  if (busy) return
  busy = true
  try {
    const { data, error } = await admin.rpc('fetch_pending_task', { p_agent_orch: ORCH, p_consumer: CONSUMER, p_limit: 1, p_env: 'dev' })
    if (error) throw new Error(error.message)
    const row = data?.[0]
    if (!row) return
    const { servesTenant, withTenant } = await import('../tenant.js')
    if (!servesTenant(row.tenant_id)) { await admin.from('todolist').update({ draft_status: null, consumer: null }).eq('id', row.id); return }
    console.log('[onto-worker] claimed', row.id, row.activity_name)
    await withTenant(row.tenant_id, () => runStep(row)).catch(async (e) => {
      console.warn('[onto-worker] failed', e.message)
      await admin.from('todolist').update({ draft_status: 'FAILED', consumer: null }).eq('id', row.id)
    })
  } catch (e) { console.warn('[onto-worker]', e.message) } finally { busy = false }
}

async function runStep(row) {
  const W = await import('../mining/worker.js')
  const job = crypto.randomUUID()
  const base = { job_id: job, todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: ORCH }
  const [a] = await q(`select a as act from proc_def, jsonb_array_elements(definition->'activities') a where id=$1 and tenant_id=$2 and a->>'id'=$3`, [row.proc_def_id, row.tenant_id, row.activity_id])
  const act = a?.act || {}
  const owner = await W.ownerOf(row)
  if (!owner) throw new Error('no human participant to act for')
  const threadId = await W.instanceThread(owner, row.proc_inst_id)
  const status = (text) => emit(owner, 'status', { threadId, text })
  const skill = (act.skills || []).find((k) => W.SKILLS[k])
  await W.events([{ ...base, event_type: 'task_started', data: { goal: `${row.activity_name} — 일 정의(스킬 ${(act.skills || []).join(', ') || '없음'} · 점검 ${(act.checkpoints || []).length}개)`, name: '업무 에이전트', role: row.activity_name } }])
  let r
  try {
    if (skill) r = await W.SKILLS[skill]({ owner, threadId, prev: await W.earlier(row.proc_inst_id), status })
    else {
      const { delegate } = await import('../agent.js')
      const { sessionFor } = await import('../supa.js')
      const [p] = await q('select email, name from pro_profile where user_id=$1', [owner])
      const { user, session } = await sessionFor(p.email, p.name)
      const prev = await W.earlier(row.proc_inst_id)
      const msg = await delegate({ user, session, threadId, silent: true, text: `프로세스의 '${row.activity_name}' 단계예요. ${act.instruction || act.description || ''}\n앞 단계 값: ${JSON.stringify(prev).slice(0, 2000)}\n점검 항목: ${(act.checkpoints || []).join(' / ')}\n쓸 스킬: ${(act.skills || []).join(', ')}` })
      r = { values: { result: String(msg?.content?.text || '').slice(0, 3000) }, say: null }
    }
  } finally { status(null) }
  const checks = await checkOutputs(act.checkpoints || [], r.values.quote || r.values.proposal || null)
  const values = { ...r.values, ...(checks.length ? { checkpoints: checks } : {}) }
  const formId = (act.tool || '').startsWith('formHandler:') ? act.tool.slice(12) : `${row.activity_id}_form`
  const payload = { [formId]: values }
  const { error } = await admin.rpc('save_task_result', { p_todo_id: row.id, p_payload: payload, p_final: true })
  if (error) throw new Error('save_task_result: ' + error.message)
  await W.events([
    { ...base, crew_type: 'result', event_type: 'task_completed', data: payload },
    { job_id: 'CREW_FINISHED', todo_id: row.id, proc_inst_id: row.proc_inst_id, crew_type: 'crew', event_type: 'crew_completed', data: 'Task completed successfully' },
  ])
  const passed = checks.filter((c) => c.ok === true).length
  const amount = values.amount ? ` 합계 ${fmtWon(Number(values.amount))}원.` : ''
  await addMessage(owner, threadId, 'agent', 'text', { text: `업무 에이전트 · ${row.activity_name}: 일 정의대로 만들었어요.${amount}${checks.length ? ` 점검 항목 ${checks.length}개 중 ${passed}개 통과.` : ''}`, checks })
  emit(owner, 'process', { instId: row.proc_inst_id, type: 'changed' })
}

export function startOntologyWorker() {
  if (!ontologyEnabled() || process.env.PRO_ONTOLOGY_WORKER === '0') return
  setInterval(tick, 4000)
  setInterval(() => sweepCases().catch(() => {}), 5000)
  console.log(`[onto-worker] polling agent_orch=${ORCH} as ${CONSUMER}`)
}

// ---------- 습관: when a case's snapshot runs out (an open-band case, one step at a time), the most common next task
// is asked about — "지난번처럼 재무 검토로 넘길까요?" — when the person is more likely to say yes than no (calibrated
// on earlier answers; the follow-up habit's bar 0.5 until there are 20 answers) ----------
export async function habitFor(caseId) {
  const c = await getCase(caseId)
  const done = c.todos.filter((t) => t.status === 'DONE' && t.activity_id !== 'intake').at(-1)
  if (!done) return null
  const view = await bundleGraph(c.bundle)
  const outs = view.edges.filter((e) => e.from === done.activity_name && e.to !== END && e.status !== 'retired').sort((a, b) => b.p - a.p)
  if (!outs.length) return null
  const { calibrate } = await import('./stats.js')
  const answers = await q(`select p, accepted from pro_onto_answers where tenant_id=$1 order by created_at desc limit 200`, [T()])
  const cal = calibrate(answers)
  const top = outs[0]
  const accept = cal ? cal.accept(top.p) : top.p
  return { from: done.activity_name, to: top.to, p: top.p, accept, calibrated: !!cal, ask: accept >= 0.5, others: outs.slice(1, 3).map((e) => ({ to: e.to, p: e.p })) }
}

export async function answerHabit(me, caseId, { to, accepted, p, from }) {
  await q(`insert into pro_onto_answers (tenant_id, user_id, case_id, from_task, to_task, p, accepted) values ($1,$2,$3,$4,$5,$6,$7)`, [T(), me.id, caseId, from || '', to, Number(p) || 0, !!accepted])
  if (!accepted) return { moved: false }
  return { moved: true, ...(await moveCase(me, caseId, { task: to, reason: '지난번처럼(습관)' })) }
}

// a running case whose current instance has finished: ask the habit question once
const asked = new Set()
async function checkCases() {
  const rows = await q(`select c.id, c.started_by, c.instances, i.status from pro_po_cases c join bpm_proc_inst i on i.proc_inst_id = c.instances[array_length(c.instances,1)]
                        where c.tenant_id=$1 and c.status='running' and i.status='COMPLETED' and c.updated_at > now() - interval '2 days' limit 5`, [T()])
  for (const r of rows) {
    const k = `${r.id}:${r.instances.length}`
    if (asked.has(k)) continue
    asked.add(k)
    const h = await habitFor(r.id).catch(() => null)
    if (!h) { await q(`update pro_po_cases set status='done', updated_at=now() where id=$1`, [r.id]); continue }
    const t = await mainThread(r.started_by)
    await addMessage(r.started_by, t.id, 'agent', 'onto-habit', { caseId: r.id, ...h, state: h.ask ? 'ask' : 'quiet' })
    emit(r.started_by, 'ontology', { caseId: r.id, habit: h })
  }
}
export async function sweepCases() {
  const { tenants, withTenant } = await import('../tenant.js')
  for (const t of tenants()) await withTenant(t, () => checkCases()).catch((e) => console.warn('[onto-worker] cases', e.message))
}
