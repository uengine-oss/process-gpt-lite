import * as SO from './lib/sendOnce.js'
import express from 'express'
import { apiHeaders } from './lib/apiHeaders.js'
import nodeFs from 'node:fs'
import nodePath from 'node:path'
import path from 'node:path'
import crypto from 'node:crypto'
import { config } from './config.js'
import { q, sessionFor, refresh, userFromJwt, isMember, isMemberEmail, normEmail } from './lib/supa.js'
import { subscribe, emit, poll, lastSeq } from './lib/bus.js'
import { mainThread, getThread, addMessage, setThreadStatus } from './lib/store.js'
import { runTurn, delegate, stopTurns, onceTurn } from './lib/agent.js'
import { turnRoutes } from './lib/turnPlan.js'
import { projectNoteRoutes } from './routes/projectNote.js'
import { ruleOf, removeRule, settleRuleConfirm } from './lib/roomRules.js'
import * as vault from './lib/vault.js'
import * as browser from './lib/browser.js'
import * as browserRemote from './lib/browserRemote.js'
import { listSchedules, deleteSchedule, ontoTimer, startScheduleTicker } from './lib/scheduler.js'
import { generatePanel, revisePanel, savePanelData, proxyFetch } from './lib/panels.js'
import { chat } from './lib/llm.js'
import * as mail from './lib/mail.js'
import { reviewFor, recordReview } from './lib/review.js'
import { processRoutes } from './routes/process.js'
import { startBrowserWorker } from './lib/browserWorker.js'
import { mountConnectors, connectorStatus, ensureHubBinding, CONNECTORS } from './mcp/connectors.js'
import { mountCraft, craftStatus } from './mcp/craft.js'
import { mountOffice } from './mcp/office.js'
import { agentTools, shape, none } from './lib/agentTools.js'
import { commitEdit } from './lib/team/worktree.js'
import { craftLiveRoutes, attachCraftLive } from './lib/craftLive.js'
import { mountFolders } from './mcp/folders.js'
import { folderRoutes } from './routes/folders.js'
import { filingRoutes } from './routes/filing.js'
import { localAgentRoutes } from './routes/localAgents.js'
import { startLocalAgents, steerFromThread } from './lib/localAgents/steps.js'
import { send as chatToLocal } from './lib/localAgents/chat.js'
import { gitAccess } from './lib/localAgents/devices.js'
import { threadFolderRoutes } from './routes/threadFolders.js'
import { ssoInfo, refreshSso } from './lib/sso.js'
import * as webpush from './lib/webpush.js'
import * as TF from './lib/folders/threadFolders.js'
import * as PT from './lib/projectTopics.js'
import { panelAppRoutes } from './routes/panelApps.js'
import { teamRoutes } from './routes/team.js'
import { contextRoutes } from './routes/context.js'
import { teamActivityRoutes } from './routes/teamActivity.js'
import { contextGradeRoutes } from './routes/contextGrade.js'
import { meetingRoutes } from './routes/meetings.js'
import { dictationRoutes } from './routes/dictation.js'
import { transcribeHealth, startSelfTest } from './lib/meetings/transcribe.js'
import { attachVoice } from './lib/meetings/voice.js'
import { resolveMain, saveMainLang, forgetMain, uiLangFor } from './lib/mainLang.js'
import { miningRoutes, startMiningScan } from './routes/mining.js'
import { improveRoutes } from './routes/improve.js'
import { billingRoutes } from './routes/billing.js'
import { backofficeRoutes } from './routes/backoffice.js'
import { agenticRoutes } from './routes/agentic.js'
import { followupRoutes } from './routes/followups.js'
import { ontologyRoutes } from './routes/ontology.js'
import { scenarioMailRoutes } from './routes/scenario-mail.js'
import { scenarioPurchaseRoutes } from './routes/scenario-purchase.js'
import { scenarioReleaseRoutes } from './routes/scenario-release.js'
import { startPlanSync } from './lib/plans/apply.js'
import { startMeter } from './lib/plans/meter.js'
import { telegramRoutes } from './routes/telegram.js'
import { mailReplyRoutes } from './routes/mailReply.js'
import { mailAttachmentRoutes } from './routes/mailAttachments.js'
import { savePrivateCard, saveKindOf } from './lib/mailAttachments.js'
import { linkPreviewRoutes } from './routes/linkPreview.js'
import { enabledFor as linkPreviewOn } from './lib/linkPreview.js'
import { backgroundRoutes } from './routes/background.js'
import { profilePictureRoutes, myPicture, rememberGooglePicture } from './routes/profilePicture.js'
import { signedIn, forget as forgetPerson } from './lib/people.js'
import { enabledFor as backgroundOn } from './lib/background/service.js'
import { isReplyCard } from './lib/mailReply.js'
import { mountImprove } from './mcp/improve.js'
import { startConstraintSweep } from './lib/improve/service.js'
import { startStepRetry } from './lib/stepRetry.js'
import { openFileCard } from './lib/fileCards.js'
import { startSkillWorker } from './lib/mining/worker.js'
import { mountPanelApps } from './mcp/panelapps.js'
import { startFolderSteps } from './lib/folders/work.js'
import { gitRoutes } from './lib/folders/gitHttp.js'
import { afterPush as afterSyncPush } from './lib/folders/sources.js'
import { startFolderGc } from './lib/folders/gc.js'
import { retryUnreadCards, reindex as reindexFolder, cardsSoon } from './lib/folders/indexer.js'
import * as FS from './lib/folders/service.js'
import * as skills from './lib/folders/skills.js'
import { ensureResultLine, fireSchedule, runMission, listMissionRuns, createMission, listSkills, saveSkillDraft, workspaceHostPath } from './lib/missions.js'
import { getSkill, deleteSkill } from './lib/skills.js'
import { startSystemRegistry, syncSystemRegistry } from './lib/systems.js'
import * as notify from './lib/notify.js'
// the AI waiting on the person, as a notice and a push whose buttons answer it (lib/askPerson.js)
import * as ASK from './lib/askPerson.js'
import { running as turnsRunning } from './lib/turns.js'
import * as team from './lib/team.js'
import * as workroom from './lib/workroom.js'
import { roomSeat } from './lib/folders/rooms.js'
import { startSeatSweep } from './lib/folders/seats.js'
import { saveAttachment } from './lib/attachments.js'
import { openStream } from './lib/sse.js'
import { resolveLang, withLang, rememberLang, saveLang, L, isEn, asUser } from './lib/lang.js'
import * as gconnect from './lib/googleConnect.js'
import * as googleClient from './lib/googleClient.js'
import { tenantMiddleware, withTenant, multiTenant, tenantOfAuthUser, forEachTenant } from './lib/tenant.js'
import { withUsage, featureOf } from './lib/usage.js'
import * as llmKeys from './lib/llmKeys.js'
import * as llmUsage from './lib/llmUsage.js'

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
// shared folders over git smart HTTP for agents on another disk (lib/folders/gitHttp.js): ahead of the body
// parser, the session and the tenant middleware — the folder token is the whole of the auth and names the tenant
// every /api answer is data: never sniffed, never a page that runs here (lib/apiHeaders.js)
app.use('/api', apiHeaders)
app.use('/api/git', gitRoutes())
// the same for the desktop app's local agents, the one git path the public address serves: a token of one job on one linked desktop, or
// of one folder a linked desktop uploads (champion folders — after a sync push, what it brought in is checked at once: lib/folders/sources.js)
app.use('/api/local-git', gitRoutes({ device: true, check: (claims, o) => withTenant(claims.tenant, () => gitAccess(claims, o)),
  after: (claims, folder, commands) => withTenant(claims.tenant, () => afterSyncPush(claims, folder, commands)) }))
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

async function auth(req, res, next) {
  const jwt = (req.headers.authorization || '').replace(/^Bearer /, '') || req.query.token
  let u
  // the sign-in check could not be made (auth server slow or restarting): 503 + X-Auth-Retry, the client retries
  try { u = jwt && await userFromJwt(jwt, { unavailable: true }) } catch { return res.status(503).set('X-Auth-Retry', '1').json({ error: 'auth unavailable' }) }
  if (!u) return res.status(401).json({ error: 'unauthorized' })
  // behind the ProcessGPT gateway a ProcessGPT account works only at its own tenant's address; with
  // tenants by host name the person's own tenant is the request's (lib/tenant.js)
  if (config.tenantFromHeader && !(await isMember(u.id, config.tenantId))) return res.status(403).json({ error: 'not a member of this tenant' })
  if (multiTenant()) req.tenantId = tenantOfAuthUser(u)
  // the person's name by the one rule every screen uses (lib/people.js: Lite's profile → Process GPT's username → the sign-in's own
  // name → the address), with their saved language — one query
  const p = await signedIn(u, req.tenantId || config.tenantId)
  req.user = { id: u.id, email: u.email, name: p.name }
  // the auth server's own record of the person (identities, app_metadata): their Google picture (routes/profilePicture.js)
  req.authUser = u
  req.session = { access_token: jwt }
  if (p.hasProfile) rememberLang(u.id, p.lang)
  // header > saved > ko; everything this request starts (agent turns, drafts, timers) keeps it
  req.lang = resolveLang({ header: langAsked(req), saved: p?.lang })
  // entered again: a body parser in the route's own chain runs outside the request's async context
  // model calls it makes are the person's, under the feature of the path (lib/usage.js, lib/llmKeys.js)
  withLang(req.lang, () => withUsage({ userId: u.id, feature: featureOf(req.path) },
    () => (req.tenantId ? withTenant(req.tenantId, next) : next())))
}

// (the address as GoTrue keeps it: 「Kim@Corp.com」 signs in as kim@corp.com, and pro_profile says so)
async function finishLogin(email0, name) {
  const email = normEmail(email0)
  const { user, session } = await sessionFor(email, name)
  await q(`insert into pro_profile(user_id,name,email) values ($1,$2,$3) on conflict (user_id) do nothing`, [user.id, name, email])
  // no administrator yet (an install without install.sh's ADMIN_EMAIL): the first one in becomes it
  await team.claimFirstAdmin(user.id).catch((e) => console.warn('[team] first admin', e.message))
  return { user, session: { access_token: session.access_token, refresh_token: session.refresh_token, expires_at: session.expires_at } }
}

// craft: which ArtCraft apps this install has ({web, cli} flags only); contextRouter: whether messages are routed
// to conversations (services/context-router) — flags only
// google: whether this request's company can connect Google (its own OAuth client from the admin
// settings, else this install's — lib/googleClient.js); googleLogin: whether 「Google로 계속하기」 signs in
// with it — an installed Lite only. sso: behind the ProcessGPT gateway, Google sign-in through
// ProcessGPT's own Supabase project when its Google provider is on (lib/sso.js). agentTools: whether this request's company's
// agent gets each built-in tool server (lib/agentTools.js: booleans; agentToolsVia labels the sources — tenant · common — and
// what stops one: tenant-overrides-common-with-other-url (a tenant row of the built-in name points elsewhere), hub-filtered)
// transcribe: whether speech-to-text answers (lib/meetings/transcribe.js self-test: ok · model · ms · at · error code · fallback —
// no address, no key) for meetings and the composer's dictation
app.get('/api/config', async (req, res) => {
  // (the pod's probe too: a database that does not answer makes it "off" for this answer, not a failed probe)
  const late = (v, ms) => new Promise((r) => setTimeout(() => r(v), ms).unref?.())
  const [google, tools] = await Promise.all([
    Promise.race([mail.googleEnabled().catch(() => false), late(false, 1500)]),
    Promise.race([agentTools.forTenant(config.tenantId).catch(() => null), late(null, 2500)]),
  ])
  const at = tools || { tools: shape(none(), () => false), via: shape(none()) }
  res.json({ google, googleLogin: google && !config.tenantFromHeader, sso: ssoInfo(), demoLogin, vault: vault.vaultInfo(), craft: craftStatus(), contextRouter: !!config.contextRouterUrl,
    agentTools: at.tools, agentToolsVia: at.via, transcribe: transcribeHealth() })
})

// ---------- Google: the installed sign-in, and connecting a signed-in person's account (lib/googleConnect.js) ----------
const stateCookie = (res, base, state, mode) => {
  const c = gconnect.cookieFor(base, state, mode)
  res.cookie(c.name, c.value, { httpOnly: true, sameSite: 'lax', secure: c.secure, maxAge: c.maxAgeMs, path: c.path })
}
// (cleared with what it was set with — a clear without the domain is another, host-only cookie)
const clearStateCookie = (res, base) => {
  const c = base ? gconnect.cookieFor(base, '', 'phone') : null
  res.clearCookie(gconnect.STATE_COOKIE, { path: gconnect.cookiePath(), ...(c ? { httpOnly: true, sameSite: 'lax', secure: c.secure } : {}) })
}
// the app's address for the page that asked (gateway: its company address, by the Origin header the
// browser sets, else the one the page says — checked by the same rule)
const baseOf = (req) => [req.headers.origin, req.body?.origin, req.query?.origin].map((o) => o && gconnect.pageBase(o)).find(Boolean) || (config.tenantFromHeader ? null : gconnect.pageBase())
// a page of its own for where no app screen can take the person (the server browser, a request gone stale)
function googlePage(res, { ok, text, status = 200 }) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
  res.status(status).set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Content-Type': 'text/html; charset=utf-8' })
  res.send(`<!doctype html><html lang="${isEn() ? 'en' : 'ko'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(ok ? L('Google 연결됨', 'Google connected') : L('Google 연결', 'Connect Google'))}</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;background:#f5f5f7;color:#1d1d1f">
<main style="max-width:420px;padding:32px;text-align:center"><p style="font-size:44px;margin:0">${ok ? '✓' : '!'}</p><h1 style="font-size:22px;font-weight:600;margin:12px 0">${esc(ok ? L('Google 에 연결했어요', 'Google is connected') : L('Google 연결을 마치지 못했어요', "Google couldn't be connected"))}</h1>
<p style="font-size:16px;line-height:1.55;color:#515154">${esc(text)}</p></main></body></html>`)
}

// 「Google로 계속하기」 on an installed Lite (LoginView). Behind the gateway the sign-in is ProcessGPT's (sso).
app.get('/api/auth/google/start', async (req, res) => {
  // (behind the gateway: back on the same company address, by path)
  const here = config.tenantFromHeader ? gconnect.publicPath() : gconnect.pageBase()
  // a kept link from before connecting needed a signed-in start (POST /connect): the settings screen has the buttons
  if (req.query.mail === '1') return res.redirect(`${here}/settings/accounts`)
  const client = config.tenantFromHeader ? null : await googleClient.clientFor()
  if (!client) return res.redirect(`${here}/login`)
  const base = here
  const { state, verifier } = gconnect.newState({ mode: 'login', tenant: config.tenantId, base, lang: isEn() ? 'en' : 'ko' })
  stateCookie(res, base, state, 'login')
  res.redirect(mail.googleAuthUrl(state, { client, redirectUri: gconnect.redirectUriOf(base), verifier }))
})

// Connect Google for the signed-in person: mode 'browser' (default) in their server browser, 'phone' in this
// browser (→ {url} of the consent screen, the state cookie set on this response)
app.post('/api/auth/google/connect', auth, async (req, res) => {
  try {
    const mode = req.body?.mode === 'phone' ? 'phone' : 'browser'
    const base = baseOf(req)
    if (!base) return res.status(400).json({ error: L('이 주소에서는 Google 연결을 시작할 수 없어요.', "A Google connection can't be started from this address.") })
    const client = await googleClient.clientFor()
    if (!client) return res.status(409).json({ error: L('이 회사에는 아직 Google 연결이 설정되지 않았어요. 관리자가 설정 › 시스템 설정 › 회사 Google 연결에 OAuth 클라이언트를 넣어야 해요.', "Google connections aren't set up for this company yet. An administrator has to add the OAuth client in Settings › System › Company Google connection.") })
    if (mode === 'browser') {
      const busy = browser.browserBusy(req.user.id)
      if (busy) return res.status(409).json({ error: L(`서버 브라우저가 지금 다른 작업('${busy}')을 하고 있어요. 그 작업이 끝나거나 멈춘 뒤 다시 연결하거나, 「휴대폰에서 연결」로 연결해 주세요.`, `The server browser is busy with another task ('${busy}'). Connect again when it is done or stopped, or use "Connect on phone".`), busy: true })
    }
    const { state, verifier } = gconnect.newState({ mode, userId: req.user.id, tenant: config.tenantId, base, lang: req.lang })
    const url = mail.googleAuthUrl(state, { client, redirectUri: gconnect.redirectUriOf(base), connectMail: true, verifier, hint: req.user.email })
    if (mode === 'phone') {
      stateCookie(res, base, state, mode)
      return res.json({ url })
    }
    const t = await mainThread(req.user.id)
    const own = (u) => { try { return String(u).startsWith(`${base}/api/auth/google/`) } catch { return false } }
    try {
      const { taskId } = await browser.connectGoogle({ userId: req.user.id, threadId: t.id, url, cookie: gconnect.cookieFor(base, state, mode), ours: own })
      gconnect.setTask(state, taskId)
      res.json({ taskId, threadId: t.id })
    } catch (e) {
      gconnect.dropState(state)
      throw e
    }
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

// Where Google comes back: the installed sign-in (mode login), or a connection for the person who started it
app.get('/api/auth/google/callback', async (req, res) => {
  let st = null, refused = ''
  try {
    st = gconnect.takeState(req.query.state, req.headers.cookie, config.tenantId)
  } catch (e) {
    // (no state of ours, or not this browser's: there is nobody to tell but this page)
    if (!e.st) return googlePage(res, { ok: false, status: 400, text: e.message })
    st = e.st
    refused = e.message
  }
  clearStateCookie(res, st.base)
  res.set('Cache-Control', 'no-store')
  res.set('Referrer-Policy', 'no-referrer')
  await withLang(st.lang || 'ko', async () => {
    const fail = (message) => {
      if (st.mode === 'login') return res.redirect(`${st.base}/login?error=${encodeURIComponent(message)}`)
      // (a failed try on the phone leaves a server-browser connection that is still waiting alone)
      if (st.mode === 'browser') {
        browser.googleConnected(st.userId, { ok: false, error: message }, st.taskId)
        return res.redirect(gconnect.doneUrlOf(st.base, { error: message, lang: st.lang }))
      }
      return res.redirect(`${st.base}/settings/accounts?google_error=${encodeURIComponent(message)}`)
    }
    try {
      if (refused) throw new Error(refused)
      if (req.query.error) throw new Error(req.query.error === 'access_denied' ? L('Google에서 허용하지 않았어요.', 'Access was not allowed on Google.') : L('Google 로그인에 실패했어요.', 'Google sign-in failed.'))
      if (typeof req.query.code !== 'string') throw new Error(L('Google 인증 코드가 없어요.', 'There is no Google authorization code.'))
      const client = await googleClient.clientFor(st.tenant)
      if (!client) throw new Error(L('이 회사의 Google 연결 설정이 지워졌어요. 관리자에게 알려 주세요.', "This company's Google connection settings were removed. Please tell an administrator."))
      const { tok, me } = await mail.googleExchange(req.query.code, st.verifier, { client, redirectUri: st.redirectUri })
      if (st.mode === 'login') {
        const login = await finishLogin(me.email, me.name)
        // the Google account's picture: the default picture of who signs in with Google (routes/profilePicture.js)
        await rememberGooglePicture(login.user.id, me.picture).catch((e) => console.warn('[picture] google', e.message))
        return res.redirect(`${st.base}/auth/done#${encodeURIComponent(JSON.stringify(login))}`)
      }
      const granted = new Set((tok.scope || '').split(' '))
      if (!granted.has('https://www.googleapis.com/auth/gmail.readonly')) throw new Error(L('메일을 연결하려면 Gmail 읽기 권한이 필요해요. 다시 연결하면서 Gmail을 허용해 주세요.', 'Connecting mail needs permission to read Gmail. Connect again and allow Gmail.'))
      // the person who started it, in the tenant they started it in — whichever Google account they picked
      const userId = st.userId
      const previous = await vault.getSecret(userId, 'oauth', config.google.vaultSite)
      await vault.putItem(userId, 'oauth', config.google.vaultSite, {
        username: me.email, access_token: tok.access_token, refresh_token: tok.refresh_token || previous?.refresh_token,
        expires_at: Date.now() + tok.expires_in * 1000, scope: tok.scope, client_id: client.clientId, tenant: st.tenant,
      })
      ensureHubBinding(userId, st.tenant).catch(() => {})
      await q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,'gmail',$2)
               on conflict (user_id) do update set provider='gmail', address=$2`, [userId, me.email])
      onboardConnected(userId, L(`${me.email} 연결됨`, `${me.email} connected`)).catch(() => {})
      setTimeout(() => asUser(userId, () => mail.pollUser(userId, { announce: true })).catch((e) => console.warn('[mail]', e.message)), 6000)
      // done on the phone, too, ends a server-browser connection still waiting: the mail is connected
      browser.googleConnected(userId, { ok: true, email: me.email, via: st.mode }, st.mode === 'browser' ? st.taskId : null)
      if (st.mode === 'browser') return res.redirect(gconnect.doneUrlOf(st.base, { lang: st.lang }))
      res.redirect(`${st.base}/settings/accounts?google=connected`)
    } catch (e) {
      console.warn('[google connect]', st.mode, e.message)
      fail(e.message)
    }
  })
})

// The server browser's last page after the consent (the card says the rest)
app.get('/api/auth/google/done', (req, res) => withLang(resolveLang({ header: req.query.lang }), () => {
  // (fixed sentences only: the reason is on the card — a link must not put its own words on this app's page)
  googlePage(res, req.query.error ? { ok: false, text: L('Lite로 돌아가면 카드에 이유와 다른 방법이 보여요.', 'Back in Lite, the card shows why and what else you can do.') } : { ok: true, text: L('Lite로 돌아가면 카드에 결과가 보여요. 이 브라우저는 Google에 로그인돼 있어요.', 'Back in Lite, the card shows the result. This browser is signed in to Google.') })
}))

// The company's own Google OAuth client (decision ①, lib/googleClient.js): administrators only; the
// secret is write-only. redirectUri: what to register with that client, for the page's address.
const adminOnly = async (req, res, next) => (await team.isAdmin(req.user)) ? next() : res.status(403).json({ error: L('회사 관리자만 바꿀 수 있어요.', 'Only a company administrator can change this.') })
const googleSetup = async (req) => {
  const base = baseOf(req)
  return { ...await googleClient.clientInfo(), redirectUri: base ? gconnect.redirectUriOf(base) : null }
}
app.get('/api/admin/google-client', auth, adminOnly, async (req, res) => res.json(await googleSetup(req)))
app.put('/api/admin/google-client', auth, adminOnly, async (req, res) => {
  try {
    await googleClient.saveClient(config.tenantId, req.body || {}, req.user.id)
    res.json(await googleSetup(req))
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
app.delete('/api/admin/google-client', auth, adminOnly, async (req, res) => {
  await googleClient.removeClient(config.tenantId, req.user.id)
  res.json(await googleSetup(req))
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
  const { code } = req.body
  // (lower case from here on: the name made from it, the account and its rows — lib/supa.js normEmail)
  const email = normEmail(req.body.email)
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
app.post('/api/auth/refresh', async (req, res) => {
  const j = await refresh(req.body.refresh_token).catch(() => ({ unavailable: true }))
  res.status(j.unavailable ? 503 : 200).json(j)
})

// ---------- profile / onboarding ----------
app.get('/api/me', auth, async (req, res) => {
  // teammates find a new account from its first visit, not from when it opens the team settings
  await team.ensureMember(req.user).catch((e) => console.warn('[team] admit', e.message))
  // birth goes out as the calendar date: a pg date parses to local midnight, which JSON shifts to the day before in UTC
  const [p] = await q(`select *, to_char(birth, 'YYYY-MM-DD') as birth from pro_profile where user_id=$1`, [req.user.id])
  const [m] = await q('select provider, address, last_poll from pro_mail_accounts where user_id=$1', [req.user.id])
  // admin: the team and tenant-wide role controls are editable (TeamRoles); otherwise read-only
  // lang: the saved language (null = never chosen); reqLang: the one this request ran in
  // mainLang: the language I speak and read in (meetings, messages); mainLangSet: whether I chose it
  // ontology: the company's process map is there (Ontological DB connected) — the 루틴 tab opens it, otherwise the routine list
  const { ontologyEnabled } = await import('./lib/ontology/store.js')
  // features: what this server turns on that the screens follow — the demo scenarios' settings tabs (PRO_SCENARIOS) and
  // 사용량·요금제 (usage limits on — PRO_LLM_KEYS — or PRO_PLAN_SCREEN=1); linkPreview: the company shows link cards (sql/051)
  // background: the company offers the day's background photos on Home (sql/054); the person's choice is profile.background
  const { enabled: billingOn } = await import('./lib/llmKeys.js')
  // user.picture: the picture the screens show (users.profile, shared with Process GPT; else the Google picture — routes/profilePicture.js),
  // null = the initial; user.pictureDefault: what clearing a choice goes back to (the Google picture, or null)
  res.json({ user: { ...req.user, ...await myPicture(req.user.id, req.authUser) }, profile: p, mail: m || null, admin: await team.isAdmin(req.user), lang: p?.lang || null, reqLang: req.lang,
    mainLang: resolveMain({ main: p?.main_lang, ui: p?.lang || req.lang }), mainLangSet: p?.main_lang || null, ontology: ontologyEnabled(),
    features: { scenarios: config.scenarios, planScreen: billingOn() || config.planScreen, linkPreview: await linkPreviewOn().catch(() => true), background: await backgroundOn().catch(() => true) } })
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
  // every screen's next answer has the new name (lib/people.js keeps names for a while)
  forgetPerson(req.user.id)
  res.json({ ok: true })
})

// my picture (Settings › 프로필, the avatar in the settings header): users.profile, the field Process GPT's account settings write
app.use('/api', profilePictureRoutes(auth))

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
  await addMessage(req.user.id, t.id, 'agent', 'connect', { text: (await mail.googleEnabled().catch(() => false)) ? L('Google 연결하기', 'Connect Google') : L('메일 연결하기', 'Connect mail'), state: 'pending' })
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
  // (the tenant it is connected in: its background mail work runs there — lib/mail.js pollInTenant)
  if (provider === 'imap') await vault.putItem(req.user.id, 'login', 'imap', { host, username, password, tenant: config.tenantId })
  await q(`insert into pro_mail_accounts(user_id,provider,address) values ($1,$2,$3)
           on conflict (user_id) do update set provider=$2, address=$3`, [req.user.id, provider, username || req.user.email])
  await q('delete from pro_mail_seen where user_id=$1', [req.user.id])
  res.json({ ok: true })
  await onboardConnected(req.user.id, provider === 'demo' ? L('데모 메일함 연결됨', 'Demo mailbox connected') : L(`${username} 연결됨`, `${username} connected`))
  setTimeout(() => mail.pollUser(req.user.id, { announce: true }).catch((e) => console.warn('[mail]', e.message)), 6000)

  // 오토 AX 온보딩: the promised ideas — the past mail is read and the company's process map drawn (lib/ontology)
  import('./lib/ontology/store.js').then(async ({ ontologyEnabled }) => {
    if (!ontologyEnabled()) return
    const { readMailAndBuild } = await import('./lib/ontology/service.js')
    await readMailAndBuild({ id: req.user.id, email: req.user.email }, { days: 90 })
  }).catch((e) => console.warn('[ontology] onboarding', e.message))
})
// Web Push: the server's public key, and this browser's subscription (lib/webpush.js, public/sw.js)
// (the key alone — what push services answered stays in this server's log: review 11-26, PR #89)
app.get('/api/push/key', auth, (req, res) => res.json({ publicKey: webpush.vapidKeys().publicKey }))
app.post('/api/push/subscriptions', auth, async (req, res) => {
  try { res.json(await webpush.subscribe(req.user, req.body?.subscription, req.headers['user-agent'])) } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})
app.delete('/api/push/subscriptions', auth, async (req, res) => res.json(await webpush.unsubscribe(req.user, req.body?.endpoint)))
// 「시험 알림 보내기」 (Home · Settings): one push to each of my devices now — the person sees it working in seconds. devices: how many
// subscriptions it went to (0: this browser never subscribed — the page then shows one itself)
// (three a minute for one person)
app.post('/api/push/test', auth, async (req, res) => {
  if (!webpush.testSlot(req.user.id)) return res.status(429).json({ error: L('시험 알림은 1분에 세 번까지 보낼 수 있어요. 잠시 뒤에 다시 눌러 주세요.', 'Up to three test notifications a minute. Try again in a moment.') })
  const devices = await webpush.pushTo(req.user.id, { id: `test-${Date.now()}`, type: 'test', tag: 'pgl-test', renotify: true,
    title: L('시험 알림이에요', 'This is a test notification'), body: L('이 알림이 보이면 휴대폰 알림이 켜진 거예요', 'If you can see this, notifications are on.') })
  res.json({ devices })
})
// A button on a phone's notification of the AI waiting on the person (public/sw.js → lib/askPerson.js act). No sign-in: the push carried
// a token for this one notice, signed by this server, bound to the person, the card and the answers it may give, used once, 24 hours.
// The card must still wait (a browser task's pick-one card: lib/browser.js answerCard). A chat question is never answered here: its options
// are the model's own text (re-review 11-26 — lib/askPerson.js act refuses it; the answerer is wired for when its marks come on a channel
// the model cannot write: the option as the person's message, in their own session found by their account id — lib/supa.js sessionOfUser).
const answerChat = ASK.chatAnswerer({ runTurn, busy: turnsRunning })
app.post('/api/push/act', async (req, res) => {
  const r = await ASK.act({ token: req.body?.token, answer: req.body?.answer }, { answerTask: browser.answerCard, answerChat })
    .catch((e) => { console.warn('[push act]', e.message); return { status: 500, error: 'failed' } })
  res.status(r.status).json(r.status === 200 ? { ok: true, answered: r.answered, said: r.said, place: r.place } : { error: r.error })
})
app.post('/api/mail/poll', auth, async (req, res) => res.json(await mail.pollUser(req.user.id, { announce: true })))
// a demo mailbox only: a fictional message arrives (demos, tests) — never real mail
// PRO_BACKGROUND=0: a second server for development (another port) that must not run the pollers,
// workers and registries the main one already runs (mail, cron callbacks, agent workers, mcp-hub sync)
const background = process.env.PRO_BACKGROUND !== '0'
if (background) setTimeout(() => mail.resumeDrafts().catch((e) => console.warn('[mail] resume', e.message)), 5000)
// 연습 메일 받기 (Settings): the fictional mails a demo mailbox can be sent ({template: id} below)
app.get('/api/mail/demo-templates', auth, (req, res) => res.json(mail.demoTemplates().map(({ id, label, hint, from, subject }) => ({ id, label, hint, from, subject }))))
// 메일 보관함(lib/mailArchive.js): 읽은 메일 — 주인만 보고 지운다
app.get('/api/mail/archive', auth, async (req, res) => {
  const { listArchive } = await import('./lib/mailArchive.js')
  res.json(await listArchive(req.user.id, { search: req.query.q || '', limit: req.query.limit, before: req.query.before || null }))
})
app.get('/api/mail/archive/:id', auth, async (req, res) => {
  const m = await (await import('./lib/mailArchive.js')).readArchived(req.user.id, req.params.id)
  return m ? res.json(m) : res.status(404).json({ error: '보관함에 없는 메일이에요.' })
})
app.delete('/api/mail/archive', auth, async (req, res) => res.json(await (await import('./lib/mailArchive.js')).clearArchive(req.user.id)))
app.post('/api/mail/demo-arrive', auth, async (req, res) => {
  try { res.json(await mail.demoArrive(req.user.id, req.body || {})) } catch (e) { res.status(400).json({ error: e.message }) }
})
// a test site on this machine mails a demo mailbox (the test shop's e-mailed sign-in code): only while demo login is on
// (development and test servers) and only from this machine — never a way in for real mail
app.post('/api/mail/demo-inbound', async (req, res) => {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  if (!demoLogin || !local) return res.status(404).end()
  try { res.json(await mail.demoInbound(req.body || {})) } catch (e) { res.status(400).json({ error: e.message }) }
})
// 메일로 온 인증 코드 자동 입력 (Settings › 보안): on unless turned off (lib/mailCode.js)
app.put('/api/me/mail-codes', auth, async (req, res) => {
  await q(`insert into pro_profile(user_id,email) values ($1,$2) on conflict (user_id) do nothing`, [req.user.id, req.user.email])
  await q('update pro_profile set mail_codes=$2 where user_id=$1', [req.user.id, req.body?.on !== false])
  res.json({ on: req.body?.on !== false })
})

app.use('/api', processRoutes(auth))
app.use('/api', folderRoutes(auth))
// 폴더에 정리: a document that came in, suggested a folder by the judge and filed there (routes/filing.js)
app.use('/api', filingRoutes(auth))
app.use('/api', panelAppRoutes(auth))
// team sharing and messenger (routes/team.js)
app.use('/api', teamRoutes(auth))
app.use('/api', contextRoutes(auth))
app.use('/api', teamActivityRoutes(auth))
app.use('/api', contextGradeRoutes(auth))
// meetings in a team room: mesh WebRTC signalling, transcription, materials, minutes (routes/meetings.js)
app.use('/api', meetingRoutes(auth))
// the chat composer's dictation where the browser has no speech service (the desktop app, the Android app, Firefox): the same transcription
app.use('/api', dictationRoutes(auth))
// process mining over ad-hoc work → recommended processes (routes/mining.js)
app.use('/api', miningRoutes(auth))
// 프로세스 개선: 병목·가치 흐름·제약·크리티컬 패스·what-if·개선 적용 (lib/improve)
app.use('/api', improveRoutes(auth))
// usage windows, plans and seats (PRO_LLM_KEYS=litellm, lib/plans)
app.use('/api', billingRoutes(auth))
// the operators' billing back office: every company's plan, usage, invoices (PRO_BILLING_OPERATORS)
app.use('/api', backofficeRoutes(auth))
// Agentic BPM PoC (pgpt-pro/docs/agentic-bpm/plan.md): policies·decisions·approvals·strategy, then the three scenarios
app.use('/api', agenticRoutes(auth))
app.use('/api', followupRoutes(auth))
// 프로세스 온톨로지: 메일 이력 + 채팅 핸드오버 → Ontological 의 회사 프로세스 지도, 스냅샷 실행, 고정 · 노화 (lib/ontology)
app.use('/api', ontologyRoutes(auth))
// the ontology's agent steps (orchestration pgpt-pro-onto) and habit questions run here even with PRO_BACKGROUND=0:
// no other server polls that orchestration, so nothing races for them (PRO_ONTOLOGY_WORKER=0 turns it off)
import('./lib/ontology/run.js').then((m) => m.startOntologyWorker()).catch((e) => console.warn('[onto-worker]', e.message))
// the assignees' own CLI agents on their desktops (lib/localAgents, docs/local-agents/design.md): devices, a step's local runs, steering;
// the desktops' links (WebSocket /api/local-agents/link) and the step worker (orchestration pgpt-pro-local) start with the server below
app.use('/api', localAgentRoutes(auth))
// the demo scenarios (demo outbox mail, purchase with its sweep, release): PRO_SCENARIOS=off leaves them out (config.scenarios)
if (config.scenarios) {
  app.use('/api', scenarioMailRoutes(auth))
  app.use('/api', scenarioPurchaseRoutes(auth))
  app.use('/api', scenarioReleaseRoutes(auth))
} else console.log('PRO_SCENARIOS=off: the demo scenarios (mail outbox, purchase, release) are off')
app.use('/api', telegramRoutes(auth))
// a mail's Home card: the mail as it arrived, a reply draft, the send on 보내기 (routes/mailReply.js)
app.use('/api', mailReplyRoutes(auth))
// a mail's attachments: opened where they belong (IeumOffice · the viewer · a download) from a private copy, never a public address
// (routes/mailAttachments.js)
app.use('/api', mailAttachmentRoutes(auth))
// link preview cards under messages with links, and the company switch (lib/linkPreview.js)
app.use('/api', linkPreviewRoutes(auth))
// the day's background photos on Home: candidates, the person's choice, the company switch and photo-site keys (lib/background)
app.use('/api', backgroundRoutes(auth))
if (config.linkPreviewAllowHosts) console.warn(config.tenantFromHeader
  ? '[link-preview] PRO_LINK_PREVIEW_ALLOW_HOSTS is ignored behind the ProcessGPT gateway'
  : `[link-preview] TEST ONLY: local hosts may be read for link cards: ${config.linkPreviewAllowHosts}`)
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
  if (!['slack', 'github', 'notion', 'youtube'].includes(site)) return res.status(400).end()
  const key = String(req.body.token || '').trim()
  // a key the connector can try first (YouTube) is not saved when it does not work
  const bad = await CONNECTORS.find((c) => c.name === site)?.verify?.(key)
  if (bad) return res.status(400).json({ error: bad })
  await vault.putItem(req.user.id, 'apikey', site, { key })
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
// A project's sub-topics (lib/projectTopics.js): the conversations the context router told apart inside it, newest first — kept apart
// from the main chat's (above). routed: whether this server classifies a project's messages at all (no router: none ever appear).
app.get('/api/threads/:id/topics', auth, async (req, res) => {
  const t = await getThread(req.user.id, req.params.id)
  if (!t || t.kind !== 'project') return res.status(404).end()
  const rows = await PT.topicsOf(req.user.id, t.id).catch(() => [])
  res.json({ routed: PT.enabled(), topics: req.lang === 'en' ? rows.map((r) => ({ ...r, summary: enSummary(r.summary) })) : rows })
})

// ---------- threads ----------
app.get('/api/threads', auth, async (req, res) => {
  // (each with its folder: lib/folders/threadFolders.js)
  if (req.query.kind !== 'project') return res.json(await TF.withFolders([await mainThread(req.user.id)]).catch(async () => [await mainThread(req.user.id)]))
  const rows = await q(`select * from pro_threads where user_id=$1 and kind='project' order by updated_at desc`, [req.user.id])
  res.json(await TF.withFolders(rows).catch(() => rows))
})
app.post('/api/threads', auth, async (req, res) => {
  // the folder the project works in (an existing one, or a new one by name) — checked first, so a refusal makes no project
  let folder = null
  try { folder = await TF.projectFolder(req.user, { folder: req.body.folder, newFolder: req.body.newFolder }) } catch (e) { return res.status(e.status || 500).json({ error: e.message }) }
  // the room is made at once under the request's first words, and the model's title replaces them when it
  // comes: waiting for it first left a new project with nothing on screen for 20 s (recording 2026-11-21)
  const text = String(req.body.text || '')
  const draft = projectDraftTitle(text)
  const [row] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning *`, [req.user.id, draft])
  if (folder) row.folder = await TF.linkProject(req.user, row, folder).catch((e) => { console.warn('[folders] project link', e.message); return null })
  emit(req.user.id, 'thread', row)
  res.json(row)
  chat({ messages: [{ role: 'system', content: L('요청을 5~12자 한국어 프로젝트 제목으로. 제목만.', 'Turn the request into a 2-5 word English project title. Only the title.') }, { role: 'user', content: text }], temperature: 0.2 })
    .then(async (t) => {
      // (a model that answered the request instead — "링크된 영상은 … 로 판단했습니다" — leaves the first words)
      const title = String(t.content || '').split('\n').map((s) => s.replace(/["'.*#`“”‘’]/g, '').trim()).find(Boolean) || ''
      if (!title || title.length > L(30, 60) || title === draft) return
      // (unless it was renamed meanwhile)
      const [named] = await q(`update pro_threads set title=$2 where id=$1 and title=$3 returning *`, [row.id, title, draft])
      if (named) emit(req.user.id, 'thread', named)
      // (the project's variation was made under the first words — a template's workspace at once: it takes the name too)
      if (named) await TF.retitleProject(named, draft).catch((e) => console.warn('[folders] project title', e.message))
    })
    .catch((e) => console.warn('[threads] title', e.message))
})
// a new project's title until the model names it: the first line of the request, cut short
const DRAFT_TITLE_MAX = 24
function projectDraftTitle(text) {
  const line = String(text || '').trim().split('\n')[0].trim()
  if (!line) return L('새 프로젝트', 'New project')
  // (cut by characters, not UTF-16 units: an emoji is never split in two)
  const chars = [...line]
  return chars.length > DRAFT_TITLE_MAX ? `${chars.slice(0, DRAFT_TITLE_MAX).join('').trim()}…` : line
}
app.use('/api', threadFolderRoutes(auth))
// 방 규칙(lib/roomRules.js): 이 방에 걸린 약속을 보고 끈다
app.get('/api/threads/:id/rule', auth, async (req, res) => res.json({ rule: await ruleOf(req.user.id, req.params.id).catch(() => null) }))
// a turn in progress, as the plan card and the progress panel show it (lib/turnPlan.js): the page opened or reloaded mid-turn
app.use('/api', turnRoutes(auth))
// 프로젝트 계획(lib/projectNote.js): GET · PUT /threads/:id/note, POST /threads/:id/note/undo, PUT /threads/:id/rule {skill}
app.use('/api', projectNoteRoutes(auth))
app.delete('/api/threads/:id/rule', auth, async (req, res) => res.json(await removeRule(req.user.id, req.params.id)))
// 「규칙을 바꿀까요?」 card (a room that has a rule, words judged to set a new one): 「바꾸기」 (choice replace) makes that card hold the new
// rule; 「이번 작업에만 적용」 (once) keeps the rule and gives the words to the browser task here (lib/agent.js onceTurn)
app.post('/api/threads/:id/rule/confirm', auth, async (req, res) => {
  const choice = req.body?.choice === 'replace' ? 'replace' : req.body?.choice === 'once' ? 'once' : null
  if (!choice || !req.body?.messageId) return res.status(400).json({ error: 'messageId, choice: replace | once' })
  const r = await settleRuleConfirm(req.user.id, String(req.body.messageId), choice, { threadId: req.params.id }).catch(() => null)
  if (!r) return res.status(404).end()
  emit(req.user.id, 'message', r.message)
  if (r.already) return res.status(409).json({ error: L('이미 고른 카드예요.', 'This card was already answered.') })
  if (choice === 'once') onceTurn({ user: req.user, session: req.session, threadId: req.params.id, text: r.said }).catch((e) => console.warn('[room rule] once', e.message))
  // 「바꾸기」: the room's work changed — its plan is brought up to date (lib/projectNote.js, in the background; design turnplan §4.2)
  if (choice === 'replace') {
    import('./lib/projectNote.js').then((PN) => PN.update({ user: req.user, threadId: req.params.id, from: { messageId: r.message?.id, text: r.said }, reason: L(`사람이 이 방의 규칙(목적)을 바꿨다: 「${String(r.said).slice(0, 300)}」`, `The person changed this room's rule (its purpose): "${String(r.said).slice(0, 300)}"`) }))
      .catch((e) => console.warn('[project-plan] rule replaced', e.message))
  }
  res.json({ ok: true, choice })
})
app.get('/api/threads/:id/messages', auth, async (req, res) => {
  const t = await getThread(req.user.id, req.params.id)
  if (!t) return res.status(404).end()
  // (a project's plan is a row of its room but not a chat message: GET /api/threads/:id/note — lib/projectNote.js)
  res.json(await q(`select * from pro_messages where thread_id=$1 and kind <> 'note' order by created_at`, [t.id]))
})
// A file attached in chat (raw body, name in X-File-Name): saved where the agent can read it and
// in storage for the card and the editor.
app.post('/api/attachments', auth, express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
  try {
    res.json(await saveAttachment(req.user, decodeURIComponent(req.headers['x-file-name'] || 'file'), req.headers['content-type'], req.body, { pages: true }))
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
  // nothing to send: no words, no file, no dragged file (a composer that once cleared a chip still being checked sent this — PR #45 review)
  const has = (x) => Array.isArray(x) && x.length > 0
  if (!String(req.body?.text ?? '').trim() && !has(req.body?.files) && !has(req.body?.refs)) return res.status(400).json({ error: L('보낼 말이나 파일이 없어요.', 'There is nothing to send.') })
  // the page's own id for this message (lib/sendOnce.js): a message sent again after a lost answer is taken once
  const clientId = SO.validId(req.body?.clientId)
  if (clientId && !(await SO.claim(t.id, clientId))) { const { send, end } = openStream(res); send('done', { duplicate: true }); return end() }
  try { return await postMessage(req, res, t, clientId) } finally { if (clientId) SO.release(t.id, clientId) }
})
async function postMessage(req, res, t, clientId) {
  // the composer's picker named a CLI on the sender's own PC (lib/localAgents/chat.js): the message goes to their desktop — the server
  // agent is not called for it; a refusal (a project folder they may not edit, no desktop at all) is said in the chat under the message
  if (req.body?.agent && req.body.agent !== 'default') {
    const { send, end } = openStream(res)
    try { send('done', { local: true, ...(await chatToLocal({ user: req.user, thread: t, text: req.body.text, agent: String(req.body.agent), conversation: req.body.conversation, files: req.body.files, refs: Array.isArray(req.body.refs) ? req.body.refs.slice(0, 10) : undefined, clientId })) }) } catch (e) {
      if (!e.status || e.status >= 500) console.warn('[local-agents] chat send', e.message)
      await addMessage(req.user.id, t.id, 'agent', 'text', { text: L(`내 PC 에이전트로 보내지 못했어요 — ${e.message}`, `Could not send this to the agent on your PC — ${e.message}`), failed: true, localRefused: true }).catch(() => {})
      send('error', { message: e.message, status: e.status || 500 })
    }
    return end()
  }
  // an instance's conversation while a local CLI agent runs one of its steps: what its person types steers that run (lib/localAgents)
  const steered = await steerFromThread(req.user, t, req.body?.text, { clientId }).catch((e) => { console.warn('[local-agents] steer', e.message); return null })
  if (steered) { const { send, end } = openStream(res); send('done', { steered: true, steer: steered.steer, delivered: steered.delivered }); return end() }
  // headers and a comment now, one every 20 s: a slow first word is not cut by a proxy (lib/sse.js)
  const { send, end } = openStream(res)
  try {
    const final = await runTurn({ user: req.user, session: req.session, threadId: t.id, text: req.body.text, context: req.body.context, files: req.body.files, conversation: req.body.conversation, fresh: !!req.body.fresh, openDoc: req.body.openDoc, refs: Array.isArray(req.body.refs) ? req.body.refs.slice(0, 10) : undefined, clientId, onDelta: (d) => send('delta', { d }),
      // the draft answer turned out to be an interim text (a tool call followed it): the page clears the draft (lib/turnPlan.js)
      onRetract: () => send('retract', {}) })
    send('done', final)
  } catch (e) {
    // dragged files that all turned out unusable and no words: nothing was sent (handleTurn) — said, not a failed chat turn
    if (e.empty) { send('error', { message: e.message, status: 400 }); return end() }
    console.error(e)
    // a message never goes unanswered: the failure is said in the chat, not only in this stream; a usage
    // limit (lib/llmKeys.js) says which one and when it opens again, with the way to Settings › Usage & plan
    await setThreadStatus(req.user.id, t.id, null).catch(() => {})
    const limit = ['quota_exceeded', 'rate_limited', 'model_not_allowed'].includes(e.code)
    await addMessage(req.user.id, t.id, 'agent', 'text', {
      text: limit ? e.message : L('이 요청을 처리하지 못했어요. 잠시 후 다시 보내 주세요.', "I couldn't handle this request. Please send it again in a moment."),
      failed: true, ...(limit ? { limit: { code: e.code, scope: e.scope || null, resetsAt: e.resetsAt || null } } : {}),
    }).catch(() => {})
    send('error', { message: e.message })
  }
  end()
}
// 멈추기: the answer being written in this thread (deepagents /chat/stop), or its browser task.
// Messages waiting their turn (대기) then go ahead.
app.post('/api/threads/:id/stop', auth, async (req, res) => {
  const t = await getThread(req.user.id, req.params.id)
  if (!t) return res.status(404).end()
  const r = await stopTurns({ user: req.user, session: req.session, threadId: t.id, conversation: req.body?.conversation ? String(req.body.conversation) : null })
  // (a conversation that is not this person's — review 11-25 #1)
  if (r.refused) return res.status(404).json({ error: L('없는 대화예요.', 'No such conversation.') })
  if (!r.stopped && browser.runningIn(req.user.id, t.id)) { browser.cancel(req.user.id); r.stopped = 1; r.browser = true }
  res.json(r)
})

// ---------- actions ----------
app.get('/api/actions', auth, async (req, res) =>
  res.json(await q(`select * from pro_actions where user_id=$1 and status in ('open','running') order by created_at desc limit 12`, [req.user.id])))
app.post('/api/actions/:id/run', auth, async (req, res) => {
  // a mail's reply is written and sent in its card (routes/mailReply.js) — an older screen still asking
  // the agent to reply gets a refusal, not a sent mail
  const [card] = await q('select * from pro_actions where id=$1 and user_id=$2', [req.params.id, req.user.id])
  if (card && isReplyCard(card)) return res.status(409).json({ error: L('이 카드는 열어서 답장을 확인하고 보내 주세요.', 'Open this card to check the reply and send it.'), code: 'reply_in_card' })
  const [a] = await q(`update pro_actions set status='running' where id=$1 and user_id=$2 returning *`, [req.params.id, req.user.id])
  if (!a) return res.status(404).end()
  emit(req.user.id, 'action', a)
  res.json(a)
  const t = await mainThread(req.user.id)
  // a card that answers a customer mail reviews that mail's drafts: never a shared-folder edit
  runTurn({ user: req.user, session: req.session, threadId: t.id, text: `${a.verb}: ${a.text}\n\n${a.prompt || ''}`, noFolder: !!a.source?.mail_id, composed: true })
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
  // a private card (a mail's attachment — lib/mailAttachments.js): no address is ever stored on it; the save must be one of its own copies
  const [own] = await q(`select m.* from pro_messages m join pro_threads t on t.id=m.thread_id where m.id=$1 and t.user_id=$2 and m.kind='file'`, [req.params.id, req.user.id])
  if (!own) return res.status(404).end()
  // (only a private card saved into the private bucket goes this way; a private card answered with any other address is refused — it never
  // gets an address — and every other card goes on as before)
  const way = saveKindOf(own, url)
  if (way === 'refuse') return res.status(400).json({ error: L('저장한 편집본을 찾지 못했어요.', "I couldn't find the saved copy.") })
  if (way === 'private') {
    try {
      const pm = await savePrivateCard(req.user, own, { url, session: req.body.session })
      emit(req.user.id, 'message', pm)
      return res.json(pm)
    } catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : L('저장하지 못했어요.', "Couldn't save it.") }) }
  }
  // (the editor saves again and again into the same copy: the old url is a version once)
  let [m] = await q(`update pro_messages m set content = content || jsonb_build_object('url', $3::text, 'edited', true,
                         'versions', coalesce(content->'versions','[]'::jsonb) || case when content->>'url' = $3 then '[]'::jsonb else jsonb_build_array(content->>'url') end,
                         'name', coalesce($4::text, content->>'name'))
                       from pro_threads t where m.id=$1 and t.id=m.thread_id and t.user_id=$2 and m.kind='file' returning m.*`,
  [req.params.id, req.user.id, url, name])
  if (!m) return res.status(404).end()
  // a shared folder's file opened from the chat (folder_open): the save is a commit in the folder's main,
  // as on the folder screen — the card follows the version it now stands on
  const ff = m.content.folder
  if (ff?.slug && ff.editable === true) {
    let saved
    try {
      const { folder } = await FS.access(ff.slug, req.user, 'editor')
      // (one opening of the card is one editing session: the screen names it)
      const r = await FS.saveOfficeEdit(folder, { name: req.user.name, email: req.user.email, id: req.user.id }, { path: ff.path, base: ff.sha, url, session: String(req.body.session || m.id) })
      if (r.commit) { await reindexFolder(folder, { cards: false }); cardsSoon(folder) }
      saved = { ok: true, path: r.path, copied: r.copied, at: new Date().toISOString() }
      ;[m] = await q(`update pro_messages set content = content || jsonb_build_object('folder', $2::jsonb, 'folder_save', $3::jsonb) where id=$1 returning *`, [m.id, { ...ff, path: r.path, sha: r.sha }, saved])
    } catch (e) {
      ;[m] = await q(`update pro_messages set content = content || jsonb_build_object('folder_save', $2::jsonb) where id=$1 returning *`, [m.id, { ok: false, error: e.message, at: new Date().toISOString() }])
    }
  }
  // a file of a received share: the save is a commit on this conversation's branch (lib/team/worktree.js)
  if (m.content.branch) await commitEdit(req.user, m).catch((e) => console.warn('[worktree] edit', e.message))
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
  const r = await workroom.resolveRoom(req.params.kind, req.params.id, req.user).catch(() => null)
  if (!r) { res.status(404).json({ error: 'no workroom' }); return null }
  if (!(await workroom.canAccess(req.user, r).catch(() => false))) { res.status(403).json({ error: L('이 작업실을 볼 권한이 없어요', "You don't have access to this workroom") }); return null }
  return r
}
const fail = (res, e) => res.status(e.status || 500).json({ error: e.message, mtime: e.mtime, ...(e.readonly ? { readonly: true } : {}) })
app.get('/api/workroom/:kind/:id', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  // (what stays on the server: the disk paths of a read-only room, the seat's own row, the save hook)
  const { root, cwd, git, seatRow, afterWrite, userId, folderRow, variationRow, role, ...info } = r
  // a variation: where its working copy is (folders/seats.js) — read only here unless it is this person's server workroom
  const seat = r.kind === 'variation' ? await roomSeat(r, req.user).catch(() => null) : null
  res.json({ ...info, folder: root ? path.basename(root) : r.branch || '', ...(seat ? { seat } : {}), terminal: workroom.terminalInfo(r), files: await workroom.tree(r) })
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
    // an agent-written page, SVG or any XML (.xhtml, .xsl …) must not run script on this origin: it gets the sandbox here. Plain text gets
    // the same script-free policy from the /api rule (apiHeaders); a PDF, picture, song or video goes without one (it would not show or play)
    const passive = /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|mp4|m4v|mov|webm|ogv|mp3|m4a|aac|wav|ogg|oga|opus|flac|weba|pdf|txt|md|csv|json)$/i.test(String(req.query.path))
    const headers = { 'X-Content-Type-Options': 'nosniff', ...(passive ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'" }) }
    const f = await workroom.rawFile(r, req.query.path)
    if (f.path) return res.sendFile(f.path, { headers })
    // a read-only room: the file as the branch has it
    res.set(headers).type(nodePath.extname(f.name) || 'application/octet-stream').send(f.buffer)
  } catch (e) { fail(res, e) }
})
app.put('/api/workroom/:kind/:id/file', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  try { res.json(await workroom.writeAs(r, req.user, req.body.path, String(req.body.content ?? ''), req.body.mtime)) } catch (e) { fail(res, e) }
})
app.post('/api/workroom/:kind/:id/publish', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  try { res.json(await workroom.publishFile(r, req.body.path, req.user)) } catch (e) { fail(res, e) }
})
app.post('/api/workroom/:kind/:id/ticket', auth, async (req, res) => {
  const r = await room(req, res); if (!r) return
  // no terminal here (no node-pty, no folder, a shared server, a variation whose working copy is elsewhere): say why instead of a socket
  // that never opens
  try { workroom.assertWritable(r, req.user) } catch (e) { return fail(res, e) }
  const st = workroom.terminalStatus(r, req.body.mode === 'claude' ? 'claude' : 'shell')
  if (!st.ok) return res.status(st.status).json({ error: st.reason })
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
function fire(id) {
  if (firing.has(id)) return console.log(`[cron] ${id.slice(0, 8)} still running, tick skipped`)
  firing.add(id)
  // skills, processes and plain prompts alike (lib/missions.js): every run is in the task's run history,
  // a failure is announced in chat and on Home, a run that found nothing new posts nothing, and a tick
  // the database could not even record is tried again a little later
  fireSchedule(id).catch((e) => console.warn('[cron]', e.message)).finally(() => firing.delete(id))
}
app.post('/api/cron/fire', async (req, res) => {
  if (req.body.secret !== config.cronSecret) return res.status(403).end()
  res.json({ ok: true })
  fire(req.body.id)
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
// where a task's results go besides the chat: the person's Telegram bot (lib/telegram.js)
app.post('/api/missions/:id/channels', auth, async (req, res) => {
  const s = await ownSchedule(req)
  if (!s) return res.status(404).end()
  const cur = Array.isArray(s.state?.channels) ? s.state.channels : []
  const next = [...new Set([...cur.filter((c) => c !== 'telegram'), ...(req.body?.telegram ? ['telegram'] : [])])]
  await q(`update pro_schedules set state = jsonb_set(coalesce(state,'{}'::jsonb), '{channels}', $2::jsonb) where id=$1`, [s.id, JSON.stringify(next)])
  res.json({ channels: next })
})
app.post('/api/missions/:id/pause', auth, async (req, res) => {
  if (!(await ownSchedule(req))) return res.status(404).end()
  const [s] = await q('update pro_schedules set paused=$2 where id=$1 returning paused', [req.params.id, !!req.body.paused])
  ontoTimer(req.params.id)
  res.json(s)
})

// whether this company's process steps name the run in their output's media (run_id compared as text, whatever its JSON
// type); a video's seeks ask again and again, so the answer is kept for a few minutes per company and run
const namedRuns = new Map()
async function runNamed(runId) {
  const key = `${config.tenantId}|${runId}`
  const hit = namedRuns.get(key)
  if (hit && hit.until > Date.now()) return hit.ok
  const rows = await q(`select 1 from todolist where tenant_id=$1 and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(output->'media')='array' then output->'media' else '[]'::jsonb end) m where m->>'run_id' = $2) limit 1`, [config.tenantId, runId])
    .catch((e) => { console.warn('[agent-files] lookup', e.message); return null })
  if (rows === null) return false
  const ok = rows.length > 0
  if (namedRuns.size > 5000) namedRuns.clear()
  namedRuns.set(key, { ok, until: Date.now() + (ok ? 5 : 1) * 60_000 })
  return ok
}

// Files a CLI agent produced in its run workspace (e.g. a demo video), streamed from cli-agent.
// A <video> element cannot send a bearer header, so the token may come as a query parameter.
app.get('/api/agent-files/:runId', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '') || String(req.query.token || '')
  const user = await userFromJwt(token).catch(() => null)
  if (!user) return res.status(401).end()
  // only a run this company's process steps name (their output's media), and only the media itself (videos · pictures)
  const runId = String(req.params.runId)
  const rel = String(req.query.path || '')
  if (!/\.(mp4|webm|png|jpe?g|gif|webp)$/i.test(rel)) return res.status(415).end()
  if (!(await runNamed(runId))) return res.status(404).end()
  const url = `${config.cliAgentUrl}/runs/${encodeURIComponent(req.params.runId)}/download?tenant_id=${encodeURIComponent(config.tenantId)}&path=${encodeURIComponent(String(req.query.path || ''))}`
  const up = await fetch(url, { headers: req.headers.range ? { Range: req.headers.range } : {} })
  res.status(up.status)
  for (const h of ['content-length', 'content-range', 'accept-ranges']) if (up.headers.get(h)) res.setHeader(h, up.headers.get(h))
  // the type comes from the name we allowed, not from upstream
  const ext = rel.split('.').pop().toLowerCase()
  res.setHeader('Content-Type', { mp4: 'video/mp4', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext])
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
// a card in line (lib/browser.js queueAction): 「이 말을 앞 작업의 답으로」 (answer) · 「앞 작업 멈추고 이것부터」 (first) · 「앞 작업 뒤에 줄 세우기」 (after)
app.post('/api/browser/queue', auth, async (req, res) => {
  const action = ['answer', 'first', 'after'].includes(req.body?.action) ? req.body.action : null
  if (!action || !req.body?.taskId) return res.status(400).json({ error: 'taskId, action: answer | first | after' })
  const r = await browser.queueAction(req.user.id, String(req.body.taskId), action)
  res.status(r.ok ? 200 : 409).json(r)
})
// 다시 시도 on a card whose step stalled (content.stall): that step is left and the turn starts again from a fresh look
app.post('/api/browser/retry', auth, (req, res) => { res.json({ ok: browser.retryStep(req.user.id, req.body?.taskId ? String(req.body.taskId) : undefined) }) })
// a browser task on the person's PC whose PC went off (lib/browser.js whenOffline): 「서버에서 이어서」 (to: 'server') · 「PC가 다시 켜지면」 (to: 'wait')
app.post('/api/browser/route', auth, async (req, res) => {
  const to = req.body?.to === 'server' ? 'server' : req.body?.to === 'wait' ? 'wait' : null
  if (!to) return res.status(400).json({ error: 'to: server | wait' })
  res.json({ ok: await browser.routeTo(req.user.id, req.body?.taskId ? String(req.body.taskId) : undefined, to) })
})
// 「이 PC에서 보기」: the browser on the person's PC shows its window there (on: false hides it)
app.post('/api/browser/show', auth, async (req, res) => {
  try { res.json({ ok: await browser.showOnPc(req.user.id, req.body?.taskId ? String(req.body.taskId) : undefined, req.body?.on !== false) }) } catch (e) { res.status(409).json({ error: e.message }) }
})
// 「브라우저 작업은 내 PC에서」 (Settings › 계정 › 내 컴퓨터의 에이전트): where the person's browser tasks run (lib/browserRemote.js) — each PC's
// own setting, kept by the desktop app and sent with its link; shown here, changed only on that PC
app.get('/api/browser/where', auth, async (req, res) => res.json(await browserRemote.whereFor(req.user)))
// ---------- search ----------
app.get('/api/search', auth, async (req, res) => {
  const like = `%${req.query.q || ''}%`
  res.json(await q(`select m.id, m.thread_id, t.kind, t.title, m.content->>'text' as text, m.created_at
    from pro_messages m join pro_threads t on t.id=m.thread_id
    where t.user_id=$1 and m.content->>'text' ilike $2 order by m.created_at desc limit 30`, [req.user.id, like]))
})

const server = app.listen(config.port, async () => {
  console.log(`pgpt-pro server on :${config.port}`)
  // the folders this server writes to on a volume that starts empty (production: the PVC at /data) — the map's form files
  // (PRO_FORMS_DIR, one folder per tenant inside: lib/ontology/history.js formsDirOf)
  for (const dir of [process.env.PRO_FORMS_DIR].filter(Boolean)) {
    try { nodeFs.mkdirSync(dir, { recursive: true }) } catch (e) { console.warn(`[startup] could not make ${dir}: ${e.message}`) }
  }
  // the first sign-in page after a start already knows whether Google sign-in is there (lib/sso.js)
  refreshSso().then((on) => config.tenantFromHeader && console.log(`[sso] Google through Supabase: ${on ? 'on' : 'off'}`))
  // a second development server shares the database: it must not reset the main server's tasks either
  // the usage event consumer (lib/plans/meter.js): one server reads at a time (advisory lock), so a development
  // server may run it too (PRO_BILLING_METER=1)
  if (background || process.env.PRO_BILLING_METER === '1') startMeter()
  // is there a transcription model behind PRO_TRANSCRIBE_*? (/api/config transcribe) — a development server checks once
  startSelfTest({ repeat: background })
  // (a development or test server with PRO_NOTIFY_FEED=1 sends its own tenant's notices to its subscriptions — e2e push-hitl's fake push service)
  if (!background && process.env.PRO_NOTIFY_FEED === '1') notify.startNotificationFeed()
  if (!background) return console.log('PRO_BACKGROUND=0: pollers, workers, registries and startup resets are off')
  // browser sessions live in memory; tasks that were mid-flight when the server stopped cannot resume
  await q(`update pro_messages set content = content || '{"state":"failed","summary":"서버가 다시 시작되어 작업이 중단됐어요."}'::jsonb
           where kind='task' and content->>'state' in ('running','needs_input','queued')
             and not exists (select 1 from pro_threads t join pro_profile p on p.user_id=t.user_id where t.id=pro_messages.thread_id and to_jsonb(p)->>'lang'='en')`)
  // (English-mode people read it in English)
  await q(`update pro_messages set content = content || '{"state":"failed","summary":"The server restarted, so the task was stopped."}'::jsonb
           where kind='task' and content->>'state' in ('running','needs_input','queued')`).catch(() => {})
  await q(`update pro_messages set content = content || '{"state":"expired"}'::jsonb where kind='vault' and content->>'state'='pending'`)
  // …and nothing waits on the person for them any more: their notices go (lib/askPerson.js — the Home lists only live ones anyway)
  // (by the task cards' own state: a wait another server still holds keeps its notice)
  await ASK.resetTaskAsks().catch((e) => console.warn('[ask] reset', e.message))
  await q(`update pro_threads set status=null where status is not null`)
  // turns wait their turn in memory (lib/turns.js): a message still marked 대기 will not be answered now
  await q(`update pro_messages set content = (content - 'queued') || '{"dropped":true}'::jsonb where role='user' and content ? 'queued'`)
  mail.startPoller()
  // every company's plan, re-applied to LiteLLM every ten minutes (lib/plans/apply.js)
  startPlanSync(forEachTenant)
  startBrowserWorker()
  startSkillWorker()
  startMiningScan()
  // registering Lite's connectors in the tenant's system list changes what ProcessGPT shows: not
  // behind the ProcessGPT gateway, where the tenants are ProcessGPT's own
  if (!config.tenantFromHeader) startSystemRegistry()
  notify.startNotificationFeed()
  startScheduleTicker(fire)
  startFolderSteps()
  // the folders' repositories packed at night, one at a time (lib/folders/gc.js)
  startFolderGc()
  // shared folders' documents the old image could not read get their cards now (lib/folders/indexer.js)
  setTimeout(() => retryUnreadCards().then((n) => n && console.log(`[folders] cards again in ${n} folder(s)`)).catch((e) => console.warn('[folders] cards again', e.message)), 30_000)
  startConstraintSweep()
  // agent steps stopped by a passing error are queued again (lib/stepRetry.js)
  startStepRetry()
})
// how long one request may take to arrive whole (Node's own default is five minutes): an upload of 200 MB on a slow line takes longer.
// A folder going up request by request gives up on its own when a body stops coming (lib/folders/batchBody.js, 30 s).
server.requestTimeout = 15 * 60 * 1000

// terminals in the agent workroom (websocket upgrade on /api/workroom/term)
workroom.attachTerminal(server)
// the desktops' links for local CLI agents (websocket upgrade on /api/local-agents/link) and their step worker — like the business
// agent's, even with PRO_BACKGROUND=0 (PRO_LOCAL_AGENT_WORKER=0 turns the worker off)
startLocalAgents(server)
// variations' seats (lib/folders/seats.js): moves that ran out of time end as 보관 중; the main server also puts away the server agents'
// working copies whose run died with the last process
startSeatSweep(forEachTenant, { restart: background })
// an ArtCraft app open in the page, driven live by the agent (websocket upgrade on /api/craft/live)
attachCraftLive(server)
// the interpreter's voice in a meeting (websocket upgrade on /api/meetings/voice)
attachVoice(server)
