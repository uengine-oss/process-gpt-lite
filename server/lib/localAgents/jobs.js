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
// Another kind of local job (pro_local_jobs.kind — 'chat': a chat message for its sender's own CLI, chat.js) has hooks of its own: the
// queue, the offer, the desktop's answers and the sweep are the same; what a job means is its kind's. A step ('step', the default) uses
// the hooks above. reply: (job, msg, link) → the CLI's answer at the end of a turn (only kinds that answer in a conversation).
const kindHooks = new Map()
export function setKindHooks(kind, h) { kindHooks.set(kind, { ...hooks, reply: async () => {}, ...h }) }
const hk = (job) => (job?.kind && job.kind !== 'step' && kindHooks.get(job.kind)) || hooks

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
// outdated: those of them that could take it but for a capability the run needs (a chat run that leaves the folder's own run settings off —
// chat.js — needs leaveOffSettings)
export async function freeLinks(job) {
  // (a chat message goes only to a desktop that runs them — 0.2.2; an older one would take it for a step)
  const able = H.linksOf(T(), job.user_id).filter((l) => canRun(l, job.agent) && (job.kind !== 'chat' || l.caps?.chat)).sort((a, b) => b.since - a.since)
  const needs = (l) => !(job.kind === 'chat' && job.chat?.leaveOff) || !!l.caps?.leaveOffSettings
  const links = able.filter(needs)
  const outdated = able.filter((l) => !needs(l))
  if (!links.length) return { capable: [], free: [], outdated }
  const busy = new Map((await q(`select device_id::text as d, count(*)::int as n from pro_local_jobs where tenant_id=$1 and state in ('offered','running') and device_id = any($2) group by 1`,
    [T(), links.map((l) => l.id)])).map((r) => [r.d, r.n]))
  return { capable: links, free: links.filter((l) => (busy.get(l.id) || 0) < (l.caps.maxJobs || 2)), outdated }
}

// A step for a local agent: its job (one per work item), then where it goes now. The work item claimed again after its job ended —
// failed (「다시 시도」), cancelled, handed to the server (and the server agent failed, then 「다시 시도」), or done (the step was reopened)
// — is a new run: queued again with the step's settings as they are now, nothing of the old run's session, steers or lines.
// spec: {todoId, instId, activity, userId, agent, mode, offline, serverAgent, waitMinutes, gate}
const REDO = `pro_local_jobs.state in ('failed','cancelled','delegated','done')`
const again = (col, val, keep = `pro_local_jobs.${col}`) => `${col} = case when ${REDO} then ${val} else ${keep} end`
export async function enqueue(spec) {
  const [j] = await q(`insert into pro_local_jobs (tenant_id, user_id, todo_id, proc_inst_id, activity_name, agent, mode, offline, server_agent, wait_minutes, gate, person_name)
                       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
                       on conflict (tenant_id, todo_id) do update set ${[
                         again('state', `'queued'`), again('error', 'null'), again('why', `'retry'`), again('created_at', 'now()'), again('device_id', 'null'),
                         again('device_name', 'null'), again('session_id', 'null'), again('run_branch', 'null'), again('result', 'null'), again('offered_at', 'null'),
                         again('started_at', 'null'), again('finished_at', 'null'), again('steers', `'[]'::jsonb`), again('suggestions', `'[]'::jsonb`),
                         again('lines', `'[]'::jsonb`), again('terminal', 'false'), again('screen', 'null'), again('sent_skills', `'[]'::jsonb`),
                         again('transcript', 'null'), again('idle_until', 'null'),
                         again('user_id', 'excluded.user_id'), again('agent', 'excluded.agent'), again('mode', 'excluded.mode'), again('offline', 'excluded.offline'),
                         again('server_agent', 'excluded.server_agent'), again('wait_minutes', 'excluded.wait_minutes'), again('gate', 'excluded.gate'),
                         again('person_name', 'excluded.person_name')].join(', ')},
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
  const { capable, free, outdated } = await freeLinks(job)
  if (free.length) return offer(job, free[0])
  if (capable.length) { if (job.why !== 'busy') { job = await set(job, { why: 'busy' }); await hk(job).note(job, 'busy') } return job }
  // (only desktops too old for this run are on: not offered to them — said why, as an offer they could not prepare would)
  if (outdated?.length) return delegate(job, 'unprepared', (await import('./chat.js')).OUTDATED())
  if (job.offline === 'server') return delegate(job, H.linksOf(T(), job.user_id).length ? 'unable' : 'offline')
  if (job.why !== 'waiting') { job = await set(job, { why: 'waiting' }); await hk(job).note(job, 'waiting') }
  return job
}

async function offer(job, link) {
  // (claimed first: two sweeps never send one job twice)
  const [claimed] = await q(`update pro_local_jobs set state='offered', device_id=$2, device_name=$3, offered_at=now(), why=null, updated_at=now()
                             where id=$1 and state='queued' returning *`, [job.id, link.id, link.name])
  if (!claimed) return job
  let payload
  try { payload = await hk(claimed).prepare(claimed, link) } catch (e) {
    console.warn(`[local-agents] ${claimed.activity_name}: cannot run locally — ${e.message}`)
    await set(claimed, { state: 'queued', device_id: null })
    return delegate({ ...claimed, state: 'queued' }, 'unprepared', e.message)
  }
  // (the skill folders it is given: a skill edit it sends back is taken only for these — knowhow.js)
  const sent = (payload.skills || []).filter((k) => k?.folder?.id).map((k) => ({ name: String(k.name || ''), folderId: String(k.folder.id) }))
  const j = await set(claimed, { folder_id: payload.git?.folder?.id || null, line: payload.git?.line || null, run_branch: payload.git?.branch || null, prompt: payload.prompt || null,
    sent_skills: sent })
  // (its card first, its message ids kept on the job: a desktop may accept the moment the job reaches it, and that answer then finds the
  // card — sent first, the accept could come back before the card was kept and make a second one, 2026-11-26)
  await hk(j).note(j, 'offered').catch((e) => console.warn('[local-agents] offered', e.message))
  if (!link.send({ type: 'job', job: { id: j.id, ...payload } })) {
    // (the link went meanwhile: back in the queue, and the card says so — only while it is still this offer: a job the desktop going offline,
    // a cancel or a hand-over has moved since is left as it is, so it is never queued twice or run again — review of #96)
    const [back] = await q(`update pro_local_jobs set state='queued', device_id=null, updated_at=now()
                            where id=$1 and state='offered' and device_id=$2 returning *`, [j.id, link.id])
    if (!back) return (await q('select * from pro_local_jobs where id=$1', [j.id]))[0] || j
    await hk(back).note(back, 'queued').catch((e) => console.warn('[local-agents] queued', e.message))
    return back
  }
  console.log(`[local-agents] ${j.activity_name} → ${link.name} (${j.agent})`)
  return j
}

// every queued job of this person, oldest first, onto their free desktops
export async function dispatchFor(userId) {
  const rows = await q(`select * from pro_local_jobs where tenant_id=$1 and user_id=$2 and state='queued' order by created_at`, [T(), userId])
  const out = []
  for (const r of rows) out.push(await route(r))
  return out
}

// an offer taken back (handed to the server, offered again elsewhere): the desktop it was offered to drops it — it may be asking its
// person, and it never starts a job the server has not confirmed (accept → accepted)
function withdraw(job, reason) {
  const link = job?.device_id ? H.linkOf(T(), String(job.device_id)) : null
  if (link) link.send({ type: 'cancel', jobId: job.id, reason })
}

export async function delegate(job, why, detail = '') {
  const [was] = await q('select state, device_id from pro_local_jobs where id=$1', [job.id])
  const [j0] = await q(`update pro_local_jobs set state='delegated', why=$2, error=$3, device_id=null, finished_at=now(), updated_at=now() where id=$1 and state in ('queued','offered') returning *`, [job.id, why, detail || null])
  if (!j0) return job
  if (was?.state === 'offered') withdraw({ ...j0, device_id: was.device_id }, 'delegated')
  const j = await endSteers(j0, 'delegated')
  console.log(`[local-agents] ${j.activity_name}: → server agent ${j.server_agent} (${why})`)
  await hk(j).note(j, 'delegated')
  await hk(j).delegate(j, why).catch((e) => console.warn('[local-agents] delegate', e.message))
  return j
}

// ---------- what a desktop says ----------
// only about its own job: the job is this person's and was given to this very device
const mine = (job, link) => !!job && String(job.user_id) === link.userId && String(job.device_id) === link.id

export async function onMessage(link, msg) {
  const job = await byId(msg.jobId)
  if (!mine(job, link)) {
    // (its person's job, no longer offered to it — taken back meanwhile: it is told to drop it, never to run it)
    if (msg.type === 'accept' && job && String(job.user_id) === link.userId) link.send({ type: 'cancel', jobId: job.id, reason: 'withdrawn' })
    if (msg.jobId) console.warn(`[local-agents] ${link.name}: ${msg.type} for a job that is not its own (${String(msg.jobId).slice(0, 8)})`)
    return
  }
  switch (msg.type) {
    case 'accept': {
      // the desktop starts only on this answer: running (or still running — an accept said again after a dropped link)
      if (job.state === 'running') { link.send({ type: 'accepted', jobId: job.id }); return }
      if (job.state !== 'offered') { link.send({ type: 'cancel', jobId: job.id, reason: job.state }); return }
      const [j] = await q(`update pro_local_jobs set state='running', started_at=now(), updated_at=now() where id=$1 and state='offered' and device_id=$2 returning *`, [job.id, link.id])
      if (!j) { link.send({ type: 'cancel', jobId: job.id, reason: 'withdrawn' }); return }
      link.send({ type: 'accepted', jobId: j.id })
      await hk(j).note(j, 'running')
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
    // its CLI's turn ended and the run waits for the people on the instance until then (null: it works again, or it ends) — runner settle.js
    case 'idle': {
      if (job.state !== 'running') return
      const until = msg.until && !Number.isNaN(Date.parse(msg.until)) ? new Date(msg.until) : null
      if ((job.idle_until ? new Date(job.idle_until).getTime() : null) === (until ? until.getTime() : null)) return
      return hk(job).note(await set(job, { idle_until: until }), 'idle')
    }
    case 'progress': {
      if (!['running', 'offered'].includes(job.state)) return
      const add = (Array.isArray(msg.lines) ? msg.lines : []).slice(-LINES).map((l) => ({ kind: String(l.kind || 'text').slice(0, 10), text: String(l.text || '').slice(0, 600), at: l.at || new Date().toISOString() }))
      if (!add.length) return
      const j = await set(job, { lines: [...(job.lines || []), ...add].slice(-LINES) })
      return hk(j).note(j, 'progress')
    }
    case 'steer-received':
      return hk(job).note(await setSteer(job, msg.steerId, { received: true, receivedAt: new Date().toISOString() }), 'steer')
    case 'steered':
      return hk(job).note(await setSteer(job, msg.steerId, { received: true, applied: msg.how || 'live', appliedAt: new Date().toISOString(), failed: false, reason: null }), 'steered')
    case 'steer-failed':
      return hk(job).note(await setSteer(job, msg.steerId, { failed: true, reason: String(msg.reason || 'refused').slice(0, 40) }), 'steer')
    // the CLI's answer at a turn's end (a chat — chat.js): its words, and what the turn changed in the folder (pushed on the run's branch).
    // Acknowledged by its turn number, so a desktop that says it again after a dropped link does not post it twice.
    // (offered too, as 'done' is: a desktop app that restarted says the answers it kept before the run's report, and the server put the run
    // it no longer holds back in the queue and offered it to it again while it said hello — hub.js online — so they come while 'offered')
    case 'reply': {
      if (!['running', 'offered'].includes(job.state)) { link.send({ type: 'replied', jobId: job.id, turn: msg.turn, state: job.state }); return }
      await hk(job).reply(job, msg, link)
      link.send({ type: 'replied', jobId: job.id, turn: msg.turn })
      return
    }
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
        const out = await hk(j).complete(j, kept)
        j = await endSteers(await set(j, { state: 'done', finished_at: new Date(), idle_until: null }), 'ended')
        // (know-how is read after the step has its result: a slow judge does not hold the next step)
        if (learned) hk(j).learned(j, learned).catch((e) => console.warn('[local-agents] know-how', e.message))
        link.send({ type: 'finished', jobId: j.id, state: 'done', line: j.line, head: out?.head || null })
      } catch (e) {
        console.warn(`[local-agents] ${j.activity_name}: result not taken — ${e.message}`)
        j = await set(j, { state: 'failed', error: e.message.slice(0, 500) })
        await hk(j).fail(j, e.message)
        link.send({ type: 'finished', jobId: j.id, state: 'failed', error: e.message.slice(0, 300) })
      }
      return hk(j).note(j, j.state)
    }
    case 'failed': {
      if (!['running', 'offered'].includes(job.state)) return
      const j = await endSteers(await set(job, { state: 'failed', error: String(msg.error || 'failed').slice(0, 800), finished_at: new Date(), idle_until: null }), 'failed')
      await hk(j).fail(j, j.error)
      link.send({ type: 'finished', jobId: j.id, state: 'failed' })
      return hk(j).note(j, 'failed')
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

// a desktop reported new capabilities or settings (its link stayed open): its person's queue is worked again — nothing it holds is
// taken back (that is onOnline's, when a link comes on)
export async function onCaps(link) {
  return dispatchFor(link.userId)
}

// a desktop went off: offers it had not taken go back in the queue (another desktop of the person, the wait, or the server); a run it
// had taken stays its own — the CLI may well go on, and the desktop tells when it is back
export async function onOffline(link) {
  const offered = await q(`update pro_local_jobs set state='queued', device_id=null, updated_at=now() where tenant_id=$1 and device_id=$2 and state='offered' returning *`, [T(), link.id])
  for (const j of offered) await route(j)
  const running = await q(`select * from pro_local_jobs where tenant_id=$1 and device_id=$2 and state='running'`, [T(), link.id])
  for (const j of running) await hk(j).note(j, 'link-lost')
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
  await hk(j).note(j, 'steer')
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
  await hk(j).note(j, 'suggestion')
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

// 「끝내기」: its worker ends a run that waits after its CLI's turn (or right after the turn at hand) — the desktop does it (settle.js)
export function finish(job) {
  if (job.state !== 'running') throw Object.assign(new Error('이 실행은 이미 끝났어요.'), { status: 409 })
  const link = job.device_id ? H.linkOf(T(), String(job.device_id)) : null
  return !!link?.send({ type: 'finish', jobId: job.id })
}

// the step was closed (moved, rewound, done by hand): the run stops
export async function cancel(job, why = 'closed') {
  if (!OPEN.includes(job.state)) return job
  const j = await endSteers(await set(job, { state: 'cancelled', why, finished_at: new Date(), idle_until: null }), 'cancelled')
  const link = job.device_id ? H.linkOf(T(), String(job.device_id)) : null
  if (link) link.send({ type: 'cancel', jobId: j.id, reason: why })
  await hk(j).note(j, 'cancelled')
  return j
}

// ---------- the sweep (every few seconds, per tenant) ----------
// waits that ran out go to the server agent; offers nobody took are offered again; a closed step's job stops; queued jobs whose
// desktop is on are sent (a missed trigger); a desktop that went off leaves its 'server' jobs to the server
export async function sweep(now = Date.now()) {
  const open = await q(`select * from pro_local_jobs where tenant_id=$1 and state in ('queued','offered','running') order by created_at limit 200`, [T()])
  for (const j of open) {
    // (a run whose result is being taken in: its step closes as part of that — it is not a step closed by hand. Before, a sweep in that
    // moment marked the run 「단계가 닫혀 로컬 실행을 멈췄어요」 and its done was refused — seen once in M-02, 2026-11-24)
    if (j.state === 'running' && j.result) continue
    if (await hk(j).cancelled(j).catch(() => false)) { await cancel(j, 'closed'); continue }
    if (overdue(j, now)) { await delegate(j, 'timeout'); continue }
    if (j.state === 'offered' && now - new Date(j.offered_at).getTime() > OFFER_MS) {
      withdraw(j, 'unanswered')
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
