// 프로세스 온톨로지 — what the routes call (spec pgpt-pro_process-ontology). Reading the mail history, building the
// graph, and the map a person sees (θ, a point in time, the automatic values with their evidence).
import { shownRoutine } from './structure.js'
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { mainThread, addMessage } from '../store.js'
import { ontologyEnabled, readGraph, cypher } from './store.js'
import { rebuild } from './build.js'
import { startMailHistory, runMailHistory, jobOf, latestJob } from './history.js'
import { labelExamples } from './names.js'
import { BAND_KO } from './stats.js'

const T = () => config.tenantId
export const err = (status, message) => Object.assign(new Error(message), { status })

export async function isAdmin(me) {
  const [u] = await q('select is_admin from users where id::text=$1 and tenant_id=$2', [String(me.id), T()])
  return !!u?.is_admin
}

export async function status(me) {
  const on = ontologyEnabled()
  const meta = on ? (await readGraph({}).catch(() => null))?.meta || null : null
  return { enabled: on, admin: await isAdmin(me), mail: await latestJob('mail_history'), build: await latestJob('build'), meta }
}

// build in the background, with a job row for its progress
export async function startBuild(me, reason = '온톨로지 다시 셈하기') {
  const [job] = await q(`insert into pro_onto_jobs (tenant_id, user_id, kind) values ($1,$2,'build') returning id`, [T(), me?.id || null])
  const tenant = T()
  rebuild({ actor: me?.email || 'system', reason, job: job.id })
    .then((r) => q(`update pro_onto_jobs set status='done', finished_at=now(), detail = detail || $2, found=$3 where id=$1`, [job.id, r, r.tasks || 0]))
    .catch((e) => { console.warn('[ontology] build', e.message); return q(`update pro_onto_jobs set status='failed', error=$2, finished_at=now() where id=$1`, [job.id, String(e.message).slice(0, 500)]) })
    .finally(() => { if (me?.id) emit(me.id, 'ontology', { job: job.id, kind: 'build', tenant }) })
  return { job: job.id }
}

// AI 후보 고르기(candidates.js): 뒤에서 돌고, 진행 줄을 작업에 남긴다
export async function startCandidates(me, { all = false } = {}) {
  const [job] = await q(`insert into pro_onto_jobs (tenant_id, user_id, kind) values ($1,$2,'candidates') returning id`, [T(), me?.id || null])
  const tenant = T()
  const { judgeCandidates } = await import('./candidates.js')
  const { sayer } = await import('./feed.js')
  judgeCandidates({ say: sayer(job.id, 30), all })
    .then((r) => q(`update pro_onto_jobs set status='done', finished_at=now(), detail = detail || $2, found=$3 where id=$1`, [job.id, r, (r.high || 0) + (r.mid || 0)]))
    .catch((e) => { console.warn('[ontology] candidates', e.message); return q(`update pro_onto_jobs set status='failed', error=$2, finished_at=now() where id=$1`, [job.id, String(e.message).slice(0, 500)]) })
    .finally(() => { if (me?.id) emit(me.id, 'ontology', { job: job.id, kind: 'candidates', tenant }) })
  return { job: job.id }
}

// 「지난 메일 읽기」: read the mailbox, then build the graph from it and the chat handovers already there; when the map
// is drawn, the person gets a summary card (the "ideas" the onboarding promised after the mail connection)
// a real mailbox's read runs for hours (Gmail's quota, a model call per thread): wait as long as the job runs
const waitJob = async (id, ms = 12 * 60 * 60_000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const j = await jobOf(id).catch(() => null)
    if (j && j.status !== 'running') return j
    await new Promise((r) => setTimeout(r, 1500))
  }
  return null
}
export async function readMailAndBuild(me, { days = 90 } = {}) {
  const started = await startMailHistory(me, { days })
  if (started.already) return started
  ;(async () => {
    const j = await waitJob(started.job)
    if (j?.status !== 'done') return
    const b = await startBuild(me, '지난 메일 읽기 뒤 다시 셈하기')
    const jb = await waitJob(b.job)
    if (jb?.status === 'done') await postSummary(me, j)
  })().catch((e) => console.warn('[ontology] read and build', e.message))
  return started
}

export async function postSummary(me, mailJob) {
  const m = await map({})
  const flows = m.processes.filter((p) => p.kind !== 'routine')
  const band = (k) => flows.filter((b) => b.band === k).length
  const t = await mainThread(me.id)
  const tasks = m.tasks.filter((x) => x.status !== 'retired').length
  const msg = await addMessage(me.id, t.id, 'agent', 'onto-summary', {
    text: `메일 ${mailJob?.total ?? '-'}통과 채팅 핸드오버를 읽어 일 ${tasks}개, 흐름 ${flows.length}개를 찾았어요. 굳은 길 ${band('paved')} · 열린 일 ${band('open')} · 지켜보기 ${band('watch')}.`,
    tasks, processes: flows.map((b) => ({ key: b.key, name: b.name, band: b.band, bandName: b.bandName, cases: b.cases })), sources: m.meta?.sources || {}, url: '/process-map',
  })
  return msg
}

export async function job(id) {
  const j = await jobOf(id)
  if (!j) throw err(404, '작업을 찾지 못했어요.')
  return j
}

// The map: tasks, NEXT edges and processes as of a point in time (validAt: the world then; default now), with the values
// set automatically and what they rest on. θ filtering is the screen's (it moves a slider over the same data).
export async function map({ validAt, systemAt } = {}) {
  if (!ontologyEnabled()) throw err(503, 'Ontological DB 가 연결되지 않았어요.')
  const g = await readGraph({ validAt, systemAt })
  const processes = g.processes.map((b) => ({ ...b, bandName: BAND_KO[b.band] || b.band }))
  // personal habits are all counted; the map shows the role routines the setting lets through (design-v0.3 §4)
  const settings = await habitSettings()
  const personal = (t) => ['habit', 'told', 'rule', 'timer'].includes(t.source) && String(t.scope || '').startsWith('role:')
  const triggers = g.triggers.filter((t) => !personal(t) || shownRoutine(t, settings))
  const routineTasks = new Set(triggers.filter(personal).map((t) => t.to))
  const shownRole = new Set(triggers.filter(personal).map((t) => String(t.scope || '').replace(/^role:/, '')))
  const procs = processes.filter((p) => p.kind !== 'routine' || shownRole.has(p.role))
    .map((p) => (p.kind === 'routine' ? { ...p, tasks: p.tasks.filter((t) => routineTasks.has(t)) } : p))
  const live = new Set(procs.map((p) => p.key))
  const routineKeys = new Set(procs.filter((p) => p.kind === 'routine').map((p) => p.key))
  const tasks = g.tasks.filter((t) => t.kind !== 'habit' || routineTasks.has(t.key))
    .map((t) => ({ ...t, procs: (t.procs || []).filter((k) => live.has(k)) })).map((t) => ({ ...t, proc: t.procs[0] || '' }))
  const hidden = g.triggers.length - triggers.length
  // a role's result events and a person's timers show only with a routine step the setting lets through
  const personalEvent = (e) => String(e.key).startsWith('artifact:@') || String(e.key).startsWith('link:@') || (e.kind === 'timer' && e.scope !== 'company')
  return { at: validAt || null, tasks, edges: g.edges, processes: procs, events: g.events.filter((e) => !personalEvent(e) || triggers.some((t) => t.from === e.key)),
    triggers, raises: g.raises, startsOn: g.startsOn.filter((x) => live.has(x.from)), hasTask: g.hasTask.filter((x) => live.has(x.from) && (!routineKeys.has(x.from) || routineTasks.has(x.to))),
    roles: g.roles, performedBy: g.performedBy, performers: g.performers, plays: g.plays, ofRole: g.ofRole.filter((x) => live.has(x.from)), ways: g.ways,
    habits: { ...settings, hidden }, meta: g.meta }
}

// 개인 습관을 지도에 보이는 설정(관리자): threshold(같은 역할 min 명 이상 · 본인이 공유한 것) | all(모두, 이름 없이) | off
export async function habitSettings() {
  const [r] = await q('select habit_publish as mode, habit_min_people as min from pro_onto_settings where tenant_id=$1', [config.tenantId]).catch(() => [])
  return { mode: r?.mode || 'threshold', min: r?.min ?? 3 }
}
export async function setHabitSettings(me, { mode, min }) {
  if (!['threshold', 'all', 'off'].includes(mode)) throw err(400, '설정은 threshold · all · off 가운데 하나예요.')
  const n = Math.max(1, Math.min(50, Math.round(Number(min) || 3)))
  await q(`insert into pro_onto_settings (tenant_id, habit_publish, habit_min_people, updated_by, updated_at) values ($1,$2,$3,$4,now())
           on conflict (tenant_id) do update set habit_publish=excluded.habit_publish, habit_min_people=excluded.habit_min_people, updated_by=excluded.updated_by, updated_at=now()`,
  [config.tenantId, mode, n, me.id])
  return habitSettings()
}

export async function labels() { return labelExamples(40) }

export { runMailHistory, cypher }
