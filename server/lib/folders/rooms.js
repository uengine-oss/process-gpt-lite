// Shared folders in the agent workroom: a folder's main (kind 'folder', id = slug) and a variation (kind 'variation', id = variation id).
// A save in the workroom becomes a commit; terminal edits are committed by the variation screen's "변경 저장" (or before a merge or a move).
// A variation has one place where it can be changed (its seat — folders/seats.js): the room is that working copy only for the person whose
// server workroom it is; everyone else (and that person while it is elsewhere — another computer, a server agent, moving) gets the room
// read only, from the branch as it was last saved (git: {repo, ref}), with the seat to say where it is.
import { config } from '../../config.js'
import * as S from './service.js'
import * as SE from './seats.js'
import { L } from '../lang.js'
import { reindex } from './indexer.js'

export async function folderRoom(kind, id, user = null) {
  if (kind === 'folder') {
    const f = await S.folderBySlug(id)
    if (!f) return null
    return { kind, id, folder: f.id, need: 'editor', title: f.name, sub: L('공유 폴더 · main', 'Shared folder · main'), agent: 'shell', root: f.repo_path, cwd: f.repo_path, branch: f.default_branch,
      afterWrite: async (rel) => { if (await S.commitMain(f, { name: L('작업실', 'Workroom'), email: 'workroom@pgpt-pro.local' }, L(`작업실에서 고침: ${rel}`, `Edited in the workroom: ${rel}`))) reindex(f).catch(() => {}) } }
  }
  const v = /^[0-9a-f-]{36}$/.test(String(id)) ? await S.variationById(id) : null
  if (!v) return null
  const f = await S.folderById(v.folder_id)
  // (a variation id of another company's folder is no room here)
  if (!f || f.tenant_id !== config.tenantId) return null
  const seat = await SE.seatOf(v.id, { v })
  // (folderRow · variationRow: what the access check and the seat's view use again without asking the database)
  const base = { kind, id, folder: f.id, slug: f.slug, variation: v.id, title: v.title, sub: `${f.name} · ${L('변형', 'variation')}`, agent: 'shell', branch: v.branch, seatRow: seat || null,
    epoch: Number(v.seat_epoch) || 0, folderRow: f, variationRow: v }
  // before sql/063 (no seats): the checkout as it was, for whoever may run in the folder
  if (seat === undefined) {
    if (!v.worktree_path) return null
    return { ...base, need: 'runner', root: v.worktree_path, cwd: v.worktree_path, writable: true, legacy: true, afterWrite: afterWriteOf(f, v) }
  }
  const mine = !!seat && !!user && seat.place === 'server' && seat.run === 'workroom' && seat.state === 'held' && String(seat.user_id) === String(user.id) && !!v.worktree_path
  if (mine) return { ...base, need: 'runner', root: v.worktree_path, cwd: v.worktree_path, writable: true, userId: String(user.id), afterWrite: afterWriteOf(f, v) }
  // read only: the branch as saved — viewers of the folder may look, nobody writes or opens a shell here
  return { ...base, need: 'viewer', root: null, cwd: null, writable: false, readonly: true, git: { repo: f.repo_path, ref: v.branch } }
}
// a save in the person's own server workroom is a commit on the variation (a save point — the seat stays where it is)
const afterWriteOf = (f, v) => async (rel) => S.commitVariation(f, await S.variationById(v.id), { name: L('작업실', 'Workroom'), email: 'workroom@pgpt-pro.local' }, L(`작업실에서 고침: ${rel}`, `Edited in the workroom: ${rel}`))

export async function folderRoomAccess(user, room) {
  const f = room.folderRow || await S.folderById(room.folder)
  const role = await S.roleOf(f, user)
  room.role = role
  return !!role && S.RANK[role] >= S.RANK[room.need]
}

// the seat as the room's page shows it (where the working copy is, who has it, what this person may do)
export async function roomSeat(room, user) {
  if (room?.kind !== 'variation' || room.legacy) return null
  const v = room.variationRow || await S.variationById(room.variation)
  const role = room.role !== undefined ? room.role : await S.roleOf(room.folderRow || await S.folderById(room.folder), user)
  return SE.viewOf(room.seatRow, v, { me: user, role })
}
