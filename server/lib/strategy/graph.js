// The strategy graph, Lite's local copy (process-gpt services/strategy keeps the real one in a Postgres with
// Apache AGE; an install without it uses these tables, and the shape follows that service: BSC perspectives,
// objectives in a DAG, a KPI each). Added for the optimizer (plan.md §4): an objective's priority, its risk
// appetite per policy category, the constraints it holds (policies that must / should hold), and links from
// process steps, product features and policies to the objectives they serve or protect.
import { q } from '../supa.js'
import { config } from '../../config.js'

const T = () => config.tenantId
export const PRIORITY_WEIGHT = { 1: 1, 2: 0.7, 3: 0.45, 4: 0.25, 5: 0.1 }
export const APPETITE = { low: 0.2, medium: 0.6, high: 1 }   // how much risk of a category the company accepts

export async function graphOf(tenant = T()) {
  const objectives = await q(`select id, perspective, name, priority, risk_appetite, constraints, kpi, parent from pro_strategy_objectives
    where tenant_id=$1 order by priority, id`, [tenant])
  const links = await q('select source, objective, relation, weight::float8 from pro_strategy_links where tenant_id=$1 order by objective, source', [tenant])
  return { objectives, links }
}

export async function saveObjective(o, tenant = T()) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.id || '')) throw Object.assign(new Error('id: lower-case words joined by -'), { status: 400 })
  await q(`insert into pro_strategy_objectives(tenant_id, id, perspective, name, priority, risk_appetite, constraints, kpi, parent)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (tenant_id, id) do update set perspective=$3, name=$4, priority=$5, risk_appetite=$6, constraints=$7, kpi=$8, parent=$9`,
  [tenant, o.id, o.perspective || 'customer', o.name, o.priority || 3, o.risk_appetite || {}, JSON.stringify(o.constraints || []), o.kpi || null, o.parent || null])
}

export async function saveLink(l, tenant = T()) {
  await q(`insert into pro_strategy_links(tenant_id, source, objective, relation, weight) values ($1,$2,$3,$4,$5)
    on conflict (tenant_id, source, objective, relation) do update set weight=$5`, [tenant, l.source, l.objective, l.relation || 'contributes', l.weight ?? 1])
}

export async function removeObjective(id, tenant = T()) {
  await q('delete from pro_strategy_links where tenant_id=$1 and objective=$2', [tenant, id])
  await q('delete from pro_strategy_objectives where tenant_id=$1 and id=$2', [tenant, id])
}

// the policies objectives hold as constraints: {policyId: {level: 'must'|'should', objectives: [...]}}
export function constraintsOf(graph) {
  const out = {}
  for (const o of graph.objectives) {
    for (const c of o.constraints || []) {
      const e = (out[c.policy] ||= { level: 'should', objectives: [] })
      if (c.level === 'must') e.level = 'must'
      e.objectives.push(o.id)
    }
  }
  return out
}
