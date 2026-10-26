// Shares: one grant per recipient for one artifact (a file card in the sender's chat). The grant
// names the storage object; the object's URL never goes to the client. A recipient reads the bytes
// through the grant, or opens their own copy (a file card in their chat) to edit or hand to their
// agent — their edits never touch the sender's original.
import { config } from '../../config.js'
import { q, admin } from '../supa.js'
import { mainThread, addMessage } from '../store.js'
import { saveAttachment } from '../attachments.js'
import { TeamError } from './access.js'

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

// file cards of mine (any of my threads), with a storage object behind them
// lenient: cards that cannot be shared are skipped instead of refusing the whole send (a mention's
// "latest artifacts" are picked automatically)
export async function myFiles(me, ids, { lenient = false } = {}) {
  const list = [...new Set((ids || []).map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 10)
  if (!list.length) return []
  const rows = await q(`select m.id, m.content from pro_messages m join pro_threads t on t.id=m.thread_id
                        where m.id = any($1::uuid[]) and t.user_id=$2 and m.kind='file'`, [list, me.id])
  if (rows.length !== list.length) throw new TeamError(404, '공유할 산출물을 찾지 못했어요.')
  return rows.flatMap((r) => {
    const o = objectOf(r.content.url)
    if (!o && lenient) return []
    if (!o) throw new TeamError(400, `'${r.content.name}' 은(는) 아직 공유할 수 없는 파일이에요(작업실 파일).`)
    return [{ sourceId: r.id, name: String(r.content.name || 'file').slice(0, 200), ...o }]
  })
}

// grants for every (recipient × file); returns the artifacts list stored on the dm message
// dmMessageId: the chats row (uuid) the artifacts travel in; roomId: its chat_rooms id
export async function grant(me, recipients, files, { note, dmMessageId, roomId }) {
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
  if (!s) throw new TeamError(404, '공유를 찾지 못했어요.')
  const { data, error } = await admin.storage.from(s.bucket).download(s.object_key)
  if (error || !data) throw new TeamError(410, '원본 파일이 더 이상 없어요.')
  return { name: s.name, type: data.type || 'application/octet-stream', buf: Buffer.from(await data.arrayBuffer()), share: s }
}

// The file card to open in the editor: the owner's own original, or the recipient's copy (made once).
export async function openCopy(user, id) {
  const s = await shareFor(user, id)
  if (!s) throw new TeamError(404, '공유를 찾지 못했어요.')
  if (s.role === 'owner') {
    const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2`, [s.source_message_id, user.id])
    if (!m) throw new TeamError(404, '원본 카드를 찾지 못했어요.')
    return m
  }
  if (s.copy_message_id) {
    const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2`, [s.copy_message_id, user.id])
    if (m) return m
  }
  const { name, type, buf } = await bytes(user, id)
  const saved = await saveAttachment(user, name, type, buf)
  const [owner] = await q('select username as name from users where id=$1 and tenant_id=$2', [s.owner_id, T()])
  const t = await mainThread(user.id)
  const m = await addMessage(user.id, t.id, 'agent', 'file', { name: saved.name, url: saved.url, path: saved.path, shared: { by: owner?.name || '팀원', shareId: s.id } })
  await q('update pro_shares set copy_message_id=$2, opened_at=coalesce(opened_at, now()) where id=$1', [s.id, m.id])
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
