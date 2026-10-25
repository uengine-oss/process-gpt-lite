import express from 'express'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'
import { q, sessionFor, refresh, userFromJwt } from './lib/supa.js'
import { subscribe, emit, poll, lastSeq } from './lib/bus.js'
import { mainThread, getThread, addMessage } from './lib/store.js'
import { runTurn, delegate } from './lib/agent.js'
import * as vault from './lib/vault.js'
import * as browser from './lib/browser.js'
import { listSchedules, deleteSchedule } from './lib/scheduler.js'
import { generatePanel, revisePanel, savePanelData, proxyFetch } from './lib/panels.js'
import { chat } from './lib/llm.js'
import * as mail from './lib/mail.js'
import { processRoutes } from './routes/process.js'
import { startBrowserWorker } from './lib/browserWorker.js'
import { mountConnectors, connectorStatus, ensureHubBinding } from './mcp/connectors.js'
import { mountCraft } from './mcp/craft.js'
import { mountOffice } from './mcp/office.js'
import { craftLiveRoutes, attachCraftLive } from './lib/craftLive.js'
import { mountFolders } from './mcp/folders.js'
import { folderRoutes } from './routes/folders.js'
import { panelAppRoutes } from './routes/panelApps.js'
import { mountPanelApps } from './mcp/panelapps.js'
import { startFolderSteps } from './lib/folders/work.js'
import * as skills from './lib/folders/skills.js'
import { runMission, listMissionRuns, createMission, listSkills, saveSkillDraft, workspaceHostPath } from './lib/missions.js'
import { getSkill, deleteSkill } from './lib/skills.js'
import { startSystemRegistry, syncSystemRegistry } from './lib/systems.js'
import * as notify from './lib/notify.js'
import * as team from './lib/team.js'
import * as workroom from './lib/workroom.js'
import { saveAttachment } from './lib/attachments.js'

const app = express()
// ArtCraft web apps (static WebAssembly builds) on this origin: their postMessage bridge only
// answers a parent page on the same origin. Hashed assets are immutable; index.html is not.
// the wasm/js are served gzipped (prepared next to them as .gz): VectorCraft's wasm is 70 MB raw, 25 MB gzipped
app.use('/craft', (req, res, next) => {
  if (!/\.(wasm|js)$/.test(req.path) || !/\bgzip\b/.test(req.headers['accept-encoding'] || '')) return next()
  const file = nodePath.join(config.craftWebRoot, nodePath.normalize(req.path)) + '.gz'
  if (!file.startsWith(config.craftWebRoot + nodePath.sep) || !nodeFs.existsSync(file)) return next()
  res.setHeader('Content-Encoding', 'gzip')
  res.setHeader('Vary', 'Accept-Encoding')
  res.setHeader('Cache-Control', /-[0-9a-f]{16}(_bg)?\.(wasm|js)$/.test(req.path) ? 'public, max-age=31536000, immutable' : 'no-cache')
  res.type(req.path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
  res.sendFile(file)
})
app.use('/craft', express.static(config.craftWebRoot, {
  setHeaders(res, file) {
    // only content-hashed names are immutable (FilmCraft's are plain filmcraft_web.js …)
    if (/-[0-9a-f]{16}(_bg)?\.(wasm|js)$/.test(file)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    else if (/\.(wasm|js)$/.test(file)) res.setHeader('Cache-Control', 'no-cache')
    else if (file.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
  },
}))
app.use(express.json({ limit: '2mb' }))

// ---------- auth ----------
const demoLogin = process.env.PRO_DEMO_LOGIN !== '0'
const oauthStates = new Map()

async function auth(req, res, next) {
  const jwt = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token
  const u = jwt && await userFromJwt(jwt)
  if (!u) return res.status(401).json({ error: 'unauthorized' })
  const [p] = await q('select name from pro_profile where user_id=$1', [u.id])
  req.user = { id: u.id, email: u.email, name: p?.name || u.user_metadata?.name || u.email.split('@')[0] }
  req.session = { access_token: jwt }
  next()
}

async function finishLogin(email, name) {
  const { user, session } = await sessionFor(email, name)
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [user.id, name, email])
  return { user, session: { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at } }
}

app.get('/api/config', (req, res) => res.json({ google: mail.googleEnabled(), demoLogin, vault: vault.vaultInfo() }))

app.get('/api/auth/google/start', (req, res) => {
  if (!mail.googleEnabled()) return res.status(400).send('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).')
  for (const [key, value] of oauthStates) {
    if (Date.now() - value.at > 10 * 60 * 1000) oauthStates.delete(key)
  }
  const state = crypto.randomBytes(32).toString('hex')
  const verifier = crypto.randomBytes(32).toString('base64url')
  const connectMail = req.query.mail === '1'
  oauthStates.set(state, { at: Date.now(), verifier, connectMail })
  res.cookie('pgpt-oauth-state', state, { httpOnly: true, sameSite: 'lax', secure: config.publicUrl.startsWith('https:'), maxAge: 10 * 60 * 1000, path: '/api/auth/google' })
  res.redirect(mail.googleAuthUrl(state, { connectMail, verifier }))
})

app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const st = oauthStates.get(req.query.state)
    const cookieState = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith('pgpt-oauth-state='))?.slice('pgpt-oauth-state='.length)
    if (!st || cookieState !== req.query.state || Date.now() - st.at > 10 * 60 * 1000) throw new Error('로그인 요청이 만료됐어요. 다시 시도해 주세요.')
    oauthStates.delete(req.query.state)
    res.clearCookie('pgpt-oauth-state', { path: '/api/auth/google' })
    if (req.query.error) throw new Error(req.query.error === 'access_denied' ? 'Google 로그인이 취소됐어요.' : 'Google 로그인에 실패했어요.')
    if (typeof req.query.code !== 'string') throw new Error('Google 인증 코드가 없어요.')
    const { tok, me } = await mail.googleExchange(req.query.code, st.verifier)
    const login = await finishLogin(me.email, me.name)
    if (st.connectMail) {
      const granted = new Set((tok.scope || '').split(' '))
      if (!granted.has('https://www.googleapis.com/auth/gmail.readonly')) throw new Error('메일 연결에 Gmail 읽기 권한이 필요해요. 다시 연결해 주세요.')
      const previous = await vault.getSecret(login.user.id, 'oauth', 'google')
      await vault.putItem(login.user.id, 'oauth', 'google', {
        username: me.email, access_token: tok.access_token, refresh_token: tok.refresh_token || previous?.refresh_token,
        expires_at: Date.now() + tok.expires_in * 1000, scope: tok.scope,
      })
      ensureHubBinding(login.user.id, config.tenantId).catch(() => {})
      await q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,'gmail',$2)
               on conflict (user_id) do update set provider='gmail', address=$2`, [login.user.id, me.email])
      onboardConnected(login.user.id, 'Google에 로그인됨').catch(() => {})
      setTimeout(() => mail.pollUser(login.user.id, { announce: true }).catch((e) => console.warn('[mail]', e.message)), 6000)
    }
    res.set('Cache-Control', 'no-store')
    res.set('Referrer-Policy', 'no-referrer')
    const frag = encodeURIComponent(JSON.stringify(login))
    res.redirect(`${config.publicUrl}/auth/done#${frag}`)
  } catch (e) {
    res.redirect(`${config.publicUrl}/login?error=${encodeURIComponent(e.message)}`)
  }
})

// Email OTP through Supabase GoTrue (needs SMTP on the auth service).
app.post('/api/auth/email/start', async (req, res) => {
  const r = await fetch(`${config.supabaseUrl}/auth/v1/otp`, {
    method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: req.body.email, create_user: true }),
  })
  res.status(r.ok ? 200 : 400).json(r.ok ? { sent: true, demo: demoLogin } : { error: (await r.text()).slice(0, 200), demo: demoLogin })
})
app.post('/api/auth/email/verify', async (req, res) => {
  const { email, code } = req.body
  if (demoLogin && code === '000000') return res.json(await finishLogin(email, email.split('@')[0]))
  const r = await fetch(`${config.supabaseUrl}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email, token: code }),
  })
  if (!r.ok) return res.status(400).json({ error: '코드가 맞지 않아요' })
  res.json(await finishLogin(email, email.split('@')[0]))
})
app.post('/api/auth/refresh', async (req, res) => res.json(await refresh(req.body.refresh_token)))

// ---------- profile / onboarding ----------
app.get('/api/me', auth, async (req, res) => {
  const [p] = await q('select * from pro_profile where user_id=$1', [req.user.id])
  const [m] = await q('select provider, address, last_poll from pro_mail_accounts where user_id=$1', [req.user.id])
  res.json({ user: req.user, profile: p, mail: m || null })
})
app.post('/api/profile', auth, async (req, res) => {
  const { name, birth, lat, lon, place, onboarded } = req.body
  await q(`insert into pro_profile(user_id,email) values ($1,$2) on conflict (user_id) do nothing`, [req.user.id, req.user.email])
  await q(`update pro_profile set name=coalesce($2,name), birth=coalesce($3,birth), lat=coalesce($4,lat), lon=coalesce($5,lon),
           place=coalesce($6,place), onboarded_at=case when $7 then coalesce(onboarded_at, now()) else onboarded_at end where user_id=$1`,
  [req.user.id, name, birth, lat, lon, place, !!onboarded])
  // the name teammates (and process-gpt's own screens) see
  if (name) await q('update users set username=$1 where id=$2 and tenant_id=$3', [name, req.user.id, config.tenantId])
  res.json({ ok: true })
})

// Onboarding conversation, staged so the client can pace the reveal.
app.post('/api/onboard/intro', auth, async (req, res) => {
  const t = await mainThread(req.user.id)
  const [{ n }] = await q('select count(*)::int n from pro_messages where thread_id=$1', [t.id])
  if (n > 0) return res.json({ skipped: true })
  const lines = [
    `안녕하세요 ${req.user.name}님, 저는 process gpt예요.`,
    '메일과 일정, 결재와 거래처 업무까지 챙기고, 필요한 사이트에는 보관함에 저장한 정보로 안전하게 대신 로그인해서 처리할게요.',
    '허락해 주시면 이메일과 캘린더를 연결해 최근 상황을 파악하고, 제가 어떻게 도울 수 있을지 알아볼게요.',
  ]
  for (const text of lines) {
    await addMessage(req.user.id, t.id, 'agent', 'text', { text })
    await new Promise((r) => setTimeout(r, 900))
  }
  await addMessage(req.user.id, t.id, 'agent', 'connect', { text: mail.googleEnabled() ? 'Google에 로그인' : '메일 연결하기', state: 'pending' })
  res.json({ ok: true })
})

async function onboardConnected(userId, label) {
  const [p] = await q('select onboarded_at from pro_profile where user_id=$1', [userId])
  if (p?.onboarded_at) return
  const t = await mainThread(userId)
  const [chip] = await q(`select id from pro_messages where thread_id=$1 and kind='connect' order by created_at desc limit 1`, [t.id])
  if (chip) {
    const [m] = await q(`update pro_messages set content=content || $2::jsonb where id=$1 returning *`, [chip.id, JSON.stringify({ state: 'done', doneText: label })])
    emit(userId, 'message', m)
  }
  await addMessage(userId, t.id, 'agent', 'text', { text: '감사합니다. 자세히 살펴볼게요. 몇 분 뒤에 아이디어를 가지고 돌아올게요.' })
  await new Promise((r) => setTimeout(r, 1200))
  await addMessage(userId, t.id, 'agent', 'text', { text: '그동안 오늘 하루는 어떠세요?' })
  await q('update pro_profile set onboarded_at=coalesce(onboarded_at, now()) where user_id=$1', [userId])
}

app.post('/api/mail/connect', auth, async (req, res) => {
  const { provider, host, username, password } = req.body
  if (provider === 'imap') await vault.putItem(req.user.id, 'login', 'imap', { host, username, password })
  await q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,$2,$3)
           on conflict (user_id) do update set provider=$2, address=$3`, [req.user.id, provider, username || req.user.email])
  await q('delete from pro_mail_seen where user_id=$1', [req.user.id])
  res.json({ ok: true })
  await onboardConnected(req.user.id, provider === 'demo' ? '데모 메일함 연결됨' : `${username} 연결됨`)
  setTimeout(() => mail.pollUser(req.user.id, { announce: true }).catch((e) => console.warn('[mail]', e.message)), 6000)
})
app.post('/api/mail/poll', auth, async (req, res) => res.json(await mail.pollUser(req.user.id, { announce: true })))

app.use('/api', processRoutes(auth))
app.use('/api', folderRoutes(auth))
app.use('/api', panelAppRoutes(auth))
mountCraft(app)
mountOffice(app)
app.use('/api', craftLiveRoutes(auth))
mountFolders(app)
mountPanelApps(app)
mountConnectors(app)
app.get('/api/connectors', auth, async (req, res) => {
  const list = await connectorStatus(req.user.id)
  const hub = list.some((c) => c.connected) ? await ensureHubBinding(req.user.id, config.tenantId) : { bound: false }
  res.json({ connectors: list, hub })
})
app.post('/api/connectors/:name/token', auth, async (req, res) => {
  const site = req.params.name
  if (!['slack', 'github', 'notion'].includes(site)) return res.status(400).end()
  await vault.putItem(req.user.id, 'apikey', site, { key: String(req.body.token || '').trim() })
  res.json({ ok: true, hub: await ensureHubBinding(req.user.id, config.tenantId) })
})

// ---------- events ----------
app.get('/api/events', auth, (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.write(': ok\n\n')
  // the client falls back to long polling when this never arrives (a proxy holding streams back)
  res.write(`event: hello\ndata: ${JSON.stringify({ seq: lastSeq() })}\n\n`)
  const off = subscribe(req.user.id, res)
  const ping = setInterval(() => res.write(': ping\n\n'), 20000)
  req.on('close', () => { off(); clearInterval(ping) })
})

// The same events by long polling, for when a proxy in front does not pass SSE.
app.get('/api/events/poll', auth, async (req, res) => {
  const after = req.query.after != null && Number.isFinite(Number(req.query.after)) ? Number(req.query.after) : lastSeq()
  const events = await poll(req.user.id, after)
  res.json({ seq: events.length ? events[events.length - 1].seq : after, events })
})

// The conversations the context router told apart in this user's main chat (its context_threads).
app.get('/api/conversations', auth, async (req, res) => {
  res.json(await q(`select conversation_id as id, title, summary, gist, kind, turns, updated_at from context_threads
                    where tenant_id=$1 and user_id=$2 order by updated_at desc limit 200`, [config.tenantId, req.user.id]).catch(() => []))
})

// ---------- threads ----------
app.get('/api/threads', auth, async (req, res) => {
  if (req.query.kind !== 'project') return res.json([await mainThread(req.user.id)])
  res.json(await q(`select * from pro_threads where user_id=$1 and kind='project' order by updated_at desc`, [req.user.id]))
})
app.post('/api/threads', auth, async (req, res) => {
  const t = await chat({ messages: [{ role: 'system', content: '요청을 5~12자 한국어 프로젝트 제목으로. 제목만.' }, { role: 'user', content: req.body.text }], temperature: 0.2 })
  const [row] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning *`, [req.user.id, t.content.replace(/["'.]/g, '').trim()])
  emit(req.user.id, 'thread', row)
  res.json(row)
})
app.get('/api/threads/:id/messages', auth, async (req, res) => {
  const t = await getThread(req.user.id, req.params.id)
  if (!t) return res.status(404).end()
  res.json(await q('select * from pro_messages where thread_id=$1 order by created_at', [t.id]))
})
// A file attached in chat (raw body, name in X-File-Name): saved where the agent can read it and
// in storage for the card and the editor.
app.post('/api/attachments', express.raw({ type: () => true, limit: '50mb' }), auth, async (req, res) => {
  try {
    res.json(await saveAttachment(req.user, decodeURIComponent(req.headers['x-file-name'] || 'file'), req.headers['content-type'], req.body))
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

app.post('/api/threads/:id/messages', auth, async (req, res) => {
  const t = await getThread(req.user.id, req.params.id)
  if (!t) return res.status(404).end()
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
  try {
    const final = await runTurn({ user: req.user, session: req.session, threadId: t.id, text: req.body.text, context: req.body.context, files: req.body.files, conversation: req.body.conversation, onDelta: (d) => send('delta', { d }) })
    send('done', final)
  } catch (e) {
    console.error(e)
    send('error', { message: e.message })
  }
  res.end()
})

// ---------- actions ----------
app.get('/api/actions', auth, async (req, res) =>
  res.json(await q(`select * from pro_actions where user_id=$1 and status in ('open','running') order by created_at desc limit 12`, [req.user.id])))
app.post('/api/actions/:id/run', auth, async (req, res) => {
  const [a] = await q(`update pro_actions set status='running' where id=$1 and user_id=$2 returning *`, [req.params.id, req.user.id])
  if (!a) return res.status(404).end()
  emit(req.user.id, 'action', a)
  res.json(a)
  const t = await mainThread(req.user.id)
  runTurn({ user: req.user, session: req.session, threadId: t.id, text: `${a.verb}: ${a.text}\n\n${a.prompt || ''}` })
    .then(async () => {
      const [d] = await q(`update pro_actions set status='done' where id=$1 returning *`, [a.id])
      emit(req.user.id, 'action', d)
    })
    .catch((e) => console.warn('[action]', e.message))
})
app.post('/api/actions/:id/dismiss', auth, async (req, res) => {
  const [a] = await q(`update pro_actions set status='dismissed' where id=$1 and user_id=$2 returning *`, [req.params.id, req.user.id])
  emit(req.user.id, 'action', a)
  res.json(a)
})

// ---------- notifications (process-gpt `notifications`) · team · roles ----------
app.get('/api/notifications', auth, async (req, res) => res.json(await notify.listFor(req.user)))
app.post('/api/notifications/:id/act', auth, async (req, res) => {
  try {
    const r = await notify.act(req.user, req.params.id, { choice: req.body.choice })
    if (!r) return res.status(404).end()
    emit(req.user.id, 'notifications', {})
    res.json(r)
  } catch (e) { console.warn('[notify act]', e.message); res.status(500).json({ error: e.message }) }
})
app.post('/api/notifications/:id/dismiss', auth, async (req, res) => {
  const ok = await notify.dismiss(req.user, req.params.id)
  emit(req.user.id, 'notifications', {})
  res.status(ok ? 200 : 404).json({ ok })
})
app.get('/api/team', auth, async (req, res) => {
  await team.ensureMember(req.user)
  res.json(await team.listTeam())
})
app.post('/api/team', auth, async (req, res) => {
  if (!/^[^@\s]+@[^@\s]+$/.test(String(req.body.email || ''))) return res.status(400).json({ error: 'email' })
  res.json(await team.addMember(req.user, req.body.email, req.body.name))
})
app.delete('/api/team/:id', auth, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'self' })
  await team.removeMember(req.params.id)
  res.json({ ok: true })
})
app.get('/api/roles/catalog', auth, async (req, res) => res.json(await team.roleCatalog()))
app.get('/api/roles', auth, async (req, res) => res.json(await team.listAssignments(req.query.defId || null)))
app.put('/api/roles', auth, async (req, res) => {
  const { defId, role, userId } = req.body
  if (!role) return res.status(400).json({ error: 'role' })
  res.json(await team.assign(req.user, { defId, role, userId }))
})

// The editor saved an edited copy next to the original: the card now opens that copy.
app.post('/api/messages/:id/file', auth, async (req, res) => {
  const url = String(req.body.url || '')
  if (!/^https?:\/\//.test(url)) return res.status(400).end()
  // an editor may save in another format of its own (photo.png → photo.pcraft): the card takes that name
  const name = req.body.name ? String(req.body.name).slice(0, 200) : null
  const [m] = await q(`update pro_messages m set content = content || jsonb_build_object('url', $3::text, 'edited', true,
                         'versions', coalesce(content->'versions','[]'::jsonb) || jsonb_build_array(content->>'url'),
                         'name', coalesce($4::text, content->>'name'))
                       from pro_threads t where m.id=$1 and t.id=m.thread_id and t.user_id=$2 and m.kind='file' returning m.*`,
  [req.params.id, req.user.id, url, name])
  if (!m) return res.status(404).end()
  emit(req.user.id, 'message', m)
  res.json(m)
})

// ---------- agent workroom (files · terminal · steering) ----------
async function room(req, res) {
  const r = await workroom.resolveRoom(req.params.kind, req.params.id).catch(() => null)
  if (!r) { res.status(404).json({ error: 'no workroom' }); return null }
  if (!(await workroom.canAccess(req.user, r).catch(() => false))) { res.status(403).json({ error: '이 작업실을 볼 권한이 없어요' }); return null }
  return r
}
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, mtime: e.mtime })
app.get('/api/workroom/:kind/:id', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  const { root, ...info } = r
  res.json({ ...info, folder: path.basename(root), terminal: true, files: await workroom.tree(r) })
})
app.get('/api/workroom/:kind/:id/file', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  try { res.json(await workroom.readFile(r, req.query.path)) } catch (e) { fail(res, e) }
})
// images, video, pdf: the browser loads these directly, so the token may come in the query
app.get('/api/workroom/:kind/:id/raw', async (req, res, next) => {
  if (!req.headers.authorization && req.query.token) req.headers.authorization = `Bearer ${req.query.token}`
  next()
}, auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  try {
    // an agent-written page or SVG must not run script on this origin
    const active = /\.(html?|svg|xml)$/i.test(String(req.query.path))
    res.sendFile(workroom.rawPath(r, req.query.path), { headers: { 'X-Content-Type-Options': 'nosniff', ...(active ? { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'" } : {}) } })
  } catch (e) { fail(res, e) }
})
app.put('/api/workroom/:kind/:id/file', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  try { res.json(await workroom.writeFile(r, req.body.path, String(req.body.content ?? ''), req.body.mtime)) } catch (e) { fail(res, e) }
})
app.post('/api/workroom/:kind/:id/publish', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  try { res.json(await workroom.publishFile(r, req.body.path, req.user)) } catch (e) { fail(res, e) }
})
app.post('/api/workroom/:kind/:id/ticket', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  res.json({ ticket: workroom.issueTicket(req.user, r, req.body.mode) })
})
app.post('/api/workroom/:kind/:id/steer', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  res.json(await workroom.steer(r, req.user, String(req.body.text || '').slice(0, 4000)))
})

// ---------- panels ----------
app.get('/api/panels', auth, async (req, res) => res.json(await q('select * from pro_panels where user_id=$1 order by sort, updated_at', [req.user.id])))
app.post('/api/panels', auth, async (req, res) => {
  try { res.json(await generatePanel({ userId: req.user.id, description: req.body.description })) } catch (e) { res.status(500).json({ error: e.message }) }
})
app.post('/api/panels/:id/revise', auth, async (req, res) =>
  res.json(await revisePanel({ userId: req.user.id, id: req.params.id, instruction: req.body.instruction })))
app.put('/api/panels/:id/data', auth, async (req, res) => res.json(await savePanelData(req.user.id, req.params.id, req.body)))
app.delete('/api/panels/:id', auth, async (req, res) => {
  await q('delete from pro_panels where id=$1 and user_id=$2', [req.params.id, req.user.id])
  emit(req.user.id, 'panel.deleted', { id: req.params.id })
  res.json({ ok: true })
})
app.get('/api/panel-proxy', auth, async (req, res) => {
  try { res.json(await proxyFetch(req.query.url)) } catch (e) { res.status(400).json({ error: e.message }) }
})
app.post('/api/panel-ask', auth, async (req, res) => {
  const m = await chat({ model: config.llm.fastModel, messages: [{ role: 'system', content: '짧게 한국어로 답해.' }, { role: 'user', content: req.body.prompt }] })
  res.json({ text: m.content })
})

// ---------- schedules ----------
app.get('/api/schedules', auth, async (req, res) => res.json(await listSchedules(req.user.id)))
app.delete('/api/schedules/:id', auth, async (req, res) => { await deleteSchedule(req.user.id, req.params.id); res.json({ ok: true }) })
// A short interval (every minute) can fire again while the last run is still working; that tick
// is skipped rather than stacking runs of the same task.
const firing = new Set()
app.post('/api/cron/fire', async (req, res) => {
  if (req.body.secret !== config.cronSecret) return res.status(403).end()
  res.json({ ok: true })
  const id = req.body.id
  if (firing.has(id)) return console.log(`[cron] ${id.slice(0, 8)} still running, tick skipped`)
  const [m] = await q('select skill, process_id, paused from pro_schedules where id=$1', [id])
  if (m?.paused) return
  firing.add(id)
  const release = () => firing.delete(id)
  if (m?.skill || m?.process_id) return runMission(id, 'cron').catch((e) => console.warn('[mission]', e.message)).finally(release)
  try {
    const [s] = await q('update pro_schedules set last_run=now() where id=$1 returning *', [id])
    if (!s) return release()
    const [p] = await q('select email, name from pro_profile where user_id=$1', [s.user_id])
    const { user, session } = await sessionFor(p.email, p.name)
    const threadId = s.thread_id || (await mainThread(s.user_id)).id
    // Same rule as missions: a run that found nothing new posts nothing (no divider either).
    const text = `${s.prompt}\n\n(예약 실행입니다. 직전 실행에서 공유한 것과 달라진 게 없으면 다른 말 없이 정확히 "변동 없음"만 답하세요. 공유할 때는 과정 설명 없이 결과만 쓰세요.)`
    delegate({ user, session, threadId, text, divider: { text: s.name, scheduleId: s.id }, quietIfUnchanged: true }).catch((e) => console.warn('[cron]', e.message)).finally(release)
  } catch (e) { release(); console.warn('[cron]', e.message) }
})

// ---------- missions (scheduled skills) ----------
const ownSchedule = async (req) => (await q('select * from pro_schedules where id=$1 and user_id=$2', [req.params.id, req.user.id]))[0]
app.post('/api/skill-drafts/:msgId/save', auth, async (req, res) => {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='skill_draft'`, [req.params.msgId, req.user.id])
  if (!m) return res.status(404).end()
  try {
    // a new skill starts private (내 스킬): kept as a skill folder, not installed for the tenant —
    // the card then asks whether to share it (lib/folders/skills.js)
    const folder = await skills.saveDraftPrivate(req.user, await workspaceHostPath(m.content.dir), m.content.name)
    const saved = { skill_name: m.content.name, folder: folder.slug }
    let mission = null
    if (req.body.cron) {
      mission = await createMission({ userId: req.user.id, name: req.body.missionName || m.content.name, cron: req.body.cron, skill: saved.skill_name, params: req.body.params || {} })
    }
    const [u] = await q(`update pro_messages set content = content || $2::jsonb where id=$1 returning *`, [m.id, JSON.stringify({ state: 'saved', skill: saved.skill_name, visibility: 'private', folder: saved.folder, missionId: mission?.id || null, cron: mission?.cron || null })])
    emit(req.user.id, 'message', u)
    res.json({ skill: saved.skill_name, mission })
  } catch (e) {
    res.status(e.message.includes('already exists') ? 409 : 500).json({ error: e.message })
  }
})
app.post('/api/systems/sync', auth, async (req, res) => res.json(await syncSystemRegistry()))
app.get('/api/skills', auth, async (req, res) => {
  const [skills, schedules] = await Promise.all([listSkills(req.session.access_token), q('select id, name, cron, skill, paused from pro_schedules where user_id=$1 and skill is not null', [req.user.id])])
  res.json(skills.map((s) => ({ ...s, missions: schedules.filter((m) => m.skill === s.name) })))
})
app.get('/api/skills/:name', auth, async (req, res) => {
  try {
    const skill = await getSkill(req.session.access_token, req.params.name)
    const missions = await q('select id, name, cron, paused from pro_schedules where user_id=$1 and skill=$2', [req.user.id, req.params.name])
    res.json({ ...skill, missions })
  } catch (e) { res.status(404).json({ error: e.message }) }
})
app.delete('/api/skills/:name', auth, async (req, res) => {
  try { await deleteSkill(req.session.access_token, req.params.name); res.json({ ok: true }) } catch (e) { res.status(500).json({ error: e.message }) }
})
app.post('/api/skills/:name/missions', auth, async (req, res) => {
  const { cron, params, name } = req.body
  if (!cron) return res.status(400).json({ error: 'cron required' })
  res.json(await createMission({ userId: req.user.id, name: name || req.params.name, cron, skill: req.params.name, params: params || {} }))
})
app.post('/api/missions', auth, async (req, res) => {
  const { name, cron, skill, params, notify } = req.body
  res.json(await createMission({ userId: req.user.id, name, cron, skill, params, notify }))
})
app.get('/api/missions/:id/runs', auth, async (req, res) => res.json(await listMissionRuns(req.user.id, req.params.id)))
app.post('/api/missions/:id/run', auth, async (req, res) => {
  if (!(await ownSchedule(req))) return res.status(404).end()
  res.json({ started: true })
  runMission(req.params.id, 'manual').catch((e) => console.warn('[mission]', e.message))
})
const MISSION_AGENTS = { deepagents: null, 'claude-code': 'cliagents', codex: 'cliagents' }
app.post('/api/missions/:id/agent', auth, async (req, res) => {
  if (!(await ownSchedule(req))) return res.status(404).end()
  const id = req.body.agent
  if (!(id in MISSION_AGENTS)) return res.status(400).json({ error: 'agent must be deepagents, claude-code or codex' })
  const agent = MISSION_AGENTS[id] ? { orch: 'cliagents', cli: id, model: req.body.model || '', permission: 'command_exec' } : { orch: 'deepagents' }
  const [s] = await q('update pro_schedules set agent=$2 where id=$1 returning agent', [req.params.id, agent])
  res.json(s)
})
app.post('/api/missions/:id/pause', auth, async (req, res) => {
  if (!(await ownSchedule(req))) return res.status(404).end()
  const [s] = await q('update pro_schedules set paused=$2 where id=$1 returning paused', [req.params.id, !!req.body.paused])
  res.json(s)
})

// Files a CLI agent produced in its run workspace (e.g. a demo video), streamed from cli-agent.
// A <video> element cannot send a bearer header, so the token may come as a query parameter.
app.get('/api/agent-files/:runId', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || String(req.query.token || '')
  const user = await userFromJwt(token).catch(() => null)
  if (!user) return res.status(401).end()
  const url = `${config.cliAgentUrl}/runs/${encodeURIComponent(req.params.runId)}/download?tenant_id=${encodeURIComponent(config.tenantId)}&path=${encodeURIComponent(String(req.query.path || ''))}`
  const up = await fetch(url, { headers: req.headers.range ? { Range: req.headers.range } : {} })
  res.status(up.status)
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (up.headers.get(h)) res.setHeader(h, up.headers.get(h))
  if (!up.body) return res.end()
  const { Readable } = await import('node:stream')
  Readable.fromWeb(up.body).pipe(res)
})

// ---------- vault ----------
// Responses never carry a secret: items come back as {id, kind, site, label, status, meta, ...}.
const vaultRoute = (fn) => async (req, res) => {
  try { await fn(req, res) } catch (e) {
    if (e instanceof vault.VaultError) return res.status(e.status).json({ error: e.message })
    console.warn('[vault]', e.message)
    res.status(500).json({ error: '보관함 처리 중 오류가 났어요.' })
  }
}
// a vault card in chat (request / update / capture) owned by this user
async function vaultCard(userId, id) {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id
                       where m.id=$1 and t.user_id=$2 and m.kind in ('vault','choice')`, [id, userId])
  return m
}
async function settleCard(userId, id, patch) {
  const [m] = await q(`update pro_messages set content=content || $2::jsonb where id=$1 returning *`, [id, JSON.stringify(patch)])
  if (m) emit(userId, 'message', m)
}

app.get('/api/vault', auth, vaultRoute(async (req, res) => res.json(await vault.listItems(req.user.id))))
app.post('/api/vault', auth, vaultRoute(async (req, res) => {
  const { kind, site, data, messageId } = req.body
  const card = messageId && await vaultCard(req.user.id, messageId)
  if (card && card.content.state !== 'pending') return res.status(409).json({ error: '이 요청은 만료됐어요.' })
  const item = await vault.putItem(req.user.id, kind, site, data, { taskId: card?.content?.taskId })
  if (card) {
    await settleCard(req.user.id, card.id, { state: 'saved', label: item.label })
    browser.resume(req.user.id, `the user saved a ${kind} for ${item.site} in the vault; use fill_secret`)
  }
  res.json(item)
}))
// change fields of a saved item (e.g. the password a site rejected)
app.patch('/api/vault/:id', auth, vaultRoute(async (req, res) => {
  const card = req.body.messageId && await vaultCard(req.user.id, req.body.messageId)
  if (card && card.content.state !== 'pending') return res.status(409).json({ error: '이 요청은 만료됐어요.' })
  const item = await vault.updateItem(req.user.id, req.params.id, req.body.data, { taskId: card?.content?.taskId })
  if (card) {
    await settleCard(req.user.id, card.id, { state: 'saved', label: item.label })
    browser.resume(req.user.id, `the user updated the saved login for ${item.site}; use fill_secret again`)
  }
  res.json(item)
}))
// keep / drop a login or card captured from a form the user typed into
app.post('/api/vault/:id/confirm', auth, vaultRoute(async (req, res) => {
  await vault.confirmItem(req.user.id, req.params.id)
  if (req.body.messageId && await vaultCard(req.user.id, req.body.messageId)) await settleCard(req.user.id, req.body.messageId, { state: 'saved' })
  res.json({ ok: true })
}))
app.post('/api/vault/:id/discard', auth, vaultRoute(async (req, res) => {
  await vault.deleteItem(req.user.id, req.params.id)
  if (req.body.messageId && await vaultCard(req.user.id, req.body.messageId)) await settleCard(req.user.id, req.body.messageId, { state: 'discarded' })
  res.json({ ok: true })
}))
app.delete('/api/vault/:id', auth, vaultRoute(async (req, res) => { await vault.deleteItem(req.user.id, req.params.id); res.json({ ok: true }) }))
// the user closed a request card instead of answering it
app.post('/api/vault/requests/:msgId/dismiss', auth, vaultRoute(async (req, res) => {
  const card = await vaultCard(req.user.id, req.params.msgId)
  if (!card) return res.status(404).end()
  await settleCard(req.user.id, card.id, { state: 'dismissed' })
  browser.resume(req.user.id, 'The user closed the request without providing it. Do not ask again; continue without it or finish and say what is missing.')
  res.json({ ok: true })
}))
// a one-time code typed into a secret card: filled into the waiting page field, never stored
app.post('/api/vault/requests/:msgId/secret', auth, vaultRoute(async (req, res) => {
  const card = await vaultCard(req.user.id, req.params.msgId)
  if (!card || card.content.kind !== 'secret' || card.content.state !== 'pending') return res.status(404).end()
  if (!String(req.body.value || '')) return res.status(400).json({ error: '값을 입력해 주세요.' })
  if (!await browser.provideSecret(req.user.id, String(req.body.value))) return res.status(409).json({ error: '이 요청은 더 이상 기다리고 있지 않아요.' })
  await settleCard(req.user.id, card.id, { state: 'used' })
  res.json({ ok: true })
}))
app.get('/api/vault/audit', auth, vaultRoute(async (req, res) => res.json(await vault.listAudit(req.user.id, req.query.limit))))
// what is stored for this user and that it behaves like envelope encryption — no plaintext
app.get('/api/vault/proof', auth, vaultRoute(async (req, res) => res.json(await vault.proof(req.user.id))))

// ---------- browser ----------
app.get('/api/browser/frame', auth, (req, res) => res.json(browser.lastFrame(req.user.id)))
app.post('/api/browser/input', auth, async (req, res) => { await browser.input(req.user.id, req.body); res.json({ ok: true }) })
// The user picked one of the options the browser agent offered; it continues with that choice.
app.post('/api/choices/:msgId', auth, async (req, res) => {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='choice'`, [req.params.msgId, req.user.id])
  if (!m) return res.status(404).end()
  const value = String(req.body.value || '')
  const [u] = await q(`update pro_messages set content = content || $2::jsonb where id=$1 returning *`, [m.id, JSON.stringify({ state: 'answered', value })])
  emit(req.user.id, 'message', u)
  browser.resume(req.user.id, `The user chose: ${value}. Continue with that choice.`)
  res.json({ ok: true })
})
app.post('/api/browser/resume', auth, (req, res) => { browser.resume(req.user.id, req.body.text); res.json({ ok: true }) })
app.post('/api/browser/cancel', auth, (req, res) => { browser.cancel(req.user.id); res.json({ ok: true }) })

// ---------- search ----------
app.get('/api/search', auth, async (req, res) => {
  const like = `%${req.query.q || ''}%`
  res.json(await q(`select m.id, m.thread_id, t.kind, t.title, m.content->>'text' as text, m.created_at
    from pro_messages m join pro_threads t on t.id=m.thread_id
    where t.user_id=$1 and m.content->>'text' ilike $2 order by m.created_at desc limit 30`, [req.user.id, like]))
})

const server = app.listen(config.port, async () => {
  console.log(`pgpt-pro server on :${config.port}`)
  // browser sessions live in memory; tasks that were mid-flight when the server stopped cannot resume
  await q(`update pro_messages set content = content || '{"state":"failed","summary":"서버가 다시 시작되어 작업이 중단됐어요."}'::jsonb
           where kind='task' and content->>'state' in ('running','needs_input')`)
  await q(`update pro_messages set content = content || '{"state":"expired"}'::jsonb where kind='vault' and content->>'state'='pending'`)
  await q(`update pro_threads set status=null where status is not null`)
  mail.startPoller()
  startBrowserWorker()
  startSystemRegistry()
  notify.startNotificationFeed()
startFolderSteps()
})

// terminals in the agent workroom (websocket upgrade on /api/workroom/term)
workroom.attachTerminal(server)
// an ArtCraft app open in the page, driven live by the agent (websocket upgrade on /api/craft/live)
attachCraftLive(server)
