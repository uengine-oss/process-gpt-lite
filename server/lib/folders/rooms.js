// Shared folders in the agent workroom: a folder's main (kind 'folder', id = slug) and a person's
// checkout of a variation (kind 'variation', id = variation id). A save in the workroom becomes a
// commit; terminal edits are committed by the variation screen's "변경 저장" (or before a merge).
import * as S from './service.js'
import { reindex } from './indexer.js'

export async function folderRoom(kind, id) {
  if (kind === 'folder') {
    const f = await S.folderBySlug(id)
    if (!f) return null
    return { kind, id, folder: f.id, need: 'editor', title: f.name, sub: '공유 폴더 · main', agent: 'shell', root: f.repo_path, cwd: f.repo_path, branch: f.default_branch,
      afterWrite: async (rel) => { if (await S.commitMain(f, { name: '작업실', email: 'workroom@pgpt-pro.local' }, `작업실에서 고침: ${rel}`)) reindex(f).catch(() => {}) } }
  }
  const v = /^[0-9a-f-]{36}$/.test(String(id)) ? await S.variationById(id) : null
  if (!v?.worktree_path) return null
  const f = await S.folderById(v.folder_id)
  return { kind, id, folder: f.id, need: 'runner', title: v.title, sub: `${f.name} · 변형`, agent: 'shell', root: v.worktree_path, cwd: v.worktree_path, branch: v.branch,
    afterWrite: async (rel) => S.commitVariation(f, await S.variationById(v.id), { name: '작업실', email: 'workroom@pgpt-pro.local' }, `작업실에서 고침: ${rel}`) }
}

export async function folderRoomAccess(user, room) {
  const f = await S.folderById(room.folder)
  const role = await S.roleOf(f, user)
  return !!role && S.RANK[role] >= S.RANK[room.need]
}
