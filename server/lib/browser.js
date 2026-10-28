// "Handoff" browser agent: one persistent Chromium profile per user, live view via
// CDP screencast, an LLM loop that acts on numbered page elements, and credentials
// filled server-side from the vault (the model only ever says "fill the password").
// Secret fields are blanked in the page snapshot, masked on screen and in the model's
// screenshots, and logins/cards the user types during takeover are captured into the vault.
import { chromium } from 'playwright'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chat } from './llm.js'
import { emit } from './bus.js'
import { candidates, useItem, putItem, setStatus, audit, normSite } from './vault.js'
import { addMessage, updateMessage, setThreadStatus } from './store.js'
import { q } from './supa.js'
import { decide, sure } from './decide.js'
import { config } from '../config.js'
import { L, isEn } from './lang.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const PROFILES = path.join(here, '..', '.browser-profiles')
const sessions = new Map() // userId -> { ctx, page, cdp, frame, task, threadId }

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

async function sessionOf(userId) {
  let s = sessions.get(userId)
  if (s && !s.ctx._closed) return s
  fs.mkdirSync(PROFILES, { recursive: true })
  const ctx = await chromium.launchPersistentContext(path.join(PROFILES, userId), {
    headless: true, viewport: { width: 1280, height: 800 }, locale: 'ko-KR',
  })
  ctx.on('close', () => { ctx._closed = true })
  s = { ctx, page: null, frame: null, task: null, threadId: null, captures: new Map(), queue: [] }
  await ctx.addInitScript(PAGE_GUARD)
  await ctx.exposeBinding('__proVaultCapture', (_src, payload) => onCapture(userId, s, payload).catch((e) => console.warn('[vault capture]', e.message)))
  s.page = ctx.pages()[0] || await ctx.newPage()
  await s.page.evaluate(PAGE_GUARD).catch(() => {})
  sessions.set(userId, s)
  await startScreencast(userId, s)
  return s
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
  s.cdp = await s.ctx.newCDPSession(s.page)
  s.cdp.on('Page.screencastFrame', async (f) => {
    s.frame = f.data
    if (s.task) emit(userId, 'browser.frame', { taskId: s.task.id, data: f.data, url: s.page.url() })
    await s.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
  })
  await s.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 2 })
}

async function pushFrame(userId, s) {
  const shot = await s.page.screenshot({ type: 'jpeg', quality: 55 }).catch(() => null)
  if (!shot) return null
  s.frame = shot.toString('base64')
  if (s.task) emit(userId, 'browser.frame', { taskId: s.task.id, data: s.frame, url: s.page.url() })
  return s.frame
}

// Numbered interactive elements, the agent's view of the page.
const SNAPSHOT_JS = () => {
  const els = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]')]
  const out = []
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
    out.push({ i, tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '',
      text: (secret ? label : (el.innerText || el.value || label)).trim().slice(0, 60),
      ...(secret ? { secret: true, filled: !!el.value } : {}) })
    if (++i >= 120) break
  }
  return { title: document.title, url: location.href, text: document.body.innerText.slice(0, 2500), els: out }
}

const TOOLS = [
  ['goto', 'Open a URL', { url: 'string' }],
  ['click', 'Click element by index', { i: 'number' }],
  ['type', 'Type text into element by index (not for secrets)', { i: 'number', text: 'string', enter: 'boolean' }],
  ['fill_secret', 'Fill a saved vault credential into element (field: username|password|card_number|card_exp|card_cvv|card_name). If none is saved the server asks the user; if several are saved it asks which one', { i: 'number', field: 'string' }],
  ['login_failed', 'The site rejected the login you filled (wrong password / error after submitting). The server marks it rejected and asks the user for a corrected password', { reason: 'string' }],
  ['need_secret', 'A one-time value only the user has (SMS/e-mail verification code, OTP, 2FA). The server asks the user and types it into element i; you never see the value', { i: 'number', label: 'string' }],
  ['scroll', 'Scroll the page', { dy: 'number' }],
  ['step_done', 'Mark a plan step complete', { step: 'number', note: 'string' }],
  ['note', 'Record facts you found (names, prices, URLs) so they survive leaving this page', { text: 'string' }],
  ['need_login', 'No saved credential for this site; ask the user to save one', { site: 'string' }],
  ['approve', 'Ask the user to approve an irreversible step (submitting a payment, sending, deleting) right before doing it. Say exactly what will happen (amount, item, recipient)', { summary: 'string' }],
  ['need_user', 'Ask the user to intervene (captcha, manual step they must do themselves). When the user only has to pick one of a few choices (which account, which plan), list them in options', { reason: 'string', options: 'array' }],
  ['finish', 'Task complete', { summary: 'string' }],
].map(([name, description, props]) => ({
  type: 'function',
  function: {
    name, description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, t === 'array' ? { type: 'array', items: { type: 'string' } } : { type: t }])),
      required: Object.keys(props).filter((k) => k !== 'enter' && k !== 'note' && k !== 'options'),
    },
  },
}))

async function plan(goal) {
  const msg = await chat({
    model: undefined, json: true,
    messages: [
      { role: 'system', content: isEn() ? 'Break a web task into 3-6 short English steps. Reply JSON {"title": "short task name in English", "steps": ["..."]}' : 'Break a web task into 3-6 short Korean steps. Reply JSON {"title": "짧은 작업명", "steps": ["..."]}' },
      { role: 'user', content: goal },
    ],
  })
  return JSON.parse(msg.content)
}

// The browser is one per person, so its tasks run one at a time: a task asked for while another one
// is still running (or waiting for the person) waits in line — its card says so, and the person can
// still answer or cancel the one in front (cards and 작업 취소 reach the task that holds the page).
// Runs a browser task; posts a task card into the thread and keeps it updated.
export async function runBrowserTask({ userId, threadId, goal, startUrl, onAction, unattended, gates = config.browserGates }) {
  const s = await sessionOf(userId)
  const t0 = Date.now()
  const p = await plan(goal)
  const ahead = s.task || s.queue.length ? (s.queue.at(-1)?.task || s.task) : null
  const card = await addMessage(userId, threadId, 'agent', 'task', {
    title: p.title, goal, steps: p.steps.map((t) => ({ text: t, done: false })), state: ahead ? 'queued' : 'running', url: startUrl || '',
    ...(ahead ? { reason: L(`앞 작업 '${ahead.title}'이(가) 끝나면 시작해요`, `Starts when the task ahead, '${ahead.title}', is done`) } : {}),
  })
  const task = { id: card.id, userId, threadId, goal, title: p.title, steps: p.steps, cancelled: false, waiting: null, notes: [], log: [], unattended, picked: {}, used: {}, secrets: new Set(), declined: new Set(),
    gates, gatedUrl: null, stats: { turns: 0, llm: 1, gate_calls: 0, gate_ms: 0, waits: 0, hints: 0, early_finish: false, decisions: [] } }
  if (ahead) {
    await addMessage(userId, threadId, 'agent', 'text', { text: L(`브라우저는 한 번에 한 작업만 해요. 앞 작업 '${ahead.title}'이(가) 끝나거나 취소되면 '${p.title}' 작업을 이어서 시작할게요.${s.task?.waiting ? ' 앞 작업은 지금 입력을 기다리고 있어요 — 그 카드에 답하거나 작업을 취소해 주세요.' : ''}`,
      `The browser does one task at a time. When the task ahead, '${ahead.title}', is done or canceled, I'll start '${p.title}'.${s.task?.waiting ? ' The task ahead is waiting for your input right now — answer its card or cancel the task.' : ''}`) })
    await new Promise((go) => s.queue.push({ task, go }))
    if (task.cancelled) {
      await updateMessage(userId, card.id, { state: 'cancelled', reason: '', summary: L('시작하기 전에 취소했어요.', 'Canceled before it started.') })
      return { state: 'cancelled', summary: '', notes: [], stats: task.stats }
    }
    await updateMessage(userId, card.id, { state: 'running', reason: '' })
  }
  s.task = task
  s.threadId = threadId
  await setThreadStatus(userId, threadId, 'working')
  if (startUrl) await s.page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {})
  const startedAt = s.page.url()
  await pushFrame(userId, s)

  const messages = [{
    role: 'system',
    content: `You operate a Chromium browser for the user. Goal: ${goal}
Plan steps: ${p.steps.map((x, i) => `${i + 1}. ${x}`).join(' ')}
Each turn you get a page snapshot with numbered elements. Call exactly one tool per turn.
For any login field (username, email, password) and any card field ALWAYS use fill_secret, even if credentials are printed on the page or you could guess them. The server asks the user for missing credentials (and which account or card to use) automatically.
Secret fields appear in the snapshot as secret:true with no value. If the site rejects a login you filled, call login_failed. For a one-time code (SMS, e-mail, OTP, 2FA) call need_secret with the input's index; never ask for it in text.
Before submitting a payment, sending a message or deleting anything, call approve and act only if the user approves.
Mark steps with step_done as you complete them. Use note to record every fact you will need in the final answer before navigating away. Finish with a${isEn() ? 'n English' : ' Korean'} summary that contains all collected facts.
Never claim a step you did not do with a tool: the summary the user sees lists only the actions you actually performed.`,
  }]
  // the first answer without a single browser action is sent back once: do the steps first
  const NUDGE = 'You have not performed any browser action yet (no goto/click/type/fill_secret/note). Do the plan steps with the tools now. Call finish only after you have actually done them; if the page already shows what the goal asks, record it with note first.'

  let result = { state: 'done', summary: '' }
  try {
  for (let turn = 0; turn < 40 && !task.cancelled; turn++) {
    say(task, L('페이지 읽는 중', 'Reading the page'))
    task.stats.turns++
    let snap = await s.page.evaluate(SNAPSHOT_JS).catch(() => ({ url: s.page.url(), els: [], text: '' }))
    let hint = ''
    if (task.gates && snap.url !== task.gatedUrl && /^https?:/.test(snap.url)) ({ snap, hint } = await pageGate(s, task, snap))
    messages.push({ role: 'user', content: hide(task, JSON.stringify(snap)) + hint })
    const shot = await s.page.screenshot({ type: 'jpeg', quality: 50, mask: [s.page.locator(SECRET_SELECTOR)], maskColor: '#1d1d1f' }).catch(() => null)
    if (shot) messages.push({ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot.toString('base64')}` } }] })
    const msg = await chat({ messages, tools: TOOLS })
    task.stats.llm++
    messages.splice(messages.length - (shot ? 2 : 1), shot ? 2 : 1, { role: 'user', content: `[page ${snap.url}] ${snap.title || ''}` })
    messages.push(msg)
    const call = msg.tool_calls?.[0]
    if (!call && !task.log.length && !task.notes.length && !task.nudged) { task.nudged = true; messages.push({ role: 'user', content: NUDGE }); continue }
    if (!call) { result = { state: 'done', summary: msg.content || '' }; break }
    const args = JSON.parse(call.function.arguments || '{}')
    task.lastSnap = snap
    let out = 'ok'
    try {
      out = await act(s, task, call.function.name, args)
    } catch (e) { out = 'error: ' + e.message.slice(0, 200) }
    messages.push({ role: 'tool', tool_call_id: call.id, content: hide(task, String(out)) })
    await onAction?.(call.function.name, args, String(out))
    await pushFrame(userId, s)
    // one action per turn; any extra calls get an explicit skip so the transcript stays valid
    for (const extra of msg.tool_calls.slice(1)) messages.push({ role: 'tool', tool_call_id: extra.id, content: 'skipped: one action per turn' })
    if (out === '__finish__' && !task.log.length && !task.notes.length && !task.nudged) { task.nudged = true; messages.push({ role: 'user', content: NUDGE }); continue }
    if (out === '__finish__') { result = { state: 'done', summary: args.summary }; break }
    if (task.gates && call.function.name === 'note' && await goalMet(task)) {
      // the notes already answer the goal: one closing call instead of more browsing turns
      task.stats.early_finish = true
      say(task, L('정리하는 중', 'Wrapping up'))
      const fin = await chat({ messages: [...messages, { role: 'user', content: `The recorded notes already answer the goal. Call finish now with a${isEn() ? 'n English' : ' Korean'} summary containing all collected facts.` }], tools: TOOLS, toolChoice: { type: 'function', function: { name: 'finish' } } })
      task.stats.llm++
      const fa = JSON.parse(fin.tool_calls?.[0]?.function?.arguments || '{}')
      result = { state: 'done', summary: fa.summary || fin.content || task.notes.join('\n') }
      break
    }
  }
  } catch (e) {
    console.warn('[browser]', e.message)
    result = { state: 'failed', summary: L('브라우저 작업을 끝내지 못했어요. 잠시 후 다시 시도해 주세요.', "I couldn't finish the browser task. Please try again in a moment.") }
  }
  if (task.cancelled) result = { state: 'cancelled', summary: L('작업을 취소했어요.', 'I canceled the task.') }
  // a task that did nothing in the browser is not "done", whatever the model wrote: it is left for
  // the person to check, and what they read is what the action log shows
  try {
    result = honest(result, task, { moved: s.page.url() !== startedAt })
    const shot = await pushFrame(userId, s)
    s.task = null
    // keep the last screen on the card so it survives reloads
    await updateMessage(userId, card.id, { state: result.state, summary: result.summary, url: s.page.url(), shot })
    say(task, null)
    await setThreadStatus(userId, threadId, null)
    result.url = s.page.url()
    result.notes = task.notes
    result.stats = { ...task.stats, ms: Date.now() - t0 }
    result.pageText = hide(task, await s.page.evaluate(() => document.body.innerText.slice(0, 6000)).catch(() => ''))
    return result
  } finally {
    if (s.task === task) s.task = null
    // the next task in line gets the browser
    s.queue.shift()?.go()
  }
}

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
      snap = await s.page.evaluate(SNAPSHOT_JS).catch(() => snap)
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

// What the agent actually did, in the person's words (the summary lists these, not the model's claims).
// Never a value typed into a field: only which field.
function logAction(task, name, a, out) {
  const els = task.lastSnap?.els || []
  const label = (i) => { const e = els.find((x) => x.i === i); return e ? (e.text || e.name || e.tag || `#${i}`).slice(0, 40) : `#${i}` }
  // a refused or impossible step is not an action taken; asking the person always is
  const ok = ['approve', 'need_user', 'need_login', 'login_failed', 'need_secret'].includes(name) || !/^(error|refused|no (card|credential)|the saved)/.test(String(out))
  const line = {
    goto: () => L(`${hostOf(a.url)} 열기`, `Open ${hostOf(a.url)}`),
    click: () => L(`'${label(a.i)}' 누르기`, `Click '${label(a.i)}'`),
    type: () => L(`'${label(a.i)}'에 입력`, `Type into '${label(a.i)}'`),
    fill_secret: () => L(`보관함의 ${{ username: '아이디', password: '비밀번호', card_number: '카드 번호', card_exp: '카드 만료일', card_cvv: 'CVC', card_name: '카드 소유자' }[a.field] || a.field} 입력`,
      `Fill in the ${{ username: 'username', password: 'password', card_number: 'card number', card_exp: 'card expiry', card_cvv: 'CVC', card_name: 'cardholder name' }[a.field] || a.field} from the Vault`),
    need_secret: () => L(`${a.label || '인증 코드'}를 받아 입력`, `Get and enter the ${a.label || 'verification code'}`),
    approve: () => L(`승인 요청: ${String(a.summary || '').slice(0, 80)} → ${/approved/.test(String(out)) ? '승인됨' : '승인 안 됨'}`, `Approval request: ${String(a.summary || '').slice(0, 80)} → ${/approved/.test(String(out)) ? 'approved' : 'not approved'}`),
    login_failed: () => L('로그인 거부 확인', 'Login rejected'),
    scroll: () => L('화면 내리기', 'Scroll down'),
    need_login: () => L(`${a.site || ''} 로그인 정보 요청`, `Ask for the ${a.site || ''} login`),
    need_user: () => L(`확인 요청: ${String(a.reason || '').slice(0, 60)}`, `Ask to check: ${String(a.reason || '').slice(0, 60)}`),
    note: () => null,
    step_done: () => null,
  }[name]?.()
  if (line) task.log.push({ kind: name, text: line, ok })
}
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return String(u || '').slice(0, 60) } }
const ACTIONS = new Set(['goto', 'click', 'type', 'fill_secret', 'need_secret', 'approve', 'scroll'])

// The summary the person reads: the model's account only when the task actually did something, and
// always the list of actions taken. Nothing done (no browser action, no fact noted, page unmoved) →
// 확인 필요, saying so plainly.
export function honest(result, task, { moved = false } = {}) {
  const acted = task.log.some((e) => ACTIONS.has(e.kind) && e.ok)
  const done = task.log.filter((e) => e.ok).map((e) => `• ${e.text}`)
  const facts = task.notes.length
  if (result.state === 'done' && !acted && !facts && !moved) {
    const planned = (task.steps || []).map((x, i) => `${i + 1}. ${x}`).join('\n')
    return { ...result, state: 'needs_review', summary: L(`브라우저에서 아무 동작도 하지 못한 채 작업이 끝났어요. 계획한 단계는 하나도 진행되지 않았어요.${planned ? `\n\n계획했던 단계\n${planned}` : ''}\n\n다시 시키거나, 작업 카드에서 직접 제어로 확인해 주세요.`,
      `The task ended without any action in the browser. None of the planned steps was done.${planned ? `\n\nPlanned steps\n${planned}` : ''}\n\nAsk again, or check it yourself with Take control on the task card.`) }
  }
  if (result.state !== 'done' && result.state !== 'needs_review') return result
  const said = String(result.summary || '').trim()
  return { ...result, summary: [said || (facts ? task.notes.join('\n') : ''), done.length ? `${L('실제로 한 일', 'What I actually did')}\n${done.slice(-12).join('\n')}` : ''].filter(Boolean).join('\n\n') }
}

async function act(s, task, name, a) {
  const out = await doAct(s, task, name, a)
  logAction(task, name, a, out)
  return out
}

async function doAct(s, task, name, a) {
  const el = (i) => s.page.locator(`[data-pro-idx="${i}"]`).first()
  const host = (() => { try { return new URL(name === 'goto' ? a.url : s.page.url()).hostname.replace(/^www\./, '') } catch { return '' } })()
  const live = (isEn() ? { goto: `Opening ${host}`, click: `Clicking on ${host}`, type: `Typing on ${host}`, fill_secret: `Typing on ${host}`, scroll: 'Looking at the page', note: 'Taking notes', step_done: 'On to the next step' }
    : { goto: `${host} 여는 중`, click: `${host}에서 클릭 중`, type: `${host}에서 입력 중`, fill_secret: `${host}에서 입력 중`, scroll: '페이지 보는 중', note: '메모하는 중', step_done: '다음 단계로' })[name]
  if (live) say(task, live)
  switch (name) {
    case 'goto': await s.page.goto(a.url, { waitUntil: 'domcontentloaded' }); return 'ok'
    case 'click': await el(a.i).click({ timeout: 8000 }); await s.page.waitForTimeout(800); return 'ok'
    case 'type': {
      // the model never types into a secret field, even text it found on the page
      if (await el(a.i).evaluate((e, sel) => e.matches(sel) || /card.?(no|num)|cardnumber|cvc|cvv|csc|otp/i.test(`${e.name} ${e.id}`), SECRET_SELECTOR)) {
        return 'refused: this is a secret field; use fill_secret (saved login/card) or need_secret (one-time code)'
      }
      await el(a.i).fill(a.text); if (a.enter) await el(a.i).press('Enter'); return 'ok'
    }
    case 'scroll': await s.page.mouse.wheel(0, a.dy || 600); return 'ok'
    case 'fill_secret': {
      const site = normSite(new URL(s.page.url()).hostname)
      const kind = String(a.field).startsWith('card') ? 'card' : 'login'
      const item = await pickItem(s, task, kind, site)
      if (!item) return kind === 'card' ? 'no card saved: the user did not add one' : `no credential saved for ${site}`
      const sec = await useItem(task.userId, item.id, { taskId: task.id, field: a.field })
      const val = { username: sec.username || sec.email, password: sec.password, card_number: sec.number, card_exp: sec.exp,
        card_cvv: sec.cvv, card_name: sec.name }[a.field]
      if (!val) return `the saved ${kind} has no ${a.field}`
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
        reason: L(`${site}에서 저장된 비밀번호를 받아들이지 않았어요`, `${site} didn't accept the saved password`), site,
        message: ['vault', { kind: 'login', site, mode: 'update', itemId: id, label: row?.label || '', reason: a.reason || '' }],
      })
      const [now] = (await candidates(task.userId, 'login', site)).filter((r) => r.id === id)
      return now && now.status !== 'rejected'
        ? 'the user saved a corrected password; fill the login form again with fill_secret and submit'
        : 'the user did not update the password; stop trying to log in'
    }
    case 'need_secret': {
      const site = normSite(host)
      if (task.unattended) {
        task.notes.push(L(`${site}: 일회용 값(${a.label || '인증 코드'})이 필요해 진행하지 못함`, `${site}: couldn't continue, a one-time value (${a.label || 'verification code'}) is needed`))
        return 'nobody is available to provide a one-time code; do not continue this login, record it in a note'
      }
      task.secretSlot = { i: a.i, label: a.label || L('인증 코드', 'verification code') }
      const answer = await waitForUser(s, task, {
        reason: L(`${a.label || '인증 코드'} 입력이 필요해요`, `The ${a.label || 'verification code'} is needed`), site,
        message: ['vault', { kind: 'secret', site, mode: 'request', label: a.label || L('인증 코드', 'verification code') }],
      })
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
        reason: a.summary || L('승인이 필요해요', 'Approval is needed'), site,
        message: ['choice', { site, approval: true, question: `${a.summary || ''}${card ? L(`\n결제 카드: ${card.label}`, `\nPayment card: ${card.label}`) : ''}`.trim(), options: L(['승인', '취소'], ['Approve', 'Cancel']) }],
      })
      return /chose: (승인|Approve)\./.test(String(answer)) ? 'the user approved: do it now' : 'the user declined: do not do it; finish and say it was not done'
    }
    case 'step_done': {
      task.steps[a.step - 1] && await updateMessage(task.userId, task.id, {
        steps: task.steps.map((t, i) => ({ text: t, done: i < a.step, note: i === a.step - 1 ? a.note : undefined })),
      })
      return 'ok'
    }
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
      const message = name === 'need_login'
        ? ['vault', { kind: 'login', site: normSite(site), mode: 'request' }]
        // a pick-one question is answered in place (hark's account chooser) rather than by takeover
        : Array.isArray(a.options) && a.options.length > 1 ? ['choice', { site, question: a.reason || '', options: a.options.slice(0, 6) }] : null
      return waitForUser(s, task, { reason: a.reason || '', site, message })
    }
    case 'note': task.notes.push(a.text); return 'noted'
    case 'finish': return '__finish__'
  }
  return 'unknown tool'
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
async function waitForUser(s, task, { reason, site, message }) {
  // the card goes up first, so whoever sees "needs input" also finds what to answer
  const posted = message ? await addMessage(task.userId, task.threadId, 'agent', message[0], { ...message[1], taskId: task.id, state: 'pending' }) : null
  await updateMessage(task.userId, task.id, { state: 'needs_input', reason: reason || '', site })
  say(task, null)
  await setThreadStatus(task.userId, task.threadId, 'needs_input')
  await pushFrame(task.userId, s)
  const answer = await new Promise((resolve) => { task.waiting = resolve })
  task.waiting = null
  // a card the user never answered (cancel, takeover) should not stay actionable
  if (posted) await q(`update pro_messages set content = content || '{"state":"expired"}'::jsonb where id=$1 and content->>'state'='pending'`, [posted.id])
  await updateMessage(task.userId, task.id, { state: 'running', reason: '' })
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
      reason: kind === 'card' ? L('결제에 사용할 카드가 필요해요', 'A card to pay with is needed') : L(`${site} 로그인이 필요해요`, `A ${site} login is needed`), site,
      message: ['vault', { kind, site, mode: 'request' }],
    })
    list = await candidates(task.userId, kind, site)
    if (!list.length) { task.declined.add(key); return null }
  }
  let chosen = list[0]
  if (list.length > 1 && !task.unattended) {
    const answer = await waitForUser(s, task, {
      reason: kind === 'card' ? L('어떤 카드를 쓸지 골라 주세요', 'Choose which card to use') : L('어떤 계정을 쓸지 골라 주세요', 'Choose which account to use'), site,
      message: ['choice', {
        site, vault: true,
        question: kind === 'card' ? L('저장된 카드가 여러 장이에요. 어떤 카드로 결제할까요?', 'There are several saved cards. Which card should I pay with?') : L(`${site}에 저장된 계정이 여러 개예요. 어떤 계정으로 로그인할까요?`, `There are several saved accounts for ${site}. Which one should I log in with?`),
        options: list.slice(0, 6).map((r) => r.label),
      }],
    })
    chosen = list.find((r) => String(answer).includes(`chose: ${r.label}.`)) || list[0]
  }
  task.picked[key] = chosen.id
  return chosen
}

// The user typed a one-time code into the vault card: it goes straight into the waiting field
// and is never stored or shown to the model.
export async function provideSecret(userId, value) {
  const s = sessions.get(userId)
  const t = s?.task
  if (!t?.secretSlot || !t.waiting) return false
  const slot = t.secretSlot
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
  const inLine = taskId && s?.queue.find((x) => x.task.id === taskId)
  if (inLine) { s.queue.splice(s.queue.indexOf(inLine), 1); inLine.task.cancelled = true; inLine.go(); return true }
  const t = s?.task
  if (t && (!taskId || t.id === taskId)) { t.cancelled = true; t.waiting?.('cancelled'); return true }
  return false
}
export const runningIn = (userId, threadId) => sessions.get(userId)?.task?.threadId === threadId

// Takeover: raw input forwarded from the live view (coords are 0..1 of the viewport).
export async function input(userId, ev) {
  const s = sessions.get(userId)
  if (!s) return
  const { width, height } = s.page.viewportSize()
  if (ev.type === 'click') await s.page.mouse.click(ev.x * width, ev.y * height)
  if (ev.type === 'key') await s.page.keyboard.press(ev.key)
  if (ev.type === 'text') await s.page.keyboard.type(ev.text)
  if (ev.type === 'scroll') await s.page.mouse.wheel(0, ev.dy)
}

// Closes the user's browser (profile stays on disk).
export async function close(userId) {
  const s = sessions.get(userId)
  sessions.delete(userId)
  await s?.ctx.close().catch(() => {})
}

export function lastFrame(userId) {
  const s = sessions.get(userId)
  return s ? { data: s.frame, url: s.page.url(), running: !!s.task } : null
}
