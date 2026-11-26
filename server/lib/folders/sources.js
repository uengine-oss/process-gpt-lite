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
// why: not_editor · no_folder · not_managed · not_empty · device_revoked · source_removed · paused · secret · structure · too_big ·
//      unchecked (what came in could not be looked at — refused all the same) · conflict · rate_limited
import { config } from '../../config.js'
import { q } from '../supa.js'
import { emit } from '../bus.js'
import { person, people } from '../people.js'
import { L } from '../lang.js'
import * as G from './git.js'
import * as S from './service.js'
import { intoMainNow } from './line.js'
import { mintToken } from './gitHttp.js'
import { refusedIn, structureOf, LIMITS } from './secrets.js'

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
// a link may ask this often (a round is a token, a push and its sync:pushed — a person presses 「지금 올리기」, the app's own rounds are
// minutes apart): past it the link is told so and nothing is done
export const RATE = { perMinute: 60 }
const asked = new WeakMap() // link → [times]
function tooOften(link, now = Date.now()) {
  const list = (asked.get(link) || []).filter((t) => now - t < 60_000)
  list.push(now)
  asked.set(link, list)
  return list.length > RATE.perMinute
}
export async function receive(link, msg) {
  const folderId = String(msg.folderId || '')
  const refuse = (why, extra = {}) => link.send({ type: 'sync:refused', folderId, why, ...extra })
  if (tooOften(link)) return refuse('rate_limited')
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
  // Until a second computer can join a folder (its first snapshot is taken in as a variation, not as main — the next stage), only the
  // computer that first uploaded the folder binds it again: another one's first snapshot would delete everyone else's files from main.
  const had = await sourceOf(folderId, link.id)
  // (asked strictly: a git that cannot answer refuses the bind — receive() says conflict — rather than taking the folder for empty)
  if (!had && (await G.git(ok.folder.repo_path, ['ls-tree', '--name-only', ok.folder.default_branch])).trim()) return refuse('not_empty')
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
  const [f] = UUID.test(folderId) ? await q('select slug from pro_folders where id=$1 and tenant_id=$2', [folderId, link.tenant]) : []
  if (f) emit(link.userId, 'folders', { slug: f.slug })
}

// ---------- what a push brought in ----------
// The files the commits base..head added or changed (or changed in kind), each once — a merge commit: only what differs from every
// parent → [{path, sha, mode, size}]. Every git call here must answer in full: an error, a time-out or a missing object throws (the caller
// refuses the push — what could not be looked at does not go through).
export async function broughtIn(repo, base, head) {
  const commits = (await G.git(repo, ['rev-list', head, ...(base ? [`^${base}`] : [])])).split('\n').filter(Boolean)
  const seen = new Map()
  for (const c of commits) {
    const parents = (await G.git(repo, ['rev-list', '--parents', '-n1', c])).trim().split(' ').slice(1)
    const diffs = []
    for (const p of parents.length ? parents : [EMPTY_TREE]) {
      const out = await G.git(repo, ['diff-tree', '-r', '-z', '--no-renames', '--diff-filter=AMT', p, c])
      const parts = out.split('\0').filter(Boolean)
      if (parts.length % 2) throw new Error('git diff-tree: output cut short')
      const m = new Map()
      for (let i = 0; i < parts.length; i += 2) {
        const meta = parts[i].split(' ')
        if (meta.length < 5 || !OID.test(meta[3] || '')) throw new Error('git diff-tree: output not understood')
        m.set(parts[i + 1], { sha: meta[3], mode: meta[1] })
      }
      diffs.push(m)
    }
    for (const [p, e] of diffs[0]) if (diffs.every((d) => d.has(p)) && !seen.has(`${p}\0${e.sha}`)) seen.set(`${p}\0${e.sha}`, { path: p, ...e })
  }
  const files = [...seen.values()]
  // (a gitlink names a commit of another repository — not an object here: it has no size, and it is refused anyway)
  const blobs = [...new Set(files.filter((f) => f.mode !== '160000').map((f) => f.sha))]
  const sizes = new Map()
  if (blobs.length) {
    for (const l of (await G.git(repo, ['cat-file', '--batch-check'], { input: blobs.join('\n') + '\n' })).split('\n').filter(Boolean)) {
      const [sha, type, size] = l.split(' ')
      if (type !== 'blob' || !/^\d+$/.test(size || '')) throw new Error(`git cat-file: ${sha} is ${type || 'missing'}`)
      sizes.set(sha, Number(size))
    }
    if (blobs.some((b) => !sizes.has(b))) throw new Error('git cat-file: output cut short')
  }
  return files.map((f) => ({ ...f, size: sizes.get(f.sha) ?? 0 }))
}
// the pushed snapshot as a whole: its files and their size before compression → {files, bytes}
async function treeSize(repo, head) {
  let files = 0, bytes = 0
  for (const line of (await G.git(repo, ['ls-tree', '-r', '-l', '-z', '--full-tree', head])).split('\0').filter(Boolean)) {
    const [meta] = line.split('\t')
    const [, type, , size] = meta.split(/\s+/)
    files++
    if (type === 'blob') bytes += Number(size) || 0
  }
  return { files, bytes }
}
// Everything the server looks at in what a sync push brought in (base..head), before anything takes it → null (fine) or the refusal
// {why, paths?, limit?}: too many new commits · a link, another repository, .gitmodules, .lfsconfig (structure) · a file or the
// whole snapshot over its limit (too_big) · a secret's file name or a key of a sure shape (secret) · unchecked (git could not answer)
export async function inspect(folder, base, head) {
  const repo = folder.repo_path
  try {
    const count = Number((await G.git(repo, ['rev-list', '--count', head, ...(base ? [`^${base}`] : [])])).trim())
    if (!Number.isInteger(count)) throw new Error('git rev-list --count: not a number')
    if (count > LIMITS.pushMaxCommits) return { why: 'too_big', limit: { kind: 'commits', value: count, max: LIMITS.pushMaxCommits } }
    const files = await broughtIn(repo, base, head)
    const odd = files.map((f) => ({ path: f.path, line: null, reason: structureOf(f) })).filter((x) => x.reason)
    if (odd.length) return { why: 'structure', paths: odd.slice(0, 50) }
    const big = files.filter((f) => f.size > LIMITS.largeFileBytes)
    if (big.length) return { why: 'too_big', limit: { kind: 'file', max: LIMITS.largeFileBytes }, paths: big.slice(0, 50).map((f) => ({ path: f.path, line: null, reason: 'large' })) }
    const all = await treeSize(repo, head)
    if (all.files > LIMITS.headMaxFiles) return { why: 'too_big', limit: { kind: 'files', value: all.files, max: LIMITS.headMaxFiles } }
    if (all.bytes > LIMITS.headMaxBytes) return { why: 'too_big', limit: { kind: 'bytes', value: all.bytes, max: LIMITS.headMaxBytes } }
    const secret = await refusedIn(files, (shas, each) => G.catBatch(repo, shas, each))
    if (secret.length) return { why: 'secret', paths: secret }
    return null
  } catch (e) {
    console.warn(`[champion] ${folder.slug}: what a push brought in could not be looked at — refused (${e.message.slice(0, 160)})`)
    return { why: 'unchecked' }
  }
}
// where the check starts: the head this source last had accepted (when head grew from it), else where head left main
async function baseFor(folder, source, head) {
  if (source.last_head && await isAncestor(folder.repo_path, source.last_head, head)) return source.last_head
  return G.mergeBase(folder.repo_path, folder.default_branch, head)
}
// the branch back where it was (or gone, when it had not been there), the refusal kept on the source for its sync:pushed
async function putBack(folder, source, from, to, no, ref = `refs/heads/${source.branch}`) {
  if (to && !ZERO.test(to)) await G.git(folder.repo_path, ['update-ref', ref, to, from], { check: false })
  else await G.git(folder.repo_path, ['update-ref', '-d', ref, from], { check: false })
  await q(`update pro_folder_sources set why=$3, report = report || $2::jsonb, updated_at=now() where id=$1`,
    [source.id, JSON.stringify({ refused: no.paths || [], refusedHead: from, refusedWhy: no.why, refusedLimit: no.limit || null }), no.why])
  console.warn(`[champion] ${folder.slug}: a push from ${String(source.device_id).slice(0, 8)} was refused (${no.why}${no.paths ? `, ${no.paths.length} file(s)` : ''}) — its branch is put back`)
}
const refusal = (no) => ({ why: no.why, ...(no.paths ? { paths: no.paths } : {}), ...(no.limit ? { limit: no.limit } : {}) })

// gitHttp after(): right after a sync token's push, still inside the folder's lock — what must not be there never stays reachable, on the
// device's sync branch or on any other branch under its prefix (the token may push there too)
export async function afterPush(claims, folder, commands) {
  if (claims?.scope !== 'sync') return
  const source = await sourceOf(folder.id, claims.device)
  if (!source) return
  for (const c of commands) {
    if (!c.ref.startsWith(`refs/heads/${prefixOf(claims.device)}`) || ZERO.test(c.new)) continue
    const base = !ZERO.test(c.old) && await isAncestor(folder.repo_path, c.old, c.new) ? c.old : await baseFor(folder, source, c.new)
    const no = await inspect(folder, base, c.new)
    if (no) await putBack(folder, source, c.new, ZERO.test(c.old) ? null : c.old, no, c.ref)
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
    if (tip !== head) {
      const r = source.report || {}
      return r.refusedHead === head && r.refusedWhy ? refusal({ why: r.refusedWhy, paths: r.refused, limit: r.refusedLimit }) : { why: 'conflict' }
    }
    const main = await G.head(folder.repo_path, `refs/heads/${folder.default_branch}`)
    // (said again — an answer that did not reach the desktop: taken already, nothing to do)
    if (source.last_head === head && !source.why && await isAncestor(folder.repo_path, head, main)) return { taken: true, main, again: true }
    const no = await inspect(folder, await baseFor(folder, source, head), head)
    if (no) {
      const prev = source.last_head && await isAncestor(folder.repo_path, source.last_head, head) ? source.last_head : null
      await putBack(folder, source, head, prev, no)
      return refusal(no)
    }
    // (a folder made before its attributes were neutralized gets them now — its own .gitattributes never changes the merge or checkout)
    await S.championAttributes(folder.repo_path)
    const r = await intoMainNow(folder, head, { who: author, message: L(`${source.label} 에서 올림`, `Uploaded from ${source.label}`) })
    const taken = await isAncestor(folder.repo_path, head, r.main)
    await q(`update pro_folder_sources set last_head=$2, last_pushed_at=now(), report=$3, why=$4, seen_main=case when $4::text is null then $5 else seen_main end, updated_at=now() where id=$1`,
      [source.id, head, report, taken ? null : 'conflict', r.main])
    return { taken, main: r.main }
  })
  if (out.why) { const { why, ...extra } = out; return refuse(why, extra) }
  if (out.again) return link.send({ type: 'sync:taken', folderId, main: out.main })
  await S.touch(folder)
  if (out.taken) {
    // (the file list and the agent assets now — the documents' cards come a little later; one index pass of a folder at a time)
    const { reindex, cardsSoon } = await import('./indexer.js')
    await S.serial(`${folder.id}:index`, () => reindex(folder, { cards: false })).catch((e) => console.warn('[champion] index', e.message))
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
