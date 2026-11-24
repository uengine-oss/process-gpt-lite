// An instance's line in a folder (inst/<id>): the branch the steps of one process instance chain on — each agent step starts from what the
// earlier ones left (work.js baseOf '@previous'). A step of another engine moves it to its result (work.js), and the work folder of an
// instance started from a mail writes its later mails and the finished steps' outputs on it (lib/mailWork.js). It is a variation like
// any other (kind instance): a person reviews it and merges it into main.
// One writer at a time per folder's lines; a line that someone else moved meanwhile is merged into, never pushed back.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { q } from '../supa.js'
import * as G from './git.js'
import * as S from './service.js'
import { L } from '../lang.js'

const ZERO = '0'.repeat(40)
export const lineOf = (instId) => `inst/${String(instId || '').replace(/[^A-Za-z0-9]/g, '').slice(-12)}`
const lockOf = (folder) => `${folder.id}:line`
const isAncestor = async (repo, a, b) => !!a && !!b && (await G.mergeBase(repo, a, b)) === a

// the line among the folder's variations (one row per line, its head kept current)
export async function lineVariation(folder, line, head, { instId = null, name = '' } = {}) {
  const [i] = !name && instId ? await q('select proc_inst_name from bpm_proc_inst where proc_inst_id=$1', [instId]) : []
  const label = name || i?.proc_inst_name || instId || line
  await q(`insert into pro_folder_variations (folder_id, branch, title, kind, status, base_commit, head_commit, holder_type, holder_id, holder_name, source)
           values ($1,$2,$3,'instance','ready',$4,$5,'user',null,$7,$6)
           on conflict (folder_id, branch) do update set head_commit=$5, status='ready', updated_at=now()`,
  [folder.id, line, L(`${label} — 인스턴스 라인`, `${label} — instance line`), await G.mergeBase(folder.repo_path, folder.default_branch, head), head,
    { label, ...(instId ? { proc_inst_id: instId } : {}) }, L('프로세스', 'Process')])
  await S.touch(folder)
}

// fn(dir) works in a checkout of the line and commits there. The checkout is detached (the line itself may be out elsewhere: a person's
// checkout of its variation) and goes away afterwards; a line not made yet starts from main. → the line's new head, or null (nothing new)
async function inLine(folder, line, fn, meta) {
  const old = await G.head(folder.repo_path, `refs/heads/${line}`)
  const from = old || await G.head(folder.repo_path, folder.default_branch)
  const dir = path.join(S.foldersRoot(), '.lines', `${folder.slug}-${crypto.randomBytes(4).toString('hex')}`)
  await fs.mkdir(path.dirname(dir), { recursive: true })
  await G.git(folder.repo_path, ['worktree', 'add', '-q', '--detach', dir, from])
  try {
    await fn(dir)
    const head = await G.head(dir)
    if (!head || head === from) return null
    await G.git(folder.repo_path, ['update-ref', `refs/heads/${line}`, head, old || ZERO])
    if (meta.record !== false) await lineVariation(folder, line, head, meta)
    return head
  } finally {
    await G.git(folder.repo_path, ['worktree', 'remove', '--force', dir], { check: false })
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    await G.git(folder.repo_path, ['worktree', 'prune'], { check: false })
  }
}
export const onLine = (folder, line, fn, meta = {}) => S.serial(lockOf(folder), () => inLine(folder, line, fn, meta))

// merge `ref` into a checkout; a conflict is undone (→ false)
async function mergeIn(dir, ref, message, who = {}) {
  await G.git(dir, [...G.who(who.name || 'Process GPT', who.email), 'merge', '--no-edit', '-q', '-m', message, ref], { check: false })
  if ((await G.git(dir, ['diff', '--name-only', '--diff-filter=U'], { check: false })).trim()) {
    await G.git(dir, ['merge', '--abort'], { check: false })
    return false
  }
  return true
}

// The line moves to `head` (a step's result, work.js): a fast-forward when head grew from the line. When the line moved meanwhile (a mail
// came in, another step finished) head is merged into it; a conflict leaves the line as it was (the step's own variation keeps its result).
// meta.record false: a branch that has its own variation row (a project's variation that a chat's local CLI works on — localAgents/chat.js)
// is moved without being recorded as an instance line. (A branch checked out in a worktree is not moved here: its worktree would not follow.)
export function advanceLine(folder, line, head, meta = {}) {
  return S.serial(lockOf(folder), async () => {
    const old = await G.head(folder.repo_path, `refs/heads/${line}`)
    if (!old || await isAncestor(folder.repo_path, old, head)) {
      await G.git(folder.repo_path, ['update-ref', `refs/heads/${line}`, head, old || ZERO])
      if (meta.record !== false) await lineVariation(folder, line, head, meta)
      return head
    }
    if (await isAncestor(folder.repo_path, head, old)) return old
    let ok = true
    const now = await inLine(folder, line, async (dir) => { ok = await mergeIn(dir, head, L('단계 결과 잇기', 'Bring in a step result')) }, meta)
    if (!ok) console.warn(`[folders] line ${line} of '${folder.slug}': ${String(head).slice(0, 8)} conflicts, left as it was`)
    return now || old
  })
}

// what main has that the line has not (a mail that came in after the first step) goes onto the line too: the next step starts from it
export function syncLine(folder, line, meta = {}) {
  return S.serial(lockOf(folder), async () => {
    const old = await G.head(folder.repo_path, `refs/heads/${line}`)
    const main = await G.head(folder.repo_path, folder.default_branch)
    if (!old || !main || await isAncestor(folder.repo_path, main, old)) return null
    let ok = true
    const head = await inLine(folder, line, async (dir) => { ok = await mergeIn(dir, folder.default_branch, L('main 의 새 파일 잇기', 'Bring in what main has new')) }, meta)
    if (!ok) console.warn(`[folders] line ${line} of '${folder.slug}': main conflicts, left as it was`)
    return head
  })
}
