// 「개선안 적용」 — 바꾼 정의를 Lite 가 프로세스를 저장하는 바로 그 길(lib/generated.js → process-gpt
// save_contract + bpmn_xml_generator)로 저장하고, process-gpt 화면의 저장 버튼처럼 proc_def_version 에 새 버전
// (snapshot = 새 BPMN, definition, message, parent_version)을 남긴다. 엔진은 다음 인스턴스부터 새 정의를 쓰고
// 인스턴스에 새 arcv_id 를 찍으므로 버전별 전후 비교가 된다. 바꾼 단계에는 process-gpt 의 PI Flag
// (uengine:properties comments, status 'resolved' = 즉시 개선)를 남겨 PiFlagBoard 에서도 보인다.
import crypto from 'node:crypto'
import { q } from '../supa.js'
import { config } from '../../config.js'
import { saveGenerated } from '../generated.js'
import { access, load, versions, err } from './service.js'
import { resources } from './toc.js'
import { skipShare } from './focus.js'
import { whatIf } from './whatif.js'
import { changesDefinition, describeChange } from './transform.js'

const T = () => config.tenantId

// an agent for a step that is automated (or pre-drafted): one per process step, made once
async function agentFor(defId, act, kind) {
  const alias = `pro-improve-${defId}-${act.id}-${kind}`.slice(0, 120)
  const [have] = await q('select id::text as id, username from users where tenant_id=$1 and alias=$2 and is_agent', [T(), alias])
  if (have) return { id: have.id, name: have.username }
  const id = crypto.randomUUID()
  const name = kind === 'draft' ? `${act.name} 보조 에이전트` : `${act.name} 에이전트`
  const goal = kind === 'draft' ? `'${act.name}' 담당자가 확인만 하면 되도록 앞 단계 산출물을 점검해 초안을 채워요.` : `앞 단계 산출물로 '${act.name}' 을(를) 처리해요.`
  await q(`insert into users (id, username, email, tenant_id, is_agent, is_admin, is_draft, agent_type, alias, goal, persona, permission_ids)
           values ($1,$2,$3,$4,true,false,false,'agent',$5,$6,$7,'{}')`, [id, name, `${alias}@${T()}`, T(), alias, goal, '숫자와 조건이 맞지 않는 곳만 짚어요.'])
  return { id, name }
}

const props = (s) => { try { return typeof s === 'string' ? JSON.parse(s || '{}') : (s || {}) } catch { return {} } }

export async function applyImprovement(me, defId, { changes = [], confirm = false, message = '', basis = 'median' } = {}) {
  const acc = await access(me, defId)
  if (!acc.canApply) throw err(403, '프로세스 담당자(소유자)나 관리자만 개선안을 적용할 수 있어요.')
  if (!confirm) throw err(400, '적용 전에 확인이 필요해요(confirm: true).')
  if (!changes.length) throw err(400, '적용할 개선안이 없어요.')
  if (!changesDefinition(changes)) throw err(400, '고른 개선안은 프로세스 정의를 바꾸지 않아요(인원 추가·보완 줄이기는 팀·역할과 앞 단계 지시에서).')
  const vs = await versions(defId)
  const { d, a, labels } = await load(defId, { version: [...vs].reverse().find((v) => v.completed >= 10)?.version || 'all' })
  const res = resources(a)
  const share = {}
  for (const c of changes) if (c.type === 'skip') { c.threshold = Number(c.threshold); c.label ||= labels[c.field] || c.field; share[c.step] = skipShare(a, c.step, c.field, c.threshold).share }
  // agents for automated / pre-drafted steps
  const agents = {}
  for (const c of changes) {
    if (c.type !== 'automate' && c.type !== 'predraft') continue
    const act = (d.definition.activities || []).find((x) => x.id === c.step)
    if (act) agents[c.step] = await agentFor(d.id, act, c.type === 'predraft' ? 'draft' : 'complete')
  }
  const r = whatIf(a, res, changes, { basis, share, agentFor: (step) => agents[step] })
  const def = r.def
  for (const c of changes) {
    if (c.type === 'predraft' && agents[c.step]) { const x = def.activities.find((y) => y.id === c.step); if (x) x.agent = agents[c.step].id }
  }
  const prev = vs.at(-1)
  const nextMajor = Math.max(0, ...vs.map((v) => parseInt(String(v.version), 10) || 0)) + 1
  const version = `${nextMajor}.0`
  // PI Flag on each changed step (process-gpt PiFlagPanel's comment shape)
  const now = new Date().toISOString()
  const groupId = crypto.randomUUID()
  for (const c of changes) {
    const x = def.activities.find((y) => y.id === c.step)
    if (!x) continue
    const p = props(x.properties)
    p.comments = [...(p.comments || []), { id: crypto.randomUUID(), groupId, status: 'resolved', type: '개선 적용', description: `v${version}: ${describeChange(c, a.g.def)} — 예상 리드타임 ${Math.round(r.before.leadSec / 360) / 10}시간 → ${Math.round(r.after.leadSec / 360) / 10}시간`, authorName: me.name || me.email, createdAt: now }]
    x.properties = JSON.stringify(p)
  }
  const forms = await q('select id, activity_id, html from form_def where lower(proc_def_id)=lower($1) and tenant_id=$2', [d.id, T()])
  const contract = {
    type: 'process-definition-result',
    processDefinition: { ...def, processDefinitionId: d.id, processDefinitionName: d.name, description: def.description || d.description || '' },
    forms: forms.map((f) => ({ activity_id: f.activity_id, form_id: f.id, html: f.html })),
    agents: Object.values(agents).map((x) => ({ id: x.id, skills: [] })),
    skills: [],
  }
  const saved = await saveGenerated(contract)
  const [row] = await q('select bpmn, definition from proc_def where id=$1 and tenant_id=$2', [d.id, T()])
  const arcv = `${d.id}_${version}`
  const msg = message || `[개선] ${changes.map((c) => describeChange(c, a.g.def)).join(' / ')}`
  await q(`insert into proc_def_version (arcv_id, proc_def_id, version, version_tag, "timeStamp", snapshot, definition, diff, message, tenant_id, parent_version, is_draft, owner)
           values ($1,$2,$3,'major',now(),$4,$5,$6,$7,$8,$9,false,$10)`,
  [arcv, d.id, version, row?.bpmn || null, row?.definition || def, JSON.stringify(changes), msg, T(), prev?.arcv_id || null, String(me.id)])
  const predicted = { before: { leadSec: r.before.leadSec, flowEfficiency: r.before.flowEfficiency, path: r.before.path }, after: { leadSec: r.after.leadSec, flowEfficiency: r.after.flowEfficiency, path: r.after.path } }
  const [run] = await q(`insert into pro_improve_runs (tenant_id, proc_def_id, from_version, to_version, arcv_id, changes, predicted, notes, applied_by)
                         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [T(), d.id, prev?.version || null, version, arcv, JSON.stringify(r.changes), predicted, JSON.stringify(r.notes), me.id])
  console.log(`[improve] ${d.id} → v${version} by ${me.email}: ${msg}`)
  return { version, arcv_id: arcv, message: msg, saved: { proc_def: saved.proc_def, forms_saved: saved.forms_saved, bpmn_bytes: saved.bpmn_bytes }, predicted, notes: r.notes, run }
}
