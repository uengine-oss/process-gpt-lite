// 메일은 내 계정으로, 받은 메일의 스레드 안에서, 「보낼 메일」 카드에서 보내기를 눌러야 나간다 · 붙여 넣은 초안을 잊지 않는다
// (운영 녹화 2026-11-27 12:56 · 12:59 — 사용자 「메일 발송이 현재 로그인 된 유저 계정으로 해서 나가야 되는데 … 다른 샌드메일 보내는
// 설정된 걸로 해서 보내지는 것 같습니다」, 「방금 내가 붙여줬던 내용을 파악을 못하고 있어」). 그날 채팅에서:
//   ① 답장 초안 + 동료가 준 내용을 붙여 「…넣어서 보내」 → 채팅에 참고로 붙여 둔 공유 폴더의 변경안 작업(따로 도는 대화방)으로 빠졌다
//   ② 「(고친 값)으로 해서 보내」 → 다음 말은 그 대화방을 보지 못해 「초안이 이 대화에 남아 있지 않아요」
//   ③ 다시 붙여 넣자 에이전트가 회사 메일 도구(send_email)로 직접 보냈다 — 회사 공용 발송 계정에서, 스레드가 아닌 새 메일로.
// 고친 뒤(스펙 openspec/specs/mail-reply-review 「사람을 대신해 보내는 메일」, chat-thread-list 「붙여 둔 폴더가 있어도」):
//   F-MY-01 붙여 둔 폴더가 있는 채팅에서 초안을 붙여 「…넣어서 보내」 → 판정 모델이 폴더 고치기가 아니라고 읽어 이 대화에서 답하고, 다음 말
//           「900101으로 해서 보내」는 같은 대화로 가서 붙여 넣은 내용으로 「보낼 메일」 카드를 만든다(보낸 사람 = 내 주소, 받은 메일의 스레드에 이어서)
//   F-MY-02 그 말에는 답이 하나 · 카드가 하나 — 같은 말로 에이전트를 두 번 부르지 않는다
//   F-MY-03 카드의 「보내기」 → 내 Gmail 에서, 받은 메일의 스레드로(threadId · In-Reply-To), 한 번만; 회사 공용 계정(가짜 SMTP)에는 아무것도 닿지 않고,
//           에이전트에게 간 요청은 회사 메일 도구를 숨기라고 했다(metadata.hidden_tools)
//   F-MY-04 메일을 연결하지 않은 사람: 카드는 「메일을 연결하면 내 계정으로 보낼 수 있어요」 · 「연결하기」(메일 연결 시트) · 「초안으로 두기」, 아무것도 나가지 않는다
//   F-MY-05 휴대폰 390px 밝은 · 밤: 카드가 화면 안, 옆으로 넘치지 않음
// 자기 스택(lib/localStack.js — 테넌트 mailout-ui, BFF 8989~ · Vite 5389~), 이 파일이 띄우는 가짜 Gmail · 가짜 회사 SMTP · 가짜 deepagents
// (운영의 에이전트처럼: hidden_tools 에 send_email 이 없으면 회사 SMTP 로 보내고, 있으면 Lite 의 send_mail_as_me 를 부른다 — 대화마다 앞의 말을
// 기억한다) · 가짜 모델(폴더 고치기 판정만 「그 밖의 일」, 채팅 라우터는 DELEGATE). 실제 메일 · 실제 모델 · 공용 deepagents 는 부르지 않는다.
// 사람 · 회사 · 주소는 지어낸 것이다(정하윤 · 김서연 · 박도윤, customer.example).
//   cd e2e && npx playwright test --project=feature tests/feature/mail-send-as-me.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { startStack, freePort, waitFor, SERVER } from '../../lib/localStack.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/mail-reply-review/e2e/results')
const TENANT = 'mailout-ui'
const DESK = { viewport: { width: 1280, height: 860 } }
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }
const req = createRequire(path.join(SERVER, 'package.json'))
test.describe.configure({ mode: 'serial' })

const CUSTOMER = { name: '김서연', address: 'seoyeon.kim@customer.example' }
const SUBJECT = '[견적 요청] 사무용 의자 납품 건'
const MAIL_ID = 'cust-mail-1'
const THREAD = 'thr-cust-1'
const FOLDER = '연말 행사 준비'
// a reply draft pasted in — one product number has five digits where it needs six (invented data)
const PASTE = `김서연 팀장님께 아래 내용으로 답장해 줘.
받는 사람: ${CUSTOMER.name} <${CUSTOMER.address}>
제목: Re: ${SUBJECT}

김서연 팀장님, 안녕하세요.
정하윤입니다.

요청하신 견적을 보내 드립니다.
[사무용 의자]
1) 모델: 표준형
2) 품번: 90101
3) 수량: 12개

감사합니다.
정하윤 드림

위 내용 그대로 견적 넣어서 보내 줘`
const FIX = '900101으로 해서 보내'

let S, keyring, tmpRoot, ME, NOMAIL
const servers = []
const listen = (srv, port) => new Promise((ok, no) => srv.once('error', no).listen(port, '127.0.0.1', () => { servers.push(srv); ok(srv) }))

// ---------- the fake Gmail: the customer's mail in its thread; what is sent ----------
const gmail = { raw: null, sends: [] }
function google() {
  return http.createServer((rq, res) => {
    let raw = []
    rq.on('data', (c) => raw.push(c))
    rq.on('end', () => {
      const u = new URL(rq.url, 'http://x')
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)) }
      if (rq.method === 'POST' && u.pathname === '/upload/gmail/v1/users/me/messages/send') {
        gmail.sends.push(Buffer.concat(raw))
        return json(200, { id: `sent-${gmail.sends.length}`, threadId: THREAD })
      }
      const m = /^\/gmail\/v1\/users\/me\/messages\/([^/?]+)$/.exec(u.pathname)
      if (m && m[1] === MAIL_ID) {
        if (u.searchParams.get('format') === 'minimal') return json(200, { id: MAIL_ID, sizeEstimate: gmail.raw.length })
        return json(200, { id: MAIL_ID, threadId: THREAD, raw: gmail.raw.toString('base64url') })
      }
      if (u.pathname === '/gmail/v1/users/me/messages') {
        const qs = u.searchParams.get('q') || ''
        return json(200, qs.includes('사무용 의자') && qs.includes(CUSTOMER.address) ? { messages: [{ id: MAIL_ID, threadId: THREAD }] } : { messages: [] })
      }
      json(404, { error: { message: 'not found' } })
    })
  })
}

// ---------- the company's shared sending account: a fake SMTP server that counts who reaches it ----------
const smtp = { hits: 0 }
const smtpServer = () => net.createServer((s) => { smtp.hits++; s.write('220 shared-sender ESMTP\r\n'); s.on('data', () => s.end('221 bye\r\n')) })

// ---------- the fake model: only the folder-edit reading says 「something else」; the chat router delegates ----------
const llm = { folderReads: 0 }
function model() {
  return http.createServer((rq, res) => {
    let raw = ''
    rq.on('data', (c) => { raw += c })
    rq.on('end', () => {
      let b = {}
      try { b = JSON.parse(raw) } catch { /* not json */ }
      const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      const folderRead = text.includes('파일을 고치거나') && text.includes(FOLDER)
      if (folderRead) llm.folderReads++
      res.writeHead(200, { 'content-type': 'application/json' })
      if (b.logprobs) {
        const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((x) => ({ letter: x[1], label: x[2] }))
        const pick = folderRead ? options.find((o) => o.label.startsWith('그 밖의 일')) : options.at(-1)
        const top = [{ token: (pick || { letter: 'A' }).letter, logprob: Math.log(folderRead ? 0.95 : 0.9) }]
        const rest = options.find((o) => o.letter !== top[0].token)
        if (rest) top.push({ token: rest.letter, logprob: Math.log(0.05) })
        return res.end(JSON.stringify({ choices: [{ message: { content: top[0].token }, logprobs: { content: [{ token: top[0].token, logprob: top[0].logprob, top_logprobs: top }] } }] }))
      }
      const answer = b.tools ? 'DELEGATE' : folderRead ? JSON.stringify({ choice: 'A', confidence: 0.95 }) : '{}'
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }))
    })
  })
}

// ---------- the fake deepagents: remembers each conversation, and sends the way the production agent did unless told to hide that tool ----------
const agent = { bodies: [], history: new Map(), smtpPort: 0 }
const sse = (res, obj, ev) => res.write(`${ev ? `event: ${ev}\n` : ''}data: ${JSON.stringify(obj)}\n\n`)
function mailOf(text) {
  const to = /받는 사람:\s*(.+)/.exec(text)?.[1]?.trim()
  const subject = /제목:\s*(.+)/.exec(text)?.[1]?.trim()
  const from = text.indexOf('\n\n', text.indexOf('제목:'))
  const end = text.indexOf('\n\n위 내용')
  return { to, subject, body: text.slice(from + 2, end > from ? end : undefined).trim() }
}
function deepagents() {
  return http.createServer((rq, res) => {
    let raw = ''
    rq.on('data', (c) => { raw += c })
    rq.on('end', async () => {
      if (!rq.url.endsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}') }
      let body = {}
      try { body = JSON.parse(raw) } catch { /* not json */ }
      agent.bodies.push(body)
      const conv = body.conversation_id || crypto.randomUUID().replace(/-/g, '')
      const said = String(body.message || '')
      const hist = agent.history.get(conv) || []
      hist.push(said)
      agent.history.set(conv, hist)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      sse(res, { conversation_id: conv }, 'metadata')
      const say = (t) => { sse(res, { type: 'token', content: t }); res.end() }
      const paste = [...hist].reverse().find((m) => m.includes('받는 사람:'))
      // (what the production agent said when the draft was not in its conversation)
      if (!paste) return say('메일은 보내지 않았어요. 보낼 답장 초안이 이 대화에 남아 있지 않아요. 보낼 메일의 제목과 본문을 붙여 주세요.')
      const fix = /(\d{6})으로 해서 보내/.exec(said)?.[1]
      if (!fix && /품번: \d{5}\b/.test(paste)) return say("아직 메일을 보내지 않았어요. 품번이 '90101'로 다섯 자리예요. 맞는 값을 알려 주세요.")
      const mail = mailOf(paste)
      const args = { to: [mail.to], subject: mail.subject, body: fix ? mail.body.replace(/품번: \d{5}\b/, `품번: ${fix}`) : mail.body, reply_to: { subject: mail.subject } }
      const hidden = body.metadata?.hidden_tools || []
      if (!hidden.includes('send_email')) {
        // the company's mail tool, as production had it: straight out through the shared sending account, a new mail
        sse(res, { type: 'tool_start', tool: 'send_email', input: args })
        await new Promise((ok) => { const c = net.connect(agent.smtpPort, '127.0.0.1', () => { c.end('QUIT\r\n'); ok() }); c.on('error', ok) })
        sse(res, { type: 'tool_end', tool: 'send_email', output: 'sent from the shared account' })
        return say('메일을 보냈어요. 회사 메일 계정으로 설정된 주소에서 나갔어요.')
      }
      sse(res, { type: 'tool_start', tool: 'send_mail_as_me', input: args })
      const r = await fetch(`http://127.0.0.1:${S.apiPort}/mcp/mail`, {
        method: 'POST', headers: { Authorization: `Bearer ${body.user_jwt}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_mail_as_me', arguments: args } }),
      }).then((x) => x.json()).catch((e) => ({ error: e.message }))
      sse(res, { type: 'tool_end', tool: 'send_mail_as_me', output: r?.result?.content?.[0]?.text || JSON.stringify(r) })
      say('보낼 메일 카드를 띄웠어요. 내용을 확인하고 카드의 「보내기」를 눌러 주세요.')
    })
  })
}

// ---------- the page ----------
async function pageOf(browser, who, opts = DESK, theme = 'light') {
  const ctx = await browser.newContext({ ...opts, baseURL: S.web, locale: 'ko-KR' })
  await ctx.addInitScript(([s, th]) => {
    if (window.top !== window) return
    localStorage.setItem('pgpt-pro-session', s)
    localStorage.setItem('pgpt-pro-theme', th)
  }, [JSON.stringify(who.session), theme])
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const composer = (p) => p.locator('[data-test="chat-composer"]').last().locator('textarea')
async function say(p, text) {
  await composer(p).fill(text)
  await composer(p).press('Enter')
}
const chatOf = async (who) => (await S.q(`select * from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [who.id]))[0]
const rowsAfter = (threadId, at) => S.q(`select id, role, kind, content, created_at from pro_messages where thread_id=$1 and created_at > $2 order by created_at`, [threadId, at])
const noOverflow = async (p) => expect(await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1)

test.beforeAll(async () => {
  test.setTimeout(300_000)
  fs.mkdirSync(SHOTS, { recursive: true })
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-mailout-'))
  keyring = path.join(tmpRoot, 'keyring.json')
  fs.writeFileSync(keyring, JSON.stringify({ current: 'k1', keys: [{ id: 'k1', key: crypto.randomBytes(32).toString('base64') }] }), { mode: 0o600 })
  process.env.PRO_VAULT_KEYRING = keyring
  // a process-gpt root of its own: the keys (.env) as they are, an agent workspace in a temporary folder
  const { PGPT_ROOT } = await import('../../lib/env.js')
  const pgptRoot = path.join(tmpRoot, 'pgpt')
  fs.mkdirSync(path.join(pgptRoot, 'services', 'deepagents', 'workspace'), { recursive: true })
  const realRoot = PGPT_ROOT || path.join(os.homedir(), 'process-gpt')
  if (fs.existsSync(path.join(realRoot, '.env'))) fs.symlinkSync(path.join(realRoot, '.env'), path.join(pgptRoot, '.env'))
  const MailComposer = req('nodemailer/lib/mail-composer')
  gmail.raw = await new MailComposer({ from: `${CUSTOMER.name} <${CUSTOMER.address}>`, to: '정하윤 <pro-rt-ms-sender@uengine.org>', subject: SUBJECT, messageId: '<cust-1@customer.example>',
    text: '정하윤 대표님, 안녕하세요.\n사무용 의자 12개의 견적을 요청드립니다.\n\n김서연 드림' }).compile().build()
  // the fakes on free ports of their own (RT_FAKE_FROM to look elsewhere)
  const F = Number(process.env.RT_FAKE_FROM) || 59970
  const gp = freePort(F, 10)
  await listen(google(), gp)
  agent.smtpPort = freePort(gp + 1, 10)
  await listen(smtpServer(), agent.smtpPort)
  const ap = freePort(agent.smtpPort + 1, 10)
  await listen(deepagents(), ap)
  const lp = freePort(ap + 1, 10)
  await listen(model(), lp)
  S = await startStack({ tenant: TENANT, apiFrom: Number(process.env.RT_API_FROM) || 8989, webFrom: Number(process.env.RT_WEB_FROM) || 5389,
    env: { PGPT_ROOT: pgptRoot, PRO_VAULT_KEYRING: keyring,
      PRO_GOOGLE_GMAIL_URL: `http://127.0.0.1:${gp}/gmail/v1`, PRO_GOOGLE_GMAIL_UPLOAD_URL: `http://127.0.0.1:${gp}/upload/gmail/v1`,
      PRO_DEEPAGENTS_URL: `http://127.0.0.1:${ap}`, PRO_CONTEXT_ROUTER_URL: '', PRO_LLM_BASE_URL: `http://127.0.0.1:${lp}/v1`, PRO_LLM_API_KEY: 'test',
      PRO_LLM_MODEL: 'fake', PRO_LLM_FAST_MODEL: 'fake', PRO_LLM_FRONT_MODEL: 'fake', PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_MEMENTO_URL: 'http://127.0.0.1:9',
      PRO_MCP_HUB_URL: 'http://127.0.0.1:9', PRO_JUDGE_URL: '', PRO_ONTOLOGY_BOLT_URL: '', PRO_STREAM_IDLE_MS: '120000',
      // the company's shared sending account, configured the way process-gpt's services read it — Lite must never use it
      SMTP_SERVER: '127.0.0.1', SMTP_PORT: String(agent.smtpPort), SMTP_USERNAME: 'shared-sender@company.example', SMTP_PASSWORD: 'not-a-real-password' } })
  ME = await S.person('pro-rt-ms-sender@uengine.org', '정하윤')
  NOMAIL = await S.person('pro-rt-ms-nomail@uengine.org', '박도윤')
  await S.join(ME); await S.join(NOMAIL)
  // (what an earlier run left — an interrupted one cleans nothing: its messages would answer this run's waits)
  for (const u of [ME, NOMAIL]) await clean(u)
  // 정하윤's Gmail mailbox, allowed to send (this server's Google is the fake above)
  const vault = await import(path.join(SERVER, 'lib/vault.js'))
  const { config } = await import(path.join(SERVER, 'config.js'))
  for (const u of [ME, NOMAIL]) { await S.q('delete from pro_vault_items where user_id=$1', [u.id]); await S.q('delete from pro_vault_keys where user_id=$1', [u.id]); await S.q('delete from pro_mail_accounts where user_id=$1', [u.id]) }
  await vault.putItem(ME.id, 'oauth', config.google.vaultSite, { username: ME.email, access_token: 'at-e2e', refresh_token: 'rt-e2e', expires_at: Date.now() + 6 * 3600_000,
    scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose', client_id: 'cid-e2e' }, { actor: 'mail' })
  await S.q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'gmail',$2)`, [ME.id, ME.email])
})
async function clean(u) {
  for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit']) await S.q(`delete from ${t} where user_id=$1`, [u.id]).catch(() => {})
  await S.q('delete from pro_thread_folders where user_id=$1', [u.id]).catch(() => {})
  await S.q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u.id]).catch((e) => console.warn('[clean] messages', e.message))
  await S.q(`update pro_threads set conversation_id=null where user_id=$1`, [u.id]).catch(() => {})
  await S.q(`delete from context_threads where user_id=$1`, [u.id]).catch(() => {})
}
test.afterAll(async () => {
  if (S) {
    for (const u of [ME, NOMAIL].filter(Boolean)) await clean(u)
    await S.q(`delete from pro_folder_variations where folder_id in (select id from pro_folders where tenant_id=$1)`, [TENANT]).catch(() => {})
    await S.q(`delete from pro_folder_members where folder_id in (select id from pro_folders where tenant_id=$1)`, [TENANT]).catch(() => {})
    await S.stop()
  }
  for (const s of servers) s.close()
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

let card = null
test('F-MY-01 붙여 둔 폴더가 있어도 붙여 넣은 초안은 이 대화에 — 다음 말 「900101으로 해서 보내」가 그 초안으로 「보낼 메일」 카드를 만든다', async ({ browser }) => {
  const p = await pageOf(browser, ME)
  await p.goto('/chat')
  await composer(p).waitFor()
  // a shared folder attached to the chat for reference, as in the recording
  const f = await S.api(ME.token, '/folders', { method: 'POST', body: { name: FOLDER, description: '행사 준비 자료' } })
  const [chat] = await S.api(ME.token, '/threads')
  await S.api(ME.token, `/threads/${chat.id}/folder`, { method: 'POST', body: { folder: f.slug || f.id } })
  const t0 = new Date()
  const n0 = agent.bodies.length
  await say(p, PASTE)
  await expect.poll(() => agent.bodies.length, { timeout: 90_000 }).toBe(n0 + 1)
  await expect(p.getByText('다섯 자리예요').last()).toBeVisible({ timeout: 60_000 })
  expect(llm.folderReads, '판정 모델이 그 말을 폴더 고치기인지 읽었다').toBeGreaterThan(0)
  const first = agent.bodies.at(-1)
  expect(first.message, '폴더의 변경안 작업이 아니라 보통의 채팅 턴').not.toContain('의 새 변형')
  expect((await S.q(`select count(*)::int as n from pro_folder_variations where folder_id=$1`, [f.id]))[0].n, '폴더의 변경안이 생기지 않았다').toBe(0)
  await say(p, FIX)
  await expect.poll(() => agent.bodies.length, { timeout: 90_000 }).toBe(n0 + 2)
  const box = p.locator('[data-test="mail-out"][data-state="pending"]').last()
  await expect(box).toBeVisible({ timeout: 60_000 })
  const second = agent.bodies.at(-1)
  const conv = (await chatOf(ME)).conversation_id
  expect(second.conversation_id, '다음 말이 같은 대화로 갔다(앞의 초안을 본다)').toBe(conv)
  expect(conv).toBeTruthy()
  await expect(box.locator('[data-test="mail-out-from"]')).toContainText(ME.email)
  await expect(box.locator('[data-test="mail-out-to"]')).toContainText(CUSTOMER.address)
  await expect(box.locator('[data-test="mail-out-thread"]')).toContainText(SUBJECT)
  await expect(box.locator('[data-test="mail-out-thread"]')).toContainText('이어서')
  await expect(box.locator('[data-test="mail-out-body"]')).toContainText('품번: 900101')
  await expect(box.locator('[data-test="mail-out-gate"]')).toContainText('눌러야 나가요')
  expect(gmail.sends.length, '카드만 띄우고 아무것도 보내지 않았다').toBe(0)
  card = { t0 }
  await box.scrollIntoViewIfNeeded()
  await p.screenshot({ path: path.join(SHOTS, 'F-MY-01-card.png') })
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MY-02 「900101으로 해서 보내」에는 답이 하나 · 카드가 하나 — 같은 말로 에이전트를 두 번 부르지 않는다', async () => {
  const chat = await chatOf(ME)
  const rows = await rowsAfter(chat.id, card.t0)
  const fixAt = rows.findIndex((r) => r.role === 'user' && r.kind === 'text' && r.content?.text === FIX)
  expect(fixAt).toBeGreaterThan(-1)
  const after = rows.slice(fixAt + 1)
  expect(after.filter((r) => r.role === 'agent' && r.kind === 'text').length, '에이전트 답 하나').toBe(1)
  expect(after.filter((r) => r.kind === 'mail_out').length, '보낼 메일 카드 하나').toBe(1)
  expect(agent.bodies.filter((b) => String(b.message).includes(FIX)).length, '그 말로 에이전트를 한 번만 불렀다').toBe(1)
})

test('F-MY-03 카드의 「보내기」 → 내 Gmail 에서 받은 메일의 스레드로, 한 번만 — 회사 공용 계정(SMTP)에는 아무것도 닿지 않는다', async ({ browser }) => {
  const p = await pageOf(browser, ME)
  await p.goto('/chat')
  const box = p.locator('[data-test="mail-out"][data-state="pending"]').last()
  await expect(box).toBeVisible({ timeout: 30_000 })
  await box.locator('[data-test="mail-out-send"]').click()
  const done = p.locator('[data-test="mail-out"][data-state="sent"]').last()
  await expect(done).toBeVisible({ timeout: 30_000 })
  await expect(done).toContainText('보냈어요')
  await expect(done).toContainText('받은 메일의 스레드에 이어서')
  await expect(done.locator('[data-test="mail-out-send"]')).toHaveCount(0)
  expect(gmail.sends.length).toBe(1)
  const sent = gmail.sends[0].toString('utf8')
  expect(JSON.parse(/\r\n\r\n(\{.*?\})\r\n/s.exec(sent)[1]).threadId, '받은 메일의 스레드로').toBe(THREAD)
  const { simpleParser } = req('mailparser')
  const mail = await simpleParser(gmail.sends[0].subarray(gmail.sends[0].indexOf('message/rfc822') + 'message/rfc822\r\n\r\n'.length))
  expect(mail.from.value[0].address, '보낸 사람은 연결한 내 주소').toBe(ME.email)
  expect(mail.to.value[0].address).toBe(CUSTOMER.address)
  expect(mail.inReplyTo).toBe('<cust-1@customer.example>')
  expect(mail.text).toContain('품번: 900101')
  // the company's shared account: nobody reached it, and the agent was told to hide its mail tool
  expect(smtp.hits, '회사 공용 발송 계정에 닿은 연결').toBe(0)
  for (const b of agent.bodies) expect(b.metadata?.hidden_tools).toContain('send_email')
  // a second press (another tab, an old screen) does not mail it twice
  const id = (await S.q(`select id from pro_messages where thread_id=$1 and kind='mail_out' order by created_at desc limit 1`, [(await chatOf(ME)).id]))[0].id
  const again = await fetch(`http://127.0.0.1:${S.apiPort}/api/mail-out/${id}/send`, { method: 'POST', headers: { Authorization: `Bearer ${ME.token}`, 'Content-Type': 'application/json' }, body: '{}' })
  expect(again.status).toBe(409)
  expect(gmail.sends.length).toBe(1)
  await done.scrollIntoViewIfNeeded()
  await p.screenshot({ path: path.join(SHOTS, 'F-MY-03-sent.png') })
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-MY-04 메일을 연결하지 않은 사람 — 「연결하기」 · 「초안으로 두기」, 아무것도 나가지 않는다', async ({ browser }) => {
  const p = await pageOf(browser, NOMAIL)
  await p.goto('/chat')
  await composer(p).waitFor()
  const before = gmail.sends.length
  await say(p, PASTE.replace('품번: 90101', '품번: 900102').replace('정하윤입니다.', '박도윤입니다.').replace('정하윤 드림', '박도윤 드림'))
  const box = p.locator('[data-test="mail-out"][data-state="pending"]').last()
  await expect(box).toBeVisible({ timeout: 60_000 })
  await expect(box.locator('[data-test="mail-out-notice"]')).toContainText('메일을 연결하면 내 계정으로 보낼 수 있어요')
  await expect(box.locator('[data-test="mail-out-from"]')).toContainText('연결된 내 메일이 없어요')
  await expect(box.locator('[data-test="mail-out-send"]')).toHaveCount(0)
  await box.scrollIntoViewIfNeeded()
  await p.screenshot({ path: path.join(SHOTS, 'F-MY-04-connect.png') })
  await box.locator('[data-test="mail-out-connect"]').click()
  await expect(p.getByText('메일 연결').first()).toBeVisible()
  await p.keyboard.press('Escape')
  await p.locator('button[aria-label="닫기"]').first().click().catch(() => {})
  await box.locator('[data-test="mail-out-keep"]').click()
  await expect(p.locator('[data-test="mail-out"][data-state="kept"]').last()).toContainText('초안으로 두었어요')
  expect(gmail.sends.length).toBe(before)
  expect(smtp.hits).toBe(0)
  expect(p.errors).toEqual([])
  await p.context().close()
})

for (const theme of ['light', 'dark']) {
  test(`F-MY-05 휴대폰 390px ${theme === 'dark' ? '밤' : '밝은'} 테마 — 카드가 화면 안, 옆으로 넘치지 않는다`, async ({ browser }) => {
    const p = await pageOf(browser, NOMAIL, PHONE, theme)
    await p.goto('/chat')
    // (a phone opens on Home: the top bar's 채팅)
    await p.locator('header.top .seg button', { hasText: '채팅' }).click()
    await expect(composer(p), `화면이 그려졌다 ${p.errors.join(' | ')}`).toBeVisible({ timeout: 60_000 })
    const box = p.locator('[data-test="mail-out"]').last()
    await expect(box).toBeVisible({ timeout: 60_000 })
    await p.locator('[data-test="mail-out"][data-state="kept"] [data-test="mail-out-reopen"]').last().click()
    const open = p.locator('[data-test="mail-out"][data-state="pending"]').last()
    await expect(open).toBeVisible()
    await open.scrollIntoViewIfNeeded()
    const r = await open.boundingBox()
    expect(r.x).toBeGreaterThanOrEqual(0)
    expect(r.x + r.width).toBeLessThanOrEqual(390 + 1)
    await noOverflow(p)
    await p.screenshot({ path: path.join(SHOTS, `F-MY-05-phone-${theme}.png`) })
    // back to the kept draft for the next run
    await open.locator('[data-test="mail-out-keep"]').click()
    await expect(p.locator('[data-test="mail-out"][data-state="kept"]').last()).toBeVisible()
    expect(p.errors).toEqual([])
    await p.context().close()
  })
}
