import express from 'express'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'
import { q, sessionFor, refresh, userFromJwt, isMember, isMemberEmail } from './lib/supa.js'
import { subscribe, emit, poll, lastSeq } from './lib/bus.js'
import { mainThread, getThread, addMessage, setThreadStatus } from './lib/store.js'
import { runTurn, delegate, stopTurns } from './lib/agent.js'
import * as vault from './lib/vault.js'
import * as browser from './lib/browser.js'
import { listSchedules, deleteSchedule } from './lib/scheduler.js'
import { generatePanel, revisePanel, savePanelData, proxyFetch } from './lib/panels.js'
import { chat } from './lib/llm.js'
import * as mail from './lib/mail.js'
import { reviewFor, recordReview } from './lib/review.js'
import { processRoutes } from './routes/process.js'
import { startBrowserWorker } from './lib/browserWorker.js'
import { mountConnectors, connectorStatus, ensureHubBinding } from './mcp/connectors.js'
import { mountCraft, craftStatus } from './mcp/craft.js'
import { mountOffice } from './mcp/office.js'
import { craftLiveRoutes, attachCraftLive } from './lib/craftLive.js'
import { mountFolders } from './mcp/folders.js'
import { folderRoutes } from './routes/folders.js'
import { panelAppRoutes } from './routes/panelApps.js'
import { teamRoutes } from './routes/team.js'
import { meetingRoutes } from './routes/meetings.js'
import { attachVoice } from './lib/meetings/voice.js'
import { resolveMain, saveMainLang, forgetMain, uiLangFor } from './lib/mainLang.js'
import { miningRoutes, startMiningScan } from './routes/mining.js'
import { improveRoutes } from './routes/improve.js'
import { mountImprove } from './mcp/improve.js'
import { startConstraintSweep } from './lib/improve/service.js'
import { startStepRetry } from './lib/stepRetry.js'
import { openFileCard } from './lib/fileCards.js'
import { startSkillWorker } from './lib/mining/worker.js'
import { mountPanelApps } from './mcp/panelapps.js'
import { startFolderSteps } from './lib/folders/work.js'
import * as skills from './lib/folders/skills.js'
import { ensureResultLine, fireSchedule, runMission, listMissionRuns, createMission, listSkills, saveSkillDraft, workspaceHostPath } from './lib/missions.js'
import { getSkill, deleteSkill } from './lib/skills.js'
import { startSystemRegistry, syncSystemRegistry } from './lib/systems.js'
import * as notify from './lib/notify.js'
import * as team from './lib/team.js'
import * as workroom from './lib/workroom.js'
import { saveAttachment } from './lib/attachments.js'
import { resolveLang, withLang, rememberLang, saveLang, L } from './lib/lang.js'
import { tenantMiddleware, withTenant, multiTenant, tenantOfAuthUser } from './lib/tenant.js'

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
// English mode (lib/lang.js): a request is in the language its X-PGL-Lang header names (the page sends
// it on every /api call); auth() below adds the signed-in person's saved language when it is absent.
// (EventSource cannot send headers: /api/events?lang=en carries it as a query parameter)
const langAsked = (req) => req.headers['x-pgl-lang'] || (typeof req.query?.lang === 'string' ? req.query.lang : undefined)
app.use((req, res, next) => withLang(resolveLang({ header: langAsked(req) }), next))
// whose request this is (lib/tenant.js): behind the ProcessGPT gateway the X-Tenant-Id it sets from the
// address (MCP calls: the tenant in the caller's JWT); with tenants by host name (PRO_TENANT_HOSTS:
// http://en.localhost:5180 is the English demo tenant) the token's person, or before sign-in the host's;
// otherwise the one tenant of this install
app.use(tenantMiddleware())

// ---------- auth ----------
// A stray rejected promise (a background job or feed reconnecting while the database restarts or
// is in recovery mode) is logged, not fatal: the server keeps answering and the job retries later.
process.on('unhandledRejection', (e) => console.warn('[unhandled]', e?.message || e))
const demoLogin = process.env.PRO_DEMO_LOGIN !== '0'
const oauthStates = new Map()

async function auth(req, res, next) {
  const jwt = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token
  const u = jwt && await userFromJwt(jwt)
  if (!u) return res.status(401).json({ error: 'unauthorized' })
  // behind the ProcessGPT gateway a ProcessGPT account works only at its own tenant's address; with
  // tenants by host name the person's own tenant is the request's (lib/tenant.js)
  if (config.tenantFromHeader && !(await isMember(u.id, config.tenantId))) return res.status(403).json({ error: 'not a member of this tenant' })
  if (multiTenant()) req.tenantId = tenantOfAuthUser(u)
  // to_jsonb(p)->>'lang': still answers on a database the lang migration (sql/019) has not reached
  const [p] = await q(`select name, to_jsonb(p)->>'lang' as lang from pro_profile p where user_id=$1`, [u.id])
  req.user = { id: u.id, email: u.email, name: p?.name || u.user_metadata?.name || u.email.split('@')[0] }
  req.session = { access_token: jwt }
  if (p) rememberLang(u.id, p.lang)
  // header > saved > ko; everything this request starts (agent turns, drafts, timers) keeps it
  req.lang = resolveLang({ header: langAsked(req), saved: p?.lang })
  // entered again: a body parser in the route's own chain runs outside the request's async context
  withLang(req.lang, () => (req.tenantId ? withTenant(req.tenantId, next) : next()))
}

async function finishLogin(email, name) {
  const { user, session } = await sessionFor(email, name)
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [user.id, name, email])
  // no administrator yet (an install without install.sh's ADMIN_EMAIL): the first one in becomes it
  await team.claimFirstAdmin(user.id).catch((e) => console.warn('[team] first admin', e.message))
  return { user, session: { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at } }
}

// craft: which ArtCraft apps this install has ({web, cli} flags only); contextRouter: whether messages are routed
// to conversations (services/context-router) — flags only
app.get('/api/config', (req, res) => res.json({ google: mail.googleEnabled(), demoLogin, vault: vault.vaultInfo(), craft: craftStatus(), contextRouter: !!config.contextRouterUrl }))

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
    if (!st || cookieState !== req.query.state || Date.now() - st.at > 10 * 60 * 1000) throw new Error(L('로그인 요청이 만료됐어요. 다시 시도해 주세요.', 'The sign-in request expired. Please try again.'))
    oauthStates.delete(req.query.state)
    res.clearCookie('pgpt-oauth-state', { path: '/api/auth/google' })
    if (req.query.error) throw new Error(req.query.error === 'access_denied' ? L('Google 로그인이 취소됐어요.', 'Google sign-in was canceled.') : L('Google 로그인에 실패했어요.', 'Google sign-in failed.'))
    if (typeof req.query.code !== 'string') throw new Error(L('Google 인증 코드가 없어요.', 'There is no Google authorization code.'))
    const { tok, me } = await mail.googleExchange(req.query.code, st.verifier)
    const login = await finishLogin(me.email, me.name)
    if (st.connectMail) {
      const granted = new Set((tok.scope || '').split(' '))
      if (!granted.has('https://www.googleapis.com/auth/gmail.readonly')) throw new Error(L('메일 연결에 Gmail 읽기 권한이 필요해요. 다시 연결해 주세요.', 'Connecting mail needs permission to read Gmail. Please connect again.'))
      const previous = await vault.getSecret(login.user.id, 'oauth', 'google')
      await vault.putItem(login.user.id, 'oauth', 'google', {
        username: me.email, access_token: tok.access_token, refresh_token: tok.refresh_token || previous?.refresh_token,
        expires_at: Date.now() + tok.expires_in * 1000, scope: tok.scope,
      })
      ensureHubBinding(login.user.id, config.tenantId).catch(() => {})
      await q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,'gmail',$2)
               on conflict (user_id) do update set provider='gmail', address=$2`, [login.user.id, me.email])
      onboardConnected(login.user.id, L('Google에 로그인됨', 'Signed in with Google')).catch(() => {})
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
// Behind the ProcessGPT gateway the accounts are ProcessGPT's: a code goes only to someone already in
// this address's tenant, and no account is made (the answer is the same either way)
const tenantEmail = async (email) => !config.tenantFromHeader || isMemberEmail(email, config.tenantId)
app.post('/api/auth/email/start', async (req, res) => {
  if (!(await tenantEmail(req.body.email))) return res.json({ sent: true, demo: demoLogin })
  const r = await fetch(`${config.supabaseUrl}/auth/v1/otp`, {
    method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: req.body.email, create_user: !config.tenantFromHeader }),
  })
  res.status(r.ok ? 200 : 400).json(r.ok ? { sent: true, demo: demoLogin } : { error: (await r.text()).slice(0, 200), demo: demoLogin })
})
app.post('/api/auth/email/verify', async (req, res) => {
  const { email, code } = req.body
  if (!(await tenantEmail(email))) return res.status(400).json({ error: '코드가 맞지 않아요' })
  // (an account of another tenant: 403 with where to sign in — lib/tenant.js)
  const done = (p) => p.then((login) => res.json(login), (e) => { if (!e.status) throw e; res.status(e.status).json({ error: e.message }) })
  if (demoLogin && code === '000000') return done(finishLogin(email, email.split('@')[0]))
  const r = await fetch(`${config.supabaseUrl}/auth/v1/verify`, {
    method: 'POST', headers: { apikey: config.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', email, token: code }),
  })
  if (!r.ok) return res.status(400).json({ error: L('코드가 맞지 않아요', "That code doesn't match") })
  await done(finishLogin(email, email.split('@')[0]))
})
app.post('/api/auth/refresh', async (req, res) => res.json(await refresh(req.body.refresh_token)))

// ---------- profile / onboarding ----------
app.get('/api/me', auth, async (req, res) => {
  const [p] = await q('select * from pro_profile where user_id=$1', [req.user.id])
  const [m] = await q('select provider, address, last_poll from pro_mail_accounts where user_id=$1', [req.user.id])
  // admin: the team and tenant-wide role controls are editable (TeamRoles); otherwise read-only
  // lang: the saved language (null = never chosen); reqLang: the one this request ran in
  // mainLang: the language I speak and read in (meetings, messages); mainLangSet: whether I chose it
  res.json({ user: req.user, profile: p, mail: m || null, admin: await team.isAdmin(req.user), lang: p?.lang || null, reqLang: req.lang,
    mainLang: resolveMain({ main: p?.main_lang, ui: p?.lang || req.lang }), mainLangSet: p?.main_lang || null })
})
// my main language (Settings › Accounts › Main language, the meeting lobby): what meetings transcribe me
// in and translate others into for me, and what messages read in; the screens follow it (ko → Korean,
// anything else → English) unless I set the screen language myself afterwards
app.put('/api/me/main-lang', auth, async (req, res) => {
  try {
    await q(`insert into pro_profile(user_id,email) values ($1,$2) on conflict (user_id) do nothing`, [req.user.id, req.user.email])
    const main = await saveMainLang(req.user.id, req.body?.lang)
    res.json({ mainLang: main, uiLang: uiLangFor(main) })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
// the person's language (Settings › Accounts › Language): background work for them uses it too
app.put('/api/me/lang', auth, async (req, res) => {
  try {
    await q(`insert into pro_profile(user_id,email) values ($1,$2) on conflict (user_id) do nothing`, [req.user.id, req.user.email])
    res.json({ lang: await saveLang(req.user.id, req.body?.lang) })
    forgetMain(req.user.id)
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
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
  const lines = L([
    `안녕하세요 ${req.user.name}님, 저는 process gpt예요.`,
    '메일과 일정, 결재와 거래처 업무까지 챙기고, 필요한 사이트에는 보관함에 저장한 정보로 안전하게 대신 로그인해서 처리할게요.',
    '허락해 주시면 이메일과 캘린더를 연결해 최근 상황을 파악하고, 제가 어떻게 도울 수 있을지 알아볼게요.',
  ], [
    `Hi ${req.user.name}, I'm Process GPT Lite.`,
    "I'll keep track of your mail and calendar, approvals and client work, and where a site needs it, I'll sign in for you safely with what you've saved in the Vault.",
    "If you let me, I'll connect your email and calendar to get a picture of what's going on lately and see how I can help.",
  ])
  for (const text of lines) {
    await addMessage(req.user.id, t.id, 'agent', 'text', { text })
    await new Promise((r) => setTimeout(r, 900))
  }
  await addMessage(req.user.id, t.id, 'agent', 'connect', { text: mail.googleEnabled() ? L('Google에 로그인', 'Sign in with Google') : L('메일 연결하기', 'Connect mail'), state: 'pending' })
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
  await addMessage(userId, t.id, 'agent', 'text', { text: L('감사합니다. 자세히 살펴볼게요. 몇 분 뒤에 아이디어를 가지고 돌아올게요.', "Thank you. I'll take a close look and come back with ideas in a few minutes.") })
  await new Promise((r) => setTimeout(r, 1200))
  await addMessage(userId, t.id, 'agent', 'text', { text: L('그동안 오늘 하루는 어떠세요?', "Meanwhile, how's your day going?") })
  await q('update pro_profile set onboarded_at=coalesce(onboarded_at, now()) where user_id=$1', [userId])
}

app.post('/api/mail/connect', auth, async (req, res) => {
  const { provider, host, username, password } = req.body
  if (provider === 'imap') await vault.putItem(req.user.id, 'login', 'imap', { host, username, password })
  await q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,$2,$3)
           on conflict (user_id) do update set provider=$2, address=$3`, [req.user.id, provider, username || req.user.email])
  await q('delete from pro_mail_seen where user_id=$1', [req.user.id])
  res.json({ ok: true })
  await onboardConnected(req.user.id, provider === 'demo' ? L('데모 메일함 연결됨', 'Demo mailbox connected') : L(`${username} 연결됨`, `${username} connected`))
  setTimeout(() => mail.pollUser(req.user.id, { announce: true }).catch((e) => console.warn('[mail]', e.message)), 6000)
})
app.post('/api/mail/poll', auth, async (req, res) => res.json(await mail.pollUser(req.user.id, { announce: true })))
// a demo mailbox only: a fictional message arrives (demos, tests) — never real mail
// PRO_BACKGROUND=0: a second server for development (another port) that must not run the pollers,
// workers and registries the main one already runs (mail, cron callbacks, agent workers, mcp-hub sync)
const background = process.env.PRO_BACKGROUND !== '0'
if (background) setTimeout(() => mail.resumeDrafts().catch((e) => console.warn('[mail] resume', e.message)), 5000)
// 연습 메일 받기 (Settings): the fictional mails a demo mailbox can be sent ({template: id} below)
app.get('/api/mail/demo-templates', auth, (req, res) => res.json(mail.demoTemplates().map(({ id, label, hint, from, subject }) => ({ id, label, hint, from, subject }))))
app.post('/api/mail/demo-arrive', auth, async (req, res) => {
  try { res.json(await mail.demoArrive(req.user.id, req.body || {})) } catch (e) { res.status(400).json({ error: e.message }) }
})

app.use('/api', processRoutes(auth))
app.use('/api', folderRoutes(auth))
app.use('/api', panelAppRoutes(auth))
// team sharing and messenger (routes/team.js)
app.use('/api', teamRoutes(auth))
// meetings in a team room: mesh WebRTC signalling, transcription, materials, minutes (routes/meetings.js)
app.use('/api', meetingRoutes(auth))
// process mining over ad-hoc work → recommended processes (routes/mining.js)
app.use('/api', miningRoutes(auth))
// 프로세스 개선: 병목·가치 흐름·제약·크리티컬 패스·what-if·개선 적용 (lib/improve)
app.use('/api', improveRoutes(auth))
mountCraft(app)
mountOffice(app)
app.use('/api', craftLiveRoutes(auth))
mountFolders(app)
mountImprove(app)
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
// (context-router writes the summary's labels in Korean: English mode reads them in English)
const enSummary = (t) => String(t || '').replace(/^최근 요청:/gm, 'Latest request:').replace(/^최근 답:/gm, 'Latest answer:').replace(/진행 중인 요청/g, 'Request in progress')
app.get('/api/conversations', auth, async (req, res) => {
  const rows = await q(`select conversation_id as id, title, summary, gist, kind, turns, updated_at from context_threads
                    where tenant_id=$1 and user_id=$2 order by updated_at desc limit 200`, [config.tenantId, req.user.id]).catch(() => [])
  res.json(req.lang === 'en' ? rows.map((r) => ({ ...r, summary: enSummary(r.summary), title: r.title === '진행 중인 요청' ? 'Request in progress' : r.title })) : rows)
})

// ---------- threads ----------
app.get('/api/threads', auth, async (req, res) => {
  if (req.query.kind !== 'project') return res.json([await mainThread(req.user.id)])
  res.json(await q(`select * from pro_threads where user_id=$1 and kind='project' order by updated_at desc`, [req.user.id]))
})
app.post('/api/threads', auth, async (req, res) => {
  const t = await chat({ messages: [{ role: 'system', content: L('요청을 5~12자 한국어 프로젝트 제목으로. 제목만.', 'Turn the request into a 2-5 word English project title. Only the title.') }, { role: 'user', content: req.body.text }], temperature: 0.2 })
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

// the page's own 검수 of a step it did (OfficeSheet: a picture put back into the 한글 document)
app.post('/api/reviews', auth, async (req, res) => {
  const file = String(req.body?.file || '').slice(0, 200), summary = String(req.body?.summary || '').slice(0, 400)
  if (!file || !summary) return res.status(400).end()
  recordReview(req.user.id, file, { ok: req.body.ok !== false, summary })
  res.json({ ok: true })
})
// a short note from the page into the person's own thread (e.g. "the recolour lost strokes, redone")
// a file card whose file sits in the workspace outside any conversation folder: publish and open it
app.post('/api/messages/:id/open-file', auth, async (req, res) => {
  try { res.json(await openFileCard(req.user, req.params.id)) } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
app.post('/api/threads/:id/note', auth, async (req, res) => {
  const t = await getThread(req.user.id, req.params.id)
  if (!t) return res.status(404).end()
  const text = String(req.body?.text || '').trim().slice(0, 600)
  if (!text) return res.status(400).end()
  res.json(await addMessage(req.user.id, t.id, 'agent', 'text', { text, note: true }))
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
    // a message never goes unanswered: the failure is said in the chat, not only in this stream
    await setThreadStatus(req.user.id, t.id, null).catch(() => {})
    await addMessage(req.user.id, t.id, 'agent', 'text', { text: L('이 요청을 처리하지 못했어요. 잠시 후 다시 보내 주세요.', "I couldn't handle this request. Please send it again in a moment."), failed: true }).catch(() => {})
    send('error', { message: e.message })
  }
  res.end()
})
// 멈추기: the answer being written in this thread (deepagents /chat/stop), or its browser task.
// Messages waiting their turn (대기) then go ahead.
app.post('/api/threads/:id/stop', auth, async (req, res) => {
  const t = await getThread(req.user.id, req.params.id)
  if (!t) return res.status(404).end()
  const r = await stopTurns({ user: req.user, session: req.session, threadId: t.id, conversation: req.body?.conversation ? String(req.body.conversation) : null })
  if (!r.stopped && browser.runningIn(req.user.id, t.id)) { browser.cancel(req.user.id); r.stopped = 1; r.browser = true }
  res.json(r)
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
      if (a.verb === 'Review') import('./lib/mining/recorder.js').then((m) => m.recordReply(req.user, a)).catch((e) => console.warn('[mining] reply', e.message))
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
// Listing the team also admits the signed-in person (lib/team.js ensureMember: in Lite the team is
// the tenant's people, and teammate features only work between members). Changing who is on it,
// and who holds a role for every process, is for administrators (users.is_admin / tenants.owner).
const ADMIN_ONLY = () => L('관리자만 바꿀 수 있어요.', 'Only administrators can change this.')
app.get('/api/team', auth, async (req, res) => {
  await team.ensureMember(req.user)
  res.json(await team.listTeam())
})
app.post('/api/team', auth, async (req, res) => {
  if (!(await team.isAdmin(req.user))) return res.status(403).json({ error: ADMIN_ONLY() })
  if (!/^[^@\s]+@[^@\s]+$/.test(String(req.body.email || ''))) return res.status(400).json({ error: 'email' })
  // (someone of another tenant's workspace: 403 — lib/tenant.js)
  try { res.json(await team.addMember(req.user, req.body.email, req.body.name)) } catch (e) { if (!e.status) throw e; res.status(e.status).json({ error: e.message }) }
})
app.delete('/api/team/:id', auth, async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'self' })
  if (!(await team.isAdmin(req.user))) return res.status(403).json({ error: ADMIN_ONLY() })
  await team.removeMember(req.params.id, req.user.id)
  res.json({ ok: true })
})
app.get('/api/roles/catalog', auth, async (req, res) => res.json(await team.roleCatalog()))
app.get('/api/roles', auth, async (req, res) => res.json(await team.listAssignments(req.query.defId || null)))
app.put('/api/roles', auth, async (req, res) => {
  const { defId, role, userId } = req.body
  if (!role) return res.status(400).json({ error: 'role' })
  if (!(await team.canAssign(req.user, defId))) return res.status(403).json({ error: defId ? L('이 프로세스의 담당자나 관리자만 역할을 정할 수 있어요.', "Only this process's owner or an administrator can assign its roles.") : L('모든 프로세스에 걸리는 역할 담당은 관리자만 정할 수 있어요.', 'Only administrators can assign roles that apply to every process.') })
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
  // the last 검수 of this document travels with its edited copy (lib/review.js)
  const rv = reviewFor(req.user.id, m.content.name) || reviewFor(req.user.id, name)
  if (rv && Date.now() - rv.at < 2 * 3600_000) {
    const [m2] = await q(`update pro_messages set content = content || jsonb_build_object('review', $2::jsonb) where id=$1 returning *`, [m.id, { ok: rv.ok, summary: rv.summary }])
    emit(req.user.id, 'message', m2)
    return res.json(m2)
  }
  emit(req.user.id, 'message', m)
  res.json(m)
})

// ---------- agent workroom (files · terminal · steering) ----------
async function room(req, res) {
  const r = await workroom.resolveRoom(req.params.kind, req.params.id).catch(() => null)
  if (!r) { res.status(404).json({ error: 'no workroom' }); return null }
  if (!(await workroom.canAccess(req.user, r).catch(() => false))) { res.status(403).json({ error: L('이 작업실을 볼 권한이 없어요', "You don't have access to this workroom") }); return null }
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
  const m = await chat({ model: config.llm.fastModel, messages: [{ role: 'system', content: L('짧게 한국어로 답해.', 'Answer briefly in English.') }, { role: 'user', content: req.body.prompt }] })
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
  firing.add(id)
  // skills, processes and plain prompts alike (lib/missions.js): every run is in the task's run history,
  // a failure is announced in chat and on Home, a run that found nothing new posts nothing, and a tick
  // the database could not even record is tried again a little later
  fireSchedule(id).catch((e) => console.warn('[cron]', e.message)).finally(() => firing.delete(id))
})

// ---------- missions (scheduled skills) ----------
const ownSchedule = async (req) => (await q('select * from pro_schedules where id=$1 and user_id=$2', [req.params.id, req.user.id]))[0]
app.post('/api/skill-drafts/:msgId/save', auth, async (req, res) => {
  const [m] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='skill_draft'`, [req.params.msgId, req.user.id])
  if (!m) return res.status(404).end()
  try {
    // a new skill starts private (내 스킬): kept as a skill folder, not installed for the tenant —
    // the card then asks whether to share it (lib/folders/skills.js)
    const host = await workspaceHostPath(m.content.dir)
    // saved to run on a schedule: the skill reports its outcome the way missions read it
    if (req.body.cron) await ensureResultLine(host).catch((e) => console.warn('[mission] result line', e.message))
    const folder = await skills.saveDraftPrivate(req.user, host, m.content.name)
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
    res.status(500).json({ error: L('보관함 처리 중 오류가 났어요.', 'Something went wrong in the Vault.') })
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
  if (card && card.content.state !== 'pending') return res.status(409).json({ error: L('이 요청은 만료됐어요.', 'This request has expired.') })
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
  if (card && card.content.state !== 'pending') return res.status(409).json({ error: L('이 요청은 만료됐어요.', 'This request has expired.') })
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
  if (!String(req.body.value || '')) return res.status(400).json({ error: L('값을 입력해 주세요.', 'Please enter a value.') })
  if (!await browser.provideSecret(req.user.id, String(req.body.value))) return res.status(409).json({ error: L('이 요청은 더 이상 기다리고 있지 않아요.', 'This request is no longer waiting.') })
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
// the task holding the browser, or (taskId = its card) one waiting in line behind it
app.post('/api/browser/cancel', auth, (req, res) => { res.json({ ok: browser.cancel(req.user.id, req.body?.taskId ? String(req.body.taskId) : undefined) }) })

// ---------- search ----------
app.get('/api/search', auth, async (req, res) => {
  const like = `%${req.query.q || ''}%`
  res.json(await q(`select m.id, m.thread_id, t.kind, t.title, m.content->>'text' as text, m.created_at
    from pro_messages m join pro_threads t on t.id=m.thread_id
    where t.user_id=$1 and m.content->>'text' ilike $2 order by m.created_at desc limit 30`, [req.user.id, like]))
})

const server = app.listen(config.port, async () => {
  console.log(`pgpt-pro server on :${config.port}`)
  // a second development server shares the database: it must not reset the main server's tasks either
  if (!background) return console.log('PRO_BACKGROUND=0: pollers, workers, registries and startup resets are off')
  // browser sessions live in memory; tasks that were mid-flight when the server stopped cannot resume
  await q(`update pro_messages set content = content || '{"state":"failed","summary":"서버가 다시 시작되어 작업이 중단됐어요."}'::jsonb
           where kind='task' and content->>'state' in ('running','needs_input','queued')
             and not exists (select 1 from pro_threads t join pro_profile p on p.user_id=t.user_id where t.id=pro_messages.thread_id and to_jsonb(p)->>'lang'='en')`)
  // (English-mode people read it in English)
  await q(`update pro_messages set content = content || '{"state":"failed","summary":"The server restarted, so the task was stopped."}'::jsonb
           where kind='task' and content->>'state' in ('running','needs_input','queued')`).catch(() => {})
  await q(`update pro_messages set content = content || '{"state":"expired"}'::jsonb where kind='vault' and content->>'state'='pending'`)
  await q(`update pro_threads set status=null where status is not null`)
  // turns wait their turn in memory (lib/turns.js): a message still marked 대기 will not be answered now
  await q(`update pro_messages set content = (content - 'queued') || '{"dropped":true}'::jsonb where role='user' and content ? 'queued'`)
  mail.startPoller()
  startBrowserWorker()
  startSkillWorker()
  startMiningScan()
  // registering Lite's connectors in the tenant's system list changes what ProcessGPT shows: not
  // behind the ProcessGPT gateway, where the tenants are ProcessGPT's own
  if (!config.tenantFromHeader) startSystemRegistry()
  notify.startNotificationFeed()
  startFolderSteps()
  startConstraintSweep()
  // agent steps stopped by a passing error are queued again (lib/stepRetry.js)
  startStepRetry()
})

// terminals in the agent workroom (websocket upgrade on /api/workroom/term)
workroom.attachTerminal(server)
// an ArtCraft app open in the page, driven live by the agent (websocket upgrade on /api/craft/live)
attachCraftLive(server)
// the interpreter's voice in a meeting (websocket upgrade on /api/meetings/voice)
attachVoice(server)
