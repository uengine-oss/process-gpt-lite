// The host context an app gets (contract v1, lib/apps/registry.js): everything an app may use of
// Lite, and nothing else. An app reaches a folder's AI-DLC work through ctx.aidlc.open(slug, user),
// which checks the person's access first and hands back that work's readers and the two ways a
// person's decision gets into the team session (a choice in its prompt, answers in a question file).
// Kept small and plain-data so it can later be served over HTTP to an app running as its own process.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { emit } from '../bus.js'
import { L, isEn } from '../lang.js'
import { notifyUser } from '../notify.js'
import * as F from '../folders/service.js'
import * as R from '../aidlc/record.js'
import * as M from '../aidlc/metrics.js'
import * as AS from '../aidlc/session.js'
import * as TM from '../aidlc/team.js'
import * as MOB from '../aidlc/mob.js'
import { describeStage, roleName, ROLE_KEYS } from '../aidlc/stages.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const pub = (f) => ({ id: f.id, slug: f.slug, name: f.name })

// user null: the server's own look (an app's waits.notify, run by the watcher) — no person's access
async function openWork(slug, user, need = 'viewer') {
  const { folder, role } = user ? await F.access(R.safeName(slug), user, need) : { folder: await F.folderBySlug(R.safeName(slug)), role: 'viewer' }
  if (!folder) throw err(404, 'folder not found')
  if (!folder.repo_path || !(await R.hasAidlc(folder.repo_path))) throw err(404, 'no AI-DLC record in this folder')
  const cur = await TM.currentIntent(folder.repo_path)
  const dir = cur?.dir
  // the server's own look runs when a wait has just appeared: see the files written a moment ago
  if (!user && dir) R.forget(dir)
  const need404 = () => { if (!dir) throw err(404, 'no AI-DLC work in this folder') }
  const session = AS.sessionName(config.tenantId, folder.slug)
  return {
    folder: pub(folder), role, canEdit: F.RANK[role] >= F.RANK.editor,
    intent: cur && { space: cur.space, slug: cur.slug, scope: cur.scope, status: cur.state.status, project: cur.state.project },
    stage: cur?.stage || null, unit: cur?.unit || null, stateStage: cur ? describeStage(cur.state.currentStage) : null,
    describeStage, roleName, roleKeys: ROLE_KEYS,
    // ---- the record (read only) ----
    // read the record afresh on the next call (a file written a moment ago)
    fresh: () => { if (dir) R.forget(dir) },
    questions: async () => { need404(); return R.listQuestions(dir) },
    reviews: async () => { need404(); return R.listReviews(dir) },
    units: async () => { need404(); return R.readUnits(dir) },
    bolts: async (unitNames) => { need404(); return R.readBolts(dir, unitNames) },
    events: async () => { need404(); return R.readAudit(dir) },
    unitMetrics: async () => { need404(); return M.unitMetrics(await R.readAudit(dir), await R.readUnits(dir)) },
    stageMetrics: async () => { need404(); return M.stageMetrics(await R.readAudit(dir)) },
    docs: async () => { need404(); return R.docList(dir) },
    readDoc: async (rel) => { need404(); return R.readDoc(dir, rel) },
    // places named in prose (a finding's Location) as links into the record
    refs: async (text, stage) => { need404(); return R.resolveRefs(text, await R.docList(dir), stage) },
    // ---- the people ----
    members: async () => (await F.members(folder.id)).filter((m) => m.type === 'user' && !m.is_agent).map((m) => ({ id: m.id, name: m.name, role: m.role })),
    holders: (roleKey) => TM.holders(folder.id, roleKey),
    deciders: (roleKey) => TM.deciders(folder, roleKey),
    mayDecide: async (roleKey) => !!user && ( (F.RANK[role] >= F.RANK.editor) || (roleKey ? (await TM.holders(folder.id, roleKey)).some((p) => p.id === user.id) : false)),
    // ---- the team session ----
    session: async () => {
      const running = await AS.has(session)
      const choice = running ? AS.parseChoice(await AS.screen(session).catch(() => '')) : null
      return { running, workroom: `/workroom/aidlc/${folder.slug}`, choice: choice && { ...choice, kind: TM.promptKind(choice), title: TM.promptTitle(TM.promptKind(choice), cur?.stage?.name || '') } }
    },
    // the last lines of the session's screen, as text (what the shared terminal shows now)
    screen: async (lines = 40) => {
      if (!(await AS.has(session))) return null
      const text = await AS.screen(session).catch(() => '')
      return text.split('\n').filter((l, i, a) => i < a.length - 1 || l.trim()).slice(-Math.min(Math.max(lines, 5), 120)).join('\n')
    },
    decide: (body) => { if (!user) throw err(403, 'a person decides'); return TM.decide(folder.slug, user, body) },
    answers: (body) => { if (!user) throw err(403, 'a person decides'); return TM.submitAnswers(folder.slug, user, body) },
    mob: (opts) => { if (!user) throw err(403, 'a person starts a meeting'); return MOB.startMob(folder.slug, user, opts) },
  }
}

export function makeContext(manifest) {
  const id = manifest.id
  return {
    contract: 1,
    app: { id, version: manifest.version },
    db: { q },
    L, isEn,
    tenant: () => config.tenantId,
    aidlc: { open: (slug, user, need) => { if (!user?.id) throw err(401, 'sign in'); return openWork(slug, user, need) }, system: (slug) => openWork(slug, null) },
    events: {
      // live to everyone in a folder who has Lite open: the SSE event 'app', for this app's ui only
      async toFolder(folder, type, data) {
        for (const m of await F.members(folder.id)) if (m.type === 'user' && !m.is_agent) emit(m.id, 'app', { app: id, folder: folder.slug, type, data })
      },
      toUser: (userId, type, data) => emit(userId, 'app', { app: id, type, data }),
    },
    notify: (userId, { title, text, url }) => notifyUser(userId, { type: 'aidlc', title, text, url }),
  }
}
