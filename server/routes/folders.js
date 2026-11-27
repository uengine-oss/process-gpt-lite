// HTTP routes for shared folders (공유 폴더). Every route checks the caller's role in the folder.
import express from 'express'
import { L } from '../lib/lang.js'
import path from 'node:path'
import { pipeline } from 'node:stream'
import os from 'node:os'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGPT_ROOT } from '../lib/paths.js'
import { config } from '../config.js'
import { q, admin } from '../lib/supa.js'
import * as G from '../lib/folders/git.js'
import * as S from '../lib/folders/service.js'
import * as M from '../lib/folders/merge.js'
// reference slots (참조 자리): every read under one goes through REFS.resolve — the reader's role in the source, now
import * as REFS from '../lib/folders/refs.js'
import { reindex, reindexSoon, search, changeCard, cardsSoon } from '../lib/folders/indexer.js'
import { handover } from '../lib/folders/handover.js'
import { listTeam } from '../lib/team.js'
import * as SK from '../lib/folders/skills.js'
import { named } from '../lib/people.js'
import * as KIT from '../lib/folders/kit.js'
import * as SRC from '../lib/folders/sources.js'
// template folders (lib/folders/templates.js): a project's own workspace from a template, and 「원본에 반영 요청」
import * as TPL from '../lib/folders/templates.js'
import * as SECRETS from '../lib/folders/secrets.js'
import { readBatch } from '../lib/folders/batchBody.js'
import * as SE from '../lib/folders/seats.js'
import * as SL from '../lib/folders/seatLink.js'
import { iga } from '../lib/josa.js'
import { emit } from '../lib/bus.js'

const MIME = S.MIME

// a message with every absolute path in it cut to its last part (「…/<name>」) — what a server failure may say to the page
// (first the server's own places — the folders, the agents' workspace, its home, the code — as 「…」, then any other absolute path; a path
// may hold spaces — Application Support — or follow a colon: at:/srv/…)
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const rootsMemo = new Map()
const knownRoots = () => {
  const bases = [path.dirname(S.foldersRoot()), path.dirname(S.workspaceDir()), PGPT_ROOT, APP_DIR, os.homedir()].filter((b) => b && b.split(/[\\/]/).filter(Boolean).length >= 2)
  const all = new Set()
  for (const b of bases) {
    all.add(b)
    if (!rootsMemo.has(b)) { try { rootsMemo.set(b, realpathSync(b)) } catch { rootsMemo.set(b, null) } }
    if (rootsMemo.get(b)) all.add(rootsMemo.get(b))
  }
  return [...all].sort((a, b) => b.length - a.length)
}
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const hidePaths = (m) => {
  let out = String(m || '')
  for (const root of knownRoots()) out = out.replace(new RegExp(`${escapeRe(root)}(?=[\\\\/\\s'"\`)]|$)`, 'g'), '…')
  return out.replace(/(^|[\s'"`(=:])((?:[A-Za-z]:)?(?:[\\/][^\s'"`\\/]+){2,}[\\/]?)/g,
    (_, pre, p) => `${pre}…/${path.basename(p.replace(/[\\/]+$/, '').replace(/\\/g, '/'))}`)
}
export function folderRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out) } catch (e) {
      const status = e.status || 500
      // (a server failure — git's own words, often — says what failed, never where on the server: the whole message goes to the log only)
      if (status >= 500) console.warn('[folders]', req.method, req.path, e.message)
      // (a seat that refused says where the working copy is — the page offers 「돌려 달라고 하기」 from it)
      if (!res.headersSent) res.status(status).json({ error: status >= 500 ? hidePaths(e.message) : e.message, ...(e.seat !== undefined ? { seat: e.seat } : {}), ...(e.why ? { why: e.why } : {}) })
    }
  }
  const user = (req) => ({ name: req.user.name, email: req.user.email, id: req.user.id })
  // raw files are loaded by <img>/<video>/editors: the token may come in the query
  const tokenAuth = (req, res, next) => { if (!req.headers.authorization && req.query.token) req.headers.authorization = `Bearer ${req.query.token}`; next() }

  r.get('/folders', auth, h((req) => S.listFolders(req.user)))
  r.post('/folders', auth, h(async (req) => {
    const b = req.body || {}
    // champion: a folder this person's computer is about to upload (the desktop app's 「내 PC 폴더 올리기」 — lib/folders/sources.js)
    const f = await S.createFolder(user(req), { name: b.name, description: b.description, slug: b.slug, champion: b.champion === true })
    await reindex(f)
    return S.publicFolder(f)
  }))
  r.post('/folders/link', auth, h(async (req) => {
    const f = await S.linkRepo(user(req), { repoPath: req.body.path, name: req.body.name, description: req.body.description })
    reindex(f).catch((e) => console.warn('[folders] link index', e.message))
    return S.publicFolder(f)
  }))
  // whether 「저장소 연결」 is offered to this person here (S.mayLink)
  r.get('/folders/caps', auth, h(async (req) => ({ link: await S.mayLink(req.user) })))
  // what the page leaves out before a folder goes up (the champion folders' rules — secrets.js pageRules)
  r.get('/folders/upload-rules', auth, h(() => SECRETS.pageRules()))
  r.get('/folders/search', auth, h((req) => search(req.user.id, req.query.q)))
  // people and agents a folder can be shared with / a variation handed to
  r.get('/folders/people', auth, h(async () => {
    const team = await listTeam()
    const agents = await q(`select id, username as name, description, agent_type from users where tenant_id=$1 and is_agent and coalesce(is_draft,false)=false
                            and coalesce(agent_type,'agent') in ('agent','deepagents') order by username limit 40`, [config.tenantId])
    return [...team.map((m) => ({ ...m, isAgent: false })), ...agents.map((a) => ({ ...a, isAgent: true }))]
  }))

  // ---------- skills as folders ----------
  r.get('/folders/skills', auth, h((req) => SK.listSkills(req.user)))
  r.post('/folders/skills/:name/open', auth, h(async (req) => {
    const name = req.params.name
    const vis = await SK.visibility(name)
    if (!vis || (vis.visibility === 'private' && String(vis.author_id) !== String(req.user.id))) throw Object.assign(new Error(L('이 스킬을 볼 수 없어요.', "You can't see this skill.")), { status: 404 })
    return { slug: (await SK.ensureSkillFolder(name)).slug }
  }))
  r.post('/folders/agents/:agentId/boss', auth, h(async (req) => {
    await SK.setBoss(req.user, req.params.agentId, req.body.owner || req.user.id)
    return { ok: true }
  }))

  r.get('/folders/:slug', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    const [members, variations, history] = await Promise.all([S.members(folder.id), S.variations(folder), S.history(folder, 30)])
    const [integration] = await q(`select * from pro_folder_integrations where folder_id=$1 and status in ('running','conflicted','resolving') order by created_at desc limit 1`, [folder.id])
    // where each variation's working copy is (its seat — lib/folders/seats.js): every member sees it, no path, no device id (a project's
    // workspace from a template is in no list — S.variations)
    const seats = await SE.viewsOf(folder, variations, { me: req.user, role }).catch((e) => { console.warn('[seats] list', e.message); return new Map() })
    return { ...S.publicFolder(folder), role, members, variations: variations.map(({ worktree_path, ...v }) => ({ ...v, worktree_path: worktree_path ? true : null, seat: seats.get(String(v.id)) || null })), history, integration: integration || null,
      template: await TPL.infoOf(folder).catch(() => null) }
  }))
  // 「템플릿으로 시작」: a project whose own workspace is a variation of this template (runner and up — the same right a project's folder needs)
  r.post('/folders/:slug/start-project', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const thread = await TPL.startProject(user(req), folder, { title: req.body?.title })
    return { id: thread.id, title: thread.title, kind: thread.kind }
  }))
  // what the 「작업실」 sheet needs at once (my variations and their seats, my computers — on or off, whether they keep working copies)
  r.get('/folders/:slug/workroom', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    return SE.workroomChoices(folder, req.user, role)
  }))
  r.get('/folders/:slug/skill', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    if (folder.kind !== 'skill') return null
    const name = folder.settings.skill_name
    const [vis, agents, contribs, merge, provider] = await Promise.all([SK.visibility(name), SK.agentsUsing(name), SK.contributions(name), SK.canMerge(folder, req.user), SK.providerConfigured()])
    const [author] = vis?.author_id ? await named(await q('select id::text, username as name from users where id=$1 and tenant_id=$2', [vis.author_id, config.tenantId])) : []
    return { name, visibility: vis?.visibility || 'tenant', author: author || null, mine: String(vis?.author_id) === String(req.user.id), askShare: vis?.visibility === 'private' && !vis.asked_at, agents, contributions: contribs, canMerge: merge, mode: provider ? 'provider' : 'local' }
  }))
  r.post('/folders/:slug/share', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return SK.share(folder, user(req), req.session.access_token)
  }))
  r.post('/folders/:slug/keep-private', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    await SK.keepPrivate(folder, req.user)
    return { ok: true }
  }))
  // a folder made for an upload from a computer that did not happen (cancelled there, or failed): removed again while it is empty
  r.delete('/folders/:slug', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    return S.discardEmptyChampion(folder, role)
  }))
  // the agent assets in main (skills · commands · instructions · rules · specs — lib/folders/kit.js)
  r.get('/folders/:slug/kit', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return KIT.kitOf(folder)
  }))
  // the computers that upload this folder (champion folders — lib/folders/sources.js): no path, only each computer's name for it
  r.get('/folders/:slug/sources', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return SRC.list(folder, req.user)
  }))
  r.patch('/folders/:slug/sources/:id', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    return SRC.setState(folder, req.user, role, req.params.id, req.body?.state)
  }))
  r.delete('/folders/:slug/sources/:id', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    return SRC.remove(folder, req.user, role, req.params.id)
  }))
  r.post('/folders/:slug/reindex', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    return { files: await reindex(folder) }
  }))
  r.patch('/folders/:slug', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'owner')
    let settings = { ...folder.settings, ...(typeof req.body.fulltext === 'boolean' ? { fulltext: req.body.fulltext } : {}) }
    // 템플릿으로 쓰기 — the same rule as TPL.setTemplate (lib/folders/templates.js); projects already started keep their workspace
    if (typeof req.body.template === 'boolean') settings = TPL.templateSettings({ ...folder, settings }, req.user, req.body.template)
    await q('update pro_folders set name=coalesce($2,name), description=coalesce($3,description), settings=$4, updated_at=now() where id=$1', [folder.id, req.body.name || null, req.body.description ?? null, settings])
    if (settings.fulltext !== folder.settings?.fulltext) { await q('update pro_folder_files set card_sha=null where folder_id=$1', [folder.id]); reindex(await S.folderById(folder.id)).catch(() => {}) }
    return { ok: true }
  }))

  // ---------- members ----------
  r.post('/folders/:slug/members', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'owner')
    await S.setMember(folder, req.user, req.body)
    return S.members(folder.id)
  }))
  r.delete('/folders/:slug/members/:type/:id', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'owner')
    await S.removeMember(folder, { type: req.params.type, id: req.params.id })
    return S.members(folder.id)
  }))

  // ---------- files ----------
  r.get('/folders/:slug/tree', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    const v = await S.assertRefVisible(folder, req.query.ref, req.user)
    const own = await S.tree(folder, req.query.ref)
    // (main: the files of the slots this person may read, at the slots' paths — each with `ref`; the slot wins over a file of this folder
    // a commit from elsewhere put under it. A project's workspace from a template reads the template's slots too.)
    return !req.query.ref || req.query.ref === 'main' || TPL.isWorkspace(v) ? [...(await REFS.ownRows(folder, own)), ...(await REFS.treeRows(folder, req.user))] : own
  }))
  // a file read through a slot answers from its source, for a reader of the source only; locked · dangling: nothing of it
  const through = async (folder, rel, ref, user) => {
    // (a workspace of a project started from a template is refused to anyone but its person; its slots are the template's)
    const v = await S.assertRefVisible(folder, ref, user)
    if (ref && ref !== 'main' && !TPL.isWorkspace(v)) return null
    const res = await REFS.resolve(folder, rel, user)
    const no = REFS.refusal(res)
    if (no) throw no
    return res?.state === 'ok' ? res : null
  }
  const refused = (res, e) => res.status(e.status).json({ error: e.message, code: e.code })
  r.get('/folders/:slug/file', auth, h(async (req, res) => {
    const { folder } = await S.access(req.params.slug, req.user)
    const p = S.safeRel(req.query.path)
    const via = await through(folder, p, req.query.ref, req.user).catch((e) => { if (!String(e.code || '').startsWith('ref_')) throw e; refused(res, e); return false })
    if (via === false) return
    if (via) return via.path ? REFS.fileRow(via) : { path: p }
    const [row] = !req.query.ref || req.query.ref === 'main' ? await q('select path, kind, size, sha, mtime, author, card, card_error from pro_folder_files where folder_id=$1 and path=$2', [folder.id, p]) : []
    return row || { path: p }
  }))
  r.get('/folders/:slug/raw', tokenAuth, auth, h(async (req, res) => {
    const { folder } = await S.access(req.params.slug, req.user)
    const via = await through(folder, req.query.path, req.query.ref, req.user).catch((e) => { if (!String(e.code || '').startsWith('ref_')) throw e; refused(res, e); return false })
    if (via === false) return
    const gone = () => Object.assign(new Error(L('파일이 없어요.', "That file isn't there.")), { status: 404 })
    if (via && !via.path) throw gone()
    // the file at one commit: its git blob id is the ETag (a cheap lookup — a 304 never reads the file), and the body comes from
    // that same commit
    const src = via ? via.source : folder
    const rel = via ? via.path : req.query.path
    const rev = await S.revOf(src, via ? via.rev : req.query.ref)
    const commit = S.COMMIT.test(rev) ? rev : (await G.git(src.repo_path, ['rev-parse', '--verify', '-q', `${rev}^{commit}`], { check: false })).trim()
    const blob = commit ? await S.blobAt(src, commit, rel) : ''
    if (!blob) throw gone()
    // (a slot's file is of its original's kind — the slot's name need not carry the extension)
    const ext = path.extname(via ? via.path : String(req.query.path)).slice(1).toLowerCase()
    const named = path.basename(String(req.query.path))
    const saveAs = via && ext && !path.extname(named) ? `${named}.${ext}` : named
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    // a file an agent wrote must not run script on this origin
    if (/^(html?|svg|xml)$/.test(ext)) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(saveAs)}`)
    // a commit's file never changes: kept a minute. A branch (main, a variation) or a slot (it follows its original's main) moves: the
    // browser asks again each time and gets 304 while the file is the same — a file changed a moment ago is never shown stale
    // (11-27: a slot's file reopened within a minute of its original changing showed the old text)
    if (!via && S.COMMIT.test(String(req.query.ref || ''))) res.setHeader('Cache-Control', 'private, max-age=60')
    else {
      const etag = `"${blob}"`
      res.setHeader('Cache-Control', 'private, no-cache')
      res.setHeader('ETag', etag)
      // (If-None-Match compares weakly: W/"…" is the same tag — a proxy may weaken it; * is any)
      const asked = String(req.headers['if-none-match'] || '').split(',').map((t) => t.trim().replace(/^W\//, ''))
      if (asked.includes(etag) || asked.includes('*')) { res.statusCode = 304; return res.end() }
    }
    res.end(await S.readBlob(src, commit, rel))
  }))
  // IeumOffice and the ArtCraft apps load documents only from storage: publish a copy of this
  // version (content-addressed, so the same blob is uploaded once) and hand back its URL
  // editable: main's IeumOffice document, for an editor of the folder — the editor saves into the folder
  r.post('/folders/:slug/publish', auth, h(async (req, res) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    // (a slot's file: its source's copy, never edited from here — 「원본 열기」 goes to the original)
    const via = await through(folder, req.body.path, req.body.ref, req.user).catch((e) => { if (!String(e.code || '').startsWith('ref_')) throw e; refused(res, e); return false })
    if (via === false) return
    if (via && !via.path) throw Object.assign(new Error(L('파일이 없어요.', "That file isn't there.")), { status: 404 })
    if (via) return { ...(await S.publishFile(via.source, via.path, via.rev)), editable: false, origin: { slug: via.source.slug, name: via.source.name, path: via.path } }
    const out = await S.publishFile(folder, req.body.path, req.body.ref)
    const ext = path.extname(String(req.body.path || '')).slice(1).toLowerCase()
    const editable = (!req.body.ref || req.body.ref === 'main') && folder.kind !== 'linked' && S.RANK[role] >= S.RANK.editor && S.OFFICE_EDIT.has(ext)
    return { ...out, editable }
  }))
  // an IeumOffice save of main's file (body: path, base = the version opened, url = the editor's copy,
  // session); final: the editor closed — the card is made now (meanwhile saves only refresh the list)
  r.post('/folders/:slug/office-save', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    const out = req.body?.url ? await S.saveOfficeEdit(folder, user(req), req.body) : { path: S.safeRel(req.body?.path), commit: null }
    if (out.commit) await reindex(folder, { cards: false })
    if (out.commit || req.body?.final) cardsSoon(folder, req.body?.final ? 0 : 60_000)
    return out
  }))
  r.post('/folders/:slug/files', auth, express.raw({ type: () => true, limit: '200mb' }), h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    const sha = await S.upload(folder, user(req), decodeURIComponent(String(req.query.path || req.headers['x-file-name'] || '')), req.body)
    await reindex(folder)
    return { ok: true, commit: sha }
  }))
  // a folder from the person's computer (dropped on the page, or 「폴더 올리기」 — src/folderDrop.js): its files a request at a time, each one
  // commit (S.uploadMany). The person and their right in the folder are known before the body is read; the body is read as it comes,
  // within the limits (lib/folders/batchBody.js); one request at a time per person and folder, and at most SENDING_PER_PERSON for a person
  // in all. The index follows a moment later. (any refusal ends the connection: the rest of a body is not read)
  const SENDING_PER_PERSON = 2
  const sending = new Set()
  const sendingOf = new Map() // tenant:person → requests on their way
  r.post('/folders/:slug/files/batch', auth, async (req, res) => {
    const end = (status, body) => { if (res.headersSent || res.destroyed) return; res.status(status).set('Connection', 'close').json(body); res.on('finish', () => req.destroy()) }
    let key = null, who = null
    try {
      const { folder } = await S.access(req.params.slug, req.user, 'editor')
      if (folder.kind !== 'managed') return end(400, { error: L('이 폴더에는 폴더째 올릴 수 없어요.', "A folder can't be uploaded into this folder.") })
      const person = `${config.tenantId}:${req.user.id}`
      if (sending.has(`${person}:${folder.id}`) || (sendingOf.get(person) || 0) >= SENDING_PER_PERSON) {
        return end(429, { error: L('올리는 중인 것이 있어요 — 끝난 뒤에 다시 해 주세요.', 'An upload is under way — try again when it is done.'), code: 'busy' })
      }
      key = `${person}:${folder.id}`; who = person
      sending.add(key); sendingOf.set(who, (sendingOf.get(who) || 0) + 1)
      const { meta, items } = await readBatch(req, SECRETS.BATCH)
      const out = await S.uploadMany(folder, user(req), items, { label: meta.label, part: meta.part, parts: meta.parts, session: meta.session })
      if (out.commit) reindexSoon(folder)
      res.json({ ok: true, ...out })
    } catch (e) {
      const status = e.status || 500
      // (the page went away mid-way — a stopped upload, a closed tab: nothing to say, nobody to say it to)
      const gone = req.destroyed || res.destroyed || ['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'ECONNABORTED'].includes(e.code)
      if (status >= 500 && !gone) console.warn('[folders]', req.method, req.path, e.message)
      end(status, { error: status >= 500 ? hidePaths(e.message) : e.message, ...(e.code && status < 500 ? { code: e.code } : {}), ...(e.limit ? { limit: e.limit } : {}) })
    } finally {
      if (key) sending.delete(key)
      if (who) { const n = (sendingOf.get(who) || 1) - 1; if (n > 0) sendingOf.set(who, n); else sendingOf.delete(who) }
    }
  })
  r.delete('/folders/:slug/files', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    await S.removeFile(folder, user(req), req.query.path)
    await reindex(folder)
    return { ok: true }
  }))

  // ---------- reference slots (lib/folders/refs.js) ----------
  // (a refusal of a slot carries its code: ref_locked · ref_readonly · ref_taken …)
  // (a server error is said without its internal words — REFS.answerOf)
  const hr = (fn) => async (req, res) => {
    try { res.json(await fn(req)) } catch (e) {
      if (!e.status) console.warn('[folders] refs', req.method, req.path, e.message)
      const a = REFS.answerOf(e)
      res.status(a.status).json(a.body)
    }
  }
  r.get('/folders/:slug/refs', auth, hr(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return REFS.list(folder, req.user)
  }))
  r.post('/folders/:slug/refs', auth, hr(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    const b = req.body || {}
    return REFS.add(folder, role, user(req), { source: b.source, path: b.path, slot: b.slot, label: b.label, keepExt: b.keepExt === true })
  }))
  r.patch('/folders/:slug/refs/:id', auth, hr(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    return REFS.rename(folder, role, user(req), req.params.id, { slot: req.body?.slot, label: req.body?.label })
  }))
  r.delete('/folders/:slug/refs/:id', auth, hr(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    return REFS.remove(folder, role, user(req), req.params.id)
  }))
  r.post('/folders/:slug/refs/:id/request-access', auth, hr(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return REFS.requestAccess(folder, user(req), req.params.id)
  }))

  // ---------- linked repository ----------
  r.get('/folders/:slug/candidates', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    if (folder.kind !== 'linked') return { branches: [], worktrees: 0, staleWorktrees: 0 }
    return S.linkedCandidates(folder)
  }))
  r.post('/folders/:slug/import', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    return S.importBranches(folder, req.user, req.body.branches)
  }))

  // ---------- variations ----------
  r.post('/folders/:slug/variations', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    // (the base as given is never handed to git: main, a variation this person may see, or a commit they may read — service.js baseFor)
    const base = await S.baseFor(folder, req.body?.base, req.user)
    return S.createVariation(folder, { title: req.body.title, kind: 'person', base, holder: { type: 'user', id: req.user.id, name: req.user.name }, source: { label: L(`${req.user.name} 님이 직접 만든 변형`, `Variation made by ${req.user.name}`) }, createdBy: req.user.id })
  }))
  r.get('/folders/:slug/variations/:vid', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    const v = await S.variationFor(folder, req.params.vid, req.user)
    const row = await SE.seatOf(v.id, { v }).catch(() => null)
    const seat = SE.seatsOn() ? await SE.viewOf(row, v, { me: req.user, role }).catch(() => null) : null
    // (what the computer holding it said back to 「여기로 가져오기」 — a terminal open in its working copy: seatLink.js pcSays)
    const says = seat && row && row.place === 'device' && String(row.user_id) === String(req.user.id) ? SL.pcSays(v.id, row) : null
    if (says) seat.pcSays = says
    const { worktree_path, ...d } = await S.variationDetail(folder, v)
    // (kept: what git does not carry, kept when a place left the disk — listed with a download until it is removed)
    const kept = SE.seatsOn() ? await SE.keptOf(folder, v, { me: req.user, role }).catch(() => []) : []
    // (a project's workspace: what a computer left of it after its working copy moved — its person's, in no list but here)
    const leftovers = v.source?.template ? await TPL.leftoversOf(folder, v, req.user).catch(() => []) : []
    return { ...d, worktree_path: worktree_path ? true : null, seat, kept, leftovers, role, folder: S.publicFolder(folder) }
  }))
  r.get('/folders/:slug/variations/:vid/diff', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return S.fileDiff(folder, await S.variationFor(folder, req.params.vid, req.user), req.query.path)
  }))
  // ---------- the seat: where the variation's working copy is (lib/folders/seats.js, spec variation-seats) ----------
  // Open it in my server workroom (its seat comes here): only the variation's own person (an agent's variation: anyone who may run in the
  // folder), and only while no one else, no computer and no running agent has it — then 409 with where it is
  const openHere = async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    if (['merged', 'discarded'].includes(v.status)) throw Object.assign(new Error(L('반영했거나 버린 변형은 열 수 없어요.', "A merged or discarded variation can't be opened.")), { status: 409 })
    if (folder.kind !== 'managed') throw Object.assign(new Error(L('이 폴더의 변형은 작업실에서 열 수 없어요.', "This folder's variations can't be opened in the workroom.")), { status: 400 })
    const out = await SE.openServer(folder, v, { user: { ...user(req), id: req.user.id }, run: 'workroom', dir: S.personCheckoutDir(req.user, v) })
    await q(`update pro_folder_variations set status='open' where id=$1 and status='ready'`, [v.id])
    emit(req.user.id, 'folders', { slug: folder.slug, variation: v.id })
    const now = await S.variationById(v.id)
    return { ok: true, workroom: `/workroom/variation/${v.id}`, seat: await SE.viewOf(await SE.seatOf(v.id, { v: now }), now, { me: req.user, role }), moved: out.action === 'move' }
  }
  // (the screens before seats call this: the same as POST …/seat {to: 'server'})
  r.post('/folders/:slug/variations/:vid/checkout', auth, h(openHere))
  r.get('/folders/:slug/variations/:vid/seat', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    const v = await S.variationFor(folder, req.params.vid, req.user)
    return SE.viewOf(await SE.seatOf(v.id, { v }), v, { me: req.user, role })
  }))
  r.post('/folders/:slug/variations/:vid/seat', auth, h(async (req) => {
    if ((req.body?.to || 'server') === 'server') return openHere(req)
    return openOnDevice(req)
  }))
  // 「이 PC 에서 작업」 (desktop 0.2.6 — lib/folders/seatLink.js): the seat moves to one of my linked computers (my server workroom is
  // committed as it is and closed first) and that computer is told to make the working copy; it is held there once the computer says
  // ready (seat:ready — the page watches the seat). Only the variation's own person, only a computer of theirs that is on and new enough.
  const seatErr = (status, message, why) => Object.assign(new Error(message), { status, why, seat: null })
  async function openOnDevice(req) {
    const { folder, role } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    if (['merged', 'discarded'].includes(v.status)) throw Object.assign(new Error(L('반영했거나 버린 변형은 열 수 없어요.', "A merged or discarded variation can't be opened.")), { status: 409 })
    if (folder.kind !== 'managed') throw Object.assign(new Error(L('이 폴더의 변형은 PC 에서 열 수 없어요.', "This folder's variations can't be opened on a PC.")), { status: 400 })
    if (!SE.mayHold(v, req.user.id)) throw await SE.refusal({ ok: false, why: 'not-yours', v, seat: await SE.seatOf(v.id) }, folder, { me: req.user, role })
    const deviceId = String(req.body?.deviceId || '')
    const [d] = /^[0-9a-f-]{36}$/i.test(deviceId) ? await q('select * from pro_local_devices where id=$1 and tenant_id=$2 and user_id=$3 and revoked_at is null', [deviceId, config.tenantId, String(req.user.id)]) : []
    if (!d) throw seatErr(404, L('이 PC 가 내 계정에 연결돼 있지 않아요 — 설정에서 다시 연결해 주세요.', "This PC isn't linked to your account — link it again in the settings."), 'no_device')
    const H = await import('../lib/localAgents/hub.js')
    const link = H.linkOf(config.tenantId, String(d.id))
    if (!link) throw seatErr(409, L(`${iga(d.name)} 꺼져 있거나 서버에 이어져 있지 않아요.`, `${d.name} is off or not connected to the server.`), 'offline')
    if (!link.caps?.seats) throw seatErr(409, L('데스크톱 앱을 새 판(0.2.6)으로 바꿔 주세요 — 이 PC 에서 작업본을 열 수 있어요.', 'Update the desktop app (0.2.6) to open working copies on this PC.'), 'old_app')
    // (head: the commit the sheet showed the run-by-itself files of — …/trust: the variation moved since, so the sheet looks again first)
    const asked = /^[0-9a-f]{40}$/.test(String(req.body?.head || '')) ? String(req.body.head) : null
    if (asked && asked !== await G.head(folder.repo_path, `refs/heads/${v.branch}`)) {
      throw seatErr(409, L('그사이 이 변형이 바뀌었어요 — 받기 전에 다시 확인할게요.', 'The variation changed meanwhile — it is checked again before it comes here.'), 'moved')
    }
    const cur = await SE.seatOf(v.id, { v })
    const me = { ...user(req), id: req.user.id }
    let epoch
    if (cur && cur.place === 'device' && String(cur.device_id) === String(d.id) && String(cur.user_id) === String(req.user.id) && !cur.job_id) {
      // (already this computer's: held — nothing to do; still moving — said again, the computer takes the same epoch once)
      if (cur.state === 'held') return { ok: true, already: true, seat: await SE.viewOf(cur, v, { me: req.user, role }) }
      epoch = cur.epoch
    } else {
      const out = await SE.claimDevice(folder, v, { user: me, device: String(d.id), ready: false })
      if (out.legacy) throw seatErr(409, L('이 서버에는 아직 작업본 자리가 없어요(sql/063).', 'This server has no working-copy seats yet (sql/063).'), 'legacy')
      epoch = out.epoch
    }
    const opened = (await q(`update pro_folder_variations set status='open' where id=$1 and status='ready' returning id`, [v.id])).length > 0
    const now = await S.variationById(v.id)
    const seat = await SE.seatOf(v.id, { v: now })
    if (!(await SL.prepare(link, folder, now, { epoch, autoSave: seat?.auto_save !== false }))) {
      await SE.transition(v.id, (vv, s) => (s && s.place === 'device' && Number(s.epoch) === Number(epoch) ? { ok: true, next: null, bump: true, action: 'fail' } : { ok: false, why: 'none' }), { by: req.user.id, note: 'the PC did not take it' })
      // (it was ready to review before this: it is again — nothing was opened)
      if (opened) await q(`update pro_folder_variations set status='ready', updated_at=now() where id=$1 and status='open'`, [v.id])
      throw seatErr(409, L(`${d.name}에 보내지 못했어요 — 잠시 뒤에 다시 해 주세요.`, `Couldn't reach ${d.name} — try again in a moment.`), 'offline')
    }
    emit(req.user.id, 'folders', { slug: folder.slug, variation: v.id })
    return { ok: true, seat: await SE.viewOf(seat, now, { me: req.user, role }) }
  }
  // before 「이 PC 에서 작업」: what of the variation would run things on a computer by itself (hooks · MCP · .envrc · VS Code tasks · Windows
  // shell files) and who changed each last — the sheet warns and the person goes on with 「그래도 열기」 (lib/folders/seatTrust.js)
  r.get('/folders/:slug/variations/:vid/trust', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    const { trustOf } = await import('../lib/folders/seatTrust.js')
    return trustOf(folder, v, req.user)
  }))
  // 「돌려놓기」: my server workroom's working copy is saved as it is and put away (보관 중); the variation is ready to review
  r.post('/folders/:slug/variations/:vid/seat/release', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    const out = await SE.closeServer(folder, v, { by: req.user.id, me: req.user, epoch: req.body?.epoch ?? null })
    const now = await S.variationById(v.id)
    changeCard(folder, now).catch(() => {})
    // (kept: things git does not carry — ignored files, a repository inside — moved aside on the server rather than deleted)
    return { ok: true, kept: out?.kept || 0, seat: await SE.viewOf(null, now, { me: req.user, role }) }
  }))
  // a save point: what my server workroom holds is committed on the variation, the working copy stays where it is
  r.post('/folders/:slug/variations/:vid/seat/save', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    const seat = await SE.seatOf(v.id, { v })
    // a computer's working copy is saved on that computer: it is asked to make a save point now (seatLink.js seat:save)
    if (seat && seat.place === 'device') {
      if (String(seat.user_id) !== String(req.user.id)) throw await SE.refusal({ ok: false, why: 'not-holder', v, seat }, folder, { me: req.user })
      if (seat.job_id) throw Object.assign(new Error(L('PC 에서 도는 실행이 이 변형을 고치는 중이에요 — 끝나면 저절로 올라와요.', 'A run on the PC is changing this variation — it comes up by itself when done.')), { status: 409 })
      if (!(await SL.tell(seat.device_id, { type: 'seat:save', variation: v.id }))) throw seatErr(409, L('그 PC 가 꺼져 있어요 — 켜지면 저절로 올라와요.', 'That PC is off — it saves by itself when it is on.'), 'offline')
      return { ok: true, asked: true }
    }
    if (seat !== undefined && !(seat && seat.place === 'server' && seat.run === 'workroom' && String(seat.user_id) === String(req.user.id))) throw await SE.refusal({ ok: false, why: seat ? (seat.run === 'agent' ? 'agent' : 'held') : 'none', v, seat }, folder, { me: req.user })
    return { commit: await SE.commitAsIs(folder, v, { author: user(req), message: req.body?.message || L(`${req.user.name}: 저장 지점`, `${req.user.name}: save point`) }) }
  }))
  // 「여기로 가져오기」 (the seat's own person, from elsewhere) · the folder owner's take (after 「돌려 달라」 and a day without an answer)
  r.post('/folders/:slug/variations/:vid/seat/take', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    // my own computer's working copy while that computer is on: it gives the seat back itself — what is there is committed as it is and
    // pushed first (seat:recall auto → its 「돌려놓기」); the page sees the seat become 보관 중
    const cur = await SE.seatOf(v.id, { v })
    if (cur?.place === 'device' && !cur.job_id && cur.state === 'held' && String(cur.user_id) === String(req.user.id)) {
      const H = await import('../lib/localAgents/hub.js')
      const link = H.linkOf(config.tenantId, String(cur.device_id))
      SL.pcSaysClear(v.id)
      if (link?.caps?.seats && link.send({ type: 'seat:recall', variation: v.id, epoch: Number(cur.epoch), auto: true })) {
        return { ok: true, waiting: true, seat: await SE.viewOf(cur, v, { me: req.user, role }) }
      }
    }
    await SE.take(folder, v, { ...user(req), id: req.user.id }, { role, epoch: req.body?.epoch ?? null })
    // (a computer's working copy taken while it is off: when it comes back its list says so — and if it is on after all, now)
    if (cur?.place === 'device' && !cur.job_id) await SL.refreshList(cur.device_id)
    const now = await S.variationById(v.id)
    return { ok: true, seat: await SE.viewOf(null, now, { me: req.user, role }) }
  }))
  // 「돌려 달라고 하기」: an editor of the folder asks whoever has the working copy for it (a Home card for them)
  r.post('/folders/:slug/variations/:vid/seat/recall', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user, 'editor')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    const out = await SE.recall(folder, v, { ...user(req), id: req.user.id }, { why: String(req.body?.why || '').slice(0, 300), role })
    // (a computer's working copy: that computer says so too — a notification there; it gives the seat back only when its person does)
    if (out.seat?.place === 'device' && !out.seat.job_id) await SL.tell(out.seat.device_id, { type: 'seat:recall', variation: v.id, epoch: Number(out.seat.epoch), auto: false, by: req.user.name || '', why: String(req.body?.why || '').slice(0, 300) })
    return { ok: true, seat: await SE.viewOf(out.seat || null, out.v || v, { me: req.user, role }) }
  }))
  // one kept folder as a zip — whoever had that working copy, the variation's own person, or the folder owner; within the download limits
  // (413 'too-big' past them). ?check=1: only whether it may ({ok, bytes, count}) — the page asks first, so a refusal is said on the page
  r.get('/folders/:slug/variations/:vid/kept/:id', tokenAuth, auth, h(async (req, res) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    const v = await S.variationFor(folder, req.params.vid, req.user)
    if (req.query.check) return SE.keptZip(folder, v, req.params.id, { me: req.user, role, check: true })
    const z = await SE.keptZip(folder, v, req.params.id, { me: req.user, role })
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(z.name)}`)
    res.setHeader('Cache-Control', 'private, no-store')
    // (one who stops reading for two minutes gives the zip up; a zip that fails — a file changed — or is given up closes its files)
    res.setTimeout(120_000, () => res.destroy())
    pipeline(z.stream, res, (e) => { if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.warn('[folders] kept zip', e.message) })
  }))
  r.patch('/folders/:slug/variations/:vid/seat', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    const row = await SE.setPrefs(folder, v, req.user, { autoSave: req.body?.autoSave, watch: req.body?.watch })
    // (a computer's working copy follows the switch at once — its next save point is or is not made by itself)
    if (row?.place === 'device' && !row.job_id) await SL.tell(row.device_id, { type: 'seat:prefs', variation: v.id, autoSave: row.auto_save !== false })
    return { ok: true, autoSave: row.auto_save, watch: row.watch }
  }))
  // 「변경 저장」 (a commit of my server workroom; release: also put it away). Only from the place that has the working copy.
  r.post('/folders/:slug/variations/:vid/commit', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    const seat = await SE.seatOf(v.id, { v })
    if (seat && !(seat.place === 'server' && seat.run === 'workroom' && String(seat.user_id) === String(req.user.id))) throw await SE.refusal({ ok: false, why: seat.place === 'device' ? 'device' : seat.run === 'agent' ? 'agent' : 'held', v, seat }, folder, { me: req.user })
    const sha = await S.commitVariation(folder, v, user(req), req.body.message || `${req.user.name}: ${v.title}`)
    if (req.body.release) await SE.closeServer(folder, await S.variationById(v.id), { by: req.user.id, me: req.user })
    const cur = await S.variationById(v.id)
    if (sha) changeCard(folder, cur).catch(() => {})
    return { commit: sha }
  }))
  r.post('/folders/:slug/variations/:vid/discard', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    // my own server workroom is put away first (saved as it is); someone else's, a computer's or a running agent's: ask for it back
    await SE.forMove(folder, v, { ...user(req), id: req.user.id }, { role })
    await S.discard(folder, await S.variationById(v.id))
    return { ok: true }
  }))
  r.post('/folders/:slug/variations/:vid/card', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return changeCard(folder, await S.variationFor(folder, req.params.vid, req.user))
  }))
  // 원본에 반영 요청 (lib/folders/templates.js): the files a project's workspace may send to its template, and the sending
  r.get('/folders/:slug/variations/:vid/proposal', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return TPL.candidates(folder, await S.variationFor(folder, req.params.vid, req.user))
  }))
  r.post('/folders/:slug/variations/:vid/propose', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    return TPL.propose(folder, v, user(req), { paths: req.body?.paths, title: req.body?.title, note: req.body?.note })
  }))
  // 반영 요청 (a skill change: resource_pull_requests row; the author and bosses are notified)
  r.post('/folders/:slug/variations/:vid/request', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    if (folder.kind !== 'skill') throw Object.assign(new Error(L('반영 요청은 스킬 폴더에서만 써요.', 'Merge requests are for skill folders only.')), { status: 400 })
    const v = await S.variationFor(folder, req.params.vid, req.user)
    if (v.status !== 'ready') throw Object.assign(new Error(L('실행이 끝난 변형만 반영을 요청할 수 있어요.', 'Only a variation whose run has finished can be put up for merge.')), { status: 409 })
    return SK.requestMerge(folder, v, user(req), req.body || {})
  }))
  r.get('/folders/:slug/variations/:vid/review', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    const v = await S.variationFor(folder, req.params.vid, req.user)
    if (folder.kind !== 'skill') return null
    return { pr: await SK.prOf(v), verification: await SK.latestVerification(v), canMerge: await SK.canMerge(folder, req.user) }
  }))
  r.post('/folders/:slug/variations/:vid/verify', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    if (folder.kind !== 'skill') throw Object.assign(new Error(L('검증은 스킬 폴더에서만 써요.', 'Verification is for skill folders only.')), { status: 400 })
    return SK.verify(folder, await S.variationFor(folder, req.params.vid, req.user), user(req), req.session.access_token)
  }))
  r.post('/folders/:slug/variations/:vid/handover', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variationFor(folder, req.params.vid, req.user)
    if (TPL.isWorkspace(v)) throw Object.assign(new Error(L('프로젝트의 작업 공간은 넘기지 않아요. 템플릿을 고칠 것은 「원본에 반영 요청」으로 보내 주세요.', "A project's workspace isn't handed over. Send what the template needs with “Request a merge into the original”.")), { status: 409 })
    return handover(folder, v, user(req), { ...req.body, jwt: req.session.access_token, role })
  }))

  // ---------- 일괄 반영 ----------
  r.post('/folders/:slug/merge', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user, 'runner')
    if (folder.kind !== 'skill' && S.RANK[role] < S.RANK.editor) throw Object.assign(new Error(L("이 작업에는 'editor' 권한이 필요해요.", "This needs the 'editor' role.")), { status: 403 })
    // a skill is merged only by its author or the boss of an agent that uses it — checked here,
    // not trusted to the screen
    if (folder.kind === 'skill' && !(await SK.canMerge(folder, req.user))) throw Object.assign(new Error(L('이 스킬을 반영할 수 있는 사람은 작성자와 이 스킬을 쓰는 에이전트의 담당자예요.', 'This skill can be merged by its author and by the owners of the agents that use it.')), { status: 403 })
    M.pendingJwt.set(req.user.id, req.session.access_token)
    return M.start(folder, user(req), req.body.ids, req.body.policy || 'stop', { role })
  }))
  r.get('/folders/:slug/merge/:iid', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return M.get(folder, req.params.iid)
  }))
  r.get('/folders/:slug/merge/:iid/sides', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return M.sides(folder, await M.get(folder, req.params.iid), S.safeRel(req.query.path))
  }))
  r.post('/folders/:slug/merge/:iid/choose', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    if (folder.kind === 'skill' && !(await SK.canMerge(folder, req.user))) throw Object.assign(new Error(L('이 스킬을 반영할 권한이 없어요.', 'You may not merge this skill.')), { status: 403 })
    return M.choose(folder, await M.get(folder, req.params.iid), user(req), req.body.choices)
  }))
  r.post('/folders/:slug/merge/:iid/agent', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    if (folder.kind === 'skill' && !(await SK.canMerge(folder, req.user))) throw Object.assign(new Error(L('이 스킬을 반영할 권한이 없어요.', 'You may not merge this skill.')), { status: 403 })
    return M.resolveWithAgent(folder, await M.get(folder, req.params.iid), user(req), req.session.access_token)
  }))
  r.post('/folders/:slug/merge/:iid/abort', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    return M.abort(folder, await M.get(folder, req.params.iid))
  }))
  return r
}
