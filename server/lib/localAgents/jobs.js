// The local job queue and its dispatcher (lib/localAgents). A process step whose activity names a local agent becomes one job
// (pro_local_jobs, one per work item). The job belongs to the step's assignee and goes only to that person's own desktops — the
// links hub.js holds for that person — and only to a desktop that says it can run that CLI and has local runs on.
//   queued    → the assignee's desktop is off (and the activity says wait), or busy
//   offered   → sent to one desktop, waiting for it to take it (it may ask the person first)
//   running   → the desktop runs the CLI; progress, steering
//   done      → the desktop pushed its branch; the step got its result (steps.js)
//   failed    → the run failed; the step shows 「다시 시도」 (lib/stepRetry.js puts it back in the queue)
//   delegated → handed to the server agent (desktop off and the activity says so, the wait ran out, the person declined)
//   cancelled → the step was closed meanwhile (a move, a rewind)
// What a state change means for the step (its folder, prompt, result, the server agent, the instance's conversation) is steps.js'
// — given here as hooks, so this file and its tests need no process engine.
import { config } from '../../config.js'
import { q } from '../supa.js'
import * as H from './hub.js'
import { canRun, overdue } from './agents.js'

const T = () => config.tenantId
export const OFFER_MS = 15 * 60_000
const LINES = 60
let hooks = {
  prepare: async () => ({}), // job → the payload the desktop gets ({prompt, git, …}); throws when the step cannot be run locally
  complete: async () => {},  // (job, result) → the step's result
  delegate: async () => {},  // (job, why) → the step goes to the server agent
  fail: async () => {},      // (job, error) → the step stopped on an error
  note: async () => {},      // (job, what) → the instance's conversation follows
  cancelled: async () => false, // job → true when its step is closed (no run any more)
  learned: async () => {},   // (job, learned) → know-how candidates from a finished run
}
export function setHooks(h) { hooks = { ...hooks, ...h } }

const OPEN = ['queued', 'offered', 'running']
export async function byId(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null
  const [j] = await q('select * from pro_local_jobs where id=$1 and tenant_id=$2', [id, T()])
  return j || null
}
export async function byTodo(todoId) {
  const [j] = await q('select * from pro_local_jobs where todo_id=$1 and tenant_id=$2', [String(todoId), T()])
  return j || null
}
async function set(job, patch) {
  const keys = Object.keys(patch)
  const [j] = await q(`update pro_local_jobs set ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}, updated_at=now() where id=$1 returning *`,
    [job.id, ...keys.map((k) => (patch[k] && typeof patch[k] === 'object' && !(patch[k] instanceof Date) ? JSON.stringify(patch[k]) : patch[k]))])
  return j || job
}

// the desktops of the job's person that can take it now (capable, local runs on, room for one more), the newest link first
export async function freeLinks(job) {
  const links = H.linksOf(T(), job.user_id).filter((l) => canRun(l, job.agent)).sort((a, b) => b.since - a.since)
  if (!links.length) return { capable: [], free: [] }
  const busy = new Map((await q(`select device_id::text as d, count(*)::int as n from pro_local_jobs where tenant_id=$1 and state in ('offered','running') and device_id = any($2) group by 1`,
    [T(), links.map((l) => l.id)])).map((r) => [r.d, r.n]))
  return { capable: links, free: links.filter((l) => (busy.get(l.id) || 0) < (l.caps.maxJobs || 2)) }
}

// A step for a local agent: its job (made once; a failed one is queued again — 「다시 시도」), then where it goes now.
// spec: {todoId, instId, activity, userId, agent, mode, offline, serverAgent, waitMinutes, gate}
export async function enqueue(spec) {
  const [j] = await q(`insert into pro_local_jobs (tenant_id, user_id, todo_id, proc_inst_id, activity_name, agent, mode, offline, server_agent, wait_minutes, gate, person_name)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                       on conflict (tenant_id, todo_id) do update set state = case when pro_local_jobs.state in ('failed','cancelled') then 'queued' else pro_local_jobs.state end,
                         error = case when pro_local_jobs.state in ('failed','cancelled') then null else pro_local_jobs.error end,
                         why = case when pro_local_jobs.state in ('failed','cancelled') then 'retry' else pro_local_jobs.why end,
                         created_at = case when pro_local_jobs.state in ('failed','cancelled') then now() else pro_local_jobs.created_at end,
                         device_id = case when pro_local_jobs.state in ('failed','cancelled') then null else pro_local_jobs.device_id end,
                         session_id = case when pro_local_jobs.state in ('failed','cancelled') then null else pro_local_jobs.session_id end,
                         updated_at = now()
                       returning *`,
  [T(), spec.userId, String(spec.todoId), spec.instId || null, spec.activity || null, spec.agent, spec.mode === 'draft' ? 'draft' : 'complete',
    spec.offline === 'wait' ? 'wait' : 'server', spec.serverAgent || 'onto', spec.waitMinutes || null, spec.gate ? JSON.stringify(spec.gate) : null, spec.personName || null])
  if (j.state !== 'queued') return j
  return route(j)
}

// where a queued job goes: a free desktop of its person → offered; a desktop of theirs is on but busy → stays queued; none is on →
// the activity's choice (server: delegated now · wait: queued, until its wait time if it has one)
export async function route(job) {
  if (job.state !== 'queued') return job
  const { capable, free } = await freeLinks(job)
  if (free.length) return offer(job, free[0])
  if (capable.length) { if (job.why !== 'busy') { job = await set(job, { why: 'busy' }); await hooks.note(job, 'busy') } return job }
  if (job.offline === 'server') return delegate(job, H.linksOf(T(), job.user_id).length ? 'unable' : 'offline')
  if (job.why !== 'waiting') { job = await set(job, { why: 'waiting' }); await hooks.note(job, 'waiting') }
  return job
}

async function offer(job, link) {
  // (claimed first: two sweeps never send one job twice)
  const [claimed] = await q(`update pro_local_jobs set state='offered', device_id=$2, device_name=$3, offered_at=now(), why=null, updated_at=now()
                             where id=$1 and state='queued' returning *`, [job.id, link.id, link.name])
  if (!claimed) return job
  let payload
  try { payload = await hooks.prepare(claimed, link) } catch (e) {
    console.warn(`[local-agents] ${claimed.activity_name}: cannot run locally — ${e.message}`)
    await set(claimed, { state: 'queued', device_id: null })
    return delegate({ ...claimed, state: 'queued' }, 'unprepared', e.message)
  }
  const j = await set(claimed, { folder_id: payload.git?.folder?.id || null, line: payload.git?.line || null, run_branch: payload.git?.branch || null, prompt: payload.prompt || null })
  if (!link.send({ type: 'job', job: { id: j.id, ...payload } })) { await set(j, { state: 'queued', device_id: null }); return j }
  console.log(`[local-agents] ${j.activity_name} → ${link.name} (${j.agent})`)
  await hooks.note(j, 'offered')
  return j
}

// every queued job of this person, oldest first, onto their free desktops
export async function dispatchFor(userId) {
  const rows = await q(`select * from pro_local_jobs where tenant_id=$1 and user_id=$2 and state='queued' order by created_at`, [T(), userId])
  const out = []
  for (const r of rows) out.push(await route(r))
  return out
}

export async function delegate(job, why, detail = '') {
  const [j0] = await q(`update pro_local_jobs set state='delegated', why=$2, error=$3, device_id=null, finished_at=now(), updated_at=now() where id=$1 and state in ('queued','offered') returning *`, [job.id, why, detail || null])
  if (!j0) return job
  const j = await endSteers(j0, 'delegated')
  console.log(`[local-agents] ${j.activity_name}: → server agent ${j.server_agent} (${why})`)
  await hooks.note(j, 'delegated')
  await hooks.delegate(j, why).catch((e) => console.warn('[local-agents] delegate', e.message))
  return j
}

// ---------- what a desktop says ----------
// only about its own job: the job is this person's and was given to this very device
const mine = (job, link) => !!job && String(job.user_id) === link.userId && String(job.device_id) === link.id

export async function onMessage(link, msg) {
  const job = await byId(msg.jobId)
  if (!mine(job, link)) { if (msg.jobId) console.warn(`[local-agents] ${link.name}: ${msg.type} for a job that is not its own (${String(msg.jobId).slice(0, 8)})`); return }
  switch (msg.type) {
    case 'accept': {
      if (job.state !== 'offered') return
      const j = await set(job, { state: 'running', started_at: new Date() })
      await hooks.note(j, 'running')
      return sendSteers(j, link)
    }
    case 'decline': {
      if (job.state !== 'offered') return
      // busy: back in the queue; the person said no, or local runs are off: the server agent
      if (msg.reason === 'busy') return set(job, { state: 'queued', device_id: null, why: 'busy' })
      await set(job, { state: 'queued', device_id: null })
      return delegate({ ...job, state: 'queued' }, msg.reason === 'disabled' ? 'disabled' : 'declined')
    }
    case 'session':
      return set(job, { session_id: String(msg.sessionId || '').slice(0, 100) || null })
    case 'progress': {
      if (!['running', 'offered'].includes(job.state)) return
      const add = (Array.isArray(msg.lines) ? msg.lines : []).slice(-LINES).map((l) => ({ kind: String(l.kind || 'text').slice(0, 10), text: String(l.text || '').slice(0, 600), at: l.at || new Date().toISOString() }))
      if (!add.length) return
      const j = await set(job, { lines: [...(job.lines || []), ...add].slice(-LINES) })
      return hooks.note(j, 'progress')
    }
    case 'steer-received':
      return hooks.note(await setSteer(job, msg.steerId, { received: true, receivedAt: new Date().toISOString() }), 'steer')
    case 'steered':
      return hooks.note(await setSteer(job, msg.steerId, { received: true, applied: msg.how || 'live', appliedAt: new Date().toISOString(), failed: false, reason: null }), 'steered')
    case 'steer-failed':
      return hooks.note(await setSteer(job, msg.steerId, { failed: true, reason: String(msg.reason || 'refused').slice(0, 40) }), 'steer')
    case 'done': {
      if (!['running', 'offered'].includes(job.state)) { link.send({ type: 'finished', jobId: job.id, state: job.state }); return }
      const result = { branch: String(msg.branch || '').slice(0, 200), commit: String(msg.commit || '').slice(0, 64) || null, pushed: !!msg.pushed,
        files: (Array.isArray(msg.files) ? msg.files : []).slice(0, 200).map((f) => String(f).slice(0, 300)), summary: String(msg.summary || '').slice(0, 8000),
        sessionId: msg.sessionId ? String(msg.sessionId).slice(0, 100) : job.session_id, agentVersion: msg.agentVersion ? String(msg.agentVersion).slice(0, 40) : null,
        // what the run learned (the steers and what changed after each, the CLI's own memory and skill edits — steps.js knowhow)
        learned: msg.knowhow && typeof msg.knowhow === 'object' ? msg.knowhow : null }
      // (the result is in the step before the job says done: whoever reads 'done' finds it there)
      const { learned, ...kept } = result
      let j = await set(job, { result: kept, session_id: result.sessionId })
      try {
        const out = await hooks.complete(j, kept)
        j = await endSteers(await set(j, { state: 'done', finished_at: new Date() }), 'ended')
        // (know-how is read after the step has its result: a slow judge does not hold the next step)
        if (learned) hooks.learned(j, learned).catch((e) => console.warn('[local-agents] know-how', e.message))
        link.send({ type: 'finished', jobId: j.id, state: 'done', line: j.line, head: out?.head || null })
      } catch (e) {
        console.warn(`[local-agents] ${j.activity_name}: result not taken — ${e.message}`)
        j = await set(j, { state: 'failed', error: e.message.slice(0, 500) })
        await hooks.fail(j, e.message)
        link.send({ type: 'finished', jobId: j.id, state: 'failed', error: e.message.slice(0, 300) })
      }
      return hooks.note(j, j.state)
    }
    case 'failed': {
      if (!['running', 'offered'].includes(job.state)) return
      const j = await endSteers(await set(job, { state: 'failed', error: String(msg.error || 'failed').slice(0, 800), finished_at: new Date() }), 'failed')
      await hooks.fail(j, j.error)
      link.send({ type: 'finished', jobId: j.id, state: 'failed' })
      return hooks.note(j, 'failed')
    }
    default:
  }
}

// a desktop came on (or reported new capabilities): what it was running carries on, what it lost goes back in the queue, then its
// person's queue is worked
export async function onOnline(link) {
  const held = await q(`select * from pro_local_jobs where tenant_id=$1 and device_id=$2 and state in ('offered','running')`, [T(), link.id])
  for (const j of held) {
    if (link.active.has(j.id)) { await sendSteers(j, link); continue }
    // (an offer it never saw, or a run it no longer has — the app was restarted mid-run): offered again
    await set(j, { state: 'queued', device_id: null, why: 'lost' })
  }
  return dispatchFor(link.userId)
}

// a desktop went off: offers it had not taken go back in the queue (another desktop of the person, the wait, or the server); a run it
// had taken stays its own — the CLI may well go on, and the desktop tells when it is back
export async function onOffline(link) {
  const offered = await q(`update pro_local_jobs set state='queued', device_id=null, updated_at=now() where tenant_id=$1 and device_id=$2 and state='offered' returning *`, [T(), link.id])
  for (const j of offered) await route(j)
  const running = await q(`select * from pro_local_jobs where tenant_id=$1 and device_id=$2 and state='running'`, [T(), link.id])
  for (const j of running) await hooks.note(j, 'link-lost')
}

// ---------- steering ----------
// what a person types while the run goes: kept on the job (so a desktop that is reconnecting still gets it) and sent now when it can be
// from: whose suggestion it was when the worker put a participant's suggested prompt into the input ({id, name, suggestionId})
export async function steer(job, user, text, { from = null } = {}) {
  const t = String(text || '').trim().slice(0, 4000)
  if (!t) throw Object.assign(new Error('empty'), { status: 400 })
  if (!['running', 'offered'].includes(job.state)) throw Object.assign(new Error('이 실행은 이미 끝났어요.'), { status: 409 })
  const s = { id: `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t, by: String(user.id), name: user.name || '', at: new Date().toISOString(), sent: false,
    ...(from ? { from: { id: String(from.id || ''), name: String(from.name || ''), suggestionId: from.suggestionId || null } } : {}) }
  // (each steer is changed in place in the database: a desktop's answer about one never overwrites another — see setSteer)
  let [j] = await q(`update pro_local_jobs set steers = coalesce(steers, '[]'::jsonb) || jsonb_build_array($2::jsonb), updated_at=now() where id=$1 returning *`, [job.id, JSON.stringify(s)])
  const link = j.device_id ? H.linkOf(T(), String(j.device_id)) : null
  if (link && j.state === 'running') j = await sendSteers(j, link)
  await hooks.note(j, 'steer')
  return { job: j, steer: s, delivered: !!(j.steers || []).find((x) => x.id === s.id)?.sent }
}
async function sendSteers(job, link) {
  const pending = (job.steers || []).filter((s) => !s.sent)
  if (!pending.length || job.state !== 'running') return job
  // marked sent first: the desktop's answer (received · steered) may come back before this returns
  let j = job
  for (const s of pending) j = await setSteer(j, s.id, { sent: true, sentAt: new Date().toISOString() })
  for (const s of pending) link.send({ type: 'steer', jobId: job.id, steerId: s.id, text: s.text, by: s.name, byId: s.by, ...(s.from ? { from: s.from.name } : {}) })
  return j
}

// one steer's state: sent (written to the desktop's link) → received (the runner has it) → applied (live: the running CLI took it ·
// resume: the same session went on with it · before-start: it joined the first message) — or failed, with why
async function setSteer(job, id, patch) {
  const [j] = await q(`update pro_local_jobs set steers = (select coalesce(jsonb_agg(case when e->>'id' = $2 then e || $3::jsonb else e end order by n), '[]'::jsonb)
                         from jsonb_array_elements(steers) with ordinality as x(e, n)), updated_at=now() where id=$1 returning *`, [job.id, String(id || ''), JSON.stringify(patch)])
  return j || job
}
// a run that ended (done, failed, stopped, handed to the server) with steers it never applied: they failed, and say why
async function endSteers(job, why) {
  const [j] = await q(`update pro_local_jobs set steers = (select coalesce(jsonb_agg(case when coalesce(e->>'applied', '') = '' and coalesce((e->>'failed')::boolean, false) = false
                         then e || jsonb_build_object('failed', true, 'reason', $2::text) else e end order by n), '[]'::jsonb)
                         from jsonb_array_elements(steers) with ordinality as x(e, n)), updated_at=now() where id=$1 returning *`, [job.id, why])
  return j || job
}

// ---------- the participants' suggestions ----------
// A prompt a participant suggests for the run (anyone who sees the instance — web, phone, their own desktop). It is never sent to the CLI:
// it waits in the run's stack until the person whose computer runs it puts it into the input (as it is, or edited) or drops it.
//   waiting → used (steerId, the text that went in, edited) · dismissed
// kind: 'opinion' (anyone's idea) | 'decision' (a role holder's answer to a choice the CLI shows — option: the choice they picked); a
// decision lands in the worker's input bar ready to send, as any suggestion: only the worker sends it.
export async function suggest(job, user, text, { kind = 'opinion', option = null } = {}) {
  const t = String(text || '').trim().slice(0, 2000)
  if (!t) throw Object.assign(new Error('empty'), { status: 400 })
  const c = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, by: String(user.id), name: user.name || '', text: t, at: new Date().toISOString(), state: 'waiting',
    kind: kind === 'decision' ? 'decision' : 'opinion', ...(kind === 'decision' && option != null ? { option: String(option).slice(0, 200) } : {}) }
  const [j] = await q(`update pro_local_jobs set suggestions = coalesce(suggestions, '[]'::jsonb) || jsonb_build_array($2::jsonb), updated_at=now() where id=$1 returning *`, [job.id, JSON.stringify(c)])
  await hooks.note(j, 'suggestion')
  return { job: j, suggestion: c }
}
export async function markSuggestion(job, id, patch) {
  const [j] = await q(`update pro_local_jobs set suggestions = (select coalesce(jsonb_agg(case when e->>'id' = $2 then e || $3::jsonb else e end order by n), '[]'::jsonb)
                         from jsonb_array_elements(suggestions) with ordinality as x(e, n)), updated_at=now() where id=$1 returning *`, [job.id, String(id || ''), JSON.stringify(patch)])
  return j || job
}
// the run's know-how candidates (steps.js knowhow): one changed in place
export async function setKnowhow(job, id, patch) {
  const [j] = await q(`update pro_local_jobs set knowhow = (select coalesce(jsonb_agg(case when e->>'id' = $2 then e || $3::jsonb else e end order by n), '[]'::jsonb)
                         from jsonb_array_elements(knowhow) with ordinality as x(e, n)), updated_at=now() where id=$1 returning *`, [job.id, String(id || ''), JSON.stringify(patch)])
  return j || job
}

// the step was closed (moved, rewound, done by hand): the run stops
export async function cancel(job, why = 'closed') {
  if (!OPEN.includes(job.state)) return job
  const j = await endSteers(await set(job, { state: 'cancelled', why, finished_at: new Date() }), 'cancelled')
  const link = job.device_id ? H.linkOf(T(), String(job.device_id)) : null
  if (link) link.send({ type: 'cancel', jobId: j.id, reason: why })
  await hooks.note(j, 'cancelled')
  return j
}

// ---------- the sweep (every few seconds, per tenant) ----------
// waits that ran out go to the server agent; offers nobody took are offered again; a closed step's job stops; queued jobs whose
// desktop is on are sent (a missed trigger); a desktop that went off leaves its 'server' jobs to the server
export async function sweep(now = Date.now()) {
  const open = await q(`select * from pro_local_jobs where tenant_id=$1 and state in ('queued','offered','running') order by created_at limit 200`, [T()])
  for (const j of open) {
    if (await hooks.cancelled(j).catch(() => false)) { await cancel(j, 'closed'); continue }
    if (overdue(j, now)) { await delegate(j, 'timeout'); continue }
    if (j.state === 'offered' && now - new Date(j.offered_at).getTime() > OFFER_MS) {
      const back = await set(j, { state: 'queued', device_id: null, why: 'unanswered' })
      await route(back)
      continue
    }
    if (j.state === 'queued') await route(j)
  }
}

// an instance's jobs (its page), newest first
export async function ofInstance(instId) {
  return q(`select * from pro_local_jobs where tenant_id=$1 and proc_inst_id=$2 order by created_at desc limit 30`, [T(), String(instId)])
}
