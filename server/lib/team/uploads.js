// Files sent from the computer in the messenger (2026-11-24 운영 화면, 「끌어다놓기 첨부가 안되네」): dropped on a conversation, pasted,
// or picked with 「내 컴퓨터에서」. Each one is stored like a chat attachment (lib/attachments.js: files/pgpt-pro/<me>/att/<uuid>.<ext>,
// 50MB) and becomes a file card of the sender's own, so the share path takes it like any other card (shares.js myFiles → fork → grant:
// a recipient's branch, their copy card, the sender's branch view and 「이어서 작업」 all expect a card with its conversation).
// Where the cards live: one conversation per person that no list shows — pro_threads kind 'files', share_ref 'messenger:uploads' (the
// same unique (user_id, share_ref) index makes it once). Not the main chat: nothing extra is added there (2026-11-18 decision); not a
// project (only kind 'project' is listed). Its branch room `pro:<id>` is where the shares of these files fork from.
import { q } from '../supa.js'
import { L } from '../lang.js'
import { saveAttachment } from '../attachments.js'
import { TeamError } from './access.js'

export const UPLOADS_REF = 'messenger:uploads'
// (a file a teammate sent the old way — a share without a branch, on a database without the worktree tables — gets its card of mine
// here when 폴더에 정리 first reads it: lib/folders/filing.js. Opening it later reuses that card: shares.js openCopy.)
export const RECEIVED_REF = 'messenger:received'
// (a file mention opened from the messenger gets a card of mine here, for the office panel to open — lib/fileRefs.js open)
export const LINKS_REF = 'messenger:links'
export const MAX_FILES = 10

// one such conversation per person and purpose, made once
export async function filesThread(userId, ref = UPLOADS_REF) {
  const [t] = await q('select * from pro_threads where user_id=$1 and share_ref=$2', [userId, ref])
  if (t) return t
  const title = ref === RECEIVED_REF ? L('메신저로 받은 파일', 'Files received in messages') : ref === LINKS_REF ? L('메신저에서 연 파일 링크', 'File links opened from messages') : L('메신저로 보낸 파일', 'Files sent in messages')
  const [n] = await q(`insert into pro_threads(user_id,kind,title,share_ref) values ($1,'files',$2,$3)
                       on conflict (user_id, share_ref) where share_ref is not null do nothing returning *`, [userId, title, ref])
  return n || filesThread(userId, ref)
}
export const uploadsThread = (userId) => filesThread(userId, UPLOADS_REF)

// → {id (the card, what POST /team/threads/:id/messages takes in artifactIds), name, size, type}
export async function uploadCard(user, rawName, type, buf) {
  let saved
  try { saved = await saveAttachment(user, rawName, type, Buffer.isBuffer(buf) ? buf : null) } catch (e) {
    if (e.status === 413) throw new TeamError(413, L('50MB 보다 큰 파일은 보낼 수 없어요.', "Files over 50 MB can't be sent."))
    if (e.status === 400) throw new TeamError(400, L('빈 파일은 보낼 수 없어요.', "An empty file can't be sent."))
    throw e
  }
  const t = await uploadsThread(user.id)
  // (not addMessage: no live event — the card is not shown anywhere until it is sent)
  const [m] = await q(`insert into pro_messages(thread_id,role,kind,content) values ($1,'user','file',$2) returning id`,
    [t.id, { name: saved.name, url: saved.url, ...(saved.path ? { path: saved.path } : {}), type: saved.type || '', size: saved.size, uploaded: 'messenger' }])
  return { id: m.id, name: saved.name, size: saved.size, type: saved.type || '' }
}
