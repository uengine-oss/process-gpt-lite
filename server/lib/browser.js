// "Handoff" browser agent: one persistent Chromium profile per user, live view via
// CDP screencast, an LLM loop that acts on numbered page elements, and credentials
// filled server-side from the vault (the model only ever says "fill the password").
// Secret fields are blanked in the page snapshot, masked on screen and in the model's
// screenshots, and logins/cards the user types during takeover are captured into the vault.
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { chat } from './llm.js'
import { emit } from './bus.js'
import { candidates, useItem, putItem, setStatus, audit, normSite } from './vault.js'
import { addMessage, updateMessage, setThreadStatus } from './store.js'
import { q, admin } from './supa.js'
import { decide, sure } from './decide.js'
import { config } from '../config.js'
import { L, isEn } from './lang.js'
import * as mailCode from './mailCode.js'
import { saveAttachment } from './attachments.js'
import { nameByContent } from './fileSniff.js'
import { workspaceHostPath } from './missions.js'
import { browserSkill, browserSkills, readBrowserSkill, browserSkillCatalog } from './browserSkills.js'
import { judge } from './judge.js'

const here = path.dirname(fileURLToPath(import.meta.url))

// Where the profiles (and so the sign-ins people made in them) live: PRO_BROWSER_PROFILES, else the
// data volume when there is one (production mounts an empty PVC at /data — a profile inside the
// container is lost on every deploy), else next to the server.
export function profilesDir(env = process.env, data = '/data') {
  if (env.PRO_BROWSER_PROFILES) return path.resolve(env.PRO_BROWSER_PROFILES)
  try {
    if (fs.statSync(data).isDirectory()) { fs.accessSync(data, fs.constants.W_OK); return path.join(data, 'browser-profiles') }
  } catch { /* no data volume here */ }
  return path.join(here, '..', '.browser-profiles')
}
export const PROFILES = profilesDir()
try { fs.mkdirSync(PROFILES, { recursive: true }) } catch (e) { console.warn('[browser] profiles', PROFILES, e.message) }

// Chromium's lock links in a profile. A pod replaced by a new one (Recreate) leaves them on the volume,
// naming a host that is gone, and Chromium may refuse a profile it thinks another machine holds. They
// are cleared before a launch, unless they name a Chromium still running on this machine.
const LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
export function clearStaleLocks(dir) {
  let holder = ''
  try { holder = fs.readlinkSync(path.join(dir, 'SingletonLock')) } catch { /* no lock, or not a link */ }
  const m = /^(.+)-(\d+)$/.exec(holder)
  if (m && m[1] === os.hostname() && alive(Number(m[2]))) return []
  const cleared = []
  for (const f of LOCKS) {
    try { fs.unlinkSync(path.join(dir, f)); cleared.push(f) } catch { /* not there */ }
  }
  return cleared
}

const sessions = new Map() // userId -> { ctx, page, cdp, frame, task, threadId }
const launching = new Map() // userId -> the launch in progress (two tasks at once share it)

// Fields whose value must never reach the model or the live view.
const SECRET_SELECTOR = 'input[type=password], [data-pro-secret], input[autocomplete^="cc-"], input[autocomplete="one-time-code"]'

// Runs in every page: masks secret fields on screen and reports logins/cards the user submits
// (during takeover) so the server can seal them into the vault. Values the vault itself filled
// are remembered on the element and not reported back.
const PAGE_GUARD = () => {
  const css = () => {
    const root = document.head || document.documentElement
    if (!root || document.getElementById('__pro_guard')) return // too early: DOMContentLoaded adds it
    const st = document.createElement('style')
    st.id = '__pro_guard'
    st.textContent = '[data-pro-secret],input[autocomplete^="cc-"],input[autocomplete="one-time-code"]{-webkit-text-security:disc!important}'
    root.appendChild(st)
  }
  document.addEventListener('DOMContentLoaded', css)
  css()
  const typed = (el) => el && el.value && el.value !== el.__proFilled
  const field = (scope, test) => [...scope.querySelectorAll('input')].find(test)
  let last = ''
  const report = (scope) => {
    if (typeof window.__proVaultCapture !== 'function') return
    const pw = field(scope, (e) => e.type === 'password' && e.value)
    const cc = field(scope, (e) => /cc-number/.test(e.autocomplete) || /card.?(no|num)|cardnumber/i.test(e.name || e.id))
    let payload = null
    if (pw && typed(pw)) {
      const user = [...scope.querySelectorAll('input')].filter((e) => /^(text|email|tel)$/.test(e.type) && e.value && !/search/i.test(e.name || ''))
        .find((e) => /user|email|login|id|account/i.test(`${e.name} ${e.id} ${e.autocomplete}`)) ||
        [...scope.querySelectorAll('input')].find((e) => /^(text|email|tel)$/.test(e.type) && e.value)
      payload = { kind: 'login', host: location.hostname, username: user ? user.value : '', password: pw.value }
    } else if (cc && typed(cc)) {
      const v = (test) => (field(scope, test) || {}).value || ''
      payload = { kind: 'card', host: location.hostname, number: cc.value,
        exp: v((e) => /cc-exp$/.test(e.autocomplete) || /exp/i.test(e.name || e.id)),
        cvv: v((e) => /cc-csc/.test(e.autocomplete) || /cvc|cvv|csc/i.test(e.name || e.id)),
        name: v((e) => /cc-name/.test(e.autocomplete) || /holder|cardname/i.test(e.name || e.id)) }
    }
    if (!payload) return
    const key = JSON.stringify(payload)
    if (key === last) return
    last = key
    window.__proVaultCapture(payload)
  }
  const scopeOf = (el) => (el && el.closest && el.closest('form')) || document
  document.addEventListener('submit', (e) => report(e.target), true)
  document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button,[type=submit],[role=button]'); if (b) report(scopeOf(b)) }, true)
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName === 'INPUT') report(scopeOf(e.target)) }, true)
}

// The type a downloaded file is stored with, so its link plays (audio, video) or opens (PDF, images) in
// the person's browser. Markup is left as a download: it is never rendered from the storage origin.
const MEDIA = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
export const mediaType = (name) => MEDIA[String(name).split('.').pop().toLowerCase()] || ''

// A file the page downloads during a task goes to the person as a file card. Its link is the storage
// copy (lib/attachments.js), which opens from anywhere: the agent's pods and this server share no disk.
async function keepDownload(userId, s, d) {
  const task = s.task
  if (!task) return d.cancel().catch(() => {})
  let name = d.suggestedFilename()
  try {
    const data = await fs.promises.readFile(await d.path())
    // a site that names nothing ("download"): the type its bytes show, so the card plays or opens it in place
    name = await nameByContent(name, data, (ext) => !!MEDIA[ext])
    const type = mediaType(name)
    const saved = await saveAttachment({ id: userId }, name, type, data)
    await addMessage(userId, task.threadId, 'agent', 'file', { name: saved.name, url: saved.url, size: saved.size, ...(type ? { type } : {}), ...(saved.path ? { path: saved.path } : {}), taskId: task.id })
    ;(task.downloads ||= []).push(saved.name)
    task.log.push({ kind: 'download', text: L(`${saved.name} 받기`, `Download ${saved.name}`), ok: true })
  } catch (e) {
    console.warn('[browser] download', e.message)
    const why = e.status === 413 ? L('50MB보다 커서', 'it is over 50 MB') : e.message.slice(0, 60)
    task.notes.push(L(`${name} 파일을 받지 못했어요(${why})`, `Could not keep ${name} (${why})`))
    // the person hears it now, not only in the summary at the end
    await addMessage(userId, task.threadId, 'agent', 'text', { text: L(`사이트에서 받은 「${name}」 파일을 채팅에 올리지 못했어요(${why}). 그 사이트에서 직접 받아 주세요.`, `I couldn't put the file "${name}" from the site in the chat (${why}). Please download it from the site yourself.`) }).catch(() => {})
  }
}

const VIEW = { width: 1280, height: 800 }
// the data volume is shared with other features: Chromium's cache stays small
const LAUNCH_ARGS = ['--disk-cache-size=52428800']

async function sessionOf(userId) {
  const s = sessions.get(userId)
  if (s && !s.ctx._closed) return s
  // two tasks asked for at once share one launch (a second launch on the same profile would fail)
  if (!launching.has(userId)) launching.set(userId, launch(userId).finally(() => launching.delete(userId)))
  return launching.get(userId)
}

async function launch(userId) {
  const dir = path.join(PROFILES, userId)
  fs.mkdirSync(dir, { recursive: true })
  const cleared = clearStaleLocks(dir) // no live session of this person here (sessionOf checked)
  if (cleared.length) console.log('[browser] cleared stale profile locks', userId, cleared.join(','))
  const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: VIEW, locale: 'ko-KR', args: LAUNCH_ARGS })
  ctx.on('close', () => { ctx._closed = true })
  const s = { ctx, page: null, frame: null, task: null, threadId: null, captures: new Map(), queue: [], planning: new Map() }
  await ctx.addInitScript(PAGE_GUARD)
  await ctx.exposeBinding('__proVaultCapture', (_src, payload) => onCapture(userId, s, payload).catch((e) => console.warn('[vault capture]', e.message)))
  const watchDownloads = (page) => page.on('download', (d) => keepDownload(userId, s, d).catch((e) => console.warn('[browser] download', e.message)))
  // a link that opens a new tab, a sign-in popup: the work (and the live view) moves there, and back when it closes
  ctx.on('page', (p) => { watchDownloads(p); if (s.page) follow(userId, s, p).catch((e) => console.warn('[browser] new page', e.message)) })
  s.page = ctx.pages()[0] || await ctx.newPage()
  watchDownloads(s.page)
  await s.page.evaluate(PAGE_GUARD).catch(() => {})
  sessions.set(userId, s)
  await startScreencast(userId, s)
  return s
}

async function follow(userId, s, p) {
  if (p === s.page || p.isClosed()) return
  const from = s.page
  p.once('close', () => {
    if (s.page !== p || s.ctx._closed) return
    const back = !from.isClosed() ? from : s.ctx.pages().filter((x) => !x.isClosed()).at(-1)
    if (back) usePage(userId, s, back).catch((e) => console.warn('[browser] back to page', e.message))
  })
  await usePage(userId, s, p)
  await p.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
}

async function usePage(userId, s, p) {
  s.page = p
  await p.bringToFront().catch(() => {})
  const old = s.cdp
  s.cdp = null
  await old?.send('Page.stopScreencast').catch(() => {})
  await old?.detach().catch(() => {})
  await startScreencast(userId, s).catch((e) => console.warn('[browser] screencast', e.message))
  if (s.task) say(s.task, L(`${hostOf(p.url()) || '새 탭'}에서 이어서 하는 중`, `Going on in ${hostOf(p.url()) || 'the new tab'}`))
}

// A login or card the user typed (takeover) is sealed into the vault at once as 'captured';
// the chat card asks whether to keep it. Nothing is posted when it matches what is saved.
async function onCapture(userId, s, p) {
  const threadId = s.task?.threadId || s.threadId
  if (!threadId || !p || !['login', 'card'].includes(p.kind)) return
  const site = normSite(p.host)
  const data = p.kind === 'login' ? { username: p.username, password: p.password } : { number: p.number, exp: p.exp, cvv: p.cvv, name: p.name }
  let item
  try {
    item = await putItem(userId, p.kind, site, data, { actor: 'browser-agent', taskId: s.task?.id, status: 'captured' })
  } catch { return } // incomplete or invalid (e.g. a card form half filled): nothing to keep
  if (item.unchanged) return
  const content = { kind: p.kind, site, mode: 'capture', itemId: item.id, label: item.label, taskId: s.task?.id, state: 'pending' }
  const prev = s.captures.get(item.id)
  if (prev) await updateMessage(userId, prev, content)
  else s.captures.set(item.id, (await addMessage(userId, threadId, 'agent', 'vault', content)).id)
}

async function startScreencast(userId, s) {
  const page = s.page
  const cdp = await s.ctx.newCDPSession(page)
  s.cdp = cdp
  cdp.on('Page.screencastFrame', async (f) => {
    if (s.page === page) {
      s.frame = f.data
      if (s.task) emit(userId, 'browser.frame', { taskId: s.task.id, data: f.data, url: page.url() })
    }
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 2 })
}

// A page busy with its own scripts must not hold a task for minutes: every look at it has a limit.
const SHOT_MS = 6000
const EVAL_MS = 8000
const within = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms).unref?.())]).catch(() => fallback)

async function pushFrame(userId, s) {
  const shot = await s.page.screenshot({ type: 'jpeg', quality: 55, timeout: SHOT_MS }).catch(() => null)
  if (!shot) return null
  s.frame = shot.toString('base64')
  if (s.task) emit(userId, 'browser.frame', { taskId: s.task.id, data: s.frame, url: s.page.url() })
  return s.frame
}

// Numbered interactive elements, the agent's view of the page. Also what the page calls itself (its
// og:site_name / application-name meta) and, from the visible fields alone, whether it has a password or
// a sign-in field: what the wall check reads besides the text.
const SNAPSHOT_JS = () => {
  const els = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]')]
  const out = []
  const fields = { password: false, signIn: false }
  const meta = (n) => (document.querySelector(`meta[property="${n}"], meta[name="${n}"]`)?.content || '').trim()
  let i = 0
  for (const el of els) {
    const r = el.getBoundingClientRect()
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue
    const st = getComputedStyle(el)
    if (st.visibility === 'hidden' || st.display === 'none') continue
    el.setAttribute('data-pro-idx', String(i))
    // a secret field shows what it is for and whether it is filled, never its value
    const secret = el.type === 'password' || el.hasAttribute('data-pro-secret') || /^cc-|one-time-code/.test(el.autocomplete || '') ||
      /card.?(no|num)|cardnumber|cvc|cvv|csc|otp/i.test(`${el.name || ''} ${el.id || ''}`)
    const label = el.placeholder || el.getAttribute('aria-label') || ''
    if (el.type === 'password') fields.password = true
    if (el.tagName === 'INPUT' && (el.type === 'email' || String(el.autocomplete || '').split(/\s+/).some((t) => t === 'username' || t === 'email'))) fields.signIn = true
    out.push({ i, tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '',
      text: (secret ? label : (el.innerText || el.value || label)).trim().slice(0, 60),
      ...(secret ? { secret: true, filled: !!el.value } : {}) })
    if (++i >= 120) break
  }
  return { title: document.title, url: location.href, site: meta('og:site_name') || meta('application-name'), fields,
    text: document.body.innerText.slice(0, 2500), els: out }
}

// Slow work on a page (a report, an audio file being made) is waited for here, without spending the model's turns.
export const WAIT = { everyMs: 15000, maxMinutes: 30, taskMaxMinutes: 60, watchMs: 2000, settleMs: 500 }

const STEP_TOOLS = new Set(['goto', 'click', 'type', 'fill_secret', 'scroll', 'wait_for_page', 'attach_file', 'note'])
const TOOLS = [
  ['goto', 'Open a URL', { url: 'string' }],
  ['click', 'Click element by index', { i: 'number' }],
  ['type', 'Type text into element by index (not for secrets)', { i: 'number', text: 'string', enter: 'boolean' }],
  ['fill_secret', 'Fill a saved vault credential into element (field: username|password|card_number|card_exp|card_cvv|card_name). If none is saved the server asks the user; if several are saved it asks which one', { i: 'number', field: 'string' }],
  ['login_failed', 'The site rejected the login you filled (wrong password / error after submitting). The server marks it rejected and asks the user for a corrected password', { reason: 'string' }],
  ['need_secret', 'A one-time value only the user has (SMS/e-mail verification code, OTP, 2FA). The server asks the user and types it into element i; you never see the value', { i: 'number', label: 'string' }],
  ['scroll', 'Scroll the page', { dy: 'number' }],
  ['wait_for_page', 'Wait for slow work on this page (something being generated) without using up your actions. The page is checked every 15 seconds until until_text appears on it or gone_text is no longer on it, or the minutes run out. Files the page downloads meanwhile reach the person by themselves', { minutes: 'number', until_text: 'string', gone_text: 'string' }],
  ['tell_user', 'Tell the person in the chat how a long task is going, in one or two sentences. Work goes on', { text: 'string' }],
  ['attach_file', 'Give a file the person attached to this task to the page: i is the file input or the control that opens the file picker', { i: 'number', name: 'string' }],
  ['step_done', 'Mark a plan step complete', { step: 'number', note: 'string' }],
  ['note', 'Record facts you found (names, prices, URLs) so they survive leaving this page', { text: 'string' }],
  ['need_login', 'No saved credential for this site; ask the user to save one', { site: 'string' }],
  ['approve', 'Ask the user to approve an irreversible step (submitting a payment, sending, deleting) right before doing it. Say exactly what will happen (amount, item, recipient)', { summary: 'string' }],
  ['need_user', 'Ask the user to intervene (captcha, manual step they must do themselves). Say in need what it is: login (they have to sign in themselves), captcha (a check that they are human), or other. When the user only has to pick one of a few choices (which account, which plan), list them in options', { reason: 'string', options: 'array', need: { type: 'string', enum: ['login', 'captcha', 'other'] } }],
  ['read_skill', 'Read the full instructions of a browser skill named in this task (what to press on that site, how long things take) and follow them', { name: 'string' }],
  ['finish', 'Task complete', { summary: 'string' }],
].map(([name, description, props]) => ({
  type: 'function',
  function: {
    name, description,
    parameters: {
      type: 'object',
      properties: {
        ...Object.fromEntries(Object.entries(props).map(([k, t]) => [k, t === 'array' ? { type: 'array', items: { type: 'string' } } : typeof t === 'object' ? t : { type: t }])),
        // a step finished by this very action is marked with it: no turn spent on step_done alone
        ...(STEP_TOOLS.has(name) ? { done: { type: 'number', description: 'Number of the plan step this action completes, if it does' } } : {}),
      },
      required: Object.keys(props).filter((k) => !['enter', 'note', 'options', 'until_text', 'gone_text', 'need'].includes(k) && !(k === 'name' && name !== 'read_skill')),
    },
  },
}))

// Only what was asked: a look-up task gets no ordering or paying step (a run once pressed 「다시 주문하기」
// on the account page it was only reading). The click gate below holds the line when a model still tries.
const PLAN_SCOPE = ' Plan only what the task asks for. Unless the task itself asks to buy, order, pay, subscribe or book, no step may add to a cart, order, reorder, buy, pay, check out, subscribe or book — a look-up task only reads. The last step states the result the task asks for.'
// Controls that start or complete a purchase (not "주문 내역" / "My orders", which only show them)
const PURCHASE_CONTROL = /(다시\s*주문|재주문|주문\s*하기|바로\s*구매|구매\s*하기|장바구니\s*(에\s*)?담기|결제\s*(하기|진행)|원\s*결제|구독\s*하기|예약\s*(하기|확정)|주문\s*확정|구매\s*확정)|\b(re-?order|order\s+(again|now)|buy\s+(again|now|it)|add\s+to\s+(cart|bag|basket)|check\s*out|pay(\s+now|\s+₩|\s+\$|\s+\d)|place\s+(your\s+|the\s+)?order|confirm\s+(order|purchase|payment|booking)|complete\s+(purchase|order|payment)|subscribe|purchase)\b|^\s*(buy|pay|order|결제|구매|주문)\s*$/i
// the controls that commit money (approval first, always)
const PAYMENT_CONTROL = /(결제\s*(하기|진행)|원\s*결제|주문\s*확정|구매\s*확정)|\b(pay(\s+now|\s+₩|\s+\$|\s+\d)|place\s+(your\s+|the\s+)?order|confirm\s+(order|purchase|payment)|complete\s+(purchase|order|payment))\b|^\s*(pay|결제)\s*$/i
// a task that asks to buy ("결제해 줘", "주문해 줘", "buy", "order it", "reorder"); "최근 주문 알려 줘" does not
export const asksToBuy = (goal) => /(구매|구입|주문\s*(해|하|을\s*넣|넣어)|재주문|결제\s*(해|하|까지)|사\s*(줘|주세요|와|올래)|구독\s*(해|하)|예약\s*(해|하))|\b(buy|purchase|pay(\s+for)?|check\s*out|subscribe|book|re-?order|place\s+(an|the)\s+order|order\s+(it|this|that|one|two|a|an|the|again|more))\b/i.test(String(goal || ''))
export const isPurchaseControl = (text) => PURCHASE_CONTROL.test(String(text || ''))
export const isPaymentControl = (text) => PAYMENT_CONTROL.test(String(text || ''))

const firstLine = (goal) => String(goal).split('\n')[0].slice(0, 60)
async function plan(goal) {
  const msg = await chat({
    model: undefined, json: true,
    messages: [
      { role: 'system', content: (isEn() ? 'Break a web task into 3-6 short English steps. Reply JSON {"title": "short task name in English", "steps": ["..."]}' : 'Break a web task into 3-6 short Korean steps. Reply JSON {"title": "짧은 작업명", "steps": ["..."]}') + PLAN_SCOPE },
      { role: 'user', content: goal },
    ],
  })
  return JSON.parse(msg.content)
}

// The browser is one per person, so its tasks run one at a time: a task asked for while another one
// is still running (or waiting for the person) waits in line — its card says so, and the person can
// still answer or cancel the one in front (cards and 작업 취소 reach the task that holds the page).
// Runs a browser task; posts a task card into the thread and keeps it updated.
// skill: the browser skill (skills/<name>/SKILL.md, lib/browserSkills.js) the work was routed to, if any —
// the agent is told its name and description and reads the body itself (read_skill); its start_url is
// where the task opens when no startUrl is given.
export async function runBrowserTask(args) {
  const k = `${args.userId}:${args.threadId}`
  started.set(k, (started.get(k) || 0) + 1)
  try { return await runBrowserTaskNow(args) } finally { const n = (started.get(k) || 1) - 1; if (n > 0) started.set(k, n); else started.delete(k) }
}
async function runBrowserTaskNow({ userId, threadId, goal, startUrl, onAction, unattended, gates = config.browserGates, files = [], skill }) {
  const sk = skill ? browserSkill(skill) : null
  if (skill && !sk) console.warn('[browser] no browser skill named', skill)
  startUrl = startUrl || sk?.startUrl || ''
  const s = await sessionOf(userId)
  const t0 = Date.now()
  // the card goes up at once and the plan fills it in: a slow model must not leave "시작할게요" with nothing under it
  const card = await addMessage(userId, threadId, 'agent', 'task', { title: firstLine(goal), goal, steps: [], state: 'running', url: startUrl || '' })
  s.planning.set(card.id, false)
  // an idle browser opens the start page while the plan is being made (the page is not anyone else's)
  const early = startUrl && !s.task && !s.queue.length && s.planning.size === 1
    ? (emit(userId, 'status', { threadId, text: L(`${hostOf(startUrl)} 여는 중`, `Opening ${hostOf(startUrl)}`) }),
      s.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).then(() => true, () => true))
    : null
  if (early) { s.early = early; early.then(() => { if (s.early === early) s.early = null }) }
  const p = await plan(goal).catch((e) => { console.warn('[browser] plan', e.message); return { title: firstLine(goal), steps: [] } })
  const cancelledEarly = s.planning.get(card.id)
  s.planning.delete(card.id)
  const ahead = s.task || s.queue.length ? (s.queue.at(-1)?.task || s.task) : null
  await updateMessage(userId, card.id, {
    title: p.title, steps: p.steps.map((t) => ({ text: t, done: false })), state: ahead ? 'queued' : 'running',
    ...(ahead ? { reason: L(`앞 작업 '${ahead.title}'이(가) 끝나면 시작해요`, `Starts when the task ahead, '${ahead.title}', is done`) } : {}),
  })
  const task = { id: card.id, userId, threadId, goal, files, title: p.title, steps: p.steps, cancelled: false, waiting: null, notes: [], log: [], unattended, picked: {}, used: {}, secrets: new Set(), declined: new Set(),
    gates, gatedUrl: null, walls: {}, stale: 0, prev: null, stuckWaits: 0, judged: null, skill: sk?.name || null, signIn: sk?.signIn || '',
    stats: { turns: 0, llm: 1, gate_calls: 0, gate_ms: 0, waits: 0, hints: 0, walls: 0, stuck: 0, early_finish: false, decisions: [], plan_ms: 0, turn_ms: [], wall_checks: [], skills_read: [] } }
  task.stats.plan_ms = Date.now() - t0
  task.cancelled = cancelledEarly
  if (ahead && !task.cancelled) {
    await addMessage(userId, threadId, 'agent', 'text', { text: L(`브라우저는 한 번에 한 작업만 해요. 앞 작업 '${ahead.title}'이(가) 끝나거나 취소되면 '${p.title}' 작업을 이어서 시작할게요.${s.task?.waiting ? ' 앞 작업은 지금 입력을 기다리고 있어요 — 그 카드에 답하거나 작업을 취소해 주세요.' : ''}`,
      `The browser does one task at a time. When the task ahead, '${ahead.title}', is done or canceled, I'll start '${p.title}'.${s.task?.waiting ? ' The task ahead is waiting for your input right now — answer its card or cancel the task.' : ''}`) })
    await new Promise((go) => s.queue.push({ task, go }))
  }
  if (task.cancelled) {
    await updateMessage(userId, card.id, { state: 'cancelled', reason: '', summary: L('시작하기 전에 취소했어요.', 'Canceled before it started.') })
    return { state: 'cancelled', summary: '', notes: [], stats: task.stats }
  }
  if (ahead) await updateMessage(userId, card.id, { state: 'running', reason: '' })
  // another task's start page, opened while it planned, lands before this one drives the page
  if (s.early && s.early !== early) await s.early
  // from here the browser is this task's: anything a site sends from now on answers what this task did
  // (a code mailed for an earlier sign-in is not this one's — lib/mailCode.js watchForCode since)
  task.drivingSince = Date.now()
  s.task = task
  s.threadId = threadId
  await setThreadStatus(userId, threadId, 'working')
  if (early && !ahead) await early
  else if (startUrl) {
    say(task, L(`${hostOf(startUrl)} 여는 중`, `Opening ${hostOf(startUrl)}`))
    await s.page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  }
  const startedAt = s.page.url()
  await pushFrame(userId, s)

  const messages = [{ role: 'system', content: agentPrompt({ goal, steps: p.steps, files }) }]
  // what the agent may know about a site comes from browser skills, by name and description only: the
  // body is read when the task uses it (read_skill), never written into the prompt
  const skills = skillNote(sk)
  if (skills) messages.push({ role: 'user', content: skills })

  let { result, ended } = await drive(s, task, { messages, onAction })
  if (task.cancelled) result = { state: 'cancelled', summary: L('작업을 취소했어요.', 'I canceled the task.') }
  else if (result.state === 'done' && !ended) {
    const reason = L(`동작 ${MAX_TURNS}번 안에 작업을 끝내지 못해 멈췄어요. 마지막 화면과 아래의 작업 내용을 보고, 카드의 「직접 제어」로 이어서 하거나 더 구체적으로 다시 시켜 주세요.`,
      `I stopped: the task wasn't finished within ${MAX_TURNS} actions. Check the last screen and what I did below, then go on with "Take control" on the card or ask again more specifically.`)
    result = { state: 'needs_review', need: 'stuck', reason, summary: reason }
  }
  // finished without saying the result: one closing call for it (the person reads the result first)
  if (result.state === 'done' && !String(result.summary || '').trim() && task.log.some((e) => e.ok)) {
    result.summary = await closingSummary(messages, task).catch((e) => { console.warn('[browser] closing summary', e.message); return '' })
  }
  // a task that did nothing in the browser is not "done", whatever the model wrote: it is left for
  // the person to check, and what they read is what the action log shows
  try {
    result = honest(result, task, { moved: s.page.url() !== startedAt })
    const shot = await pushFrame(userId, s)
    s.task = null
    // keep the last screen on the card so it survives reloads; a card that stopped says why and what to do
    const host = hostOf(s.page.url())
    const why = result.state === 'failed' || result.state === 'needs_review'
      ? { need: result.need || 'other', reason: result.reason || firstPara(result.summary), site: result.site || host, siteName: result.siteName || nameOn(task, host) } : { need: null, reason: '' }
    await updateMessage(userId, card.id, { state: result.state, summary: result.summary, url: s.page.url(), shot, ...why })
    say(task, null)
    await setThreadStatus(userId, threadId, null)
    result.url = s.page.url()
    result.notes = task.notes
    result.stats = { ...task.stats, ms: Date.now() - t0, avg_ms: averages(task.stats.turn_ms) }
    console.log(`[browser] task ${task.id} ${result.state} in ${Math.round(result.stats.ms / 1000)}s · ${task.stats.turns} turns · plan ${task.stats.plan_ms}ms · per turn ${Object.entries(result.stats.avg_ms).map(([k, v]) => `${k} ${v}ms`).join(', ')}`)
    result.pageText = hide(task, await within(s.page.evaluate(() => document.body.innerText.slice(0, 6000)), EVAL_MS, ''))
    return result
  } finally {
    if (s.task === task) s.task = null
    // the next task in line gets the browser
    s.queue.shift()?.go()
  }
}

// The agent's first message: the goal, its steps and the rules every browser task keeps.
function agentPrompt({ goal, steps = [], files = [] }) {
  return `You operate a Chromium browser for the user. Goal: ${goal}
Plan steps: ${steps.map((x, i) => `${i + 1}. ${x}`).join(' ')}
Each turn you get a page snapshot with numbered elements. Call exactly one tool per turn.
For any login field (username, email, password) and any card field ALWAYS use fill_secret, even if credentials are printed on the page or you could guess them. The server asks the user for missing credentials (and which account or card to use) automatically.
Secret fields appear in the snapshot as secret:true with no value. If the site rejects a login you filled, call login_failed. For a one-time code (SMS, e-mail, OTP, 2FA) call need_secret with the input's index; never ask for it in text.
Before submitting a payment, sending a message or deleting anything, call approve and act only if the user approves.
Do only what the goal asks. ${asksToBuy(goal) ? 'Buy or order only what the goal names, and only after approve.' : 'The goal does not ask to buy anything: never click reorder, buy, add-to-cart, checkout, pay, subscribe or booking controls — the server refuses them.'}
When an action completes a plan step, give that step's number as done on the action itself; use step_done only for a step that needs no action of its own. Use note to record every fact you will need in the final answer before navigating away. Finish with a${isEn() ? 'n English' : ' Korean'} summary that starts with the result the goal asks for (one or two sentences) and contains all collected facts.
Never claim a step you did not do with a tool: the summary the user sees lists only the actions you actually performed.
${files.length ? `The person attached these files for this task: ${files.map((f) => f.name).join(', ')}.\n` : ''}`.trimEnd()
}
// the first answer without a single browser action is sent back once: do the steps first
const NUDGE = 'You have not performed any browser action yet (no goto/click/type/fill_secret/note). Do the plan steps with the tools now. Call finish only after you have actually done them; if the page already shows what the goal asks, record it with note first.'

// Model turns on the page, one action each, until the agent finishes, a wall or an error ends it, or
// stop(snap) says the caller's own end has come (a Google connection settled by its callback).
// → { result, ended }: ended is false only when the turns ran out.
async function drive(s, task, { messages, onAction, stop = () => false }) {
  let result = { state: 'done', summary: '' }
  let ended = false
  try {
  for (let turn = 0; turn < MAX_TURNS && !task.cancelled; turn++) {
    say(task, L('페이지 읽는 중', 'Reading the page'))
    const tm = { snap: 0, judge: 0, shot: 0, llm: 0, act: 0 }
    let t = Date.now()
    let snap = await look(s)
    tm.snap = Date.now() - t
    if (stop(snap)) { result = { state: 'stopped', summary: '' }; ended = true; break }
    task.page = { host: hostOf(snap.url), name: pageName(snap) }
    let hint = ''
    // a sign-in wall, a bot check, a site refusing this browser: the person's turn, not the model's.
    // Judged once per page (a new address, or after the person stepped in), not by any wording
    t = Date.now()
    const wall = await wallOn(task, snap)
    tm.judge = Date.now() - t
    const w = wall && await atWall(s, task, wall, snap)
    if (w?.end) { result = w.end; ended = true; break }
    if (w?.waited) { turn--; task.prev = null; continue }
    if (w?.hint) hint += w.hint
    // the same screen, action after action, with nothing changing: the person is asked before more turns go by
    const key = pageKey(snap)
    if (task.prev) task.stale = key !== task.prev.key || task.prev.progress ? 0 : task.stale + (task.prev.acted ? 1 : 0)
    if (task.stale >= STUCK_TURNS) {
      const st = await whenStuck(s, task, snap)
      if (st.end) { result = st.end; ended = true; break }
      turn--; continue
    }
    task.stats.turns++
    if (task.gates && snap.url !== task.gatedUrl && /^https?:/.test(snap.url)) {
      const g = await pageGate(s, task, snap)
      snap = g.snap
      hint += g.hint
    }
    // a file the page downloaded since the last look
    const got = (task.downloads || []).splice(0)
    if (got.length) hint += `\nDownloaded and shown to the person as file cards: ${got.join(', ')}`
    messages.push({ role: 'user', content: hide(task, JSON.stringify(snap)) + hint })
    t = Date.now()
    const shot = await s.page.screenshot({ type: 'jpeg', quality: 50, mask: [s.page.locator(SECRET_SELECTOR)], maskColor: '#1d1d1f', timeout: SHOT_MS }).catch(() => null)
    tm.shot = Date.now() - t
    if (shot) {
      messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot.toString('base64')}` } }] })
      // the same picture is the live view's newest frame (no second screenshot after the action)
      s.frame = shot.toString('base64')
      emit(task.userId, 'browser.frame', { taskId: task.id, data: s.frame, url: s.page.url() })
    }
    t = Date.now()
    const msg = await chat({ messages, tools: TOOLS })
    tm.llm = Date.now() - t
    task.stats.llm++
    messages.splice(messages.length - (shot ? 2 : 1), shot ? 2 : 1, { role: 'user', content: `[page ${snap.url}] ${snap.title || ''}` })
    messages.push(msg)
    const call = msg.tool_calls?.[0]
    if (!call && !task.log.length && !task.notes.length && !task.nudged) { task.nudged = true; messages.push({ role: 'user', content: NUDGE }); timing(task, tm); continue }
    if (!call) { result = { state: 'done', summary: msg.content || '' }; ended = true; timing(task, tm); break }
    let args = {}
    try { args = JSON.parse(call.function.arguments || '{}') } catch { /* answered below as an error */ }
    task.lastSnap = snap
    let out = 'ok'
    t = Date.now()
    try {
      out = await act(s, task, call.function.name, args)
    } catch (e) { out = 'error: ' + e.message.slice(0, 200) }
    tm.act = Date.now() - t
    timing(task, tm, call.function.name)
    task.prev = { key, acted: ACTING.has(call.function.name) || /^error/.test(String(out)), progress: ['note', 'step_done'].includes(call.function.name) }
    messages.push({ role: 'tool', tool_call_id: call.id, content: hide(task, String(out)) })
    await onAction?.(call.function.name, args, String(out))
    // one action per turn; any extra calls get an explicit skip so the transcript stays valid
    for (const extra of msg.tool_calls.slice(1)) messages.push({ role: 'tool', tool_call_id: extra.id, content: 'skipped: one action per turn' })
    if (out === '__finish__' && !task.log.length && !task.notes.length && !task.nudged) { task.nudged = true; messages.push({ role: 'user', content: NUDGE }); continue }
    if (out === '__finish__') { result = { state: 'done', summary: args.summary }; ended = true; break }
    if (task.gates && call.function.name === 'note' && await goalMet(task)) {
      // the notes already answer the goal: one closing call instead of more browsing turns
      task.stats.early_finish = true
      say(task, L('정리하는 중', 'Wrapping up'))
      const fin = await chat({ messages: [...messages, { role: 'user', content: `The recorded notes already answer the goal. Call finish now with a${isEn() ? 'n English' : ' Korean'} summary containing all collected facts.` }], tools: TOOLS, toolChoice: { type: 'function', function: { name: 'finish' } } })
      task.stats.llm++
      const fa = JSON.parse(fin.tool_calls?.[0]?.function?.arguments || '{}')
      result = { state: 'done', summary: fa.summary || fin.content || task.notes.join('\n') }
      ended = true
      break
    }
  }
  } catch (e) {
    console.warn('[browser]', e.message)
    const reason = failReason(e)
    result = { state: 'failed', need: 'other', reason, summary: reason }
  }
  return { result, ended }
}

// What one turn took: reading the page, the model's picture, the model, the action.
function timing(task, tm, tool = '') {
  task.stats.turn_ms.push({ ...tm, tool })
  if (task.stats.turn_ms.length > MAX_TURNS) task.stats.turn_ms.shift()
  const slow = Object.entries(tm).filter(([k, v]) => k !== 'llm' && v > 10000)
  if (slow.length) console.warn(`[browser] slow turn (${tool}): ${slow.map(([k, v]) => `${k} ${v}ms`).join(', ')}`)
}
const averages = (list) => Object.fromEntries(['snap', 'judge', 'shot', 'llm', 'act'].map((k) => [k, list.length ? Math.round(list.reduce((a, x) => a + (x[k] || 0), 0) / list.length) : 0]))
const firstPara = (text) => String(text || '').split('\n\n')[0].slice(0, 400)

// Fast checks before spending an agent turn, answered by the router's typed decision (judge model
// → logprob → JSON) and acted on only when the answer is measured and sure.
const PAGE_STATES_EN = [
  { key: 'loading', label: 'Still loading, or the body is almost empty', hint: 'a spinner, a blank screen, only a skeleton' },
  { key: 'login_wall', label: 'Asks to log in or sign up; the content is hidden' },
  { key: 'captcha', label: 'Bot check (captcha, are you human)' },
  { key: 'content', label: 'Readable content is visible' },
]
const PAGE_STATES = [
  { key: 'loading', label: '아직 불러오는 중이거나 본문이 거의 비어 있음', hint: '스피너, 빈 화면, 뼈대만 보임' },
  { key: 'login_wall', label: '로그인이나 가입을 요구해 내용이 가려짐' },
  { key: 'captcha', label: '봇 확인(캡차, 사람인지 확인)' },
  { key: 'content', label: '읽을 수 있는 본문이 보임' },
]

async function gate(task, state, question, options) {
  const t = Date.now()
  // the judge model is another model: vault values the page may echo are blanked for it too
  const d = await decide(hide(task, state), question, options)
  if (d) {
    task.stats.gate_calls++
    task.stats.gate_ms += Date.now() - t
    task.stats.decisions.push({ q: question, choice: d.choice, confidence: d.confidence, strategy: d.strategy, calibrated: d.calibrated })
  }
  return d
}

// On each new page: wait out a page that is still loading instead of asking the agent what to do,
// and tell an unattended agent up front that a login wall or bot check cannot be passed.
async function pageGate(s, task, snap) {
  for (let i = 0; ; i++) {
    const d = isEn()
      ? await gate(task, `${snap.title || ''}\n${snap.url}\n${snap.els.length} elements\n${(snap.text || '').slice(0, 1500)}`, 'What state is this web page in right now?', PAGE_STATES_EN)
      : await gate(task, `${snap.title || ''}\n${snap.url}\n요소 ${snap.els.length}개\n${(snap.text || '').slice(0, 1500)}`,
      '이 웹 페이지의 지금 상태는?', PAGE_STATES)
    if (sure(d, 'loading') && i < 2) {
      task.stats.waits++
      say(task, L('페이지 기다리는 중', 'Waiting for the page'))
      await s.page.waitForTimeout(1500)
      snap = await look(s)
      continue
    }
    task.gatedUrl = snap.url
    if (task.unattended && (sure(d, 'login_wall') || sure(d, 'captcha'))) {
      task.stats.hints++
      return { snap, hint: `\n[page check: this page is a ${d.choice === 'captcha' ? 'bot check' : 'login wall'} and nobody is available to get past it. Do not try; use the alternative source in the goal, or finish with what you have]` }
    }
    return { snap, hint: '' }
  }
}

async function goalMet(task) {
  const d = isEn() ? await gate(task, `Goal: ${task.goal}\n\nRecorded facts:\n${task.notes.map((n) => `- ${n}`).join('\n')}`,
    'Can the recorded facts alone fully answer what the goal asks for?', [
      { key: 'done', label: 'Yes, everything the goal asks for is recorded' },
      { key: 'more', label: 'No, there is still information to find' },
    ]) : await gate(task, `목표: ${task.goal}\n\n기록한 사실:\n${task.notes.map((n) => `- ${n}`).join('\n')}`,
    '기록한 사실만으로 목표가 요구한 것을 빠짐없이 답할 수 있나?', [
      { key: 'done', label: '예, 목표가 요구한 정보가 모두 기록돼 있다' },
      { key: 'more', label: '아니오, 아직 더 찾아야 할 정보가 있다' },
    ])
  return sure(d, 'done', 0.9)
}

const MAX_TURNS = 40
async function closingSummary(messages, task) {
  const fin = await chat({ messages: [...messages, { role: 'user', content: `You finished without saying the result. Call finish now with a${isEn() ? 'n English' : ' Korean'} summary that starts with the result the goal asks for in one or two sentences and contains every fact you recorded. Say plainly what you could not do; do not claim anything you did not do with a tool.` }], tools: TOOLS, toolChoice: { type: 'function', function: { name: 'finish' } } })
  task.stats.llm++
  const fa = JSON.parse(fin.tool_calls?.[0]?.function?.arguments || '{}')
  return String(fa.summary || fin.content || '').trim()
}

// What the agent actually did, in the person's words (the summary lists these, not the model's claims).
// Never a value typed into a field: only which field.
function logAction(task, name, a, out) {
  const els = task.lastSnap?.els || []
  const label = (i) => { const e = els.find((x) => x.i === i); return e ? (e.text || e.name || e.tag || `#${i}`).slice(0, 40) : `#${i}` }
  // a refused or impossible step is not an action taken; asking the person always is
  const ok = ['approve', 'need_user', 'need_login', 'login_failed', 'need_secret'].includes(name) || !/^(error|refused|not pressed|no (card|credential)|the saved)/.test(String(out))
  const line = {
    goto: () => L(`${hostOf(a.url)} 열기`, `Open ${hostOf(a.url)}`),
    click: () => L(`'${label(a.i)}' 누르기`, `Click '${label(a.i)}'`),
    // a field by its label from the page, not its snapshot text (which may be what was typed in it)
    type: () => { const n = task.target?.i === a.i && task.target.name ? task.target.name : label(a.i); return L(`'${n}'에 입력`, `Type into '${n}'`) },
    fill_secret: () => L(`보관함의 ${{ username: '아이디', password: '비밀번호', card_number: '카드 번호', card_exp: '카드 만료일', card_cvv: 'CVC', card_name: '카드 소유자' }[a.field] || a.field} 입력`,
      `Fill in the ${{ username: 'username', password: 'password', card_number: 'card number', card_exp: 'card expiry', card_cvv: 'CVC', card_name: 'cardholder name' }[a.field] || a.field} from the Vault`),
    need_secret: () => L(`${a.label || '인증 코드'}를 받아 입력`, `Get and enter the ${a.label || 'verification code'}`),
    approve: () => L(`승인 요청: ${String(a.summary || '').slice(0, 80)} → ${/approved/.test(String(out)) ? '승인됨' : '승인 안 됨'}`, `Approval request: ${String(a.summary || '').slice(0, 80)} → ${/approved/.test(String(out)) ? 'approved' : 'not approved'}`),
    login_failed: () => L('로그인 거부 확인', 'Login rejected'),
    scroll: () => L('화면 내리기', 'Scroll down'),
    wait_for_page: () => L(`화면이 바뀌기를 기다리기(${Math.round(Number(a.minutes) || 0)}분까지)`, `Wait for the page to change (up to ${Math.round(Number(a.minutes) || 0)} min)`),
    attach_file: () => L(`${a.name || '첨부 파일'} 올리기`, `Upload ${a.name || 'the attached file'}`),
    tell_user: () => null,
    need_login: () => L(`${a.site || ''} 로그인 정보 요청`, `Ask for the ${a.site || ''} login`),
    need_user: () => L(`확인 요청: ${String(a.reason || '').slice(0, 60)}`, `Ask to check: ${String(a.reason || '').slice(0, 60)}`),
    note: () => null,
    step_done: () => null,
    read_skill: () => null,
  }[name]?.()
  if (line) task.log.push({ kind: name, text: line, ok, ...(String(out).startsWith(REFUSED_PURCHASE) ? { refusedPurchase: true } : {}) })
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return String(u || '').slice(0, 60) } }
const ACTIONS = new Set(['goto', 'click', 'type', 'fill_secret', 'need_secret', 'approve', 'scroll', 'wait_for_page', 'attach_file'])
const REFUSED_PURCHASE = 'refused: purchase gate —'

// The summary the person reads: the model's account only when the task actually did something, and
// always the list of actions taken. Nothing done (no browser action, no fact noted, page unmoved) →
// 확인 필요, saying so plainly.
export function honest(result, task, { moved = false } = {}) {
  const acted = task.log.some((e) => ACTIONS.has(e.kind) && e.ok)
  const done = task.log.filter((e) => e.ok).map((e) => `• ${e.text}`)
  const facts = task.notes.length
  if (result.state === 'done' && !acted && !facts && !moved) {
    const planned = (task.steps || []).map((x, i) => `${i + 1}. ${x}`).join('\n')
    return { ...result, state: 'needs_review', need: 'other',
      reason: L('브라우저에서 아무 동작도 하지 못하고 끝났어요. 같은 말로 다시 시키거나, 카드의 「직접 제어」로 화면을 확인해 주세요.', 'The task ended without doing anything in the browser. Ask again, or check the screen with "Take control" on the card.'),
      summary: L(`브라우저에서 아무 동작도 하지 못한 채 작업이 끝났어요. 계획한 단계는 하나도 진행되지 않았어요.${planned ? `\n\n계획했던 단계\n${planned}` : ''}\n\n다시 시키거나, 작업 카드에서 직접 제어로 확인해 주세요.`,
        `The task ended without any action in the browser. None of the planned steps was done.${planned ? `\n\nPlanned steps\n${planned}` : ''}\n\nAsk again, or check it yourself with Take control on the task card.`) }
  }
  if (result.state !== 'done' && result.state !== 'needs_review') return result
  const said = String(result.summary || '').trim()
  // the result comes first, always: the model's account, else the facts noted, else a plain sentence
  const head = said || (facts ? task.notes.join('\n') : L('작업을 마쳤지만 결과를 따로 알려 드릴 내용은 기록하지 못했어요. 마지막 화면과 아래 한 일을 확인해 주세요.', "I finished, but I didn't record a result to report. Check the last screen and what I did below."))
  const refused = task.log.filter((e) => e.kind === 'click' && e.refusedPurchase).map((e) => `• ${e.text}`)
  return { ...result, summary: [head, done.length ? `${L('실제로 한 일', 'What I actually did')}\n${done.slice(-12).join('\n')}` : '',
    refused.length ? `${L('요청하지 않은 구매라 누르지 않은 것', "Not pressed — a purchase you didn't ask for")}\n${refused.slice(-4).join('\n')}` : ''].filter(Boolean).join('\n\n') }
}

// ---- the page as the agent reads it, and when the person has to step in ----

const BLANK = (s) => ({ title: '', url: s.page.url(), text: '', els: [] })
const look = (s) => within(s.page.evaluate(SNAPSHOT_JS), EVAL_MS, BLANK(s)).then((x) => x || BLANK(s))
// the agent's view of any Playwright page (the live wall check, test/browser-walls.live.mjs)
export const snapshotOf = (page) => look({ page })
// the same address and the same things on screen
const pageKey = (snap) => crypto.createHash('sha1').update(`${snap.url}\n${snap.text}\n${(snap.els || []).map((e) => `${e.tag}:${e.text}:${e.filled ? 1 : 0}`).join('|')}`).digest('hex')
// tools whose effect shows on the page; when it does not, turn after turn, the task is stuck
const ACTING = new Set(['goto', 'click', 'type', 'scroll', 'fill_secret', 'attach_file'])
export const STUCK_TURNS = 5 // "4턴 넘게": the fifth action in a row that changes nothing hands over
const WALL_WAITS = 3
const BLOCKED = '__blocked__'
const CLEARED = '__cleared__'

// ---- browser skills: site know-how as modules (lib/browserSkills.js), names first, bodies on use ----

// The first thing the agent reads after its instructions: the skill this task was routed to (name and
// description, to be read with read_skill), else the list of skills it may read when one fits.
export function skillNote(sk) {
  if (sk) {
    return `Browser skill for this task: ${sk.name} — ${sk.description}\nBefore you act, read it with read_skill("${sk.name}") and follow it.`
  }
  const list = browserSkillCatalog()
  return list ? `Browser skills you can read with read_skill(name) when one fits this task (site know-how), then follow it:\n${list}` : ''
}
function readSkill(task, name) {
  const body = readBrowserSkill(String(name || '').trim())
  if (!body) return `error: no browser skill named "${name}". The skills are: ${browserSkills().map((x) => x.name).join(', ') || 'none'}`
  task.stats.skills_read.push(name)
  return body
}

// ---- walls: pages the agent cannot get past by itself, told apart by a judgment of the page ----

// What the page calls itself (og:site_name or application-name), else its title, else its address.
export function pageName(snap) {
  const name = String(snap?.site || snap?.title || '').replace(/\s+/g, ' ').trim() || hostOf(snap?.url || '')
  return name.length > 40 ? `${name.slice(0, 39)}…` : name
}
// the name of the site at host, as its page gave it when the task was last on it
const nameOn = (task, host) => (task.page?.host === host && task.page.name) || host

// What the judge reads: the task, and the page as a person would size it up, plus structural facts. The
// task matters: a site's front page with only sign-in buttons reads fine on its own, but its tools are not there.
export function wallState(snap, goal = '') {
  const buttons = (snap.els || []).filter((e) => ['a', 'button'].includes(e.tag) || /^(submit|button)$/.test(e.type || '')).map((e) => e.text).filter(Boolean)
  const text = String(snap.text || '').replace(/\n{2,}/g, '\n').slice(0, 800)
  return [`Page title: ${snap.title || '(none)'}`, `Task: ${String(goal || '(not given)').replace(/\s+/g, ' ').slice(0, 300)}`, `Site address: ${hostOf(snap.url)}`,
    `Has a password field: ${snap.fields?.password ? 'yes' : 'no'}`, `Has a sign-in field (e-mail or username): ${snap.fields?.signIn ? 'yes' : 'no'}`,
    `Buttons and links: ${[...new Set(buttons)].slice(0, 30).join(' | ') || '(none)'}`, `Visible text (start):\n${text || '(none)'}`].join('\n')
}
const WALL_QUESTION = 'A browser agent is doing the task above for a person and has reached this page. Can it go on with the task by itself, or does the person have to step in first?'
const WALL_OPTIONS = [
  { key: 'login_needed', label: 'The person has to sign in first: the page is a sign-in form, or it shows an introduction with sign-in buttons instead of the tools or content the task needs' },
  { key: 'refused', label: 'The site refuses this browser: it says it will not let this browser or app sign in or use the site, so signing in here cannot work' },
  { key: 'human_check', label: 'The site shows a check that the visitor is a human (a captcha or robot check) instead of the page' },
  { key: 'site_error', label: 'The site shows its own error page instead of the page (for example a bad or rejected request, or something went wrong) with nothing on it to sign in to or go on from' },
  { key: 'ok', label: 'The agent can go on: what the task needs is on this page or reachable from it without signing in (a sign-in button beside it does not count)' },
]
const WALL_NEED = { login_needed: 'login', refused: 'blocked', human_check: 'captcha' }
// (a task goes on past a site's error page as before: the agent can go back or try another way. Google
// connecting has no other way in this browser, so there it ends the wait like a refusal — runConnect)
export const CONNECT_NEED = { ...WALL_NEED, site_error: 'blocked' }
export const WALL_BAR = 0.7

// One judgment of the page → { need, site, name, key, p } when it is a wall the judge is sure of (0.7),
// else null (no answer, unsure, or the page is fine: the agent goes on as usual).
export async function judgeWall(snap, task = null, needs = WALL_NEED) {
  let u
  try { u = new URL(snap?.url || '') } catch { return null }
  if (!/^https?:$/.test(u.protocol)) return null
  const t0 = Date.now()
  let r = null
  const state = wallState(snap, task?.goal)
  try { r = await judge({ state: task ? hide(task, state) : state, question: WALL_QUESTION, options: WALL_OPTIONS }) } catch (e) { console.warn('[browser] wall check', e.message) }
  const [key, p] = Object.entries(r?.probabilities || {}).sort((a, b) => b[1] - a[1])[0] || ['', 0]
  const check = { host: hostOf(snap.url), key, p: Math.round(p * 100) / 100, ms: Date.now() - t0, via: r?.via || 'none' }
  if (task) task.stats.wall_checks.push(check)
  const need = p >= WALL_BAR ? needs[key] : null
  return need ? { need, site: hostOf(snap.url), name: pageName(snap), key, p: check.p } : null
}
// The wall on this page, judged when the address is new (or the person stepped in since); the same page
// is not judged again.
async function wallOn(task, snap) {
  if (task.judged && task.judged.url === snap.url) return task.judged.wall
  const wall = await judgeWall(snap, task, task.wallNeeds)
  task.judged = { url: snap.url, wall }
  return wall
}
// a screen to compare while waiting: the address and what is on it, without what is typed into fields
const screenKey = (snap) => crypto.createHash('sha1').update(`${snap.url}\n${snap.title}\n${snap.text}\n${(snap.els || []).filter((e) => !['input', 'textarea', 'select'].includes(e.tag)).map((e) => `${e.tag}:${e.text}`).join('|')}`).digest('hex')

// What the person reads on the card when the task stops at a wall, and what to do about it.
function wallReason(wall, again) {
  const name = wall.name || wall.site
  if (wall.need === 'login') {
    return again
      ? L(`아직 ${name} 로그인이 끝나지 않았어요. 카드의 「직접 로그인」을 눌러 로그인을 마치면 이어서 진행해요.`, `The sign-in to ${name} is not done yet. Press "Sign in yourself" on the card and finish signing in — I'll go on from there.`)
      : L(`이 브라우저에서 ${name}에 한 번 로그인해야 이어서 할 수 있어요. 카드의 「직접 로그인」을 눌러 로그인하면 이어서 진행해요. 로그인은 다음에도 남아요.`,
        `To use ${name}, this browser needs a one-time sign-in. Press "Sign in yourself" on the card and sign in — I'll go on from there. The sign-in stays for next time.`)
  }
  return L(`${name}에서 사람인지 확인하는 화면이 나왔어요. 카드의 「직접 제어」로 확인을 마치면 이어서 진행해요.`,
    `${name} is asking to check you're human. Finish it with "Take control" on the card — I'll go on from there.`)
}

// The site refused this browser: no waiting helps, so the task ends saying so and what else works.
function blockedEnd(task, wall) {
  const name = wall.name || wall.site
  const reason = L(`${name} 쪽에서 이 서버 브라우저의 로그인을 받아 주지 않아요. 그래서 이 브라우저로는 ${name} 작업을 할 수 없어요. 그 사이트에서 직접 만든 결과 파일을 이 방에 올려 주면 이어서 할게요.`,
    `${name} won't accept a sign-in from this server's browser, so it can't be used from here. Do it on ${name} yourself and put the result files in this room — I'll take it from there.`)
  task.notes.push(reason)
  return { state: 'failed', need: 'blocked', reason, summary: reason, site: wall.site, siteName: name }
}

// A wall on the page: the person is asked (a card that says what to do) and the task waits, without
// spending a model turn. Signing in is noticed by itself: when the screen changes and settles, the page is
// judged once more (never on a timer), and the wait ends when the wall is gone. Giving control back
// ends it too, and the next turn judges the page again.
// → { waited } after the wait, { end } to stop the task, { hint } for a task nobody watches, or null (the model goes on).
async function atWall(s, task, wall, snap) {
  if (wall.need === 'blocked') return { end: blockedEnd(task, wall) }
  const site = normSite(wall.site)
  const key = `${wall.need}:${site}`
  if (task.unattended) {
    if (task.walls[key]) return null
    task.walls[key] = 1
    task.stats.hints++
    task.notes.push(wall.need === 'captcha' ? L(`${site}: 로봇 확인 화면이 나와 진행하지 못함`, `${site}: stopped at a bot check`) : L(`${site}: 로그인이 필요해 진행하지 못함`, `${site}: needs a sign-in`))
    return { hint: `\n[page check: this page is a ${wall.need === 'captcha' ? 'bot check' : 'sign-in wall'} and nobody is available to get past it. Do not try; use the alternative source in the goal, or finish with what you have]` }
  }
  // a site whose login the vault keeps is the model's: it fills the saved one — also when the site signs
  // people in elsewhere and the vault keeps that one (its browser skill says where: NotebookLM → Google). A task
  // that asks the vault first (Google connect) lets the model ask for the login on the card when none is saved
  const saved = async (host) => !!host && (await candidates(task.userId, 'login', host).catch(() => [])).length > 0
  if (wall.need === 'login' && (task.vaultFirst || await saved(site) || await saved(normSite(task.signIn || '')))) return null
  const n = task.walls[key] = (task.walls[key] || 0) + 1
  const name = wall.name || site
  if (n > WALL_WAITS) {
    const reason = wall.need === 'captcha'
      ? L(`${name}의 로봇 확인이 풀리지 않아 멈췄어요. 카드의 「직접 제어」로 확인을 마친 뒤 다시 시켜 주세요.`, `The bot check on ${name} wasn't passed, so I stopped. Finish it with "Take control" on the card, then ask again.`)
      : L(`${name} 로그인이 끝나지 않아 멈췄어요. 카드의 「직접 로그인」으로 로그인한 뒤 다시 시켜 주세요.`, `The sign-in to ${name} wasn't finished, so I stopped. Sign in with "Sign in yourself" on the card, then ask again.`)
    return { end: { state: 'failed', need: wall.need, reason, summary: reason, site: wall.site, siteName: name } }
  }
  task.stats.walls++
  let seen = screenKey(snap), moved = null, verdict
  const answer = await waitForUser(s, task, {
    need: wall.need, reason: wallReason(wall, n > 1), site, siteName: name,
    // the screen changed (an address, what is on it) and then stayed so for one look: judged once more
    watch: async (snap) => {
      const k = screenKey(snap)
      if (k === seen) { moved = null; return null }
      if (k !== moved) { moved = k; return null }
      seen = k
      moved = null
      verdict = await judgeWall(snap, task)
      if (!task.waiting) return null // given back meanwhile: the next turn judges it
      task.judged = { url: snap.url, wall: verdict }
      if (verdict?.need === 'blocked') return BLOCKED
      return verdict?.need === wall.need ? null : CLEARED
    },
  })
  // the refusal came while signing in for this site: the card still names the site the task is for
  if (answer === BLOCKED) return { end: blockedEnd(task, { ...verdict, name }) }
  // given back by the person (not seen by the watch): the next turn judges the page again
  if (answer !== CLEARED) task.judged = null
  return { waited: true }
}

// Several actions on the same screen and nothing changed: the person takes a look before more turns go by.
async function whenStuck(s, task, snap) {
  task.stats.stuck++
  const site = hostOf(snap.url)
  const last = task.log.filter((e) => ACTING.has(e.kind)).at(-1)?.text
  const reason = L(`${site}의 같은 화면에서 ${task.stale}번 해 봤지만 화면이 바뀌지 않아 멈췄어요${last ? `(마지막: ${last})` : ''}. 카드의 「직접 제어」로 다음 화면까지 넘긴 뒤 「제어 돌려주기」를 누르면 이어서 해요. 필요 없으면 작업을 취소해 주세요.`,
    `I tried ${task.stale} times on the same ${site} screen and nothing changed${last ? ` (last: ${last})` : ''}, so I stopped. Get it to the next screen with "Take control" on the card and press "Give control back" — I'll go on. Cancel the task if it's not needed.`)
  task.stale = 0
  task.prev = null
  if (task.unattended || ++task.stuckWaits > 2) return { end: { state: 'failed', need: 'stuck', reason, summary: reason } }
  await waitForUser(s, task, { need: 'stuck', reason, site })
  return {}
}

// An error that ended the task, in words the person can act on.
function failReason(e) {
  const m = String(e?.message || '')
  if (/^LLM |aborted|timed? ?out/i.test(m)) return L('AI 모델이 제때 답하지 않아 브라우저 작업을 멈췄어요. 잠시 후 같은 말로 다시 시켜 주세요.', "The AI model didn't answer in time, so I stopped the browser task. Ask again in a moment.")
  if (/has been closed|Target closed|browser has disconnected/i.test(m)) return L('브라우저가 닫혀 작업을 멈췄어요. 같은 말로 다시 시키면 브라우저를 새로 열어 시작해요.', 'The browser closed, so I stopped. Ask again and I\'ll start in a fresh browser.')
  return L(`브라우저 작업 중 오류가 나서 멈췄어요(${m.replace(/\s+/g, ' ').slice(0, 80)}). 잠시 후 같은 말로 다시 시켜 주세요. 계속 안 되면 카드의 「직접 제어」로 마지막 화면을 확인해 주세요.`,
    `The browser task stopped on an error (${m.replace(/\s+/g, ' ').slice(0, 80)}). Ask again in a moment; if it keeps failing, check the last screen with "Take control" on the card.`)
}

async function waitForPage(s, task, a) {
  const until = String(a.until_text || '').trim(), gone = String(a.gone_text || '').trim()
  const left = WAIT.taskMaxMinutes - (task.waitedMinutes || 0)
  if (left <= 0) return `error: this task has already waited ${WAIT.taskMaxMinutes} minutes; tell the person where it stands and finish`
  const minutes = Math.min(Math.max(Number(a.minutes) || 5, 0), WAIT.maxMinutes, left)
  const t0 = Date.now()
  const passed = () => (Date.now() - t0) / 60000
  try {
    for (;;) {
      if (task.cancelled) return 'cancelled'
      if (task.over?.()) return 'done: this task is over'
      const text = await s.page.locator('body').innerText({ timeout: 5000 }).catch(() => '')
      if (until && text.includes(until)) return `done: "${until}" is on the page now`
      if (gone && !text.includes(gone)) return `done: "${gone}" is no longer on the page`
      if (passed() >= minutes) return `still waiting after ${minutes} minutes: it has not finished. Wait again, or tell the person where it stands`
      say(task, L(`기다리는 중 · ${Math.floor(passed())}분째`, `Waiting · ${Math.floor(passed())} min`))
      await pushFrame(task.userId, s)
      await s.page.waitForTimeout(Math.min(WAIT.everyMs, Math.max(50, (minutes - passed()) * 60000)))
    }
  } finally { task.waitedMinutes = (task.waitedMinutes || 0) + passed() }
}

// The element an action is about, as the person would name it: a button by its text, a field by its
// label or placeholder (never its value), a secret field only by its kind. `what` is for the purchase gate.
const DESCRIBE_JS = (e) => {
  const tag = e.tagName.toLowerCase()
  const field = tag === 'input' || tag === 'textarea' || tag === 'select' || e.isContentEditable
  const auto = e.autocomplete || ''
  const id = `${e.name || ''} ${e.id || ''}`
  const secret = e.type === 'password' ? 'password' : /^cc-number/.test(auto) || /card.?(no|num)|cardnumber/i.test(id) ? 'card'
    : /^cc-csc/.test(auto) || /cvc|cvv|csc/i.test(id) ? 'cvc' : /^cc-exp/.test(auto) ? 'exp' : /one-time-code/.test(auto) || /otp/i.test(id) ? 'otp'
      : e.hasAttribute('data-pro-secret') || /^cc-/.test(auto) ? 'secret' : ''
  const label = e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.placeholder || e.getAttribute('title') || ''
  const button = tag === 'input' && /^(submit|button|reset)$/.test(e.type) ? e.value : ''
  const name = (field && !button ? label || e.name || '' : e.innerText || label || button || e.getAttribute('alt') || '').replace(/\s+/g, ' ').trim()
  const what = field && !button ? '' : [e.innerText, e.value, e.getAttribute('aria-label'), e.getAttribute('title')].filter(Boolean).join(' ').trim().slice(0, 80)
  return { name: name.length > 30 ? `${name.slice(0, 29)}…` : name, field: !!field && !button, secret, what }
}
const SECRET_KIND = { password: ['비밀번호 칸', 'the password field'], card: ['카드 번호 칸', 'the card number field'], cvc: ['CVC 칸', 'the CVC field'], exp: ['카드 만료일 칸', 'the card expiry field'], otp: ['인증 코드 칸', 'the code field'], secret: ['비밀 칸', 'a secret field'] }
// The live line while acting: 「새 노트북」 누르는 중 · 「검색」 칸에 입력 중 · 비밀번호 칸에 입력 중
export function actionLine(kind, target = {}, host = '') {
  const n = String(target.name || '').trim()
  if (kind === 'click') return n ? L(`「${n}」 누르는 중`, `Clicking "${n}"`) : L(`${host}에서 누르는 중`, `Clicking on ${host}`)
  const sk = SECRET_KIND[target.secret]
  if (sk) return L(`${sk[0]}에 입력 중`, `Typing in ${sk[1]}`)
  return n ? L(`「${n}」 칸에 입력 중`, `Typing in "${n}"`) : L(`${host}에서 입력 중`, `Typing on ${host}`)
}

// Where the agent is about to press or type, in page pixels of the live view (1280×800), so the card
// can draw a circle there. The element is scrolled into view first, as the click itself would.
async function point(s, task, locator, kind) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 })
    const b = await locator.boundingBox({ timeout: 2000 })
    if (!b) return
    const { width: w, height: h } = s.page.viewportSize() || VIEW
    emit(task.userId, 'browser.click', { taskId: task.id, x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), w, h, kind })
  } catch { /* the action itself reports what is wrong */ }
}

// After a press: a short pause for the page to react, and the new page's load when it navigated.
async function settle(page) {
  await page.waitForTimeout(WAIT.settleMs)
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {})
}

async function act(s, task, name, a) {
  const out = await doAct(s, task, name, a)
  logAction(task, name, a, out)
  if (STEP_TOOLS.has(name) && Number(a.done) > 0 && !/^(error|refused|not pressed)/.test(String(out))) await markStep(task, Number(a.done))
  return out
}

// The plan on the card: steps up to n are done.
async function markStep(task, n, note) {
  if (!task.steps[n - 1]) return
  await updateMessage(task.userId, task.id, { steps: task.steps.map((t, i) => ({ text: t, done: i < n, note: i === n - 1 ? note : undefined })) })
}

async function doAct(s, task, name, a) {
  const el = (i) => s.page.locator(`[data-pro-idx="${i}"]`).first()
  const host = (() => { try { return new URL(name === 'goto' ? a.url : s.page.url()).hostname.replace(/^www\./, '') } catch { return '' } })()
  const live = (isEn() ? { goto: `Opening ${host}`, click: `Clicking on ${host}`, type: `Typing on ${host}`, fill_secret: `Typing on ${host}`, scroll: 'Looking at the page', note: 'Taking notes', step_done: 'On to the next step', read_skill: `Reading the ${a.name || ''} skill` }
    : { goto: `${host} 여는 중`, click: `${host}에서 누르는 중`, type: `${host}에서 입력 중`, fill_secret: `${host}에서 입력 중`, scroll: '페이지 보는 중', note: '메모하는 중', step_done: '다음 단계로', read_skill: `${a.name || ''} 스킬 읽는 중` })[name]
  // what is being pressed or typed into, by its name on the page (never the value in it)
  task.target = ['click', 'type', 'fill_secret'].includes(name) ? { i: a.i, ...await within(el(a.i).evaluate(DESCRIBE_JS, undefined, { timeout: 3000 }), 4000, {}) } : null
  const line = task.target ? actionLine(name === 'click' ? 'click' : 'type', task.target, host) : live
  if (line) say(task, line)
  switch (name) {
    case 'goto': await s.page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 }); return 'ok'
    case 'click': {
      // the purchase gate: a control that orders or pays is pressed only when the goal asks to buy, and
      // one that commits money only after the person approved (the approve card) — whatever the model says
      // (the description timed out: read it again before pressing — an unread control must not slip past the gate)
      if (!('what' in task.target)) {
        const again = await el(a.i).evaluate(DESCRIBE_JS, undefined, { timeout: 8000 }).catch(() => null)
        if (!again) return 'error: could not read what this control is; look at the page again before pressing it'
        task.target = { i: a.i, ...again }
      }
      const what = task.target.what || ''
      if (isPurchaseControl(what)) {
        if (!asksToBuy(task.goal)) return `${REFUSED_PURCHASE} '${what}' starts a purchase or order, and the goal does not ask to buy anything. Do not press it; do what the goal asks and finish.`
        if (isPaymentControl(what) && !task.approved) {
          const ok = await act(s, task, 'approve', { summary: L(`'${what}'을(를) 눌러 결제·주문을 진행할까요?`, `Press '${what}' to go ahead with the payment or order?`) })
          if (!/approved: do it now/.test(String(ok))) return `not pressed: ${ok}`
        }
      }
      await point(s, task, el(a.i), 'click')
      await el(a.i).click({ timeout: 8000 })
      await settle(s.page)
      return 'ok'
    }
    case 'type': {
      // the model never types into a secret field, even text it found on the page
      if (task.target.secret || await el(a.i).evaluate((e, sel) => e.matches(sel) || /card.?(no|num)|cardnumber|cvc|cvv|csc|otp/i.test(`${e.name} ${e.id}`), SECRET_SELECTOR, { timeout: 3000 })) {
        return 'refused: this is a secret field; use fill_secret (saved login/card) or need_secret (one-time code)'
      }
      await point(s, task, el(a.i), 'type')
      await el(a.i).fill(a.text, { timeout: 8000 }); if (a.enter) { await el(a.i).press('Enter', { timeout: 8000 }); await settle(s.page) }
      return 'ok'
    }
    case 'scroll': await s.page.mouse.wheel(0, a.dy || 600); return 'ok'
    case 'wait_for_page': return waitForPage(s, task, a)
    case 'tell_user': await addMessage(task.userId, task.threadId, 'agent', 'text', { text: String(a.text || '').slice(0, 600) }); return 'told'
    case 'attach_file': {
      const list = task.files || []
      const f = list.find((x) => x.name === a.name) || (!a.name && list.length === 1 ? list[0] : null)
      if (!f) return list.length ? `error: no attached file is named '${a.name || ''}' — the files are: ${list.map((x) => x.name).join(', ')}` : 'error: no file was attached to this task'
      const { file, done } = await localCopy(f)
      try {
        await point(s, task, el(a.i), 'click')
        if (await el(a.i).evaluate((e) => e.tagName === 'INPUT' && e.type === 'file', undefined, { timeout: 3000 })) { await el(a.i).setInputFiles(file); return `attached ${f.name}` }
        const [chooser] = await Promise.all([s.page.waitForEvent('filechooser', { timeout: 8000 }), el(a.i).click({ timeout: 8000 })])
        await chooser.setFiles(file)
        return `attached ${f.name}`
      } finally { await done() }
    }
    case 'fill_secret': {
      const site = normSite(new URL(s.page.url()).hostname)
      const kind = String(a.field).startsWith('card') ? 'card' : 'login'
      const item = await pickItem(s, task, kind, site)
      if (!item) return kind === 'card' ? 'no card saved: the user did not add one' : `no credential saved for ${site}`
      const sec = await useItem(task.userId, item.id, { taskId: task.id, field: a.field })
      const val = { username: sec.username || sec.email, password: sec.password, card_number: sec.number, card_exp: sec.exp,
        card_cvv: sec.cvv, card_name: sec.name }[a.field]
      if (!val) return `the saved ${kind} has no ${a.field}`
      await point(s, task, el(a.i), 'type')
      await fillSecret(el(a.i), val, task)
      if (kind === 'login') task.used[site] = item.id
      return 'filled ' + a.field
    }
    case 'login_failed': {
      const site = normSite(host)
      const id = task.used[site] || task.picked[site]
      if (!id) return 'no saved login was filled on this site; use fill_secret first'
      await setStatus(task.userId, id, 'rejected', { taskId: task.id, detail: { reason: a.reason || '' } })
      if (task.unattended) {
        task.notes.push(L(`${site}: 저장된 로그인이 거부됨`, `${site}: the saved login was rejected`))
        return 'the saved login was rejected and nobody can fix it now; do not retry, use the alternative in the goal or finish'
      }
      const [row] = (await candidates(task.userId, 'login', site)).filter((r) => r.id === id)
      await waitForUser(s, task, {
        need: 'login', site,
        reason: L(`${site}에서 저장된 비밀번호를 받아들이지 않았어요. 카드에서 비밀번호를 고쳐 저장하면 다시 로그인해 이어서 해요.`, `${site} didn't accept the saved password. Fix it on the card and save — I'll sign in again and go on.`),
        message: ['vault', { kind: 'login', site, mode: 'update', itemId: id, label: row?.label || '', reason: a.reason || '' }],
      })
      const [now] = (await candidates(task.userId, 'login', site)).filter((r) => r.id === id)
      return now && now.status !== 'rejected'
        ? 'the user saved a corrected password; fill the login form again with fill_secret and submit'
        : 'the user did not update the password; stop trying to log in'
    }
    case 'need_secret': {
      const site = normSite(host)
      const label = a.label || L('인증 코드', 'verification code')
      // a code the site e-mailed: the person's own mailbox is watched while the card asks them (lib/mailCode.js);
      // whichever comes first — the mail or the person — goes into the field
      const watch = await mailCode.enabledFor(task.userId).catch(() => false)
      const names = watch ? mailCode.namesOf(await s.page.title().catch(() => '')) : []
      if (task.unattended) {
        const found = watch && await mailCode.watchForCode(task.userId, { site: host, names, since: task.drivingSince, timeoutMs: 120000 })
        if (found) {
          task.secretSlot = { i: a.i, label }
          await fillFromMail(s, task, found, null)
          task.secretSlot = null
          return `the ${label} from the user's e-mail (${found.from}) was entered into the field (you cannot see it); submit the form and continue`
        }
        task.notes.push(L(`${site}: 일회용 값(${label})이 필요해 진행하지 못함`, `${site}: couldn't continue, a one-time value (${label}) is needed`))
        return 'nobody is available to provide a one-time code; do not continue this login, record it in a note'
      }
      const ctl = new AbortController()
      task.secretSlot = { i: a.i, label, stopWatch: () => ctl.abort() }
      if (watch) {
        mailCode.watchForCode(task.userId, { site: host, names, since: task.drivingSince, signal: ctl.signal })
          .then((found) => found && task.secretSlot && task.waiting && fillFromMail(s, task, found, task.waiting))
          .catch((e) => console.warn('[mail-code]', e.message))
      }
      const answer = await waitForUser(s, task, {
        need: 'login', site,
        reason: L(`${site} 로그인에 ${label}가 필요해요. 받은 값을 카드에 넣으면 이어서 해요.`, `${site} needs the ${label} to sign in. Enter it on the card and I'll go on.`),
        message: ['vault', { kind: 'secret', site, mode: 'request', label, ...(watch ? { mailWatch: true, mailName: names[0] || null } : {}) }],
      })
      ctl.abort()
      task.secretSlot = null
      return answer
    }
    case 'approve': {
      const site = normSite(host)
      if (task.unattended) {
        task.notes.push(L(`${site}: 승인이 필요해 하지 않음 (${a.summary || ''})`, `${site}: not done, it needs approval (${a.summary || ''})`))
        return 'nobody is available to approve this; do not do it, record it in a note and continue'
      }
      const card = task.picked.wallet && (await candidates(task.userId, 'card', 'wallet')).find((r) => r.id === task.picked.wallet)
      const answer = await waitForUser(s, task, {
        need: 'approve', site,
        reason: `${a.summary || L('이 단계는 승인이 필요해요.', 'This step needs your approval.')} ${L('카드에서 「승인」을 누르면 진행하고, 「취소」를 누르면 하지 않아요.', 'Press "Approve" on the card to go ahead, or "Cancel" to skip it.')}`,
        message: ['choice', { site, approval: true, question: `${a.summary || ''}${card ? L(`\n결제 카드: ${card.label}`, `\nPayment card: ${card.label}`) : ''}`.trim(), options: L(['승인', '취소'], ['Approve', 'Cancel']) }],
      })
      const yes = /chose: (승인|Approve)\./.test(String(answer))
      if (yes) task.approved = true
      return yes ? 'the user approved: do it now' : 'the user declined: do not do it; finish and say it was not done'
    }
    case 'step_done': await markStep(task, a.step, a.note); return 'ok'
    case 'need_login':
    case 'need_user': {
      const site = a.site || new URL(s.page.url()).hostname
      // A process step runs with nobody watching: waiting for a login or an approval would hold
      // the step (and the one-at-a-time worker) forever, so the agent is told to go around it.
      if (task.unattended) {
        task.notes.push(`${site}: ${name === 'need_login' ? L('로그인 정보가 없어 건너뜀', 'skipped, no login saved') : L(`사람 확인이 필요해 하지 않음 (${a.reason || ''})`, `not done, a person needs to check (${a.reason || ''})`)}`)
        return name === 'need_login'
          ? `no saved login for ${site} and nobody is available to sign in; do not log in, use the alternative source in the goal instead`
          : 'nobody is available to approve this; do not do it, record it in a note and continue'
      }
      if (name === 'need_login' && task.declined.has(normSite(site))) return 'the user declined to give a login for this site; do not ask again'
      const choice = name === 'need_user' && Array.isArray(a.options) && a.options.length > 1
      const message = name === 'need_login'
        ? ['vault', { kind: 'login', site: normSite(site), mode: 'request' }]
        // a pick-one question is answered in place (hark's account chooser) rather than by takeover
        : choice ? ['choice', { site, question: a.reason || '', options: a.options.slice(0, 6) }] : null
      const need = name === 'need_login' ? 'login' : choice ? 'choice' : needOf(a.need, task)
      return waitForUser(s, task, { need, reason: askReason(need, a.reason, normSite(site), name === 'need_login'), site, message })
    }
    case 'note': task.notes.push(a.text); return 'noted'
    case 'read_skill': return readSkill(task, a.name)
    case 'finish': return '__finish__'
  }
  return 'unknown tool'
}

// A file the person attached, as a path on this machine for the page's file input: the workspace copy
// where this server has the workspace (local, Docker bundle), else the person's storage copy fetched into
// a temporary folder (production: the agent's pods and this server share no disk).
// a file the page names by path is used only when it is under the workspace's uploads (lib/attachments.js) and
// resolves inside it — anything else (a server file, "../") goes by its stored copy or not at all
const ownUploadPath = (p) => typeof p === 'string' && p.startsWith('/workspace/uploads/') && !p.split('/').includes('..')
async function localCopy(f) {
  const root = ownUploadPath(f.path) && await workspaceHostPath('/workspace').catch(() => null)
  const there = root && await workspaceHostPath(f.path).catch(() => null)
  if (there && path.resolve(there).startsWith(path.resolve(root) + path.sep)) return { file: there, done: async () => {} }
  let buf
  const pub = `${config.supabaseUrl}/storage/v1/object/public/files/`
  const key = f.key || (String(f.url || '').startsWith(pub) ? decodeURIComponent(f.url.slice(pub.length)) : '')
  if (!key) throw new Error('the attached file has no stored copy to give the page')
  const { data, error } = await admin.storage.from('files').download(key)
  if (error) throw new Error(`could not read the attached file (${error.message})`)
  buf = Buffer.from(await data.arrayBuffer())
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pro-attach-'))
  const file = path.join(dir, path.basename(String(f.name || 'file')) || 'file')
  await fs.promises.writeFile(file, buf)
  return { file, done: () => fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}) }
}

// Fill a vault value into the page: the element remembers it (so the page guard does not
// "capture" it back) and is masked on screen.
async function fillSecret(locator, value, task) {
  remember(task, String(value))
  await locator.fill(String(value))
  await locator.evaluate((e, v) => { e.__proFilled = v; e.setAttribute('data-pro-secret', '') }, String(value))
}

// Values filled during the task are blanked out of anything the model reads, should the page echo
// one back (a confirmation page printing the card number, a field value in an error message).
// Short values (CVC, expiry) are left alone: they would also erase ordinary numbers on the page.
function remember(task, v) {
  if (!task || v.length < 6) return
  task.secrets.add(v)
  if (/^\d{12,19}$/.test(v)) task.secrets.add(v.replace(/(\d{4})(?=\d)/g, '$1 '))
}
function hide(task, text) {
  let out = text
  for (const v of task.secrets) out = out.split(v).join('[vault]')
  return out
}

// Puts the task in "needs input", optionally posts a card (vault request, choice), and waits for
// the user's answer (saved credential, choice, takeover done, cancel).
// What the model's own request to the person is about, and the sentence the card shows: its words,
// then what pressing what does.
// The model says which (need_user's need); else what this page was judged to be.
const ASKS = new Set(['login', 'captcha'])
const needOf = (said, task) => ASKS.has(said) ? said
  : task.judged && task.judged.url === task.lastSnap?.url && ASKS.has(task.judged.wall?.need) ? task.judged.wall.need : 'other'
function askReason(need, why, site, vault = false) {
  const said = String(why || '').trim()
  const head = said ? (/[.!?。요]$/.test(said) ? said : `${said}.`) : {
    login: L(`${site}에 로그인해야 이어서 할 수 있어요.`, `${site} needs you to sign in.`),
    captcha: L(`${site}에서 로봇 확인 화면이 나왔어요.`, `${site} is showing a bot check.`),
    choice: L('골라 주셔야 할 것이 있어요.', 'There is something to choose.'),
  }[need] || L(`${site}에서 사람의 손이 필요해요.`, `${site} needs a person's hand.`)
  const next = vault ? L('카드에서 로그인 정보를 저장하거나, 「직접 로그인」을 눌러 직접 로그인하면 이어서 진행해요.', 'Save the login on the card, or press "Sign in yourself" and sign in — I\'ll go on from there.') : {
    login: L('카드의 「직접 로그인」을 눌러 로그인하면 이어서 진행해요.', 'Press "Sign in yourself" on the card and sign in — I\'ll go on from there.'),
    captcha: L('카드의 「직접 제어」로 확인을 마치면 이어서 진행해요.', 'Finish it with "Take control" on the card — I\'ll go on from there.'),
    choice: L('카드에서 하나를 고르면 이어서 해요.', 'Pick one on the card and I\'ll go on.'),
  }[need] || L('카드의 「직접 제어」로 처리한 뒤 「제어 돌려주기」를 누르면 이어서 해요.', 'Do it with "Take control" on the card, then press "Give control back" — I\'ll go on.')
  return `${head} ${next}`
}

// need (what kind of help: login | blocked | captcha | choice | approve | stuck | other) and reason (what
// stopped it and what to do) go on the task card, which draws its pill and button from them.
// watch(snapshot) → a text ends the wait by itself (a sign-in finished in takeover), looked at every few seconds.
// siteName: what the person calls the site, for the card's pill (the page's own name; the host when unknown).
async function waitForUser(s, task, { reason, site, siteName, message, need = 'other', watch }) {
  // listening before anything is posted: an answer that comes at once (the card answered the moment
  // it shows) is not lost
  let answered
  const answer$ = new Promise((resolve) => { answered = resolve })
  task.waiting = answered
  // the card goes up first, so whoever sees "needs input" also finds what to answer
  const posted = message ? await addMessage(task.userId, task.threadId, 'agent', message[0], { ...message[1], taskId: task.id, state: 'pending' }) : null
  await updateMessage(task.userId, task.id, { state: 'needs_input', need, reason: reason || '', site, siteName: siteName || nameOn(task, normSite(site)) })
  say(task, null)
  await setThreadStatus(task.userId, task.threadId, 'needs_input')
  await pushFrame(task.userId, s)
  let checking = false
  const timer = watch && setInterval(async () => {
    if (checking || !task.waiting) return
    checking = true
    try { const v = await watch(await look(s)); if (v) task.waiting?.(v) } catch { /* the next look */ } finally { checking = false }
  }, WAIT.watchMs)
  const answer = await answer$
  task.waiting = null
  if (timer) clearInterval(timer)
  // a card the user never answered (cancel, takeover) should not stay actionable
  if (posted) await q(`update pro_messages set content = content || '{"state":"expired"}'::jsonb where id=$1 and content->>'state'='pending'`, [posted.id])
  await updateMessage(task.userId, task.id, { state: 'running', need: null, reason: '' })
  await setThreadStatus(task.userId, task.threadId, 'working')
  return answer
}

// Which saved login/card to use: asks the user to add one if there is none, and which one if
// there are several (remembered for the rest of the task).
async function pickItem(s, task, kind, site) {
  const key = kind === 'card' ? 'wallet' : site
  if (task.picked[key]) return { id: task.picked[key] }
  if (task.declined.has(key)) return null // the user closed this request once: never ask again in this task
  let list = await candidates(task.userId, kind, site)
  if (!list.length) {
    if (task.unattended) { task.notes.push(L(`${site}: 저장된 ${kind === 'card' ? '카드' : '로그인'}가 없어 건너뜀`, `${site}: skipped, no saved ${kind === 'card' ? 'card' : 'login'}`)); return null }
    await waitForUser(s, task, {
      need: kind === 'card' ? 'other' : 'login', site,
      reason: kind === 'card' ? L('결제에 쓸 카드가 필요해요. 카드에서 결제 카드를 저장하면 이어서 해요.', 'A card to pay with is needed. Save one on the card and I\'ll go on.')
        : L(`${site}에 로그인해야 이어서 할 수 있어요. 카드에서 로그인 정보를 저장하거나, 「직접 로그인」을 눌러 직접 로그인하면 이어서 진행해요.`, `${site} needs you to sign in. Save the login on the card, or press "Sign in yourself" and sign in — I'll go on from there.`),
      message: ['vault', { kind, site, mode: 'request' }],
    })
    list = await candidates(task.userId, kind, site)
    if (!list.length) { task.declined.add(key); return null }
  }
  let chosen = list[0]
  if (list.length > 1 && !task.unattended) {
    const answer = await waitForUser(s, task, {
      need: 'choice', site,
      reason: kind === 'card' ? L('저장된 카드가 여러 장이에요. 카드에서 쓸 카드를 고르면 이어서 해요.', 'There are several saved cards. Pick one on the card and I\'ll go on.') : L(`${site}에 저장된 계정이 여러 개예요. 카드에서 쓸 계정을 고르면 이어서 해요.`, `There are several saved accounts for ${site}. Pick one on the card and I'll go on.`),
      message: ['choice', {
        site, vault: true,
        question: kind === 'card' ? L('저장된 카드가 여러 장이에요. 어떤 카드로 결제할까요?', 'There are several saved cards. Which card should I pay with?') : L(`${site}에 저장된 계정이 여러 개예요. 어떤 계정으로 로그인할까요?`, `There are several saved accounts for ${site}. Which one should I log in with?`),
        options: list.slice(0, 6).map((r) => r.label),
      }],
    })
    chosen = list.find((r) => String(answer).includes(`chose: ${r.label}.`)) || list[0]
  }
  // a login the site turned down last time is not tried again as it is (a wrong password, again and again,
  // gets an account locked): the person fixes it on the card first
  if (kind === 'login' && chosen.status === 'rejected') {
    if (task.unattended) { task.notes.push(L(`${site}: 저장된 로그인이 지난번에 거부돼 쓰지 않음`, `${site}: the saved login was rejected last time, not used`)); return null }
    await waitForUser(s, task, {
      need: 'login', site,
      reason: L(`${site}에서 지난번에 저장된 비밀번호를 받아들이지 않았어요. 카드에서 비밀번호를 고쳐 저장하면 그 비밀번호로 로그인해 이어서 해요.`, `${site} didn't accept the saved password last time. Fix it on the card and save — I'll sign in with it and go on.`),
      message: ['vault', { kind: 'login', site, mode: 'update', itemId: chosen.id, label: chosen.label || '', reason: '' }],
    })
    const [now] = (await candidates(task.userId, kind, site)).filter((r) => r.id === chosen.id)
    if (!now || now.status === 'rejected') { task.declined.add(key); return null }
  }
  task.picked[key] = chosen.id
  return chosen
}

// The code a site e-mailed, found in the person's own mailbox (lib/mailCode.js): straight into the waiting field, kept
// nowhere; the card says where it came from (never the code) and the agent goes on as if the person had typed it.
// resolve: the waiting task's (an unattended task has none and is told by its caller).
async function fillFromMail(s, t, found, resolve) {
  const slot = t.secretSlot
  if (!slot || slot.done) return false
  slot.done = true
  await fillSecret(s.page.locator(`[data-pro-idx="${slot.i}"]`).first(), found.code, t)
  await audit(t.userId, 'one_time', { kind: 'secret', site: normSite(s.page.url().split('/')[2]), actor: 'mail', taskId: t.id, detail: { label: slot.label, from: found.from } })
  const [card] = await q(`select id from pro_messages where thread_id=$1 and kind='vault' and content->>'taskId'=$2 and content->>'kind'='secret'
    and content->>'state'='pending' order by created_at desc limit 1`, [t.threadId, t.id])
  if (card) await updateMessage(t.userId, card.id, { state: 'mail', mailFrom: found.from })
  resolve?.(`the ${slot.label} from the user's e-mail (${found.from}) was entered into the field (you cannot see it); submit the form and continue`)
  return true
}

// The user typed a one-time code into the vault card: it goes straight into the waiting field
// and is never stored or shown to the model.
export async function provideSecret(userId, value) {
  const s = sessions.get(userId)
  const t = s?.task
  if (!t?.secretSlot || !t.waiting) return false
  const slot = t.secretSlot
  // the mail got there first
  if (slot.done) return false
  slot.done = true
  slot.stopWatch?.()
  await fillSecret(s.page.locator(`[data-pro-idx="${slot.i}"]`).first(), value, t)
  await audit(userId, 'one_time', { kind: 'secret', site: normSite(s.page.url().split('/')[2]), actor: 'user', taskId: t.id, detail: { label: slot.label } })
  t.waiting(`the user entered the ${slot.label} into the field (you cannot see it); submit the form and continue`)
  return true
}

// The live line under the task card: what the agent is doing right now ("example.com에서 클릭 중").
function say(task, text) {
  if (task?.threadId) emit(task.userId, 'status', { threadId: task.threadId, text })
}

// Called when the user saved a credential, approved, or finished taking over.
export function resume(userId, text = 'user resolved it, continue') {
  sessions.get(userId)?.task?.waiting?.(text)
}
// 작업 취소: the task holding the browser, or (by its card id) one waiting in line
export function cancel(userId, taskId) {
  const s = sessions.get(userId)
  if (taskId && s?.planning.has(taskId)) { // its card is up, the plan is not back yet
    s.planning.set(taskId, true)
    updateMessage(userId, taskId, { state: 'cancelled', reason: '', summary: L('시작하기 전에 취소했어요.', 'Canceled before it started.') }).catch(() => {})
    return true
  }
  const inLine = taskId && s?.queue.find((x) => x.task.id === taskId)
  if (inLine) { s.queue.splice(s.queue.indexOf(inLine), 1); inLine.task.cancelled = true; inLine.go(); return true }
  const t = s?.task
  if (t && (!taskId || t.id === taskId)) { t.cancelled = true; t.waiting?.('cancelled'); return true }
  return false
}
const started = new Map() // `${userId}:${threadId}` → tasks begun and not yet over (planning, in line or running)
export const runningIn = (userId, threadId) => (started.get(`${userId}:${threadId}`) || 0) > 0 || sessions.get(userId)?.task?.threadId === threadId

// ---- Google 연결 in this browser (lib/googleConnect.js): the agent signs in with the vault's Google login (or
// asks for it on the card) and leaves a second step to the person; what it cannot get past is the person's ----
const GOOGLE_SKILL = 'google-sign-in'
// The card goes up as a task (「Google 연결」), the browser gets the state cookie and opens Google's consent
// address, and the person is asked at once to sign in with 「직접 로그인」. Signing in here leaves this
// browser signed in to Google as well, so NotebookLM and the other Google sites work in later tasks. The
// callback (server/index.js) reports the result (googleConnected); a screen Google uses to refuse this
// browser is told apart by the usual wall judgment (judgeWall → refused), and the card then offers
// 「휴대폰에서 연결」, the person's own browser, for the mail alone. Nothing finished in 15 minutes ends it.
// (tests shorten it)
export const CONNECT = { ms: 15 * 60 * 1000 }
const CONNECTED = '__connected__'
const connects = new Map() // userId -> { taskId, settle(outcome) }

// what holds this person's browser now ('' when nothing does)
export function browserBusy(userId) {
  const s = sessions.get(userId)
  if (!s || s.ctx._closed) return ''
  return s.task?.title || s.queue.at(-1)?.task?.title || (s.planning.size ? L('새 작업', 'a new task') : '')
}

// The callback's result for this person: { ok, email, via } or { ok: false, error }. Ends the connect
// flow that is waiting (true) — taskId: only when it is that one (its own consent screen).
export function googleConnected(userId, result, taskId = null) {
  const c = connects.get(userId)
  if (!c || (taskId && c.taskId !== taskId)) return false
  c.settle(result.ok ? { state: 'connected', email: result.email, via: result.via } : { state: 'error', error: result.error })
  return true
}

const connectReason = () => L('Google 계정으로 로그인하고 「허용」을 누르면 메일이 연결되고, 이 브라우저도 Google에 로그인돼 NotebookLM 같은 Google 사이트를 바로 쓸 수 있어요. 화면은 「직접 로그인」으로 직접 조작해요.',
  'Sign in with your Google account and press "Allow": your mail gets connected, and this browser is signed in to Google too, so Google sites such as NotebookLM work right away. "Sign in yourself" lets you work the screen.')
const PHONE_NEXT = () => L('「휴대폰에서 연결」을 누르면 지금 쓰는 기기에서 Google에 로그인해 메일만 연결해요(NotebookLM 같은 Google 사이트는 이 브라우저에서 따로 로그인해야 해요).',
  'Press "Connect on phone" to sign in to Google on the device you are using and connect the mail only (Google sites such as NotebookLM then need their own sign-in in this browser).')

// url: Google's consent address; cookie: the state cookie (lib/googleConnect.js cookieFor);
// ours(url): whether an address is this app's own (the callback, the done page) — those are not judged
export async function connectGoogle({ userId, threadId, url, cookie, ours = () => false }) {
  const s = await sessionOf(userId)
  const busy = browserBusy(userId)
  if (busy) {
    throw Object.assign(new Error(L(`서버 브라우저가 지금 다른 작업('${busy}')을 하고 있어요. 그 작업이 끝나거나 멈춘 뒤 다시 연결하거나, 「휴대폰에서 연결」로 연결해 주세요.`,
      `The server browser is busy with another task ('${busy}'). Connect again when it is done or stopped, or use "Connect on phone".`)), { status: 409 })
  }
  const title = L('Google 연결', 'Connect Google')
  // (claimed before anything is awaited: a task whose plan comes back meanwhile must see the browser taken)
  s.task = { id: null, threadId, title, connect: true, cancelled: false, waiting: null }
  const steps = [L('Google 계정으로 로그인', 'Sign in with your Google account'), L('권한 허용', 'Allow access'), L('연결 확인', 'Connection confirmed')]
  let card
  try {
    card = await addMessage(userId, threadId, 'agent', 'task', { title, goal: title, steps: steps.map((t) => ({ text: t, done: false })), state: 'running', url, connect: 'google' })
  } catch (e) { if (s.task?.connect && s.task.id === null) s.task = null; throw e }
  const task = { id: card.id, userId, threadId, title, steps, files: [], connect: true,
    goal: L('Google 계정 연결: Google 계정으로 로그인하고, 이 연결이 요청한 권한을 허용해 메일을 연결한다. 이 브라우저도 Google에 로그인된 채로 남는다',
      'Connect the Google account: sign in to Google and allow the access this connection asks for, so the mail is connected. This browser stays signed in to Google'),
    cancelled: false, waiting: null, notes: [], log: [], unattended: false, picked: {}, used: {}, secrets: new Set(), declined: new Set(),
    gates: null, gatedUrl: null, walls: {}, stale: 0, prev: null, stuckWaits: 0, judged: null, skill: GOOGLE_SKILL,
    // a site error page ends it like a refusal; a sign-in screen is the agent's (the vault is asked first)
    wallNeeds: CONNECT_NEED, vaultFirst: true,
    stats: { turns: 0, llm: 0, gate_calls: 0, gate_ms: 0, waits: 0, hints: 0, walls: 0, stuck: 0, early_finish: false, decisions: [], plan_ms: 0, turn_ms: [], wall_checks: [], skills_read: [] } }
  s.task = task
  s.threadId = threadId
  await setThreadStatus(userId, threadId, 'working')
  runConnect(s, task, { url, cookie, ours }).catch((e) => console.warn('[browser] google connect', e.message))
  return { taskId: card.id }
}

async function runConnect(s, task, { url, cookie, ours }) {
  const { userId } = task
  const t0 = Date.now()
  let outcome = null
  const settle = (o) => { if (outcome) return; outcome = o; task.waiting?.(CONNECTED) }
  task.over = () => !!outcome
  connects.set(userId, { taskId: task.id, settle })
  // our own callback page means it ended there without a result (a stale or foreign state: a good one goes
  // on to the done page) — its own text says why. Our pages are never judged
  const onOurs = (snap) => {
    if (!ours(snap?.url)) return false
    let path = ''
    try { path = new URL(snap.url).pathname } catch { /* not an address */ }
    if (path.endsWith('/api/auth/google/callback')) settle({ state: 'error', error: String(snap.text || '').trim().slice(0, 300) || L('Google 연결 요청이 만료됐어요.', 'The Google connection request expired.') })
    return true
  }
  const timer = setTimeout(() => settle({ state: 'timeout' }), CONNECT.ms)
  timer.unref?.()
  try {
    await s.ctx.addCookies([{ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, httpOnly: true, secure: cookie.secure,
      sameSite: cookie.sameSite, expires: Math.floor((Date.now() + cookie.maxAgeMs) / 1000) }])
    say(task, L('Google 여는 중', 'Opening Google'))
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    const site = hostOf(url)
    // the agent first: the google-sign-in skill (read when used) knows Google's screens; a login is filled
    // from the vault or asked for on the card, a second step goes to the person (a code on the card, a
    // prompt on their phone). When it finishes, gives up or gets stuck, the person takes it on below
    if (!outcome && !task.cancelled) {
      const messages = [{ role: 'system', content: agentPrompt({ goal: task.goal, steps: task.steps }) }]
      const skills = skillNote(browserSkill(GOOGLE_SKILL))
      if (skills) messages.push({ role: 'user', content: skills })
      const d = await drive(s, task, { messages, stop: (snap) => { onOurs(snap); return !!outcome } })
      task.stats.agent = d.result.state
      if (!outcome && !task.cancelled && d.result.need === 'blocked') outcome = { state: 'blocked' }
    }
    let seen = null, moved = null
    while (!outcome && !task.cancelled) {
      const answer = await waitForUser(s, task, {
        need: 'login', site, siteName: 'Google', reason: connectReason(),
        // a screen that changed and then stayed for one look is judged once (never on a timer): Google
        // refusing this browser ends the wait; our own callback and done page are left to the callback
        watch: async (snap) => {
          if (outcome) return CONNECTED
          if (onOurs(snap)) return outcome ? CONNECTED : null
          const k = screenKey(snap)
          if (k === seen) { moved = null; return null }
          if (k !== moved) { moved = k; return null }
          seen = k
          moved = null
          const verdict = await judgeWall(snap, task, CONNECT_NEED)
          return verdict?.need === 'blocked' ? BLOCKED : null
        },
      })
      if (answer === BLOCKED) { outcome ||= { state: 'blocked' }; break }
      // 제어 돌려주기 before Google came back to us: the person is asked again (the card says what is left)
    }
  } catch (e) {
    outcome ||= { state: 'error', error: failReason(e) }
  } finally {
    clearTimeout(timer)
    if (connects.get(userId)?.taskId === task.id) connects.delete(userId)
  }
  const o = task.cancelled && !outcome ? { state: 'cancelled' } : outcome || { state: 'cancelled' }
  const end = {
    connected: () => ({ state: 'done', need: null, reason: '', steps: task.steps.map((t) => ({ text: t, done: true })),
      summary: o.via === 'phone'
        ? L(`휴대폰에서 Google을 연결했어요(${o.email}). 메일은 연결됐지만 이 서버 브라우저는 아직 Google에 로그인되지 않았어요.`, `Google was connected on the phone (${o.email}). The mail is connected; this server browser is not signed in to Google yet.`)
        : L(`Google에 연결했어요(${o.email}). 메일을 읽기 시작하고, 이 브라우저도 Google에 로그인돼 있어서 NotebookLM 같은 Google 사이트를 바로 쓸 수 있어요.`, `Google is connected (${o.email}). I'm starting on your mail, and this browser is signed in to Google too, so Google sites such as NotebookLM work right away.`) }),
    blocked: () => {
      const reason = `${L('Google이 이 서버 브라우저에서 하는 로그인을 받아 주지 않았어요.', "Google won't accept a sign-in from this server's browser.")} ${PHONE_NEXT()}`
      return { state: 'failed', need: 'blocked', reason, summary: reason }
    },
    timeout: () => {
      const reason = `${L(`${Math.max(1, Math.round(CONNECT.ms / 60000))}분 안에 Google 연결이 끝나지 않아 멈췄어요. 「다시 연결」로 처음부터 하거나,`, `Google wasn't connected within ${Math.max(1, Math.round(CONNECT.ms / 60000))} minutes, so I stopped. Start over with "Connect again", or`)} ${PHONE_NEXT()}`
      return { state: 'failed', need: 'other', reason, summary: reason }
    },
    error: () => {
      const reason = `${String(o.error || L('Google 연결에 실패했어요.', 'Connecting Google failed.')).trim()} ${PHONE_NEXT()}`
      return { state: 'failed', need: 'other', reason, summary: reason }
    },
    cancelled: () => ({ state: 'cancelled', need: null, reason: '', summary: L('Google 연결을 멈췄어요.', 'I stopped connecting Google.') }),
  }[o.state]()
  try {
    const shot = await pushFrame(userId, s)
    if (s.task === task) s.task = null
    await updateMessage(userId, task.id, { ...end, url: s.page.url(), shot, connect: 'google', site: hostOf(url), siteName: 'Google' })
    // the card of a finished task shows no text of its own: the result is said in the chat (a stopped one
    // says why on the card itself)
    if (end.state === 'done') await addMessage(userId, task.threadId, 'agent', 'text', { text: end.summary })
    say(task, null)
    await setThreadStatus(userId, task.threadId, null)
    console.log(`[browser] google connect ${task.id} ${o.state} in ${Math.round((Date.now() - t0) / 1000)}s · ${task.stats.wall_checks.length} page checks`)
  } finally {
    if (s.task === task) s.task = null
    s.queue.shift()?.go()
  }
  return o
}

// Takeover: raw input forwarded from the live view (coords are 0..1 of the viewport).
export async function input(userId, ev) {
  const s = sessions.get(userId)
  if (!s) return
  const { width, height } = s.page.viewportSize()
  try {
    if (ev.type === 'click') await s.page.mouse.click(ev.x * width, ev.y * height)
    if (ev.type === 'key') await s.page.keyboard.press(ev.key)
    if (ev.type === 'text') await s.page.keyboard.type(ev.text)
    if (ev.type === 'scroll') await s.page.mouse.wheel(0, ev.dy)
  } catch (e) { console.warn('[browser] input', ev.type, e.message) } // a key the driver does not know, a page going away: the next key still counts
}

// Closes the user's browser (profile stays on disk).
export async function close(userId) {
  const s = sessions.get(userId)
  sessions.delete(userId)
  await s?.ctx.close().catch(() => {})
}

export function lastFrame(userId) {
  const s = sessions.get(userId)
  return s ? { data: s.frame, url: s.page.url(), running: !!s.task, taskId: s.task?.id || null } : null
}

// The person's browser (launched if it is not running): tests route made-up sites through it.
export const contextFor = async (userId) => (await sessionOf(userId)).ctx
