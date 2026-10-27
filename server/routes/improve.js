// HTTP routes for 프로세스 개선 (lib/improve/*): 병목·가치 흐름·제약·크리티컬 패스, what-if, 개선 적용, 버전 비교.
import express from 'express'
import { q } from '../lib/supa.js'
import { config } from '../config.js'
import * as S from '../lib/improve/service.js'
import { applyImprovement } from '../lib/improve/apply.js'

const send = (res, p) => p.then((x) => res.json(x)).catch((e) => {
  if (!e.status) console.warn('[improve]', e.stack || e.message)
  res.status(e.status || 500).json({ error: e.message })
})

export function improveRoutes(auth) {
  const r = express.Router()
  // processes with a history to analyse (the ones this person may look at)
  r.get('/improve', auth, (req, res) => send(res, (async () => {
    const admin = await S.isAdmin(req.user)
    const rows = await q(`select d.id, d.name, d.owner, count(i.*)::int as instances, count(i.*) filter (where i.status='COMPLETED')::int as completed, max(i.updated_at) as last_at,
                                 s.step_name, s.resource_name, s.rho, s.wait_share, s.detected_at
                          from proc_def d join bpm_proc_inst i on lower(i.proc_def_id)=lower(d.id) and i.tenant_id=d.tenant_id and not coalesce(i.is_deleted,false)
                          left join pro_improve_state s on s.tenant_id=d.tenant_id and s.proc_def_id=d.id
                          where d.tenant_id=$1 and not coalesce(d.isdeleted,false)
                            and ($2 or d.owner=$3 or exists (select 1 from todolist t where t.proc_inst_id=i.proc_inst_id and (t.user_id like '%'||$3||'%' or t.user_id like '%'||$4||'%')))
                          group by d.id, d.name, d.owner, s.step_name, s.resource_name, s.rho, s.wait_share, s.detected_at
                          order by count(i.*) filter (where i.status='COMPLETED') desc, max(i.updated_at) desc nulls last limit 50`, [config.tenantId, admin, String(req.user.id), req.user.email || '(none)'])
    return rows
  })()))
  r.get('/improve/:defId', auth, (req, res) => send(res, S.overview(req.user, req.params.defId, { version: req.query.version, basis: req.query.basis })))
  r.get('/improve/:defId/instances/:instId', auth, (req, res) => send(res, S.instance(req.user, req.params.defId, req.params.instId)))
  r.post('/improve/:defId/whatif', auth, (req, res) => send(res, S.simulateChanges(req.user, req.params.defId, req.body || {})))
  r.post('/improve/:defId/apply', auth, (req, res) => send(res, applyImprovement(req.user, req.params.defId, req.body || {})))
  // the diagram of the version being analysed (process-gpt keeps each version's BPMN as its snapshot)
  r.get('/improve/:defId/bpmn', auth, async (req, res) => {
    try {
      await S.access(req.user, req.params.defId)
      const v = req.query.version && req.query.version !== 'all' ? String(req.query.version) : null
      const [row] = v ? await q(`select snapshot as xml from proc_def_version where lower(proc_def_id)=lower($1) and tenant_id=$2 and version=$3 and coalesce(snapshot,'')<>'' order by "timeStamp" desc limit 1`, [req.params.defId, config.tenantId, v])
        : await q(`select bpmn as xml from proc_def where lower(id)=lower($1) and tenant_id=$2`, [req.params.defId, config.tenantId])
      return row?.xml ? res.type('application/xml').send(row.xml) : res.status(404).end()
    } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
  })
  r.get('/improve/:defId/compare', auth, (req, res) => send(res, S.compare(req.user, req.params.defId)))
  return r
}
