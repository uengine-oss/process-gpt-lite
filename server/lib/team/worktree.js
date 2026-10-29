// Team shares on the handover artifact worktree (공유 = 분기). The same tables, functions and key
// rules as process-gpt's chat handover (vue3 src/utils/artifactWorktree.js, deepagents
// core/storage/worktree.py): one repo per thread, one branch per room, immutable commits whose tree is
// path → {sha256, size, content_type}, content stored once at files/artifacts/{tenant}/objects/{sha}.
// A Lite room is a conversation: `pro:<pro_threads.id>`. This server writes through the service
// connection only after it has checked the caller owns the conversation (routes/team.js).
// Design: process-gpt/openspec/changes/pgpt-pro-share-worktree/design.md
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import { workspaceHostPath } from '../missions.js'
import { fetchRoomFile } from '../roomStore.js'
import { TeamError } from './access.js'
import { objectOf } from './shares.js'

const BUCKET = 'files'
const RETRY_LIMIT = 5
const T = () => config.tenantId

export const roomOf = (threadId) => `pro:${threadId}`
export const threadOfRoom = (room) => (/^pro:([0-9a-f-]{36})$/i.exec(String(room || '')) || [])[1] || null
// deepagents names the room's work folder after the conversation id (core/skills/tools.py _conv_slug)
const slugOf = (room) => String(room).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')

export const objectKey = (sha) => `artifacts/${T()}/objects/${sha}`
export const objectUrl = (entry) => (entry?.sha256 ? `${config.supabaseUrl}/storage/v1/object/public/${BUCKET}/${objectKey(entry.sha256)}` : '')

const TYPES = { txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', xml: 'application/xml',
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwpx: 'application/hwp+zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
const typeOf = (path, fallback) => TYPES[String(path).split('.').pop().toLowerCase()] || fallback || 'application/octet-stream'
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// the content once: an object that is already there is success
export async function putObject(buf, path, type) {
  const sha = sha256(buf)
  const content_type = typeOf(path, type)
  const { error } = await admin.storage.from(BUCKET).upload(objectKey(sha), buf, { contentType: content_type, upsert: false })
  if (error && !/409|Duplicate|already exists/i.test(`${error.statusCode || ''} ${error.error || ''} ${error.message || ''}`)) throw error
  return { sha256: sha, size: buf.length, content_type }
}

// ---- trees (pure; the same rules as vue3 artifactWorktree.js — test/worktree.test.js) ----
const same = (a, b) => (a?.sha256 || null) === (b?.sha256 || null)

export function diffTrees(base = {}, head = {}) {
  const added = [], modified = [], removed = []
  for (const p of Object.keys(head)) if (!(p in base)) added.push(p); else if (!same(base[p], head[p])) modified.push(p)
  for (const p of Object.keys(base)) if (!(p in head)) removed.push(p)
  return { added: added.sort(), modified: modified.sort(), removed: removed.sort() }
}

export function pickTree(tree, paths) {
  const out = {}
  for (const p of paths) if (tree?.[p]) out[p] = tree[p]
  return out
}

// base → mine changes laid on theirs
export function rebaseChanges(base, mine, theirs) {
  const out = { ...(theirs || {}) }
  const d = diffTrees(base || {}, mine || {})
  for (const p of [...d.added, ...d.modified]) out[p] = mine[p]
  for (const p of d.removed) delete out[p]
  return out
}

// what a branch did, on top of the batch base: it started with the picked files only, so files it
// never received are not deletions
export const sideTree = (baseTree, startTree, headTree) => rebaseChanges(startTree || {}, headTree || {}, baseTree || {})

// 3-way merge over the batch base. sides: [{key, label, tree}]. A path one side changed takes that
// side; sides that changed it differently are a conflict unless choices[path] names one.
export function mergeTrees(base = {}, sides, choices = {}) {
  const paths = new Set(Object.keys(base))
  for (const s of sides) for (const p of Object.keys(s.tree || {})) paths.add(p)
  const tree = {}, conflicts = []
  for (const path of [...paths].sort()) {
    const changed = sides.filter((s) => !same(s.tree?.[path], base[path])).map((s) => ({ key: s.key, label: s.label, entry: s.tree?.[path] || null }))
    const distinct = changed.filter((c, i) => changed.findIndex((d) => same(d.entry, c.entry)) === i)
    let result
    if (!distinct.length) result = base[path] || null
    else if (distinct.length === 1) result = distinct[0].entry
    else {
      const chosen = choices[path] ? changed.find((c) => c.key === choices[path]) : null
      if (chosen) result = chosen.entry
      else { conflicts.push({ path, sides: changed }); result = base[path] || null }
    }
    if (result) tree[path] = result
  }
  return { tree, conflicts }
}

// ---- reads ----
export async function branchHead(room) {
  const [b] = await q(`select b.*, c.tree, c.created_at as head_at, c.author_id, c.reason from artifact_branches b
                       join artifact_commits c on c.id=b.head_commit_id where b.room_id=$1`, [room])
  return b || null
}
export async function commit(id) {
  if (!id) return null
  const [c] = await q('select * from artifact_commits where id=$1', [id])
  return c || null
}

// ---- writes (service connection; callers have checked ownership) ----
// change(tree) → new tree; retried on a moved head (40001) against the newest head
export async function commitRoom(room, { reason, authorId = null, change, parents = null }) {
  for (let i = 0; i < RETRY_LIMIT; i++) {
    const head = await branchHead(room)
    if (!head) throw new Error(`방 브랜치가 없습니다: ${room}`)
    const tree = await change(head.tree || {}, head)
    try {
      const [r] = await q('select commit_branch($1,$2,$3::jsonb,$4,$5::uuid[],$6) as r',
        [room, head.head_commit_id, JSON.stringify(tree), reason, parents ? [head.head_commit_id, ...parents] : null, authorId])
      return { commitId: r.r.commit_id, created: !!r.r.created, tree }
    } catch (e) {
      if (e.code !== '40001') throw e
    }
  }
  throw new Error(`커밋 재시도 한도를 넘었습니다: ${room}`)
}

// a conversation's branch, made on first use. Its repo starts at `origin` (a mail case, or the room itself).
export async function ensureBranch(room, { origin, authorId }) {
  const found = await branchHead(room)
  if (found) return found
  const [{ id: repo }] = await q('select ensure_artifact_repo($1,$2) as id', [origin || room, T()])
  await q('select create_branch($1,$2,null,$3::jsonb,$4)', [repo, room, '{}', authorId])
  return branchHead(room)
}

// a recipient's branch from the sender's commit with the picked paths only
export async function forkBranch({ repoId, room, baseCommitId, tree, authorId }) {
  const [{ r }] = await q('select create_branch($1,$2,$3,$4::jsonb,$5) as r', [repoId, room, baseCommitId, JSON.stringify(tree), authorId])
  return r.head_commit_id
}

// ---- a conversation's file cards as tree entries ----
// the path of a card in its room's tree: inside the room's own work folder, relative to it; otherwise its name
export function pathOf(card, room) {
  const p = String(card.content?.path || '')
  const marker = `/.bpmn/${slugOf(room)}/`
  const i = p.indexOf(marker)
  if (i !== -1) return p.slice(i + marker.length)
  return String(card.content?.name || 'file').replace(/[\\/]/g, '_').slice(0, 200)
}

// the bytes behind a card: its storage object, or the agent's work folder (a workroom-only card)
export async function cardBytes(card) {
  const c = card.content || {}
  const o = objectOf(c.url)
  if (o) {
    const { data, error } = await admin.storage.from(o.bucket).download(o.key)
    if (error || !data) throw new TeamError(410, `'${c.name}' 의 원본 파일이 더 이상 없어요.`)
    return { buf: Buffer.from(await data.arrayBuffer()), type: data.type }
  }
  if (/^\/workspace\//.test(c.path || '') && !String(c.path).split('/').includes('..')) {
    const host = await workspaceHostPath(c.path).catch(() => null)
    if (host) return { buf: await fs.readFile(host), type: '' }
    // the agent's pods are elsewhere (no shared disk): the room folder deepagents left in storage
    const stored = await fetchRoomFile(c.path)
    if (stored) return stored
  }
  throw new TeamError(400, `'${c.name}' 은(는) 내용을 찾을 수 없어 공유할 수 없어요.`)
}

// The sender's conversation state at share time: its head plus the picked cards whose content changed
// since this server last committed them (a card picked again unchanged must not undo what a gathered
// branch brought in). Returns {head, paths} with paths for the picked cards.
export async function commitWorkState(me, room, cards, { origin }) {
  const head0 = await ensureBranch(room, { origin, authorId: me.id })
  const entries = {}, paths = [], marks = []
  for (const card of cards) {
    const path = pathOf(card, room)
    paths.push(path)
    const { buf, type } = await cardBytes(card)
    const sha = sha256(buf)
    if (card.content?.wt?.room === room && card.content.wt.sha256 === sha && head0.tree?.[path]) continue
    entries[path] = await putObject(buf, path, type)
    marks.push([card.id, { room, sha256: sha }])
  }
  if (Object.keys(entries).length) await commitRoom(room, { reason: 'handover', authorId: me.id, change: (tree) => ({ ...tree, ...entries }) })
  for (const [id, wt] of marks) await q(`update pro_messages set content = content || jsonb_build_object('wt', $2::jsonb) where id=$1`, [id, wt])
  return { head: await branchHead(room), paths: [...new Set(paths)] }
}

// A person saved a branch file in the editor: the saved copy becomes an `edit` commit on that
// conversation's branch (only the conversation's own branch). Unchanged content commits nothing.
export async function commitEdit(user, card) {
  const b = card.content?.branch
  if (!b?.room || b.room !== roomOf(card.thread_id)) return null
  const { buf, type } = await cardBytes(card)
  const entry = await putObject(buf, b.path, type)
  const r = await commitRoom(b.room, { reason: 'edit', authorId: user.id, change: (tree) => ({ ...tree, [b.path]: entry }) })
  await q(`update pro_messages set content = content || jsonb_build_object('sha256', $2::text) where id=$1`, [card.id, entry.sha256])
  return r
}

// ---- gathering (합류) ----
// branches split from this room that changed since they last came back, per batch
export async function pendingBranches(room) {
  const rows = await q(`select distinct on (s.branch_room_id) s.branch_room_id, s.batch_id, s.base_commit_id, s.start_commit_id, s.merged_commit_id,
                               s.recipient_id, u.username as name, b.head_commit_id
                          from pro_shares s join artifact_branches b on b.room_id=s.branch_room_id
                          left join users u on u.id=s.recipient_id and u.tenant_id=s.tenant_id
                         where s.tenant_id=$1 and s.source_room_id=$2 and s.branch_room_id is not null and s.revoked_at is null
                         order by s.branch_room_id, s.created_at`, [T(), room])
  return rows.filter((r) => r.head_commit_id !== (r.merged_commit_id || r.start_commit_id))
}

// Merge the returned branches into the room (one merge commit). Conflicts without a choice throw 409
// with the conflicts listed; choices: {path: sideKey} where the room's own side is 'mine'.
export async function gather(me, room, choices = {}) {
  const pending = await pendingBranches(room)
  if (!pending.length) return { merged: 0 }
  const commits = new Map()
  const get = async (id) => { if (!commits.has(id)) commits.set(id, await commit(id)); return commits.get(id) }
  const result = await commitRoom(room, {
    reason: 'merge', authorId: me.id,
    parents: [...new Set(pending.map((p) => p.head_commit_id))],
    change: async (tree) => {
      let merged = tree
      // one batch at a time, over the commit that batch split from
      for (const batch of [...new Set(pending.map((p) => p.batch_id))]) {
        const rows = pending.filter((p) => p.batch_id === batch)
        const base = (await get(rows[0].base_commit_id))?.tree || {}
        const sides = [{ key: 'mine', label: '내 대화', tree: merged }]
        for (const r of rows) {
          const start = (await get(r.merged_commit_id || r.start_commit_id))?.tree || {}
          sides.push({ key: r.branch_room_id, label: r.name || '팀원', tree: sideTree(base, start, (await get(r.head_commit_id))?.tree || {}) })
        }
        const m = mergeTrees(base, sides, choices)
        if (m.conflicts.length) {
          throw Object.assign(new TeamError(409, '같은 파일을 서로 다르게 고친 갈래가 있어요. 어느 쪽을 쓸지 골라 주세요.'), {
            conflicts: m.conflicts.map((c) => ({ path: c.path, sides: c.sides.map((s) => ({ key: s.key, label: s.label, size: s.entry?.size ?? null, removed: !s.entry })) })),
          })
        }
        // paths outside every side of this batch (later work in the room) stay as they are
        merged = { ...merged, ...m.tree }
        for (const p of Object.keys(merged)) if (p in base && !(p in m.tree)) delete merged[p]
      }
      return merged
    },
  })
  for (const p of pending) await q('update pro_shares set merged_commit_id=$2 where branch_room_id=$1', [p.branch_room_id, p.head_commit_id])
  return { merged: pending.length, commitId: result.commitId }
}

// ---- what a branch did (the sender's view) ----
export async function branchStatus(row) {
  const head = await branchHead(row.branch_room_id)
  if (!head) return null
  const start = await commit(row.start_commit_id)
  const d = diffTrees(start?.tree || {}, head.tree || {})
  const changed = head.head_commit_id !== row.start_commit_id
  return {
    room: row.branch_room_id, recipient: { id: row.recipient_id, name: row.name },
    added: d.added, modified: d.modified, removed: d.removed,
    at: changed ? head.head_at : null, by: changed ? (head.author_id ? 'person' : 'agent') : null,
    files: Object.keys(head.tree || {}).sort(),
  }
}
