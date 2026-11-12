// AI-DLC projects are shared folders (usually linked git repositories) that hold an aidlc/ record.
// Who may look is the folder's: viewer and up. Everything here only reads the folder's working copy.
import * as F from '../folders/service.js'
import * as R from './record.js'
import * as M from './metrics.js'
import { describeStage } from './stages.js'

async function rootOf(slug, user) {
  const { folder, role } = await F.access(R.safeName(slug), user, 'viewer')
  return { root: folder.repo_path, folder, role }
}

export async function projects(user) {
  const out = []
  for (const id of await F.readableFolderIds(user.id)) {
    const f = await F.folderById(id)
    if (!f || f.kind === 'skill' || !f.repo_path || !(await R.hasAidlc(f.repo_path))) continue
    out.push({ folder: f.slug, name: f.name, kind: f.kind, intents: await R.listIntents(f.repo_path) })
  }
  return out
}

// the same list by name only (the chat asks "is there a project this request is for?" on every turn)
export async function projectsOf(user) {
  const out = []
  for (const id of await F.readableFolderIds(user.id)) {
    const f = await F.folderById(id)
    if (!f || f.kind === 'skill' || !f.repo_path || !(await R.hasAidlc(f.repo_path))) continue
    out.push({ folder: f.slug, name: f.name, at: f.updated_at })
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

export async function intents(slug, user) {
  const { root } = await rootOf(slug, user)
  return R.listIntents(root)
}

async function record(slug, user, space, intent) {
  const { root, role } = await rootOf(slug, user)
  const { dir, intent: meta } = await R.intentDir(root, space, intent)
  return { dir, meta, role }
}

// everything the dashboards need in one call
export async function summary(slug, user, space, intent, now = Date.now()) {
  const { dir, meta, role } = await record(slug, user, space, intent)
  const [state, events, units, questions, reviews] = await Promise.all([R.readState(dir), R.readAudit(dir), R.readUnits(dir), R.listQuestions(dir), R.listReviews(dir)])
  return build({ folder: slug, meta, role, state, events, units, questions, reviews, now })
}

// pure: the summary from what was read (also what the tests check)
export function build({ folder, meta, role = null, state, events, units, questions, reviews, now = Date.now() }) {
  const stages = M.stageMetrics(events, now)
  const unitRows = M.unitMetrics(events, units, now)
  const waiting = [
    ...stages.filter((s) => s.state === 'waiting').map((s) => ({ kind: 'stage', name: s.name, slug: s.slug, role: s.role, since: s.waitingSince, minutes: s.waitingMin })),
    ...unitRows.filter((u) => u.status === 'waiting').map((u) => ({ kind: 'unit', name: u.name, slug: 'code-generation', role: describeStage('code-generation').role, since: u.waitingSince, minutes: u.humanMin })),
  ]
  return {
    folder, space: meta.space, slug: meta.slug, scope: meta.scope || state.scope, status: meta.status, role,
    project: state.project, depth: state.depth, testStrategy: state.testStrategy, autonomy: state.autonomy,
    current: state.currentStage ? describeStage(state.currentStage) : null,
    next: state.nextStage && state.nextStage !== 'none' ? describeStage(state.nextStage) : null,
    runStatus: state.status, nextAction: state.nextAction,
    rail: M.rail(state), stages, units: unitRows, waiting,
    counts: M.counts(events),
    quality: {
      reviews: M.reviewSummary(reviews),
      sensorFailures: events.filter((e) => e.event === 'SENSOR_FAILED').slice(-20).map((e) => ({ ts: e.ts, sensor: e.fields['Sensor ID'] || '', stage: describeStage(e.stage).name, path: e.fields['Output path'] || '' })),
    },
    questions: { files: questions.length, open: questions.reduce((n, f) => n + f.open, 0) },
  }
}

export async function timeline(slug, user, space, intent, opts) {
  const { dir } = await record(slug, user, space, intent)
  return M.timeline(await R.readAudit(dir), opts)
}

export async function questions(slug, user, space, intent) {
  const { dir } = await record(slug, user, space, intent)
  return (await R.listQuestions(dir)).map((f) => ({ ...f, stageName: describeStage(f.stage).name, role: describeStage(f.stage).role }))
}

export async function reviews(slug, user, space, intent) {
  const { dir } = await record(slug, user, space, intent)
  return R.listReviews(dir)
}
