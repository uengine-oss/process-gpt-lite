// Agent steps that stopped on an error. process-gpt's agent SDK marks a step that threw
// todolist.draft_status='FAILED' and never picks it up again, so the instance waits forever. When
// the error was a passing one (database in recovery mode, a dropped connection, a gateway or model
// timeout — or no error was even recorded because the database was down), this server queues the
// step again the way process-gpt queues new work (draft_status back to NULL), a few times and
// further apart each time. After that, or for an error that is not passing, the person who started
// the instance hears about it (Home card) and the instance page offers 「다시 시도」.
import { config } from '../config.js'
import { q, eachTenant } from './supa.js'
import { emit } from './bus.js'

const T = () => config.tenantId
export const MAX_AUTO = Number(process.env.PRO_STEP_RETRY_MAX || 3)
const BASE_SEC = Number(process.env.PRO_STEP_RETRY_BASE_SEC || 60) // 1 → 2 → 4 minutes
const TRANSIENT = /recovery mode|57P03|terminat(ed|ing) (unexpectedly|connection)|connection (refused|reset|closed|error|timed out)|could not connect|server closed the connection|ECONN(RESET|REFUSED|ABORTED)|EPIPE|socket hang up|fetch failed|timed? ?out|timeout|deadline exceeded|other side closed|ServerDisconnected|RemoteProtocolError|APIConnectionError|ReadError|ConnectError|\b50[234]\b|Bad Gateway|Service Unavailable|Gateway Time-?out|too many (connections|clients|requests)|\b429\b|rate.?limit|overloaded|temporar(il)?y unavailable|StreamChunkTimeout/i

// a failure with no error recorded at all happened while the database could not take the record
export const isTransient = (raw) => !raw || TRANSIENT.test(String(raw))

async function lastError(todoId) {
  const [e] = await q(`select data->>'raw_error' as raw, data->>'friendly' as friendly, timestamp from events
                       where todo_id=$1 and event_type::text='error' order by timestamp desc limit 1`, [String(todoId)])
  return e || null
}

// back in process-gpt's queue exactly like a new agent step (fetch_pending_task: IN_PROGRESS,
// draft and draft_status empty); the claim counter starts over
async function requeue(todoId) {
  const [t] = await q(`update todolist set draft_status=null, draft=null, consumer=null, lease_until=null, claim_count=0
                       where id::text=$1 and draft_status::text='FAILED' and status::text='IN_PROGRESS' and tenant_id=$2
                       returning id::text as id, proc_inst_id`, [String(todoId), T()])
  return t || null
}

// who started the instance: the person on its first human step (the start form)
async function starterOf(instId) {
  const [t] = await q(`select user_id from todolist where proc_inst_id=$1 and agent_orch is null and user_id is not null
                       order by start_date asc nulls last limit 1`, [instId])
  const key = String(t?.user_id || '').split(',')[0].trim()
  if (!key) return null
  const [u] = await q('select id::text as id from users where (id::text=$1 or email=$1) and tenant_id=$2 limit 1', [key, T()])
  return u?.id || null
}

async function giveUp(t, err, transient) {
  await q(`insert into pro_step_retries (todo_id, tenant_id, proc_inst_id, last_error, transient, failed_at, gave_up_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,now(),now())
           on conflict (todo_id) do update set last_error=$4, transient=$5, failed_at=$6, gave_up_at=now(), updated_at=now()`,
  [t.id, T(), t.proc_inst_id, (err?.raw || '').slice(0, 500), transient, t.updated_at])
  const who = await starterOf(t.proc_inst_id)
  if (!who) return
  const [i] = await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [t.proc_inst_id])
  const url = `/projects/p/${encodeURIComponent(t.proc_inst_id)}`
  await q('update notifications set is_checked=true where tenant_id=$1 and url=$2 and type=$3', [T(), url, 'agent_failed'])
  await q(`insert into notifications (id, user_id, title, type, description, url, tenant_id) values (gen_random_uuid(),$1,$2,'agent_failed',$3,$4,$5)`,
    [who, `에이전트 단계가 멈췄어요: ${t.activity_name}`,
      `${i?.proc_inst_name || t.proc_inst_id} — ${(err?.friendly || err?.raw || '오류 기록 없이 실패했어요').slice(0, 160)}${transient ? ` (자동으로 ${MAX_AUTO}번 다시 시도했어요)` : ''}. 인스턴스 화면에서 「다시 시도」를 누르면 이어서 진행해요.`,
      url, T()])
  emit(who, 'notifications', {})
  emit(who, 'process', { instId: t.proc_inst_id, type: 'changed' })
}

// one pass over the tenant's failed agent steps of running instances (instId: just that one)
export async function sweep({ now = new Date(), instId = null } = {}) {
  const rows = await q(`select t.id::text as id, t.proc_inst_id, t.activity_name, t.updated_at, r.attempts, r.retried_at, r.gave_up_at, r.failed_at
                        from todolist t
                        join bpm_proc_inst i on i.proc_inst_id=t.proc_inst_id and i.status::text='RUNNING' and not coalesce(i.is_deleted,false)
                        left join pro_step_retries r on r.todo_id=t.id::text
                        where t.tenant_id=$1 and t.draft_status::text='FAILED' and t.status::text='IN_PROGRESS' and t.agent_orch is not null
                          and t.updated_at > now() - interval '2 days' and ($2::text is null or t.proc_inst_id=$2)`, [T(), instId])
  const done = []
  for (const t of rows) {
    // already handed to a person, and nothing new happened since
    if (t.gave_up_at && (!t.failed_at || new Date(t.updated_at) <= new Date(t.failed_at))) continue
    const err = await lastError(t.id)
    const transient = isTransient(err?.raw)
    const attempts = t.attempts || 0
    if (!transient || attempts >= MAX_AUTO) { await giveUp(t, err, transient); done.push({ id: t.id, gaveUp: true }); continue }
    const due = new Date(new Date(t.updated_at).getTime() + BASE_SEC * 1000 * 2 ** attempts)
    if (now < due) continue
    if (!(await requeue(t.id))) continue
    await q(`insert into pro_step_retries (todo_id, tenant_id, proc_inst_id, attempts, last_error, transient, failed_at, retried_at, updated_at)
             values ($1,$2,$3,1,$4,$5,$6,now(),now())
             on conflict (todo_id) do update set attempts=pro_step_retries.attempts+1, last_error=$4, transient=$5, failed_at=$6, retried_at=now(), gave_up_at=null, updated_at=now()`,
    [t.id, T(), t.proc_inst_id, (err?.raw || '').slice(0, 500), transient, t.updated_at])
    console.log(`[step-retry] ${t.proc_inst_id} · ${t.activity_name}: queued again (${attempts + 1}/${MAX_AUTO}) after ${(err?.raw || 'no error recorded').slice(0, 120)}`)
    done.push({ id: t.id, retried: attempts + 1 })
  }
  return done
}

// 「다시 시도」 by a person who can see the instance: queue it now, with a fresh automatic budget
export async function retryNow(me, todoId, canSee) {
  const [t] = await q(`select id::text as id, proc_inst_id, draft_status::text as draft_status, status::text as status, agent_orch from todolist where id::text=$1 and tenant_id=$2`, [String(todoId), T()])
  if (!t) throw Object.assign(new Error('작업 항목을 찾지 못했어요.'), { status: 404 })
  if (!(await canSee(t.proc_inst_id, me))) throw Object.assign(new Error('이 프로세스를 볼 권한이 없어요.'), { status: 403 })
  if (!t.agent_orch || t.draft_status !== 'FAILED' || t.status !== 'IN_PROGRESS') throw Object.assign(new Error('실패한 에이전트 단계만 다시 시도할 수 있어요.'), { status: 409 })
  await requeue(t.id)
  await q(`insert into pro_step_retries (todo_id, tenant_id, proc_inst_id, manual, retried_at, updated_at) values ($1,$2,$3,1,now(),now())
           on conflict (todo_id) do update set manual=pro_step_retries.manual+1, attempts=0, gave_up_at=null, retried_at=now(), updated_at=now()`, [t.id, T(), t.proc_inst_id])
  await q('update notifications set is_checked=true where tenant_id=$1 and url=$2 and type=$3', [T(), `/projects/p/${encodeURIComponent(t.proc_inst_id)}`, 'agent_failed'])
  emit(me.id, 'process', { instId: t.proc_inst_id, type: 'changed' })
  return { ok: true, todoId: t.id }
}

// what the instance page shows for its failed steps: the error in words and where the retries are
export async function failures(todoIds) {
  const out = {}
  for (const id of todoIds) {
    const err = await lastError(id)
    const [r] = await q('select attempts, manual, gave_up_at, retried_at from pro_step_retries where todo_id=$1', [String(id)])
    const transient = isTransient(err?.raw)
    out[id] = {
      error: (err?.friendly || err?.raw || '오류 기록 없이 실패했어요').slice(0, 300),
      transient, attempts: r?.attempts || 0, max: MAX_AUTO,
      // still in the automatic budget: the sweep queues it again on its own
      autoRetry: transient && !r?.gave_up_at && (r?.attempts || 0) < MAX_AUTO,
    }
  }
  return out
}

let timer = null
export function startStepRetry() {
  if (timer) return
  const tick = () => eachTenant(() => sweep()).catch((e) => console.warn('[step-retry]', e.message))
  timer = setInterval(tick, Number(process.env.PRO_STEP_RETRY_TICK_MS || 30000))
  setTimeout(tick, 15000)
}
