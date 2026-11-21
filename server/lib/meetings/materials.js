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
import * as IX from '../folders/indexer.js'
import * as S from '../team/shares.js'
import { view as messageView } from '../team/messenger.js'
import { L } from '../lang.js'
import * as EM from '../embed.js'

const T = () => config.tenantId
const UUID = /^[0-9a-f-]{36}$/i

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
// documents in the shared folders the speaker can read ("폴더에 있는 … PDF 열어볼래?" found nothing before
// 2026-11-19: only a folder's variations were candidates). Kind 'folder' with a path: the folder's main copy.
const baseOf = (p) => String(p || '').split('/').pop()
async function folderFileCandidates(speaker) {
  const ids = await F.readableFolderIds(speaker.id).catch(() => [])
  if (!ids.length) return []
  const rows = await q(`select f.folder_id::text as folder_id, p.slug, p.name as folder_name, f.path, f.card->'keywords' as keywords
                        from pro_folder_files f join pro_folders p on p.id=f.folder_id
                        where f.folder_id = any($1) and p.kind is distinct from 'skill'
                        order by f.mtime desc nulls last limit 600`, [ids]).catch(() => [])
  return rows.map(folderFile)
}
const folderFile = (r) => ({ kind: 'folder', id: `${r.folder_id}:${r.path}`, title: baseOf(r.path), folderFile: true,
  where: r.folder_name, keywords: Array.isArray(r.keywords) ? r.keywords.slice(0, 12) : [], ref: { folderId: r.folder_id, slug: r.slug, path: r.path } })

export async function candidates(kind, { roomId, speaker }) {
  if (kind === 'file') return fileCandidates(roomId, speaker)
  if (kind === 'process') return processCandidates(speaker)
  if (kind === 'panel') return panelCandidates(speaker)
  if (kind === 'folder') return [...await folderFileCandidates(speaker), ...await folderCandidates(speaker)]
  return []
}
// ---- which candidate a spoken line means: the model picks (no word lists, no synonyms) ----
// All the candidates the speaker can see, one line per name. With embeddings, the nearest few by
// meaning (name, where it is, its document card's keywords); without, the newest of each kind up to a
// cap — and the judge reads the names and picks one, or none. A company's own words for things belong
// in its glossary data, never here.
const KIND_WORD = { file: ['파일', 'file'], process: ['진행 중인 업무', 'work in progress'], panel: ['팀 앱', 'team app'], folder: ['폴더 문서', 'folder document'] }
const kindWord = (c) => L(...(c.folderFile ? KIND_WORD.folder : KIND_WORD[c.kind] || KIND_WORD.file))
const describe = (c) => `[${kindWord(c)}] ${String(c.title).slice(0, 90)}${c.where ? ` · ${String(c.where).slice(0, 40)}` : ''}${c.keywords?.length ? ` · ${c.keywords.slice(0, 6).join(', ')}` : ''}`
const CAP = { file: 60, folder: 60, process: 20, panel: 20 }
const SHORTLIST = 8
const MIN_PICK = 0.5
export async function allCandidates(ctx, kinds = ['file', 'process', 'panel', 'folder']) {
  const all = (await Promise.all(kinds.map((k) => candidates(k, ctx).then((l) => l.slice(0, CAP[k] || 40)).catch(() => [])))).flat()
  return oncePerName(all)
}
// the shortlist the judge reads: nearest by embeddings, else everything (newest first per kind)
export async function shortlist(utter, list, k = SHORTLIST) {
  if (list.length <= k) return { list, by: 'all' }
  const r = await EM.rank(utter, list.map((c, i) => ({ key: i, text: describe(c) })), k)
  return r ? { list: r.map((x) => list[x.key]), by: 'embedding' } : { list, by: 'all' }
}
// utter + ctx → {pick, p, ms, shortlist} — pick null when nothing fits (or nothing is there)
export async function pick(utter, ctx, { state = null, judge, list = null } = {}) {
  const all = list || await allCandidates(ctx)
  if (!all.length) return { pick: null, p: 0, ms: 0, shortlist: 'empty' }
  const s = await shortlist(utter, all)
  const ask = judge || (async (st, question, options) => (await import('../judge.js')).judge({ state: st, question, options }))
  const j = await ask(state || utter, L('방금 한 말이 가리키는 자료는 어느 것인가요?', 'Which material does the remark just made point to?'),
    [{ key: 'none', label: L('목록에 맞는 자료가 없음', 'None of these fits') }, ...s.list.map((c, i) => ({ key: `c${i}`, label: describe(c) }))])
  const [key, p] = Object.entries(j?.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || [null, 0]
  const c = key && key !== 'none' && p >= MIN_PICK ? s.list[Number(String(key).slice(1))] : null
  return { pick: c || null, p, ms: j?.ms || 0, shortlist: s.by }
}

// ---- found by the person (자료 찾기 in the meeting's 자료 tab) ----
const WHERE = { file: ['파일', 'File'], process: ['진행 상황', 'Progress'], panel: ['앱 데이터', 'App data'], folder: ['폴더 문서 수정본', 'Folder revision'] }
export const pickView = (c) => ({ key: `${c.kind}:${c.id}`, kind: c.kind, title: c.title, where: c.where || L(...(WHERE[c.kind] || WHERE.file)), folderFile: !!c.folderFile, score: c.score ?? null })
// what a person typed: names first, then the folder index (document cards and full text) for words not in any name
// one line per document name: a folder document shown in a meeting is also my copy and the room's file
// (folderToFile) — the list showed it two or three times (2026-11-19 recording). The better-ranked place
// stays, holding the folder's own document when there is one (the original I can open in the folder)
export function oncePerName(list) {
  const out = [], at = new Map()
  for (const c of list) {
    const k = String(c.title).toLowerCase()
    if (!at.has(k)) { at.set(k, out.length); out.push(c) } else if (c.folderFile && !out[at.get(k)].folderFile) out[at.get(k)] = c
  }
  return out
}
export async function search(text, ctx, limit = 12) {
  return oncePerName(await searchAll(text, ctx, limit * 2)).slice(0, limit)
}
async function searchAll(text, ctx, limit) {
  const t = String(text || '').trim().slice(0, 120)
  if (!t) {
    // nothing typed: what is nearest — this room's files, then the newest folder documents
    const [files, docs] = await Promise.all([fileCandidates(ctx.roomId, ctx.speaker).catch(() => []), folderFileCandidates(ctx.speaker)])
    return [...files.slice(0, 6), ...docs.slice(0, limit - Math.min(6, files.length))].map(pickView)
  }
  // what a person typed into the search box is a query: names holding every typed word (any case),
  // then the nearest by embeddings, then the folder index for words not in any name
  const all = await allCandidates(ctx)
  const words = t.toLowerCase().split(/\s+/).filter(Boolean)
  const hit = all.filter((c) => { const n = `${c.title} ${(c.keywords || []).join(' ')}`.toLowerCase(); return words.every((w) => n.includes(w)) })
  const out = hit.slice(0, limit).map((c) => ({ ...c, score: 2 }))
  if (out.length < limit) {
    const near = await EM.rank(t, all.map((c, i) => ({ key: i, text: describe(c) })), limit)
    for (const x of near || []) {
      const c = all[x.key]
      if (out.length >= limit || x.sim < 0.3 || out.some((o) => o.kind === c.kind && o.id === c.id)) continue
      out.push({ ...c, score: Math.round(x.sim * 100) / 100 })
    }
  }
  if (out.length < limit) {
    const seen = new Set(out.map((c) => `${c.kind}:${c.id}`))
    const hits = await IX.search(ctx.speaker.id, t, 20).catch(() => [])
    for (const h of hits) {
      if (h.type !== 'file' || out.length >= limit) continue
      const c = folderFile({ folder_id: h.folder.id, slug: h.folder.slug, folder_name: h.folder.name, path: h.file.path })
      if (!seen.has(`${c.kind}:${c.id}`)) { seen.add(`${c.kind}:${c.id}`); out.push({ ...c, score: 0.5 }) }
    }
  }
  return out.map(pickView)
}
// 모두에게 띄우기 of a shared folder's document when someone in the room is not in that folder (2026-11-19
// recording: the other person saw 「볼 권한이 없어요」): the presenter's own copy of it — a file card in their
// home thread, like a chat attachment — so the room gets it the way any file of theirs is shown (grantForRoom
// shares a copy each). The material row becomes that file; where it came from stays in ref.folder.
const DOC_TYPE = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwpx: 'application/hwp+zip', hwp: 'application/x-hwp', csv: 'text/csv', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }
export async function folderToFile(user, mat) {
  const r = mat.ref || {}
  const { folder } = await F.access(r.slug, user)
  const buf = await F.readBlob(folder, 'main', r.path)
  const { saveAttachment } = await import('../attachments.js')
  const { mainThread, addMessage } = await import('../store.js')
  const name = baseOf(r.path)
  const f = await saveAttachment(user, name, DOC_TYPE[name.split('.').pop().toLowerCase()] || 'application/octet-stream', buf)
  const t = await mainThread(user.id)
  const card = await addMessage(user.id, t.id, 'user', 'file', { name: f.name, url: f.url, ...(f.path ? { path: f.path } : {}), attached: true,
    meeting: mat.meeting_id, from: { folder: folder.name, path: r.path } })
  const [upd] = await q(`update pro_meeting_materials set kind='file', ref=$2 where id=$1 returning *`,
    [mat.id, { sourceId: card.id, ownerId: user.id, folder: { folderId: r.folderId, slug: r.slug, path: r.path } }])
  return upd
}

// a key the person picked, checked again against their own access (never a ref from the page)
export async function resolve(key, ctx) {
  const k = String(key || '')
  const i = k.indexOf(':')
  const kind = k.slice(0, i), id = k.slice(i + 1)
  if (!['file', 'process', 'panel', 'folder'].includes(kind) || !id) return null
  if (kind === 'folder' && id.includes(':')) {
    const folderId = id.slice(0, id.indexOf(':')), path = id.slice(id.indexOf(':') + 1)
    if (!UUID.test(folderId)) return null
    const f = await F.folderById(folderId).catch(() => null)
    if (!f || f.kind === 'skill') return null
    try { await F.access(f.slug, ctx.speaker) } catch { return null }
    const [row] = await q('select path from pro_folder_files where folder_id=$1 and path=$2', [f.id, path])
    return row ? folderFile({ folder_id: f.id, slug: f.slug, folder_name: f.name, path: row.path }) : null
  }
  return (await candidates(kind, ctx).catch(() => [])).find((c) => String(c.id) === id) || null
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

// an agent's result names whose agent made it in the reader's language, not in its starter's (stored)
const MADE_BY = /^(?:(.+?)님의 에이전트가 만들었어요|Made by (.+?)'s agent)$/
export function reasonFor(mat) {
  const m = mat.kind === 'result' && MADE_BY.exec(String(mat.reason || '').trim())
  if (!m) return mat.reason || null
  const who = m[1] || m[2]
  return L(`${who}님의 에이전트가 만들었어요`, `Made by ${who}'s agent`)
}

// the material as this person sees it: a summary to draw, never a storage URL or key
export async function view(user, mat) {
  const base = { id: mat.id, kind: mat.kind, title: mat.title, reason: reasonFor(mat), byAgent: mat.by_agent, presentedBy: mat.presented_by || null,
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
  if (mat.kind === 'folder' && r.path) {
    // a document of the folder's main copy: the page opens it like the folder screen does (raw / editor copy)
    try {
      const { folder } = await F.access(r.slug, user)
      const [row] = await q(`select path, size, card->>'abstract' as abstract from pro_folder_files where folder_id=$1 and path=$2`, [folder.id, r.path])
      return { ...base, folder: { slug: r.slug, name: folder.name, path: r.path, file: true, ext: String(r.path).split('.').pop().toLowerCase(), size: row?.size ?? null, abstract: row?.abstract || null } }
    } catch { return { ...base, folder: null } }
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
