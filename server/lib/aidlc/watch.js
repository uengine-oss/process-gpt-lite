// The AI-DLC watcher: for every shared folder holding an AI-DLC record, what waits on a person now —
// a selection prompt on the team session's screen (how to answer, the summary, a stage approval, a
// tool permission), or a question file whose answers are blank — becomes one Home card for the people
// in the stage's role (lib/aidlc/team.js deciders), opening the decision page. A wait that is over is
// closed and its cards leave Home.
import crypto from 'node:crypto'
import { q, eachTenant } from '../supa.js'
import { config } from '../../config.js'
import { L } from '../lang.js'
import { notifyUser } from '../notify.js'
import { emit } from '../bus.js'
import * as R from './record.js'
import * as F from '../folders/service.js'
import * as AS from './session.js'
import * as TM from './team.js'
import * as APPS from '../apps/registry.js'

const T = () => config.tenantId
// each wait's card opens the decision page; its own address lets it leave Home when that wait is over
export const waitUrl = (slug, key) => `/aidlc/${slug}/decide?w=${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`

// what waits on a person in one folder now: [{ key, kind, stage, roleKey, title, text }]
export async function waitsOf(folder) {
  const cur = await TM.currentIntent(folder.repo_path).catch(() => null)
  if (!cur) return []
  const stage = cur.stage
  const name = AS.sessionName(T(), folder.slug)
  const choice = (await AS.has(name)) ? AS.parseChoice(await AS.screen(name).catch(() => '')) : null
  if (choice) {
    const kind = TM.promptKind(choice)
    // a tool permission while code is written is the developer's to answer (lib/aidlc/team.js waitRole)
    const roleKey = TM.waitRole(stage, choice)
    // a permission card says which tool and command asks (the box above the question)
    const text = choice.detail ? `${choice.title} — ${choice.detail.split('\n').slice(0, 2).join(' · ')}` : choice.question || choice.title
    return [{ key: `prompt:${choice.fingerprint}`, kind: 'prompt', promptKind: kind, stage: stage.slug, roleKey, title: TM.promptTitle(kind, stage.name), text: text.slice(0, 400) }]
  }
  // no prompt on screen: question files of the stage with blank answers (the team answers in the file)
  // (a blank summary confirmation is the session's own prompt, coming next — not a question for the team)
  const files = (await R.listQuestions(cur.dir)).filter((f) => f.stage === stage.slug && f.questions.some((x) => !x.answer && !x.summary))
  return files.map((f) => {
    const open = f.questions.filter((x) => !x.answer && !x.summary)
    return { key: `questions:${f.path}:${open.map((x) => x.id).join(',')}`, kind: 'questions', path: f.path, questions: open, stage: stage.slug, roleKey: stage.roleKey,
      title: L(`${stage.name} 질문 ${open.length}개가 답을 기다려요`, `${open.length} ${stage.name} question(s) wait for answers`),
      text: open.map((x) => `${x.id}. ${x.text}`).join(' / ').slice(0, 300) }
  })
}

export async function scanFolder(folder) {
  const now = await waitsOf(folder)
  const open = await q('select wait_key from pro_aidlc_waits where tenant_id=$1 and folder_id=$2 and closed_at is null', [T(), folder.id])
  const known = new Set(open.map((x) => x.wait_key))
  const fresh = []
  for (const w of now) {
    if (known.has(w.key)) continue
    // (a wait seen before and closed, then back — the same prompt again — is announced again)
    const [row] = await q(`insert into pro_aidlc_waits(tenant_id,folder_id,wait_key,kind,stage,role_key,title) values ($1,$2,$3,$4,$5,$6,$7)
                           on conflict (tenant_id,folder_id,wait_key) do update set closed_at=null, opened_at=now() where pro_aidlc_waits.closed_at is not null
                           returning wait_key`, [T(), folder.id, w.key, w.kind, w.stage, w.roleKey, w.title])
    if (!row) continue
    // a kind an app handles (lib/apps: the review board takes questions and approvals) opens in that app,
    // which may also tell the people its items go to
    const via = APPS.handlerFor(w.kind === 'questions' ? 'aidlc.questions' : w.promptKind === 'approval' ? 'aidlc.approval' : '')
    const url = via ? APPS.appWaitUrl(via.id, folder.slug, w.key) : waitUrl(folder.slug, w.key)
    const told = new Set()
    for (const p of await TM.deciders(folder, w.roleKey)) {
      if (p.id) { await notifyUser(p.id, { type: 'aidlc', title: `${folder.name} · ${w.title}`, text: w.text, url }); told.add(p.id) }
    }
    if (via?.notify) await via.notify({ id: folder.id, slug: folder.slug, name: folder.name }, w, url, told).catch((e) => console.warn('[aidlc watch] app', via.id, e.message))
    fresh.push(w)
  }
  const gone = [...known].filter((k) => !now.some((w) => w.key === k))
  if (gone.length) {
    await q('update pro_aidlc_waits set closed_at=now() where tenant_id=$1 and folder_id=$2 and wait_key = any($3)', [T(), folder.id, gone])
    // a wait that is over: its cards leave Home
    const urls = gone.flatMap((k) => [waitUrl(folder.slug, k), ...APPS.handlerIds().map((id) => APPS.appWaitUrl(id, folder.slug, k))])
    const users = await q(`update notifications set is_checked=true where tenant_id=$1 and type='aidlc' and url = any($2) and not coalesce(is_checked,false) returning user_id`,
      [T(), urls])
    for (const u of new Set(users.map((x) => x.user_id))) emit(u, 'notifications', {})
  }
  // open app screens of this folder look again (a new question file, an approval, a wait that ended)
  if (fresh.length || gone.length) {
    for (const m of await F.members(folder.id)) if (m.type === 'user' && !m.is_agent) emit(m.id, 'app', { app: '*', folder: folder.slug, type: 'aidlc.waits', data: { waits: now.length } })
  }
  return { fresh, gone }
}

export async function scanOnce() {
  const folders = await q(`select * from pro_folders where tenant_id=$1 and repo_path is not null and kind <> 'skill'`, [T()])
  for (const f of folders) {
    if (!(await R.hasAidlc(f.repo_path))) continue
    await scanFolder(f).catch((e) => console.warn('[aidlc watch]', f.slug, e.message))
  }
}

let started = false
export function startAidlcWatch(ms = 8000) {
  if (started) return
  started = true
  setInterval(() => eachTenant(() => scanOnce().catch((e) => console.warn('[aidlc watch]', e.message))), ms)
}
