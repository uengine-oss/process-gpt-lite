// 내가 보낸 메일은 Home 카드가 되지 않는다 (lib/mailSelf.js · lib/mail.js pollUser, 스펙 openspec/specs/mail-card-actions). 2026-11-26 운영
// (휴대폰 Home): 사용자가 고객에게 보낸 메일이 받은 메일처럼 읽혀 자기에게 답장하라는 「답장」 카드와 자기 첨부를 검토하라는 「검토」 카드가
// 되었다 — 「이 메일은 내가 보낸건데 왜 내가 받은걸로 뜨는건가.」
// 실제 서버(index.js) · 실제 DB, Google 자리는 가짜(fixtures/fake-google.mjs — 동의 화면 · 토큰 · Gmail 메일함 · 스레드 · send-as), 모델 자리는
// 가짜 메일 비서(받은 메일마다 답장 카드를 만드는 — 누가 보냈는지 모르면 실제 모델도 그렇게 했다). 실제 메일 · 실제 Google 없음.
//   - Gmail: 「휴대폰에서 연결」로 Lite 주소와 다른 Google 계정을 연결하고, 메일함을 읽으면 내 회사 주소에서 고객에게 보낸 사본(SENT 없음) ·
//     send-as 별칭으로 보낸 것은 카드가 없고 메일 비서도 읽지 않는다(읽은 것으로 남고 보관함에는 있다). 스레드에서 원래 보낸 사람에게 간 내
//     답장이 더 나중인 메일은 답장 카드 없이 다른 카드만 — 그 메일이 요청한 문서의 초안은 회신 카드가 아니라 검토 카드로. 같은 이름의 다른
//     주소 · 고객의 메일 · 나에게만 쓴 메모 · 그룹이 「… via 다온 영업」으로 다시 쓴 고객 글 · 별칭으로 다루지 않는 그룹 주소는 그대로 카드.
//     다시 읽어도 되살아나지 않는다.
//   - 데모 메일함: 내 Lite 주소에서 나에게만 온 연습 메일(받는 사람이 나뿐)도 읽을 메일로 카드, 고객의 연습 메일도 카드.
//   MO_BFF_PORT=8965 node test/mail-own-sent.e2e.mjs
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { startFakeGoogle } from './fixtures/fake-google.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const BFF = Number(process.env.MO_BFF_PORT || 8795)
const base = `http://127.0.0.1:${BFF}`, api = `${base}/api`
const TENANT = 'pro-mailself-e2e'
// the people and companies are made up (*.example.test)
const EMAIL = { gmail: 'pro-mailself-gmail@daon.example.test', demo: 'pro-mailself-demo@daon.example.test' }
const NAME = '한서윤'
const GOOGLE = 'seoyun.han@inbox.example.test' // the Google account connected: not the Lite address
const ALIAS = 'sales@daon.example.test' // a send-as alias of that account
const GROUP = 'help@daon.example.test' // a group address the account may send as, not treated as an alias
const CUSTOMER = '"오하늘" <haneul@vendor.example.test>'
const PARTNER = '"강도윤" <doyun@partner.example.test>'
const CLIENT = 'env-client.apps.googleusercontent.com'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`); await sleep(150) } }

const fake = await startFakeGoogle({ clients: { [CLIENT]: 'env-secret' } })
// the mail assistant: a reply card for every mail it is given (as the real one did with the person's own mail), and for a mail answered since
// a review card more and the quote it asks for (to see that only the reply card goes, and the draft comes on a review card); the brief names
// how many it read
const llm = { triage: [] }
const model = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(raw) } catch { /* empty */ }
    const sys = String(body.messages?.[0]?.content || '')
    let content = '{}'
    if (sys.startsWith("You read a user's newest emails")) {
      const mails = JSON.parse(body.messages?.[1]?.content || '[]')
      llm.triage.push(mails)
      const who = (from) => /^"?([^"<]+?)"?\s*</.exec(String(from))?.[1] || String(from)
      content = JSON.stringify({
        actions: mails.flatMap((m) => [
          { mail_id: m.id, verb: 'Reply', kind: 'reply', text: `${who(m.from)}님께 「${m.subject}」 회신`, icon_domain: '', due: null, prompt: '회신해 줘' },
          ...(m.answered ? [{ mail_id: m.id, verb: 'Review', kind: 'task', text: `「${m.subject}」 첨부 검토`, icon_domain: '', due: null, prompt: '검토해 줘' }] : []),
        ]),
        brief: `새 메일 ${mails.length}통을 읽었어요.`,
        drafts: mails.filter((m) => m.answered).map((m) => ({ mail_id: m.id, customer: '파트너상사', items: [{ kind: '견적서', format: 'xlsx', name: '파트너상사 견적서.xlsx' }], summary: '견적서' })),
      })
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] }))
  })
})
await new Promise((r) => model.listen(0, '127.0.0.1', r))
const folders = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-mailself-folders-'))
Object.assign(process.env, {
  PRO_PORT: String(BFF), PRO_PUBLIC_URL: base, PRO_BACKGROUND: '0', PRO_CONTEXT_ROUTER_URL: '', PRO_TENANT_ID: TENANT, PRO_TENANT_FROM_HEADER: '0', PRO_TENANT_HOSTS: '',
  GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 'env-secret', ...fake.env,
  PRO_LLM_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, PRO_LLM_API_KEY: 'test', PRO_LLM_MODEL: 'fake', PRO_LLM_FAST_MODEL: 'fake', PRO_JUDGE_URL: '',
  PRO_ONTOLOGY_BOLT_URL: '', PRO_DEEPAGENTS_URL: 'http://127.0.0.1:9', PRO_MEMENTO_URL: 'http://127.0.0.1:9', PRO_COMPLETION_URL: 'http://127.0.0.1:9', PRO_MCP_HUB_URL: 'http://127.0.0.1:9',
  PRO_DEMO_LOGIN: '1', PRO_SCENARIOS: 'off', PRO_FOLDERS_ROOT: folders,
})
process.chdir(path.resolve(here, '..'))
const { q, pool, admin: supa } = await import('../lib/supa.js')

const users = {}
async function cleanup() {
  const ids = (await q('select id from users where tenant_id=$1', [TENANT]).catch(() => [])).map((r) => r.id)
  const listed = await supa.auth.admin.listUsers({ page: 1, perPage: 1000 }).catch(() => ({ data: { users: [] } }))
  for (const u of listed.data?.users || []) if (Object.values(EMAIL).includes(u.email)) ids.push(u.id)
  for (const id of new Set(ids)) {
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [id]).catch(() => {})
    for (const t of ['pro_threads', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_mail_accounts', 'pro_mail_seen', 'pro_demo_mail', 'pro_profile', 'pro_actions', 'context_threads'])
      await q(`delete from ${t} where user_id=$1`, [id]).catch(() => {})
    await q('delete from pro_mail_archive where owner_id=$1', [id]).catch(() => {})
    await q('delete from pro_mining_cases where user_id=$1', [id]).catch(() => {})
    await q('delete from users where id=$1', [id]).catch(() => {})
  }
  await q('delete from handover_events where tenant_id=$1', [TENANT]).catch(() => {})
  await q('delete from pro_mining_cases where tenant_id=$1', [TENANT]).catch(() => {})
  await q('delete from users where tenant_id=$1', [TENANT]).catch(() => {})
  await q('delete from tenants where id=$1', [TENANT]).catch(() => {})
  for (const u of listed.data?.users || []) if (Object.values(EMAIL).includes(u.email)) await supa.auth.admin.deleteUser(u.id).catch(() => {})
}
const call = (who, p, { method = 'GET', body, headers = {} } = {}) => fetch(`${api}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users[who].session.access_token}`, ...headers }, body: body ? JSON.stringify(body) : undefined })
const json = async (r) => { const t = await r.text(); try { return JSON.parse(t) } catch { return t } }

before(async () => {
  await cleanup()
  await q(`insert into tenants (id, owner, mcp) values ($1, null, '{"mcpServers":{}}') on conflict (id) do update set owner = null, is_deleted = false`, [TENANT])
  await import('../index.js')
  await until(() => fetch(`${api}/config`).then((r) => r.ok), 'BFF')
  for (const who of Object.keys(EMAIL)) {
    const r = await fetch(`${api}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL[who], code: '000000' }) })
    users[who] = await r.json()
    assert.ok(users[who]?.session?.access_token, JSON.stringify(users[who]))
    await call(who, '/profile', { method: 'POST', body: { name: NAME, birth: '1990-01-01', onboarded: true } })
  }
})

after(async () => {
  await cleanup()
  await fake.close(); model.close()
  fs.rmSync(folders, { recursive: true, force: true })
  await pool.end().catch(() => {})
  setTimeout(() => process.exit(process.exitCode || 0), 300)
})

test('Gmail: 내 회사 주소 · send-as 별칭으로 고객에게 보낸 메일은 카드가 없고 메일 비서도 읽지 않는다, 내가 이미 답한 메일은 답장 카드 없이(문서 초안은 검토 카드로), 나에게 쓴 메모 · 그룹이 다시 쓴 고객 글 · 그룹 주소 · 같은 이름의 다른 주소 · 고객은 카드', async () => {
  const now = Date.now()
  const min = (m) => now - m * 60_000
  // the account's aliases: sales@ (an alias) and help@ (a group it sends "on behalf of" — not treated as an alias)
  fake.mailbox.sendAs = [{ sendAsEmail: ALIAS, displayName: '다온 영업', treatAsAlias: true, verificationStatus: 'accepted' },
    { sendAsEmail: GROUP, displayName: '다온 고객지원', treatAsAlias: false, verificationStatus: 'accepted' }]
  fake.mailbox.messages = [
    // what happened in production: sent from the company address (another mail system) to a customer with the connected Gmail in Cc — no SENT label
    { id: 'mo-company', threadId: 't-company', from: `"${NAME}" <${EMAIL.gmail}>`, to: CUSTOMER, cc: GOOGLE, subject: '11월 활동 보고서와 사업 전략 자료 보내 드립니다', text: '11월 활동 보고서와 사업 전략 자료를 보내 드립니다. 검토 부탁드립니다.', labels: ['INBOX', 'IMPORTANT'], at: min(40) },
    // sent as the account's alias to a customer — no SENT label
    { id: 'mo-alias', threadId: 't-alias', from: `"다온 영업" <${ALIAS}>`, to: CUSTOMER, subject: '12월 교육 일정 안내', text: '12월 교육 일정을 안내드립니다.', labels: ['INBOX'], at: min(35) },
    // sent from the connected Gmail with myself in Cc: Gmail files it as SENT (and INBOX) — the list leaves it out
    { id: 'mo-selfcc', threadId: 't-selfcc', from: `"${NAME}" <${GOOGLE}>`, to: PARTNER, cc: GOOGLE, subject: '회의록 공유', text: '오늘 회의록을 공유합니다.', labels: ['SENT', 'INBOX'], at: min(30) },
    // a partner's mail asking for a quote, which I have answered since (my reply to the partner, from the Gmail: SENT) …
    { id: 'mo-answered', threadId: 't-answered', from: PARTNER, to: GOOGLE, subject: '견적서 요청', text: '30명 기준 견적서를 부탁드립니다.', labels: ['INBOX'], at: min(25) },
    { id: 'mo-answered-reply', threadId: 't-answered', from: `"${NAME}" <${GOOGLE}>`, to: PARTNER, subject: 'Re: 견적서 요청', text: '확인했습니다. 내일 견적서 보내 드리겠습니다.', labels: ['SENT'], at: min(20) },
    // a note to myself from the company system (to the connected Gmail only): mail to read
    { id: 'mo-note', threadId: 't-note', from: `"${NAME}" <${EMAIL.gmail}>`, to: GOOGLE, subject: '내일 할 일 메모', text: '내일 오전 견적 검토하기.', labels: ['INBOX'], at: min(15) },
    // a customer's post to the group sales@, rewritten "via" the group (From is the alias, Reply-To the customer)
    { id: 'mo-via', threadId: 't-via', from: `"오하늘 via 다온 영업" <${ALIAS}>`, to: ALIAS, cc: '"오하늘 팀" <team@vendor.example.test>', replyTo: CUSTOMER, xOriginalSender: 'haneul@vendor.example.test', subject: '교육 신청 문의', text: '12월 교육에 3명 신청하고 싶습니다.', labels: ['INBOX'], at: min(12) },
    // a colleague's answer to a customer as the help@ group (a group the account sends "on behalf of", not an alias of mine)
    { id: 'mo-group', threadId: 't-group', from: `"다온 고객지원" <${GROUP}>`, to: CUSTOMER, subject: 'Re: 설치 문의', text: '설치 안내를 드립니다.', labels: ['INBOX'], at: min(10) },
    // someone with the same name at an address that is not mine
    { id: 'mo-namesake', threadId: 't-namesake', from: `"${NAME}" <seoyun@other-company.example.test>`, to: GOOGLE, subject: '세미나 발표 요청', text: '다음 달 세미나 발표를 부탁드려도 될까요?', labels: ['INBOX'], at: min(8) },
    // a customer's mail
    { id: 'mo-customer', threadId: 't-customer', from: CUSTOMER, to: GOOGLE, subject: '견적 문의', text: '30명 기준 견적을 부탁드립니다.', labels: ['INBOX'], at: min(5) },
  ]
  // 「휴대폰에서 연결」 with a Google account that is not the Lite address
  const r = await fetch(`${api}/auth/google/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${users.gmail.session.access_token}`, Origin: base }, body: JSON.stringify({ mode: 'phone', origin: base }) })
  assert.equal(r.status, 200, await r.clone().text())
  const cookie = /pgpt-oauth-state=([^;]+)/.exec(r.headers.get('set-cookie') || '')?.[1]
  const back = await fake.approve((await r.json()).url, GOOGLE)
  const ok = await fetch(back, { redirect: 'manual', headers: { Cookie: `pgpt-oauth-state=${cookie}` } })
  assert.equal(ok.status, 302)
  const me = await json(await call('gmail', '/me'))
  assert.deepEqual([me.user.email, me.mail.provider, me.mail.address], [EMAIL.gmail, 'gmail', GOOGLE])

  // the mailbox is read (as the poller does; the connection's own first read comes later and finds nothing new)
  const polled = await json(await call('gmail', '/mail/poll', { method: 'POST' }))
  assert.deepEqual(polled, { fresh: 8, actions: 6, own: 2, answered: 1 }, JSON.stringify(polled))
  // the mail assistant never read my own mail; the answered one came marked
  assert.equal(llm.triage.length, 1)
  assert.deepEqual(llm.triage[0].map((m) => [m.id, !!m.answered]),
    [['mo-customer', false], ['mo-namesake', false], ['mo-group', false], ['mo-via', false], ['mo-note', false], ['mo-answered', true]])
  // Home: a reply card for each mail to read, only the review card of the answered mail — and its quote draft on a review card, not a reply card
  const draftCard = await until(async () => (await json(await call('gmail', '/actions'))).find((a) => a.source?.drafted), '견적서 초안 카드')
  assert.deepEqual([draftCard.source.mail_id, draftCard.verb, draftCard.source.kind, draftCard.source.drafts, draftCard.source.drafted], ['mo-answered', 'Review', 'task', undefined, ['파트너상사 견적서.xlsx']])
  assert.equal(draftCard.text, '파트너상사 견적서 초안 검토')
  const cards = await json(await call('gmail', '/actions'))
  assert.deepEqual(cards.map((a) => [a.source?.mail_id, a.verb, a.source?.drafted ? 'draft' : 'triage']).sort(), [
    ['mo-answered', 'Review', 'draft'], ['mo-answered', 'Review', 'triage'], ['mo-customer', 'Reply', 'triage'], ['mo-group', 'Reply', 'triage'],
    ['mo-namesake', 'Reply', 'triage'], ['mo-note', 'Reply', 'triage'], ['mo-via', 'Reply', 'triage']])
  assert.ok(!cards.some((a) => ['mo-company', 'mo-alias', 'mo-selfcc'].includes(a.source?.mail_id)), '내가 보낸 메일의 카드는 없다')
  // 대화 › 메일 (the messenger's 메일 chip): the same
  const inbox = await json(await call('gmail', '/mail/cards'))
  assert.deepEqual([...new Set(inbox.map((a) => a.source?.mail_id))].sort(), ['mo-answered', 'mo-customer', 'mo-group', 'mo-namesake', 'mo-note', 'mo-via'])
  // my own mail is read (it does not come back) and kept in the archive with its labels
  const uid = users.gmail.user.id
  const seen = (await q('select mail_id from pro_mail_seen where user_id=$1', [uid])).map((x) => x.mail_id).sort()
  assert.deepEqual(seen, ['mo-alias', 'mo-answered', 'mo-company', 'mo-customer', 'mo-group', 'mo-namesake', 'mo-note', 'mo-via'])
  const arch = await q('select mail_id, from_addr, labels from pro_mail_archive where owner_id=$1 and mail_id = any($2)', [uid, ['mo-company', 'mo-alias']])
  assert.equal(arch.length, 2)
  // the brief's chips point at the triage's cards only
  const [brief] = await q(`select m.content from pro_messages m join pro_threads t on t.id = m.thread_id where t.user_id=$1 and m.kind='text' and m.content->>'text' like '새 메일 %' order by m.created_at desc limit 1`, [uid])
  assert.deepEqual(brief.content.text, '새 메일 6통을 읽었어요.')
  assert.deepEqual([...new Set(brief.content.mails.map((c) => c.mailId))].sort(), ['mo-answered', 'mo-customer', 'mo-group', 'mo-namesake', 'mo-note', 'mo-via'])
  // Gmail was asked who the account sends as, and the thread of each mail to read (From · To · Cc, with the connection's token)
  assert.ok(fake.mailbox.log.some((p) => p.startsWith('/settings/sendAs')), fake.mailbox.log.join('\n'))
  assert.ok(fake.mailbox.log.some((p) => p.startsWith('/threads/t-answered?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc')))
  assert.ok(!fake.mailbox.log.some((p) => p.startsWith('/threads/t-company')), '내 메일의 스레드는 읽지 않는다')

  // read again: nothing new, no card comes back
  const again = await json(await call('gmail', '/mail/poll', { method: 'POST' }))
  assert.deepEqual(again, { fresh: 0 })
  assert.equal((await json(await call('gmail', '/actions'))).length, 7)
})

test('데모 메일함: 내 Lite 주소에서 나에게만 온 연습 메일(받는 사람이 나뿐 — 나에게 쓴 메모)도 읽을 메일로 카드, 고객의 연습 메일도 카드', async () => {
  // the demo mailbox, as 「데모 메일함」 connects it (its address is the Lite address) — without the connection's own read six seconds later
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'demo',$2) on conflict (user_id) do update set provider='demo', address=$2`, [users.demo.user.id, EMAIL.demo])
  // the sample mails of the demo mailbox are read first (their cards are not what this test is about)
  await json(await call('demo', '/mail/poll', { method: 'POST' }))
  const n = llm.triage.length
  // a demo mail is a mail to the demo mailbox: from my own Lite address it is a note to myself — read, not taken for mail I sent
  const note = await json(await call('demo', '/mail/demo-arrive', { method: 'POST', body: { from: `"${NAME}" <${EMAIL.demo}>`, subject: '내일 할 일 메모', text: '내일 오전 견적 검토하기.' } }))
  assert.deepEqual([note.fresh, note.actions, note.own], [1, 1, undefined], JSON.stringify(note))
  const theirs = await json(await call('demo', '/mail/demo-arrive', { method: 'POST', body: { from: CUSTOMER, subject: '납품 일정 문의', text: '납품 일정을 알려 주세요.' } }))
  assert.equal(theirs.actions, 1, JSON.stringify(theirs))
  assert.deepEqual(llm.triage.slice(n).map((ms) => ms.map((m) => m.subject)), [['내일 할 일 메모'], ['납품 일정 문의']])
  const cards = await json(await call('demo', '/actions'))
  assert.ok(cards.some((a) => a.source?.subject === '납품 일정 문의'))
  assert.ok(cards.some((a) => a.source?.subject === '내일 할 일 메모'))
})
