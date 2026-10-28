// 일괄 반영: the chosen variations are merged one after another in an integration checkout that
// starts from main; main moves (fast-forward) only when every one went in. A conflict stops the
// run (policy stop) and waits: choose a side per file, or hand the conflicted files to a resolving
// agent (a deepagents run on a copy of them). People's own edits in main are committed first.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { q } from '../supa.js'
import * as G from './git.js'
import * as S from './service.js'
import { reindex } from './indexer.js'
import { runAgent, RULES, rules } from './runner.js'
import { L } from '../lang.js'
import { afterMerge } from './skills.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const intDir = (folder, id) => path.join(S.foldersRoot(), '.integrate', folder.slug, id)

export async function get(folder, id) {
  const [r] = await q('select * from pro_folder_integrations where id=$1 and folder_id=$2', [id, folder.id])
  if (!r) throw err(404, L('반영 기록을 찾지 못했어요.', "I couldn't find that merge."))
  return r
}

export async function start(folder, user, ids, policy = 'stop') {
  if (folder.kind === 'linked') throw err(400, L('연결형 폴더는 아직 이 화면에서 반영하지 않아요.', "Linked folders can't be merged from this screen yet."))
  if (!ids?.length) throw err(400, L('반영할 변형을 골라 주세요.', 'Please choose the variations to merge.'))
  const vs = []
  for (const id of ids) {
    const v = await S.variation(folder, id)
    if (v.status !== 'ready') throw err(409, L(`'${v.title}' 은(는) 아직 반영할 수 없어요 (${S.STATUS[v.status]}).`, `'${v.title}' can't be merged yet (${S.statusText(v.status)}).`))
    vs.push(v)
  }
  const running = await q(`select id from pro_folder_integrations where folder_id=$1 and status in ('running','conflicted','resolving')`, [folder.id])
  if (running.length) throw err(409, L('이 폴더에서 다른 반영이 진행 중이에요.', 'Another merge is in progress in this folder.'))
  await S.commitMain(folder, { name: user.name, email: user.email }, L('반영 전 main 의 편집 저장', 'Save edits on main before merging'))
  const id = crypto.randomUUID()
  const dir = intDir(folder, id)
  await fs.mkdir(path.dirname(dir), { recursive: true })
  const base = await G.head(folder.repo_path, folder.default_branch)
  await G.git(folder.repo_path, ['worktree', 'add', '-q', '--detach', dir, base])
  const [row] = await q(`insert into pro_folder_integrations (id, folder_id, variation_ids, policy, status, steps, base_commit, worktree_path, created_by)
                         values ($1,$2,$3,$4,'running','[]',$5,$6,$7) returning *`, [id, folder.id, vs.map((v) => v.id), policy, base, dir, user.id])
  return proceed(folder, row, user)
}

// merge the variations not merged yet; stop at the first conflict
async function proceed(folder, row, user) {
  const steps = row.steps || []
  for (const vid of row.variation_ids) {
    if (steps.some((s) => s.variation_id === vid)) continue
    const v = await S.variationById(vid)
    const out = await G.git(row.worktree_path, [...G.who(user.name, user.email), 'merge', '--no-ff', '--no-edit', '-m', L(`반영: ${v.title} (${v.branch})`, `Merge: ${v.title} (${v.branch})`), v.branch], { check: false })
    const unmerged = (await G.git(row.worktree_path, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean)
    if (unmerged.length) {
      const conflicts = []
      for (const p of unmerged) conflicts.push({ path: p, variation_id: vid, binary: await isBinaryConflict(row.worktree_path, p) })
      steps.push({ variation_id: vid, ok: false, title: v.title })
      await q(`update pro_folder_integrations set steps=$2, conflicts=$3, status='conflicted', updated_at=now() where id=$1`, [row.id, JSON.stringify(steps), JSON.stringify(conflicts)])
      await S.setStatus(v, 'conflicted')
      const r = await get(folder, row.id)
      if (row.policy === 'agent' && conflicts.every((c) => !c.binary)) return resolveWithAgent(folder, r, user)
      return r
    }
    if (/fatal|error/i.test(out) && !(await G.head(row.worktree_path))) throw err(500, out.slice(0, 300))
    steps.push({ variation_id: vid, ok: true, title: v.title })
    await q('update pro_folder_integrations set steps=$2, updated_at=now() where id=$1', [row.id, JSON.stringify(steps)])
  }
  return finish(folder, await get(folder, row.id), user)
}

async function isBinaryConflict(dir, p) {
  if (/\.(docx|xlsx|pptx|hwpx?|pdf|png|jpe?g|psd|mp4|wav|mp3)$/i.test(p)) return true
  const attr = await G.git(dir, ['check-attr', 'binary', '--', p], { check: false })
  return /binary: set/.test(attr)
}

// both sides of a conflicted file, for the screen: what main (plus what was merged before) has,
// and what the variation has
export async function sides(folder, row, rel) {
  const c = (row.conflicts || []).find((x) => x.path === rel)
  if (!c) throw err(404, L('충돌 파일이 아니에요.', "That file isn't in conflict."))
  const v = await S.variationById(c.variation_id)
  const ours = await G.git(row.worktree_path, ['show', `:2:${rel}`], { buffer: true, check: false })
  const theirs = await G.git(row.worktree_path, ['show', `:3:${rel}`], { buffer: true, check: false })
  const base = await G.git(row.worktree_path, ['show', `:1:${rel}`], { buffer: true, check: false })
  const txt = (b) => (c.binary || !b?.length ? null : b.toString('utf8'))
  return { path: rel, binary: c.binary, variation: { id: v.id, title: v.title, holder_name: v.holder_name }, base: txt(base), ours: txt(ours), theirs: txt(theirs) }
}

// choices: {path: 'ours'|'theirs'} — ours = main with the variations merged before this one
export async function choose(folder, row, user, choices = {}) {
  if (row.status !== 'conflicted') throw err(409, L('지금은 충돌을 풀 단계가 아니에요.', 'There is no conflict to resolve right now.'))
  for (const c of row.conflicts) {
    const side = choices[c.path]
    if (!['ours', 'theirs'].includes(side)) throw err(400, L(`'${c.path}' 의 쪽을 골라 주세요.`, `Please choose a side for '${c.path}'.`))
    await G.git(row.worktree_path, ['checkout', `--${side}`, '--', c.path])
    await G.git(row.worktree_path, ['add', '--', c.path])
  }
  return concludeConflict(folder, row, user, Object.fromEntries(row.conflicts.map((c) => [c.path, choices[c.path]])))
}

async function concludeConflict(folder, row, user, resolution) {
  await G.git(row.worktree_path, [...G.who(user.name, user.email), 'commit', '--no-edit', '-q'])
  const steps = row.steps.map((s) => (s.ok ? s : { ...s, ok: true, resolved: resolution }))
  for (const c of row.conflicts) await S.setStatus({ id: c.variation_id }, 'ready')
  await q(`update pro_folder_integrations set steps=$2, conflicts='[]', status='running', updated_at=now() where id=$1`, [row.id, JSON.stringify(steps)])
  return proceed(folder, await get(folder, row.id), user)
}

// a resolving agent gets copies of the conflicted text files (with the conflict markers) in its
// own run folder, edits them, and the result goes back into the integration checkout
export async function resolveWithAgent(folder, row, user, jwt) {
  if (row.conflicts.some((c) => c.binary)) throw err(400, L('문서·미디어 파일 충돌은 한쪽을 골라 주세요.', 'For a document or media file conflict, please choose one side.'))
  jwt = jwt || pendingJwt.get(user.id)
  if (!jwt) throw err(400, L('해결 에이전트를 부를 수 없어요(로그인 정보 없음).', "I can't call the resolving agent (no sign-in)."))
  await q(`update pro_folder_integrations set status='resolving', updated_at=now() where id=$1`, [row.id])
  const room = `fold-merge-${row.id}`
  const dir = S.runCheckoutDir(room, folder)
  const container = S.runCheckoutContainer(room, folder)
  await fs.rm(dir, { recursive: true, force: true })
  for (const c of row.conflicts) {
    await fs.mkdir(path.dirname(path.join(dir, c.path)), { recursive: true })
    await fs.copyFile(path.join(row.worktree_path, c.path), path.join(dir, c.path))
  }
  const titles = row.steps.filter((s) => !s.ok).map((s) => s.title).join(', ')
  const msg = L(`공유 폴더 '${folder.name}' 에 변형(${titles})을 합치다가 충돌이 났어요. 작업 폴더: ${container}
충돌 파일: ${row.conflicts.map((c) => c.path).join(', ')}
각 파일의 <<<<<<< / ======= / >>>>>>> 표시 사이에 양쪽 변경이 있어요. 두 쪽의 의도를 모두 살려 하나로 합치고, 충돌 표시는 모두 지워서 파일을 저장하세요. ${RULES}
끝나면 무엇을 어떻게 합쳤는지 한두 문장으로 알려 주세요.`, `Merging the variations (${titles}) into the shared folder '${folder.name}' ran into conflicts. Working folder: ${container}
Conflicting files: ${row.conflicts.map((c) => c.path).join(', ')}
In each file both changes sit between the <<<<<<< / ======= / >>>>>>> markers. Combine them into one that keeps the intent of both, remove every conflict marker and save the file. ${rules()}
When you are done, say in one or two sentences what you combined and how.`)
  let note = ''
  try {
    note = await runAgent({ jwt, user, conversationId: room, message: msg })
  } catch (e) {
    await q(`update pro_folder_integrations set status='conflicted', updated_at=now() where id=$1`, [row.id])
    throw e
  }
  for (const c of row.conflicts) {
    const text = await fs.readFile(path.join(dir, c.path), 'utf8')
    if (/^(<<<<<<<|>>>>>>>)/m.test(text)) {
      await q(`update pro_folder_integrations set status='conflicted', updated_at=now() where id=$1`, [row.id])
      throw err(422, L(`해결 에이전트가 '${c.path}' 의 충돌을 다 풀지 못했어요. 직접 골라 주세요.`, `The resolving agent couldn't resolve every conflict in '${c.path}'. Please choose yourself.`))
    }
    await fs.writeFile(path.join(row.worktree_path, c.path), text)
    await G.git(row.worktree_path, ['add', '--', c.path])
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  return concludeConflict(folder, await get(folder, row.id), user, { agent: note.slice(0, 600) })
}
// the merge screen calls start() with the user's token; an agent-policy merge needs it later
export const pendingJwt = new Map()

async function finish(folder, row, user) {
  const result = await G.head(row.worktree_path)
  // people may have edited main meanwhile: keep their edit, then try to move main forward
  await S.commitMain(folder, { name: user.name, email: user.email }, L('반영 전 main 의 편집 저장', 'Save edits on main before merging'))
  const ff = await G.git(folder.repo_path, ['merge', '--ff-only', '-q', result], { check: false })
  const now = await G.head(folder.repo_path, folder.default_branch)
  if (now !== result) {
    // main moved: merge the integration result into it (a plain merge; conflicts here go back to the screen)
    const out = await G.git(folder.repo_path, [...G.who(user.name, user.email), 'merge', '--no-edit', '-m', L('일괄 반영', 'Merge all'), result], { check: false })
    const unmerged = (await G.git(folder.repo_path, ['diff', '--name-only', '--diff-filter=U'])).trim()
    if (unmerged) {
      await G.git(folder.repo_path, ['merge', '--abort'], { check: false })
      await q(`update pro_folder_integrations set status='aborted', updated_at=now() where id=$1`, [row.id])
      throw err(409, L(`반영하는 사이 main 이 바뀌어 충돌이 났어요. 다시 반영해 주세요. (${ff || out})`, `main changed during the merge and now conflicts. Please merge again. (${ff || out})`).slice(0, 300))
    }
  }
  const head = await G.head(folder.repo_path, folder.default_branch)
  for (const vid of row.variation_ids) {
    const v = await S.variationById(vid)
    if (v.worktree_path) await S.release(folder, v)
    await q(`update pro_folder_variations set status='merged', updated_at=now() where id=$1`, [vid])
  }
  await G.git(folder.repo_path, ['worktree', 'remove', '--force', row.worktree_path], { check: false })
  await G.git(folder.repo_path, ['worktree', 'prune'], { check: false })
  await q(`update pro_folder_integrations set status='done', result_commit=$2, worktree_path=null, updated_at=now() where id=$1`, [row.id, head])
  await S.touch(folder)
  if (folder.kind === 'skill') await afterMerge(folder, row.variation_ids, user).catch((e) => console.warn('[skills] after merge', e.message))
  reindex(folder).catch((e) => console.warn('[folders] reindex', e.message))
  return get(folder, row.id)
}

export async function abort(folder, row) {
  if (row.worktree_path) {
    await G.git(row.worktree_path, ['merge', '--abort'], { check: false })
    await G.git(folder.repo_path, ['worktree', 'remove', '--force', row.worktree_path], { check: false })
    await G.git(folder.repo_path, ['worktree', 'prune'], { check: false })
  }
  for (const c of row.conflicts || []) await S.setStatus({ id: c.variation_id }, 'ready')
  await q(`update pro_folder_integrations set status='aborted', worktree_path=null, updated_at=now() where id=$1`, [row.id])
  return get(folder, row.id)
}
