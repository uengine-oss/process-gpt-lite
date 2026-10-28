// HTTP routes for shared folders (공유 폴더). Every route checks the caller's role in the folder.
import express from 'express'
import { L } from '../lib/lang.js'
import path from 'node:path'
import { config } from '../config.js'
import { q, admin } from '../lib/supa.js'
import * as G from '../lib/folders/git.js'
import * as S from '../lib/folders/service.js'
import * as M from '../lib/folders/merge.js'
import { reindex, search, changeCard } from '../lib/folders/indexer.js'
import { handover } from '../lib/folders/handover.js'
import { listTeam } from '../lib/team.js'
import * as SK from '../lib/folders/skills.js'

const MIME = {
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', py: 'text/plain; charset=utf-8', js: 'text/plain; charset=utf-8',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', wav: 'audio/wav', mp3: 'audio/mpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', hwpx: 'application/hwp+zip', hwp: 'application/x-hwp', dxf: 'image/vnd.dxf', psd: 'image/vnd.adobe.photoshop',
}

export function folderRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { const out = await fn(req, res); if (out !== undefined && !res.headersSent) res.json(out) } catch (e) {
      if (!e.status) console.warn('[folders]', req.method, req.path, e.message)
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.message })
    }
  }
  const user = (req) => ({ name: req.user.name, email: req.user.email, id: req.user.id })
  // raw files are loaded by <img>/<video>/editors: the token may come in the query
  const tokenAuth = (req, res, next) => { if (!req.headers.authorization && req.query.token) req.headers.authorization = `Bearer ${req.query.token}`; next() }

  r.get('/folders', auth, h((req) => S.listFolders(req.user)))
  r.post('/folders', auth, h(async (req) => {
    const f = await S.createFolder(user(req), req.body || {})
    await reindex(f)
    return S.publicFolder(f)
  }))
  r.post('/folders/link', auth, h(async (req) => {
    const f = await S.linkRepo(user(req), { repoPath: req.body.path, name: req.body.name, description: req.body.description })
    reindex(f).catch((e) => console.warn('[folders] link index', e.message))
    return S.publicFolder(f)
  }))
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
    return { ...S.publicFolder(folder), role, members, variations, history, integration: integration || null }
  }))
  r.get('/folders/:slug/skill', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    if (folder.kind !== 'skill') return null
    const name = folder.settings.skill_name
    const [vis, agents, contribs, merge, provider] = await Promise.all([SK.visibility(name), SK.agentsUsing(name), SK.contributions(name), SK.canMerge(folder, req.user), SK.providerConfigured()])
    const [author] = vis?.author_id ? await q('select id::text, username as name from users where id=$1 and tenant_id=$2', [vis.author_id, config.tenantId]) : []
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
  r.post('/folders/:slug/reindex', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    return { files: await reindex(folder) }
  }))
  r.patch('/folders/:slug', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'owner')
    const settings = { ...folder.settings, ...(typeof req.body.fulltext === 'boolean' ? { fulltext: req.body.fulltext } : {}) }
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
    return S.tree(folder, req.query.ref)
  }))
  r.get('/folders/:slug/file', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    const p = S.safeRel(req.query.path)
    const [row] = !req.query.ref || req.query.ref === 'main' ? await q('select path, kind, size, sha, mtime, author, card, card_error from pro_folder_files where folder_id=$1 and path=$2', [folder.id, p]) : []
    return row || { path: p }
  }))
  r.get('/folders/:slug/raw', tokenAuth, auth, h(async (req, res) => {
    const { folder } = await S.access(req.params.slug, req.user)
    const buf = await S.readBlob(folder, req.query.ref, req.query.path)
    const ext = path.extname(String(req.query.path)).slice(1).toLowerCase()
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'private, max-age=60')
    // a file an agent wrote must not run script on this origin
    if (/^(html?|svg|xml)$/.test(ext)) res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'")
    if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(String(req.query.path)))}`)
    res.end(buf)
  }))
  // IeumOffice and the ArtCraft apps load documents only from storage: publish a copy of this
  // version (content-addressed, so the same blob is uploaded once) and hand back its URL
  r.post('/folders/:slug/publish', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    const p = S.safeRel(req.body.path)
    const v = req.body.ref && req.body.ref !== 'main' ? await S.variation(folder, req.body.ref) : null
    const ref = v ? v.branch : folder.default_branch
    const sha = (await G.git(folder.repo_path, ['rev-parse', `${ref}:${p}`], { check: false })).trim()
    if (!sha) throw Object.assign(new Error(L('파일이 없어요.', "That file isn't there.")), { status: 404 })
    const ext = (path.extname(p).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin')
    const key = `pgpt-pro/folders/${folder.id}/${sha}.${ext}`
    const { data: there } = await admin.storage.from('files').list(`pgpt-pro/folders/${folder.id}`, { search: `${sha}.${ext}` })
    if (!there?.length) {
      const { error } = await admin.storage.from('files').upload(key, await G.git(folder.repo_path, ['cat-file', 'blob', sha], { buffer: true }), { contentType: MIME[ext] || 'application/octet-stream', upsert: true })
      if (error) throw error
    }
    return { url: `${config.supabaseUrl}/storage/v1/object/public/files/${key}`, name: path.basename(p) }
  }))
  r.post('/folders/:slug/files', express.raw({ type: () => true, limit: '200mb' }), auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    const sha = await S.upload(folder, user(req), decodeURIComponent(String(req.query.path || req.headers['x-file-name'] || '')), req.body)
    await reindex(folder)
    return { ok: true, commit: sha }
  }))
  r.delete('/folders/:slug/files', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'editor')
    await S.removeFile(folder, user(req), req.query.path)
    await reindex(folder)
    return { ok: true }
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
    return S.createVariation(folder, { title: req.body.title, kind: 'person', base: req.body.base, holder: { type: 'user', id: req.user.id, name: req.user.name }, source: { label: L(`${req.user.name} 님이 직접 만든 변형`, `Variation made by ${req.user.name}`) }, createdBy: req.user.id })
  }))
  r.get('/folders/:slug/variations/:vid', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user)
    const v = await S.variation(folder, req.params.vid)
    return { ...(await S.variationDetail(folder, v)), role, folder: S.publicFolder(folder) }
  }))
  r.get('/folders/:slug/variations/:vid/diff', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return S.fileDiff(folder, await S.variation(folder, req.params.vid), req.query.path)
  }))
  // a person's checkout: put it on disk for the workroom, commit what they changed there
  r.post('/folders/:slug/variations/:vid/checkout', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variation(folder, req.params.vid)
    if (['merged', 'discarded'].includes(v.status)) throw Object.assign(new Error(L('반영했거나 버린 변형은 열 수 없어요.', "A merged or discarded variation can't be opened.")), { status: 409 })
    await S.checkout(folder, v, S.personCheckoutDir(req.user, v))
    await q(`update pro_folder_variations set status='open' where id=$1 and status='ready'`, [v.id])
    return { ok: true, workroom: `/workroom/variation/${v.id}` }
  }))
  r.post('/folders/:slug/variations/:vid/commit', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variation(folder, req.params.vid)
    const sha = await S.commitVariation(folder, v, user(req), req.body.message || `${req.user.name}: ${v.title}`)
    const cur = await S.variationById(v.id)
    if (req.body.release) await S.release(folder, cur)
    if (sha) changeCard(folder, cur).catch(() => {})
    return { commit: sha }
  }))
  r.post('/folders/:slug/variations/:vid/discard', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    await S.discard(folder, await S.variation(folder, req.params.vid))
    return { ok: true }
  }))
  r.post('/folders/:slug/variations/:vid/card', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    return changeCard(folder, await S.variation(folder, req.params.vid))
  }))
  // 반영 요청 (a skill change: resource_pull_requests row; the author and bosses are notified)
  r.post('/folders/:slug/variations/:vid/request', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    if (folder.kind !== 'skill') throw Object.assign(new Error(L('반영 요청은 스킬 폴더에서만 써요.', 'Merge requests are for skill folders only.')), { status: 400 })
    const v = await S.variation(folder, req.params.vid)
    if (v.status !== 'ready') throw Object.assign(new Error(L('실행이 끝난 변형만 반영을 요청할 수 있어요.', 'Only a variation whose run has finished can be put up for merge.')), { status: 409 })
    return SK.requestMerge(folder, v, user(req), req.body || {})
  }))
  r.get('/folders/:slug/variations/:vid/review', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user)
    const v = await S.variation(folder, req.params.vid)
    if (folder.kind !== 'skill') return null
    return { pr: await SK.prOf(v), verification: await SK.latestVerification(v), canMerge: await SK.canMerge(folder, req.user) }
  }))
  r.post('/folders/:slug/variations/:vid/verify', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    if (folder.kind !== 'skill') throw Object.assign(new Error(L('검증은 스킬 폴더에서만 써요.', 'Verification is for skill folders only.')), { status: 400 })
    return SK.verify(folder, await S.variation(folder, req.params.vid), user(req), req.session.access_token)
  }))
  r.post('/folders/:slug/variations/:vid/handover', auth, h(async (req) => {
    const { folder } = await S.access(req.params.slug, req.user, 'runner')
    const v = await S.variation(folder, req.params.vid)
    return handover(folder, v, user(req), { ...req.body, jwt: req.session.access_token })
  }))

  // ---------- 일괄 반영 ----------
  r.post('/folders/:slug/merge', auth, h(async (req) => {
    const { folder, role } = await S.access(req.params.slug, req.user, 'runner')
    if (folder.kind !== 'skill' && S.RANK[role] < S.RANK.editor) throw Object.assign(new Error(L("이 작업에는 'editor' 권한이 필요해요.", "This needs the 'editor' role.")), { status: 403 })
    // a skill is merged only by its author or the boss of an agent that uses it — checked here,
    // not trusted to the screen
    if (folder.kind === 'skill' && !(await SK.canMerge(folder, req.user))) throw Object.assign(new Error(L('이 스킬을 반영할 수 있는 사람은 작성자와 이 스킬을 쓰는 에이전트의 담당자예요.', 'This skill can be merged by its author and by the owners of the agents that use it.')), { status: 403 })
    M.pendingJwt.set(req.user.id, req.session.access_token)
    return M.start(folder, user(req), req.body.ids, req.body.policy || 'stop')
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
