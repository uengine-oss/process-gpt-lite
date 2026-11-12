// 프로세스 온톨로지 — what the routes call (spec pgpt-pro_process-ontology). Reading the mail history, building the
// graph, and the map a person sees (θ, a point in time, the automatic values with their evidence).
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

// 「지난 메일 읽기」: read the mailbox, then build the graph from it and the chat handovers already there; when the map
// is drawn, the person gets a summary card (the "ideas" the onboarding promised after the mail connection)
const waitJob = async (id, ms = 60 * 60_000) => {
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
  const band = (k) => m.bundles.filter((b) => b.band === k).length
  const t = await mainThread(me.id)
  const tasks = m.tasks.filter((x) => x.status !== 'retired').length
  const msg = await addMessage(me.id, t.id, 'agent', 'onto-summary', {
    text: `메일 ${mailJob?.total ?? '-'}통과 채팅 핸드오버를 읽어 일 ${tasks}개, 흐름 ${m.bundles.length}개를 찾았어요. 굳은 길 ${band('paved')} · 열린 일 ${band('open')} · 지켜보기 ${band('watch')}.`,
    tasks, bundles: m.bundles.map((b) => ({ key: b.key, name: b.name, band: b.band, bandName: b.bandName, cases: b.cases })), sources: m.meta?.sources || {}, url: '/process-map',
  })
  return msg
}

export async function job(id) {
  const j = await jobOf(id)
  if (!j) throw err(404, '작업을 찾지 못했어요.')
  return j
}

// The map: tasks, NEXT edges and bundles as of a point in time (validAt: the world then; default now), with the values
// set automatically and what they rest on. θ filtering is the screen's (it moves a slider over the same data).
export async function map({ validAt, systemAt } = {}) {
  if (!ontologyEnabled()) throw err(503, 'Ontological DB 가 연결되지 않았어요.')
  const g = await readGraph({ validAt, systemAt })
  const bundles = g.bundles.map((b) => ({ ...b, bandName: BAND_KO[b.band] || b.band }))
  return { at: validAt || null, tasks: g.tasks, edges: g.edges, bundles, meta: g.meta }
}

export async function labels() { return labelExamples(40) }

export { runMailHistory, cypher }
