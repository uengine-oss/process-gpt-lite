// The AI-DLC watcher: for every shared folder holding an AI-DLC record, what waits on a person now —
// a selection prompt on the team session's screen (how to answer, the summary, a stage approval, a
// tool permission), or a question file whose answers are blank — becomes one Home card for the people
// in the stage's role (lib/aidlc/team.js deciders), opening the decision page. A wait that is over is
// closed and its cards leave Home.
import { q, eachTenant } from '../supa.js'
import { config } from '../../config.js'
import { L } from '../lang.js'
import { notifyUser } from '../notify.js'
import { emit } from '../bus.js'
import * as R from './record.js'
import * as AS from './session.js'
import * as TM from './team.js'

const T = () => config.tenantId
const url = (slug) => `/aidlc/${slug}/decide`

// what waits on a person in one folder now: [{ key, kind, stage, roleKey, title, text }]
export async function waitsOf(folder) {
  const cur = await TM.currentIntent(folder.repo_path).catch(() => null)
  if (!cur) return []
  const stage = cur.stage
  const name = AS.sessionName(T(), folder.slug)
  const choice = (await AS.has(name)) ? AS.parseChoice(await AS.screen(name).catch(() => '')) : null
  if (choice) {
    const kind = TM.promptKind(choice)
    // a tool permission while code is written is the developer's to answer
    const roleKey = kind === 'permission' && stage.phase === 'construction' ? 'developer' : stage.roleKey
    return [{ key: `prompt:${choice.fingerprint}`, kind: 'prompt', stage: stage.slug, roleKey, title: TM.promptTitle(kind, stage.name), text: choice.question || choice.title }]
  }
  // no prompt on screen: question files of the stage with blank answers (the team answers in the file)
  const files = (await R.listQuestions(cur.dir)).filter((f) => f.open > 0 && f.stage === stage.slug)
  return files.map((f) => {
    const open = f.questions.filter((x) => !x.answer)
    return { key: `questions:${f.path}:${open.map((x) => x.id).join(',')}`, kind: 'questions', stage: stage.slug, roleKey: stage.roleKey,
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
    for (const p of await TM.deciders(folder, w.roleKey)) {
      if (p.id) await notifyUser(p.id, { type: 'aidlc', title: `${folder.name} · ${w.title}`, text: w.text, url: url(folder.slug) })
    }
    fresh.push(w)
  }
  const gone = [...known].filter((k) => !now.some((w) => w.key === k))
  if (gone.length) {
    await q('update pro_aidlc_waits set closed_at=now() where tenant_id=$1 and folder_id=$2 and wait_key = any($3)', [T(), folder.id, gone])
    // nothing left to decide in this folder: its cards leave Home
    if (!now.length) {
      const users = await q(`update notifications set is_checked=true where tenant_id=$1 and type='aidlc' and url=$2 and not coalesce(is_checked,false) returning user_id`, [T(), url(folder.slug)])
      for (const u of new Set(users.map((x) => x.user_id))) emit(u, 'notifications', {})
    }
  }
  if (fresh.length || gone.length) emit(`aidlc:${folder.slug}`, 'aidlc', { waits: now.length })
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
