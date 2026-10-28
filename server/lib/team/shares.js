// Shares: one grant per recipient for one artifact (a file card in the sender's chat). A share is a
// fork (lib/team/worktree.js): the sender's conversation is committed and each recipient gets a branch
// from that commit in their own work conversation, so the content is stored once and a recipient's
// edits stay on their branch. Grants made before that (no branch_room_id) name the storage object and
// open as the recipient's own copy, as they always did. Storage keys never go to the client.
import crypto from 'node:crypto'
import { config } from '../../config.js'
import { L } from '../lang.js'
import { q, admin } from '../supa.js'
import { mainThread, addMessage, updateMessage } from '../store.js'
import { saveAttachment } from '../attachments.js'
import { TeamError } from './access.js'
import * as W from './worktree.js'

const T = () => config.tenantId
const KIND = (n) => String(n || '').split('.').pop().toLowerCase().slice(0, 12)

// a public storage URL of this deployment → {bucket, key}; anything else is not shareable
export function objectOf(url) {
  try {
    const u = new URL(String(url || ''))
    const base = new URL(config.supabaseUrl)
    // the same storage, however the URL names it (editors save as localhost, uploads as 127.0.0.1)
    const loop = (h) => (['localhost', '127.0.0.1', '[::1]'].includes(h) ? 'loopback' : h)
    if (loop(u.hostname) !== loop(base.hostname) || (u.port || '80') !== (base.port || '80')) return null
    const m = /^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/.exec(u.pathname)
    if (!m || m[2].split('/').some((s) => s === '..' || s === '.')) return null
    return { bucket: decodeURIComponent(m[1]), key: decodeURIComponent(m[2]) }
  } catch { return null }
}

// a workroom-only card (the agent wrote it, it has no storage URL) shares through its work folder
const inWorkroom = (c) => /^\/workspace\//.test(String(c?.path || '')) && !String(c.path).split('/').includes('..')

// file cards of mine (any of my threads), with a storage object or a work folder file behind them
// lenient: cards that cannot be shared are skipped instead of refusing the whole send (a mention's
// "latest artifacts" are picked automatically)
export async function myFiles(me, ids, { lenient = false } = {}) {
  const list = [...new Set((ids || []).map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 10)
  if (!list.length) return []
  const rows = await q(`select m.id, m.thread_id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id
                        where m.id = any($1::uuid[]) and t.user_id=$2 and m.kind='file' order by m.created_at`, [list, me.id])
  if (rows.length !== list.length) throw new TeamError(404, L('공유할 산출물을 찾지 못했어요.', "I couldn't find the outputs to share."))
  return rows.flatMap((r) => {
    const o = objectOf(r.content.url)
    if (!o && !inWorkroom(r.content) && lenient) return []
    if (!o && !inWorkroom(r.content)) throw new TeamError(400, L(`'${r.content.name}' 은(는) 아직 공유할 수 없는 파일이에요.`, `'${r.content.name}' can't be shared yet.`))
    return [{ sourceId: r.id, name: String(r.content.name || 'file').slice(0, 200), ...(o || {}), card: r }]
  })
}

// The fork every recipient of one share action starts from: the sender's conversation is committed
// (returned branches gathered first), and the picked files are the recipients' tree.
// choices: conflict picks for the gathering ({path: side}); a conflict without one is a 409.
export async function fork(me, files, { choices } = {}) {
  const threadId = files[0].card.thread_id
  const room = W.roomOf(threadId)
  const { caseOfFiles } = await import('../mining/recorder.js')
  const caseId = await caseOfFiles(me, files.map((f) => f.name)).catch(() => null)
  const { paths } = await W.commitWorkState(me, room, files.map((f) => f.card), { origin: caseId })
  await W.gather(me, room, choices)
  const head = await W.branchHead(room)
  const tree = W.pickTree(head.tree, paths)
  return { room, repoId: head.repo_id, baseCommitId: head.head_commit_id, tree, paths, batchId: crypto.randomUUID(), caseId }
}

// the recipient's work conversation for one share message: made once, a project thread whose
// deepagents conversation is the branch room
async function workThread(recipientId, ref, title) {
  const [t] = await q(`select * from pro_threads where user_id=$1 and share_ref=$2`, [recipientId, ref])
  if (t) return { thread: t, created: false }
  const [n] = await q(`insert into pro_threads(user_id,kind,title,share_ref) values ($1,'project',$2,$3)
                       on conflict (user_id, share_ref) where share_ref is not null do nothing returning *`, [recipientId, title.slice(0, 60), ref])
  if (!n) return workThread(recipientId, ref, title)
  const [u] = await q('update pro_threads set conversation_id=$2 where id=$1 returning *', [n.id, W.roomOf(n.id)])
  return { thread: u, created: true }
}

// grants for every (recipient × file); returns the artifacts list stored on the dm message
// dmMessageId: the chats row (uuid) the artifacts travel in; roomId: its chat_rooms id
// forked: the fork of this share action (several 1:1 messages share one); made here when not given
export async function grant(me, recipients, files, { note, dmMessageId, roomId, forked }) {
  const f0 = forked || await fork(me, files).catch((e) => {
    // a database without the worktree tables still shares, the old way
    if (e instanceof TeamError || e.code !== '42P01' && e.code !== '42883') throw e
    console.warn('[team] worktree unavailable, sharing copies:', e.message)
    return null
  })
  if (f0) return grantBranches(me, recipients, files, { note, dmMessageId, roomId, forked: f0 })
  const artifacts = files.map((f) => ({ name: f.name, kind: KIND(f.name), sourceId: f.sourceId, shares: {} }))
  for (const r of recipients) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const [s] = await q(`insert into pro_shares(tenant_id,owner_id,recipient_id,chat_uuid,room_id,source_message_id,name,bucket,object_key,note)
                           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
      [T(), me.id, r.id, dmMessageId || null, roomId || null, f.sourceId, f.name, f.bucket, f.key, note ? String(note).slice(0, 1000) : null])
      artifacts[i].shares[r.id] = s.id
    }
  }
  return artifacts
}

// one branch per recipient from the fork, in their own work conversation with a card per file
async function grantBranches(me, recipients, files, { note, dmMessageId, roomId, forked }) {
  const artifacts = files.map((f) => ({ name: f.name, kind: KIND(f.name), sourceId: f.sourceId, shares: {} }))
  const names = files.map((f) => f.name)
  for (const r of recipients) {
    const { thread } = await workThread(r.id, `recv:${dmMessageId}:${r.id}`, `${me.name}님의 ${names[0]}${names.length > 1 ? ` 외 ${names.length - 1}` : ''}`)
    const room = W.roomOf(thread.id)
    const start = await W.forkBranch({ repoId: forked.repoId, room, baseCommitId: forked.baseCommitId, tree: forked.tree, authorId: me.id })
    await addMessage(r.id, thread.id, 'agent', 'text', { text: `${me.name}님이 공유한 일이에요${note ? `: "${String(note).slice(0, 300)}"` : '.'}`, shared: { by: me.name } })
    for (let i = 0; i < files.length; i++) {
      const path = W.pathOf(files[i].card, forked.room)
      const entry = forked.tree[path]
      const [s] = await q(`insert into pro_shares(tenant_id,owner_id,recipient_id,chat_uuid,room_id,source_message_id,name,bucket,object_key,note,
                             source_room_id,branch_room_id,path,base_commit_id,start_commit_id,batch_id)
                           values ($1,$2,$3,$4,$5,$6,$7,'files',$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
      [T(), me.id, r.id, dmMessageId || null, roomId || null, files[i].sourceId, files[i].name, W.objectKey(entry.sha256), note ? String(note).slice(0, 1000) : null,
        forked.room, room, path, forked.baseCommitId, start, forked.batchId])
      artifacts[i].shares[r.id] = s.id
      const m = await addMessage(r.id, thread.id, 'agent', 'file', { name: files[i].name, url: W.objectUrl(entry), sha256: entry.sha256, branch: { room, path }, shared: { by: me.name, shareId: s.id } })
      await q('update pro_shares set copy_message_id=$2 where id=$1', [s.id, m.id])
    }
  }
  return artifacts
}

async function shareFor(user, id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null
  const [s] = await q('select * from pro_shares where id=$1 and tenant_id=$2', [id, T()])
  if (!s || s.revoked_at) return null
  if (s.recipient_id === user.id) return { ...s, role: 'recipient' }
  if (s.owner_id === user.id) return { ...s, role: 'owner' }
  return null
}

export async function bytes(user, id) {
  const s = await shareFor(user, id)
  if (!s) throw new TeamError(404, L('공유를 찾지 못했어요.', "I couldn't find that share."))
  // a recipient reads their branch as it is now
  const entry = s.branch_room_id && s.role === 'recipient' ? (await W.branchHead(s.branch_room_id))?.tree?.[s.path] : null
  const { data, error } = await admin.storage.from(s.bucket).download(entry ? W.objectKey(entry.sha256) : s.object_key)
  if (error || !data) throw new TeamError(410, L('원본 파일이 더 이상 없어요.', 'The original file is no longer there.'))
  return { name: s.name, type: data.type || 'application/octet-stream', buf: Buffer.from(await data.arrayBuffer()), share: s }
}

// The file card to open in the editor: the owner's own original, or the recipient's copy (made once).
export async function openCopy(user, id) {
  const s = await shareFor(user, id)
  if (!s) throw new TeamError(404, L('공유를 찾지 못했어요.', "I couldn't find that share."))
  if (s.role === 'owner') {
    const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2`, [s.source_message_id, user.id])
    if (!m) throw new TeamError(404, L('원본 카드를 찾지 못했어요.', "I couldn't find the original card."))
    return m
  }
  if (s.branch_room_id) return branchCard(user, s)
  if (s.copy_message_id) {
    const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2`, [s.copy_message_id, user.id])
    if (m) return m
  }
  const { name, type, buf } = await bytes(user, id)
  const saved = await saveAttachment(user, name, type, buf)
  const [owner] = await q('select username as name from users where id=$1 and tenant_id=$2', [s.owner_id, T()])
  const t = await mainThread(user.id)
  const m = await addMessage(user.id, t.id, 'agent', 'file', { name: saved.name, url: saved.url, path: saved.path, shared: { by: owner?.name || L('팀원', 'Teammate'), shareId: s.id } })
  await q('update pro_shares set copy_message_id=$2, opened_at=coalesce(opened_at, now()) where id=$1', [s.id, m.id])
  return m
}

// The recipient's card for a branch file, showing the branch head (the agent may have changed it since).
// No copy: the card points at the content object.
async function branchCard(user, s) {
  const thread = W.threadOfRoom(s.branch_room_id)
  const head = await W.branchHead(s.branch_room_id)
  const entry = head?.tree?.[s.path]
  if (!thread || !entry) throw new TeamError(410, '받은 파일이 작업 대화에 더 이상 없어요.')
  let [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id
                     where t.id=$1 and t.user_id=$2 and m.kind='file' and m.content->'branch'->>'path'=$3 order by m.created_at desc limit 1`, [thread, user.id, s.path])
  if (!m) m = await addMessage(user.id, thread, 'agent', 'file', { name: s.name, url: W.objectUrl(entry), sha256: entry.sha256, branch: { room: s.branch_room_id, path: s.path }, shared: { shareId: s.id } })
  else if (m.content.sha256 !== entry.sha256) m = await updateMessage(user.id, m.id, { url: W.objectUrl(entry), sha256: entry.sha256 })
  await q('update pro_shares set opened_at=coalesce(opened_at, now()) where id=$1', [s.id])
  return m
}

// The recipient's copies of a message's artifacts, as composer-style attachments for runTurn.
export async function copiesFor(user, shareIds) {
  const out = []
  for (const id of shareIds) {
    const m = await openCopy(user, id).catch(() => null)
    if (m?.content?.url) out.push({ name: m.content.name, url: m.content.url, path: m.content.path })
  }
  return out
}

// An agent that cannot unfold a branch gets the branch's files as attachments (copies, as before).
export async function branchAttachments(user, room) {
  const head = await W.branchHead(room)
  const out = []
  for (const [path, entry] of Object.entries(head?.tree || {}).slice(0, 10)) {
    const { data } = await admin.storage.from('files').download(W.objectKey(entry.sha256))
    if (!data) continue
    const saved = await saveAttachment(user, path.split('/').pop(), entry.content_type, Buffer.from(await data.arrayBuffer()))
    out.push({ name: saved.name, url: saved.url, path: saved.path })
  }
  return out
}

export async function revoke(user, id) {
  const [s] = await q('update pro_shares set revoked_at=now() where id=$1 and tenant_id=$2 and owner_id=$3 and revoked_at is null returning id', [id, T(), user.id])
  return !!s
}

// the artifacts of a dm message as one viewer sees them: their own share id, never storage keys
export function viewArtifacts(viewerId, senderId, artifacts) {
  return (artifacts || []).map((a) => ({
    name: a.name, kind: a.kind,
    shareId: viewerId === senderId ? Object.values(a.shares || {})[0] || null : a.shares?.[viewerId] || null,
    own: viewerId === senderId,
  }))
}
