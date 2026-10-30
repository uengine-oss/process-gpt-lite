// Before / after for the purchase scenario (plan.md §5 P2 "끝났다고 보는 기준"): approval wait and lead time of the
// seeded history (no briefs) against the instances that ran with briefs and speculative preparation, both from the
// same lead-time decomposition (lib/improve/leadtime.js through analyze.js: wait = queue + review wait before the
// assignee started), next to what the what-if model predicted for a '사전 초안'. A PoC on seeded data: the "after"
// instances are the ones the E2E (or a demo) ran, with people acting within seconds — they show the mechanics,
// not how fast real approvers would be.
import { q } from '../../supa.js'
import { config } from '../../../config.js'
import { liveModel, predicted } from '../../improve/live.js'
import { percentile, mean } from '../../improve/analyze.js'
import { DEF_ID, ACT, SEED_MARK } from './process.js'

const T = () => config.tenantId
const stat = (v) => {
  const xs = v.filter((x) => Number.isFinite(x))
  return { n: xs.length, median: xs.length ? Math.round(percentile(xs, 0.5)) : null, p80: xs.length ? Math.round(percentile(xs, 0.8)) : null, mean: xs.length ? Math.round(mean(xs)) : null }
}

function group(m, ids) {
  const insts = m.a.instances.filter((i) => ids.has(i.id) && i.status === 'COMPLETED')
  const done = new Set(insts.map((i) => i.id))
  const ex = (act) => m.a.executions.filter((x) => done.has(x.instId) && x.activityId === act && x.done && x.seq === 0)
  const perInst = (acts, k) => [...done].map((id) => m.a.executions.filter((x) => x.instId === id && acts.includes(x.activityId) && x.done).reduce((s, x) => s + x[k], 0))
  return {
    instances: insts.length,
    leadTime: stat(insts.map((i) => i.leadSec)),
    approvalWait: { perInstance: stat(perInst([ACT.lead, ACT.finance], 'wait')), lead: stat(ex(ACT.lead).map((x) => x.wait)), finance: stat(ex(ACT.finance).map((x) => x.wait)) },
    approvalWork: { lead: stat(ex(ACT.lead).map((x) => x.work)), finance: stat(ex(ACT.finance).map((x) => x.work)) },
    order: { wait: stat(ex(ACT.order).map((x) => x.wait)), work: stat(ex(ACT.order).map((x) => x.work)) },
  }
}

export async function measure() {
  const m = await liveModel(DEF_ID, { fresh: true })
  const seeded = new Set((await q(`select proc_inst_id from bpm_proc_inst where lower(proc_def_id)=$1 and tenant_id=$2 and variables_data @> $3::jsonb`, [DEF_ID, T(), JSON.stringify(SEED_MARK)])).map((r) => r.proc_inst_id))
  const briefed = new Set((await q(`select distinct proc_inst_id from pro_decision_briefs where tenant_id=$1 and brief->>'defId'=$2 and brief->>'state'='ready'`, [T(), DEF_ID])).map((r) => r.proc_inst_id).filter((id) => !seeded.has(id)))
  const one = (step) => predicted(m, [{ type: 'predraft', step, saving: 0.5 }])
  return {
    before: { label: 'seeded history (no briefs)', ...group(m, seeded) },
    after: { label: 'run with briefs + speculative preparation', ...group(m, briefed) },
    prediction: {
      note: "what-if '사전 초안' (work of the step −50%) on the seeded model; queue waits only change for capacity-bound people",
      all: predicted(m, [ACT.lead, ACT.finance, ACT.order].map((step) => ({ type: 'predraft', step, saving: 0.5 }))),
      lead: one(ACT.lead), finance: one(ACT.finance), order: one(ACT.order),
    },
    targetSec: m.targetSec ? Math.round(m.targetSec) : null,
    caveat: 'PoC on seeded data: the "after" instances were run by a script (approvers act within seconds), so their waits show the mechanics, not real behaviour.',
  }
}
