// A champion folder's sources (원본 PC — spec openspec/specs/champion-folders): the computers that upload a folder a person picked there.
// The server never knows the folder's path — only its name on that computer (label). Each source is one device of one person on one
// managed folder (pro_folder_sources, sql/059) with its own branch, pgpt-agent/sync-<device 8>/main, that only that device's sync token
// may push to (gitHttp.js on the public /api/local-git path, checked on every request by localAgents/devices.js syncAccess).
// The desktop asks over its link (localAgents/hub.js — the link's own tenant, person and device; never anyone else's folder):
//   sync:bind {folderId, label}       → sync:bound {folderId, sourceId, branch} | sync:refused {folderId, why}
//   sync:token {folderId}             → sync:token {folderId, token, url, path, branch, push, main} (1 hour) | sync:refused
//   sync:pushed {folderId, head, report} → in the folder's lock: what the push brought in is checked (secrets.js), then main moves to
//                                        head (line.js intoMainNow — a fast-forward, else a merge, else main stays) → the index and the
//                                        folder's agent assets (kit.js) → sync:taken {folderId, main} | sync:behind | sync:refused
//   sync:unbind {folderId}            → sync:unbound {folderId}
// why: not_editor · no_folder · not_managed · device_revoked · source_removed · paused · secret · too_big · conflict
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { person, people } from '../people.js'
import { L } from '../lang.js'
import * as G from './git.js'
import * as S from './service.js'
import { intoMainNow } from './line.js'
import { mintToken } from './gitHttp.js'
import { refusedIn } from './secrets.js'

const T = () => config.tenantId
export const TOKEN_HOURS = 1
const UUID = /^[0-9a-f-]{36}$/i
const OID = /^[0-9a-f]{40}$/
const ZERO = /^0{40}$/
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const err = (status, message) => Object.assign(new Error(message), { status })
export const prefixOf = (deviceId) => `pgpt-agent/sync-${String(deviceId).slice(0, 8)}/`
export const branchOf = (deviceId) => `${prefixOf(deviceId)}main`
const isAncestor = async (repo, a, b) => !!a && !!b && (await G.mergeBase(repo, a, b)) === a
// a folder's name on that computer — a name, never a path
const labelOf = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').split(/[\\/]/).filter(Boolean).pop()?.replace(/\s+/g, ' ').trim().slice(0, 120) || L('내 PC 폴더', 'Folder on my PC')
const COUNTS = ['gitignore', 'secret', 'personal', 'rebuildable', 'large', 'structure']
const n = (v) => Math.max(0, Math.floor(Number(v) || 0))
// what a desktop says it uploaded: counts only (no path, no value)
export const reportOf = (r = {}) => ({ files: n(r.files), bytes: n(r.bytes), excluded: Object.fromEntries(COUNTS.map((k) => [k, n(r.excluded?.[k])])), flagged: n(r.flagged) })

export const handles = (msg) => typeof msg?.type === 'string' && msg.type.startsWith('sync:')

// ---------- who may ----------
// the link's person on the link's device, for a champion folder of the link's company → {folder, role} | {why}
async function allowed(link, folderId, need = 'editor') {
  if (!UUID.test(String(folderId || ''))) return { why: 'no_folder' }
  const [d] = await q('select revoked_at from pro_local_devices where id=$1 and tenant_id=$2', [link.id, link.tenant])
  if (!d || d.revoked_at) return { why: 'device_revoked' }
  const [folder] = await q('select * from pro_folders where id=$1 and tenant_id=$2', [folderId, link.tenant])
  if (!folder) return { why: 'no_folder' }
  if (folder.kind !== 'managed' || !folder.settings?.champion) return { why: 'not_managed' }
  const role = await S.roleOf(folder, { id: link.userId })
  if (!role) return { why: 'no_folder' }
  if (S.RANK[role] < S.RANK[need]) return { why: 'not_editor' }
  return { folder, role }
}
const sourceOf = async (folderId, deviceId) => (await q('select * from pro_folder_sources where folder_id=$1 and device_id=$2', [folderId, deviceId]))[0] || null
const stateWhy = (s) => (!s ? 'no_folder' : s.state === 'removed' ? 'source_removed' : s.state === 'paused' ? 'paused' : null)

// ---------- the link's messages ----------
export async function receive(link, msg) {
  const folderId = String(msg.folderId || '')
  const refuse = (why, extra = {}) => link.send({ type: 'sync:refused', folderId, why, ...extra })
  try {
    if (msg.type === 'sync:bind') return await bind(link, folderId, msg.label, refuse)
    if (msg.type === 'sync:token') return await token(link, folderId, refuse)
    if (msg.type === 'sync:pushed') return await pushed(link, folderId, msg, refuse)
    if (msg.type === 'sync:unbind') return await unbind(link, folderId)
  } catch (e) {
    console.warn(`[champion] ${msg.type} ${folderId.slice(0, 8)}:`, e.message)
    return refuse('conflict')
  }
}

async function bind(link, folderId, label, refuse) {
  const ok = await allowed(link, folderId)
  if (ok.why) return refuse(ok.why)
  const [s] = await q(`insert into pro_folder_sources (tenant_id, folder_id, user_id, device_id, label, branch) values ($1,$2,$3,$4,$5,$6)
                       on conflict (folder_id, device_id) do update set user_id=$3, label=$5, state='active', why=null, updated_at=now() returning *`,
  [link.tenant, folderId, link.userId, link.id, labelOf(label), branchOf(link.id)])
  link.send({ type: 'sync:bound', folderId, sourceId: s.id, branch: s.branch })
  emit(link.userId, 'folders', { slug: ok.folder.slug })
}

async function token(link, folderId, refuse) {
  const ok = await allowed(link, folderId)
  if (ok.why) return refuse(ok.why)
  const s = await sourceOf(folderId, link.id)
  const why = stateWhy(s)
  if (why) return refuse(why)
  const pub = String(process.env.PRO_GIT_PUBLIC_URL || '').trim().replace(/\/+$/, '')
  const p = `/api/local-git/${folderId}.git`
  // (person: the snapshot's author — the name every screen shows for them)
  const who = await person(link.userId).catch(() => null)
  link.send({ type: 'sync:token', folderId, path: p, url: pub ? `${pub}${p}` : null, branch: s.branch, push: prefixOf(link.id),
    person: { name: who?.name || '', email: who?.email || '' },
    main: await G.head(ok.folder.repo_path, `refs/heads/${ok.folder.default_branch}`),
    token: mintToken({ tenant: link.tenant, folderId, push: prefixOf(link.id), scope: 'sync', device: link.id, hours: TOKEN_HOURS }) })
}

async function unbind(link, folderId) {
  if (UUID.test(folderId)) await q(`update pro_folder_sources set state='removed', updated_at=now() where folder_id=$1 and device_id=$2 and tenant_id=$3`, [folderId, link.id, link.tenant])
  link.send({ type: 'sync:unbound', folderId })
  const [f] = UUID.test(folderId) ? await q('select slug from pro_folders where id=$1', [folderId]) : []
  if (f) emit(link.userId, 'folders', { slug: f.slug })
}

// ---------- what a push brought in ----------
// the files the commits base..head added or changed, each once (a merge commit: only what differs from every parent) → [{path, sha, size}]
export async function broughtIn(repo, base, head) {
  const commits = (await G.git(repo, ['rev-list', '--max-count=500', head, ...(base ? [`^${base}`] : [])], { check: false })).split('\n').filter(Boolean)
  const seen = new Map()
  for (const c of commits) {
    const parents = (await G.git(repo, ['rev-list', '--parents', '-n1', c], { check: false })).trim().split(' ').slice(1)
    const diffs = []
    for (const p of parents.length ? parents : [EMPTY_TREE]) {
      const out = await G.git(repo, ['diff-tree', '-r', '-z', '--no-renames', '--diff-filter=AM', p, c], { check: false })
      const parts = out.split('\0').filter(Boolean)
      const m = new Map()
      for (let i = 0; i + 1 < parts.length; i += 2) { const meta = parts[i].split(' '); m.set(parts[i + 1], meta[3]) }
      diffs.push(m)
    }
    for (const [p, sha] of diffs[0]) if (diffs.every((d) => d.has(p)) && !seen.has(`${p}\0${sha}`)) seen.set(`${p}\0${sha}`, { path: p, sha })
  }
  const files = [...seen.values()]
  if (!files.length) return files
  const sizes = new Map((await G.git(repo, ['cat-file', '--batch-check'], { check: false, input: files.map((f) => f.sha).join('\n') + '\n' }))
    .split('\n').filter(Boolean).map((l) => { const [sha, , size] = l.split(' '); return [sha, Number(size) || 0] }))
  return files.map((f) => ({ ...f, size: sizes.get(f.sha) ?? 0 }))
}
// what must not go up, among what base..head brought in → [{path, line, reason}]
export async function refusedBetween(folder, base, head) {
  const files = await broughtIn(folder.repo_path, base, head)
  return refusedIn(files, (f) => G.git(folder.repo_path, ['cat-file', 'blob', f.sha], { buffer: true }).catch(() => null))
}
// where the check starts: the head this source last had accepted (when head grew from it), else where head left main
async function baseFor(folder, source, head) {
  if (source.last_head && await isAncestor(folder.repo_path, source.last_head, head)) return source.last_head
  return G.mergeBase(folder.repo_path, folder.default_branch, head)
}
// the branch back where it was (or gone, when it had not been there), the refusal kept on the source for its sync:pushed
async function putBack(folder, source, from, to, hits, ref = `refs/heads/${source.branch}`) {
  if (to && !ZERO.test(to)) await G.git(folder.repo_path, ['update-ref', ref, to, from], { check: false })
  else await G.git(folder.repo_path, ['update-ref', '-d', ref, from], { check: false })
  await q(`update pro_folder_sources set why='secret', report = report || $2::jsonb, updated_at=now() where id=$1`, [source.id, JSON.stringify({ refused: hits, refusedHead: from })])
  console.warn(`[champion] ${folder.slug}: a push from ${String(source.device_id).slice(0, 8)} carried ${hits.length} file(s) that must not go up — its branch is put back`)
}

// gitHttp after(): right after a sync token's push, still inside the folder's lock — a file that must not be there never stays reachable,
// on the device's sync branch or on any other branch under its prefix (the token may push there too)
export async function afterPush(claims, folder, commands) {
  if (claims?.scope !== 'sync') return
  const source = await sourceOf(folder.id, claims.device)
  if (!source) return
  for (const c of commands) {
    if (!c.ref.startsWith(`refs/heads/${prefixOf(claims.device)}`) || ZERO.test(c.new)) continue
    const base = !ZERO.test(c.old) && await isAncestor(folder.repo_path, c.old, c.new) ? c.old : await baseFor(folder, source, c.new)
    const hits = await refusedBetween(folder, base, c.new)
    if (hits.length) await putBack(folder, source, c.new, ZERO.test(c.old) ? null : c.old, hits, c.ref)
  }
}

async function pushed(link, folderId, msg, refuse) {
  const ok = await allowed(link, folderId)
  if (ok.why) return refuse(ok.why)
  const head = String(msg.head || '')
  if (!OID.test(head)) return refuse('conflict')
  const report = reportOf(msg.report)
  const who = await person(link.userId).catch(() => null)
  const author = { name: who?.name || 'Process GPT Lite', email: who?.email || undefined }
  const folder = ok.folder
  const out = await S.serial(folder.id, async () => {
    const source = await sourceOf(folderId, link.id)
    const why = stateWhy(source)
    if (why) return { why }
    const tip = await G.head(folder.repo_path, `refs/heads/${source.branch}`)
    // (put back right after the push — gitHttp after(): the same answer)
    if (tip !== head) return source.why === 'secret' && source.report?.refusedHead === head ? { why: 'secret', paths: source.report.refused || [] } : { why: 'conflict' }
    const hits = await refusedBetween(folder, await baseFor(folder, source, head), head)
    if (hits.length) {
      const prev = source.last_head && await isAncestor(folder.repo_path, source.last_head, head) ? source.last_head : null
      await putBack(folder, source, head, prev, hits)
      return { why: 'secret', paths: hits }
    }
    const r = await intoMainNow(folder, head, { who: author, message: L(`${source.label} 에서 올림`, `Uploaded from ${source.label}`) })
    const taken = await isAncestor(folder.repo_path, head, r.main)
    await q(`update pro_folder_sources set last_head=$2, last_pushed_at=now(), report=$3, why=$4, seen_main=case when $4::text is null then $5 else seen_main end, updated_at=now() where id=$1`,
      [source.id, head, report, taken ? null : 'conflict', r.main])
    return { taken, main: r.main }
  })
  if (out.why) return refuse(out.why, out.paths ? { paths: out.paths } : {})
  await S.touch(folder)
  if (out.taken) {
    // (the file list and the agent assets now — the documents' cards come a little later)
    const { reindex, cardsSoon } = await import('./indexer.js')
    await reindex(folder, { cards: false }).catch((e) => console.warn('[champion] index', e.message))
    cardsSoon(folder, 5_000)
    link.send({ type: 'sync:taken', folderId, main: out.main })
  } else link.send({ type: 'sync:behind', folderId, main: out.main })
  emit(link.userId, 'folders', { slug: folder.slug })
}

// ---------- the folder screen ----------
const view = (s, names, devices, me) => ({
  id: s.id, label: s.label, userId: String(s.user_id), userName: names.get(String(s.user_id))?.name || '', deviceName: devices.get(String(s.device_id)) || '',
  state: s.state, why: s.why || null, lastPushedAt: s.last_pushed_at, report: reportOf(s.report), mine: String(s.user_id) === String(me.id),
})
export async function list(folder, me) {
  const rows = await q(`select * from pro_folder_sources where folder_id=$1 and state <> 'removed' order by created_at`, [folder.id])
  const names = await people([...new Set(rows.map((r) => String(r.user_id)))])
  const devices = new Map((await q('select id::text, name from pro_local_devices where id = any($1::uuid[])', [rows.map((r) => r.device_id)])).map((d) => [d.id, d.name]))
  return rows.map((r) => view(r, names, devices, me))
}
// the source's own person or the folder's owner
async function own(folder, me, role, id) {
  if (!UUID.test(String(id || ''))) throw err(404, L('연결된 PC 를 찾지 못했어요.', "I couldn't find that computer."))
  const [s] = await q(`select * from pro_folder_sources where id=$1 and folder_id=$2 and state <> 'removed'`, [id, folder.id])
  if (!s) throw err(404, L('연결된 PC 를 찾지 못했어요.', "I couldn't find that computer."))
  if (String(s.user_id) !== String(me.id) && role !== 'owner') throw err(403, L('그 PC 의 주인이나 폴더 소유자만 바꿀 수 있어요.', 'Only its person or the folder owner can change that.'))
  return s
}
// the desktop is told at once when it is linked now (else it hears it on its next sync:token)
async function tell(s, msg) {
  const H = await import('../localAgents/hub.js')
  H.linkOf(s.tenant_id, String(s.device_id))?.send(msg)
}
export async function setState(folder, me, role, id, state) {
  if (!['paused', 'active'].includes(state)) throw err(400, L("상태는 'paused' 나 'active' 예요.", "The state is 'paused' or 'active'."))
  const s = await own(folder, me, role, id)
  await q('update pro_folder_sources set state=$2, why=null, updated_at=now() where id=$1', [s.id, state])
  await tell(s, state === 'paused' ? { type: 'sync:refused', folderId: folder.id, why: 'paused' } : { type: 'sync:resumed', folderId: folder.id })
  return list(folder, me)
}
export async function remove(folder, me, role, id) {
  const s = await own(folder, me, role, id)
  await q(`update pro_folder_sources set state='removed', updated_at=now() where id=$1`, [s.id])
  await tell(s, { type: 'sync:refused', folderId: folder.id, why: 'source_removed' })
  return list(folder, me)
}
