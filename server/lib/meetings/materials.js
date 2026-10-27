// Materials a meeting can put up (회의 자료) and who may see them — every check is an existing one:
//   file     a file card: the room's shared files (chats.pgpt.artifacts) or the speaker's own cards;
//            visible to its owner and to whoever holds a pro_shares grant for it
//   process  a process instance (canSeeInstance), shown with its steps and step-output chips
//   panel    a panel app's rows (folder membership, read as that person — masked views included)
//   folder   a shared folder's variation (수정본) (folder role)
//   result   an agent result posted in the room during the meeting (room members)
// A material row keeps ids only. What one person is sent is built for that person (view()).
import { config } from '../../config.js'
import { q } from '../supa.js'
import * as P from '../processes.js'
import * as PA from '../panelApps/service.js'
import * as F from '../folders/service.js'
import * as S from '../team/shares.js'
import { view as messageView } from '../team/messenger.js'

const T = () => config.tenantId
const UUID = /^[0-9a-f-]{36}$/i

// ---- matching an utterance against candidate names (no model) ----
const STOP = new Set(['xlsx', 'xls', 'dxf', 'hwpx', 'hwp', 'docx', 'pdf', 'svg', 'png', '파일', '최종', '초안', 'v1', 'v2', 'v3', '신청', '프로세스'])
const SYN = { 평면도: ['도면', '평면'], 견적서: ['견적'], 안내문: ['안내'], 정산: ['정산서'], 휴가: ['연차', '휴가'], 출장비: ['출장'], 제안서: ['제안'] }
export const nameTokens = (name) => String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '').split(/[\s_\-·.,()[\]/]+/).filter((t) => t.length >= 2 && !STOP.has(t.toLowerCase()))
const EXT_CUE = [[/견적|정산표|예산/, /\.(xlsx|xls|csv)$/i], [/평면도|도면|설계도/, /\.(dxf|dwg)$/i], [/안내문|공문|제안서|보고서/, /\.(hwpx|hwp|docx)$/i]]
export function score(utter, name) {
  const u = String(utter || '').replace(/\s+/g, '')
  let s = 0
  for (const t of nameTokens(name)) {
    if (u.includes(t)) { s += t.length >= 3 ? 2 : 1; continue }
    for (const [k, alts] of Object.entries(SYN)) if (t.includes(k) && alts.some((a) => u.includes(a))) { s += 1; break }
  }
  if (s) for (const [cue, ext] of EXT_CUE) if (cue.test(u) && ext.test(String(name))) s += 1
  return s
}

// ---- candidates, in the speaker's access ----
async function fileCandidates(roomId, speaker) {
  const out = new Map()
  // files shared in this room (grants for its people already exist)
  const rows = await q(`select uuid, messages from chats where id=$1 and jsonb_typeof(messages->'pgpt'->'artifacts')='array'
                        and jsonb_array_length(messages->'pgpt'->'artifacts') > 0
                        order by coalesce(public.pro_chat_ts(messages), now()) desc limit 120`, [roomId])
  for (const r of rows) {
    const g = r.messages.pgpt || {}
    const owner = g.by || r.messages.userId
    for (const a of g.artifacts || []) {
      if (!a?.sourceId || out.has(a.sourceId)) continue
      out.set(a.sourceId, { kind: 'file', id: a.sourceId, title: a.name, ref: { sourceId: a.sourceId, ownerId: owner, artifacts: [a] } })
    }
  }
  // the speaker's own file cards (not copies of someone else's)
  const mine = await q(`select m.id::text as id, m.content->>'name' as name from pro_messages m join pro_threads t on t.id=m.thread_id
                        where t.user_id=$1 and m.kind='file' and m.content->'shared' is null and m.content->>'name' is not null
                        order by m.created_at desc limit 200`, [speaker.id])
  // a file of the same name already shared in this room is the one meant (an older card of it is not)
  const named = new Set([...out.values()].map((c) => c.title))
  for (const r of mine) if (!out.has(r.id) && !named.has(r.name)) { named.add(r.name); out.set(r.id, { kind: 'file', id: r.id, title: r.name, ref: { sourceId: r.id, ownerId: speaker.id } }) }
  // what others shared with the speaker anywhere
  const got = await q(`select distinct on (source_message_id) source_message_id::text as id, name, owner_id::text as owner from pro_shares
                       where tenant_id=$1 and recipient_id=$2 and revoked_at is null and source_message_id is not null
                       order by source_message_id, created_at desc limit 200`, [T(), speaker.id])
  for (const r of got) if (!out.has(r.id) && !named.has(r.name)) { named.add(r.name); out.set(r.id, { kind: 'file', id: r.id, title: r.name, ref: { sourceId: r.id, ownerId: r.owner } }) }
  return [...out.values()]
}
async function processCandidates(speaker) {
  const list = await P.listInstances({ userEmail: speaker.email, userId: speaker.id, limit: 40 }).catch(() => [])
  return list.map((i) => ({ kind: 'process', id: i.proc_inst_id, title: i.proc_inst_name || i.def_name || i.proc_inst_id, ref: { instId: i.proc_inst_id } }))
}
async function panelCandidates(speaker) {
  const apps = await PA.listApps(speaker, { all: true }).catch(() => [])
  return apps.map((a) => ({ kind: 'panel', id: a.id, title: a.title, ref: { appId: a.id } }))
}
async function folderCandidates(speaker) {
  const ids = (await F.readableFolderIds(speaker.id).catch(() => [])).slice(0, 12)
  const out = []
  for (const id of ids) {
    const f = await F.folderById(id)
    if (!f || f.kind === 'skill') continue
    const vs = await q(`select id, title, status from pro_folder_variations where folder_id=$1 and status <> 'discarded' order by updated_at desc limit 8`, [f.id]).catch(() => [])
    for (const v of vs) out.push({ kind: 'folder', id: v.id, title: `${f.name} · ${v.title}`, ref: { folderId: f.id, slug: f.slug, variationId: v.id } })
  }
  return out
}
export async function candidates(kind, { roomId, speaker }) {
  if (kind === 'file') return fileCandidates(roomId, speaker)
  if (kind === 'process') return processCandidates(speaker)
  if (kind === 'panel') return panelCandidates(speaker)
  if (kind === 'folder') return folderCandidates(speaker)
  return []
}
// every kind, scored against what was said; best first
export async function ranked(utter, ctx, kinds = ['file', 'process', 'panel', 'folder']) {
  const all = (await Promise.all(kinds.map((k) => candidates(k, ctx).catch(() => [])))).flat()
  return all.map((c) => ({ ...c, score: score(utter, c.title) })).filter((c) => c.score > 0).sort((a, b) => b.score - a.score)
}

// ---- access per person ----
export async function canSee(user, mat) {
  const r = mat.ref || {}
  try {
    if (mat.kind === 'file') {
      if (r.ownerId === user.id) return true
      const [s] = await q(`select 1 from pro_shares where tenant_id=$1 and recipient_id=$2 and source_message_id::text=$3 and revoked_at is null limit 1`, [T(), user.id, r.sourceId])
      return !!s
    }
    if (mat.kind === 'process') return await P.canSeeInstance(r.instId, user)
    if (mat.kind === 'panel') { await PA.appFor(user, r.appId); return true }
    if (mat.kind === 'folder') { await F.access(r.slug, user); return true }
    if (mat.kind === 'result') return true // a room message: the meeting's people are the room's people
  } catch { return false }
  return false
}

const hiddenUrl = (o) => { const { url: _u, path: _p, ...rest } = o; return rest }

// the material as this person sees it: a summary to draw, never a storage URL or key
export async function view(user, mat) {
  const base = { id: mat.id, kind: mat.kind, title: mat.title, reason: mat.reason || null, byAgent: mat.by_agent, presentedBy: mat.presented_by || null,
    at: mat.created_at, roomCard: mat.chat_uuid || null }
  const r = mat.ref || {}
  if (mat.kind === 'file') {
    const ext = String(mat.title).split('.').pop().toLowerCase()
    return { ...base, file: { name: mat.title, ext, own: r.ownerId === user.id } }
  }
  if (mat.kind === 'process') {
    const d = await P.getInstance(r.instId, user).catch(() => null)
    if (!d) return { ...base, process: null }
    return { ...base, process: { instId: r.instId, status: d.inst.status, name: d.inst.proc_inst_name || d.def?.name,
      steps: d.steps.filter((s) => !['start', 'end', 'gateway'].includes(s.kind)).map((s) => ({ name: s.name, state: s.state, assignee: s.assignee, running: s.running })),
      outputs: d.artifacts.slice(0, 8).map((a) => ({ ...hiddenUrl(a), text: a.text ? String(a.text).slice(0, 120) : undefined })) } }
  }
  if (mat.kind === 'panel') {
    const d = await PA.rows(user, r.appId).catch(() => null)
    const fields = (d?.app?.def?.fields || []).slice(0, 5).map((f) => ({ key: f.key, label: f.label }))
    return { ...base, panel: { appId: r.appId, fields, rows: (d?.rows || []).slice(0, 8).map((x) => Object.fromEntries(fields.map((f) => [f.key, x[f.key] ?? '']))), total: (d?.rows || []).length } }
  }
  if (mat.kind === 'folder') {
    try {
      const { folder } = await F.access(r.slug, user)
      const v = await F.variation(folder, r.variationId)
      const d = v ? await F.variationDetail(folder, v) : null
      return { ...base, folder: { slug: r.slug, name: folder.name, variationId: r.variationId, status: v?.status, statusLabel: F.STATUS[v?.status] || v?.status,
        changes: (d?.changes || []).slice(0, 8).map((c) => ({ path: c.path || c.file, status: c.status })) } }
    } catch { return { ...base, folder: null } }
  }
  if (mat.kind === 'result') {
    // the agent's result message in the room, as this person sees it (their own share ids for its files)
    const [row] = await q('select uuid, id, messages from chats where uuid=$1', [r.chatUuid])
    const v = row ? messageView(user.id, row) : null
    return { ...base, result: { messageId: r.chatUuid, text: v ? v.body.slice(0, 400) : '', files: v ? v.artifacts : (r.files || []).map((name) => ({ name })) } }
  }
  return base
}

// open a file material: the owner's own card, or my copy through my grant (the same as opening a share)
export async function openFile(user, mat) {
  const r = mat.ref || {}
  if (r.ownerId === user.id) {
    const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id::text=$1 and t.user_id=$2`, [r.sourceId, user.id])
    if (m) return m
  }
  const [s] = await q(`select id from pro_shares where tenant_id=$1 and recipient_id=$2 and source_message_id::text=$3 and revoked_at is null order by created_at desc limit 1`, [T(), user.id, r.sourceId])
  if (!s) return null
  return S.openCopy(user, s.id)
}

// presenting the owner's file to the room: a grant for each room member who has none yet (a share)
export async function grantForRoom(owner, mat, roomMembers, { roomId, chatUuid, note }) {
  if (mat.kind !== 'file' || mat.ref?.ownerId !== owner.id || !UUID.test(String(mat.ref?.sourceId))) return mat.ref?.artifacts || null
  const lacking = []
  for (const p of roomMembers) if (p.id !== owner.id && !(await canSee(p, mat))) lacking.push(p)
  const files = await S.myFiles(owner, [mat.ref.sourceId], { lenient: true })
  if (!files.length) return mat.ref?.artifacts || null
  const made = lacking.length ? await S.grant(owner, lacking, files, { note, dmMessageId: chatUuid, roomId }) : files.map((f) => ({ name: f.name, kind: f.name.split('.').pop(), sourceId: f.sourceId, shares: {} }))
  // keep the grants that already existed (room shares) beside the new ones
  const prev = (mat.ref.artifacts || [])[0]?.shares || {}
  const art = { ...made[0], shares: { ...prev, ...made[0].shares } }
  return { artifacts: [art], files, lacking }
}
