// 사람 착수 신호. process-gpt 엔진은 사람 단계에 도달하는 순간 작업 항목을 IN_PROGRESS 로 바꾸므로, 상태 전이
// 이력만으로는 담당자가 언제 손을 댔는지 모른다. 담당자가 그 작업 항목을 처음 열 때 events 에 human_checked 를
// 한 번 남긴다(리드타임 분해가 이 시각을 사람 착수로 쓴다 — lib/improve/leadtime.js 확장 2).
import crypto from 'node:crypto'
import { q } from '../supa.js'

export async function markOpened(todo, me) {
  if (!todo || todo.agent_orch || !['IN_PROGRESS', 'TODO', 'NEW'].includes(todo.status)) return false
  const ids = String(todo.user_id || '')
  if (!ids.includes(String(me.id)) && !(me.email && ids.includes(me.email))) return false
  if (todo.status !== 'IN_PROGRESS') {
    const [i] = await q('select current_activity_ids from bpm_proc_inst where proc_inst_id=$1', [todo.proc_inst_id])
    if (!(i?.current_activity_ids || []).includes(todo.activity_id)) return false
  }
  const [hit] = await q(`select 1 from events where todo_id=$1 and event_type='human_checked' limit 1`, [String(todo.id)])
  if (hit) return false
  await q(`insert into events (id, job_id, todo_id, proc_inst_id, event_type, crew_type, data, timestamp, tenant_id) values ($1,$2,$3,$4,'human_checked','pgpt-pro',$5,now(),$6)`,
    [crypto.randomUUID(), `opened:${todo.id}`, String(todo.id), todo.proc_inst_id, { by: me.name || me.email, opened: true }, todo.tenant_id])
  return true
}
