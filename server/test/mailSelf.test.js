// 내가 보낸 메일은 내 할 일이 아니다 (lib/mailSelf.js, 스펙 openspec/specs/mail-card-actions). 2026-11-26 운영(휴대폰 Home): 사용자가
// 고객에게 보낸 메일이 받은 메일처럼 읽혀 「답장 · <자기 이름>님께 … 잘 받았다고 회신」 · 「검토 · <자기 이름>님의 … 자료 검토」 카드가
// 되었다 — 「이 메일은 내가 보낸건데 왜 내가 받은걸로 뜨는건가.」 Gmail 목록은 보낸편지함을 빼지만(-in:sent), 그 사람의 다른 주소
// (회사 주소에서 연결한 Gmail 을 참조로, send-as 별칭)로 보낸 메일의 사본에는 SENT 라벨이 없다.
// 검토(PR #80)로 좁힌 것: 별칭은 Gmail 이 별칭으로 다루는 것만, 별칭으로만 맞는 메일은 Reply-To · X-Original-Sender 가 남이면 남의 메일
// (그룹 주소로 다시 쓴 고객 글 「… via 영업」 · 공용 주소로 보낸 동료 메일), SENT 가 없으면 나 말고 다른 받는 사람이 있어야 내 메일(나에게
// 쓴 메모 · From 을 내 주소로 바꿔 전달하는 규칙은 읽을 메일), 「이미 답함」은 원래 보낸 사람에게 간 내 나중 메일만(동료에게 전달 ·
// 예약 발송 · 스팸 · 휴지통은 아님).
// 이 파일은 DB · Google 없이 Gmail 모양의 고정물로. (메일함을 읽어 Home 카드를 만드는 전체 길은 test/mail-own-sent.e2e.mjs, 이미 답한
// 메일의 문서 초안 · 지도 · 프로세스 마이닝은 test/mailSelf.integration.test.js.) 사람 · 회사 · 주소는 지어낸 것이다(*.example.test).
import test from 'node:test'
import assert from 'node:assert/strict'

const S = await import('../lib/mailSelf.js')

const ME = { lite: 'seoyun@daon.example.test', gmail: 'seoyun.han@inbox.example.test', alias: 'sales@daon.example.test' }
const CUSTOMER = '"오하늘" <haneul@vendor.example.test>'
const COLLEAGUE = '"윤가람" <garam@daon.example.test>'
// the person: own addresses (the connected Gmail, the Lite address) and one send-as alias
const me = S.addressBook([ME.gmail, ME.lite], [ME.alias])
// a message as Gmail's API gives it (users.messages.get / users.threads.get format=metadata)
const gm = (id, { from, to = '', cc = '', replyTo = '', xos = '', labels = ['INBOX'], at = 0, thread = 't' } = {}) => ({ id, threadId: thread, labelIds: labels, internalDate: String(at),
  payload: { headers: [['From', from], ['To', to], ['Cc', cc], ['Reply-To', replyTo], ['X-Original-Sender', xos], ['Subject', `제목 ${id}`]].filter(([, v]) => v).map(([name, value]) => ({ name, value })) } })
// the same mail as the intake (lib/mail.js fetchGmail) hands it on
const fetched = (m) => {
  const h = Object.fromEntries(m.payload.headers.map((x) => [x.name.toLowerCase(), x.value]))
  return { id: m.id, thread: m.threadId, from: h.from, to: h.to, cc: h.cc, replyTo: h['reply-to'], xOriginalSender: h['x-original-sender'], labels: m.labelIds }
}

test('보낸 사람 주소 · 받는 사람 목록: 표시 이름 · 꺾쇠 · 대소문자를 걷어 낸 주소, 이름 안의 쉼표로는 나누지 않는다', () => {
  assert.equal(S.addrOf('"한서윤" <Seoyun@Daon.Example.Test>'), 'seoyun@daon.example.test')
  assert.equal(S.addrOf('seoyun@daon.example.test'), 'seoyun@daon.example.test')
  assert.equal(S.addrOf('=?UTF-8?B?7ZWc7ISc7Jyk?= <seoyun@daon.example.test>'), 'seoyun@daon.example.test')
  assert.equal(S.addrOf('"Han, Seoyun <home>" <seoyun.han@inbox.example.test>'), 'seoyun.han@inbox.example.test', '꺾쇠는 마지막 것이 주소')
  for (const x of ['', null, undefined, 'undisclosed-recipients:;', '한서윤', '한서윤 <not an address>']) assert.equal(S.addrOf(x), '', String(x))
  assert.deepEqual(S.addrsOf('"Oh, Haneul" <Haneul@Vendor.example.test>, garam@daon.example.test,  "윤, 가람" <x@y.example.test>'),
    ['haneul@vendor.example.test', 'garam@daon.example.test', 'x@y.example.test'])
  assert.deepEqual(S.addrsOf(['a@b.example.test', '"C" <c@d.example.test>, e@f.example.test', null]), ['a@b.example.test', 'c@d.example.test', 'e@f.example.test'])
  assert.deepEqual(S.addrsOf(''), [])
})

test('내 메일: SENT 라벨 · 회사 주소에서 고객에게 보낸 사본 · 별칭으로 보낸 것, 같은 이름의 다른 주소는 남의 메일', () => {
  // sent from the connected Gmail with myself in Cc: Gmail files it as SENT and INBOX — mine whatever the addresses known
  const selfCc = gm('self-cc', { from: `"한서윤" <${ME.gmail}>`, to: CUSTOMER, cc: ME.gmail, labels: ['SENT', 'INBOX', 'IMPORTANT'] })
  assert.equal(S.isOwn(selfCc, S.addressBook()), true)
  assert.equal(S.isOwn(fetched(selfCc), S.addressBook()), true, '읽어 온 모양(labels)도')
  // sent from the company address (another mail system) to a customer with the connected Gmail in Cc: no SENT label — the production case
  assert.equal(S.isOwn(fetched(gm('company-copy', { from: `"한서윤" <${ME.lite.toUpperCase()}>`, to: CUSTOMER, cc: ME.gmail })), me), true)
  // Bcc to myself: To names only the customer
  assert.equal(S.isOwn(fetched(gm('bcc-copy', { from: `"한서윤" <${ME.lite}>`, to: CUSTOMER })), me), true)
  // a send-as alias of the connected account, to a customer, nothing naming someone else
  assert.equal(S.isOwn(fetched(gm('alias', { from: `"다온 영업" <${ME.alias}>`, to: CUSTOMER })), me), true)
  // my own address with a Reply-To elsewhere is still mine (only an alias match needs more)
  assert.equal(S.isOwn(fetched(gm('own-reply-to', { from: `<${ME.lite}>`, to: CUSTOMER, replyTo: 'support@daon-helpdesk.example.test' })), me), true)
  // someone else
  assert.equal(S.isOwn(fetched(gm('customer', { from: CUSTOMER, to: ME.gmail })), me), false)
  // the same display name at an address that is not mine: not taken for me (someone else may have the same name)
  assert.equal(S.isOwn(fetched(gm('namesake', { from: '"한서윤" <seoyun@other-company.example.test>', to: ME.gmail })), me), false)
  // a plain Set (all own addresses) works too
  assert.equal(S.isOwn(fetched(gm('set', { from: `<${ME.lite}>`, to: CUSTOMER })), new Set([ME.lite])), true)
  assert.equal(S.isOwn({ id: 'x' }, me), false)
  assert.equal(S.isOwn(null, me), false)
})

test('나에게만 간 메일은 읽을 메일: 나에게 쓴 메모 · From 을 내 회사 주소로 바꿔 전달하는 규칙 — SENT 라벨이 있으면 내 메일', () => {
  // a note to self from the company system: To only my own addresses
  assert.equal(S.isOwn(fetched(gm('note', { from: `"한서윤" <${ME.lite}>`, to: ME.gmail })), me), false)
  assert.equal(S.isOwn(fetched(gm('note-cc', { from: `<${ME.lite}>`, to: ME.gmail, cc: `${ME.lite}, ${ME.alias}` })), me), false)
  // an Outlook rule forwarding company mail to the Gmail, From rewritten to my company address: every forwarded mail stays readable
  assert.equal(S.isOwn(fetched(gm('fwd-rule', { from: `"한서윤" <${ME.lite}>`, to: `"한서윤" <${ME.gmail}>` })), me), false)
  // no recipients at all (all Bcc): not proof it went to someone else
  assert.equal(S.isOwn(fetched(gm('no-to', { from: `<${ME.lite}>` })), me), false)
  // Gmail says it was sent (from the Gmail itself to myself): mine
  assert.equal(S.isOwn(fetched(gm('sent-to-self', { from: `<${ME.gmail}>`, to: ME.gmail, labels: ['SENT', 'INBOX'] })), me), true)
})

test('별칭으로만 맞으면: 그룹 주소로 다시 쓴 고객 글(「… via 다온 영업」, Reply-To · X-Original-Sender 가 고객) · 공용 주소로 보낸 동료 메일은 남의 메일', () => {
  // a customer's post to the group sales@, rewritten by the group for DMARC: From is the group, Reply-To the customer
  const via = gm('via', { from: `"오하늘 via 다온 영업" <${ME.alias}>`, to: ME.alias, cc: '"오하늘 팀" <team@vendor.example.test>', replyTo: CUSTOMER, xos: 'haneul@vendor.example.test' })
  assert.equal(S.isOwn(fetched(via), me), false)
  assert.equal(S.isOwn(via, me), false, 'Gmail 모양(payload.headers)도')
  // only X-Original-Sender names the customer
  assert.equal(S.isOwn(fetched(gm('via-xos', { from: `"오하늘 via 다온 영업" <${ME.alias}>`, to: 'team@vendor.example.test', xos: 'haneul@vendor.example.test' })), me), false)
  // a colleague sending as the shared alias: the group names them as the original sender
  assert.equal(S.isOwn(fetched(gm('colleague-as-alias', { from: `"다온 영업" <${ME.alias}>`, to: CUSTOMER, xos: 'garam@daon.example.test' })), me), false)
  // Reply-To that is mine keeps it mine
  assert.equal(S.isOwn(fetched(gm('alias-reply-me', { from: `<${ME.alias}>`, to: CUSTOMER, replyTo: ME.lite })), me), true)
})

// a fake Gmail for gmailSendAs · answeredOf: the requests it got, and a reply per path
function fakeGmail(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: u.searchParams.getAll('metadataHeaders'), auth: init.headers?.Authorization, signal: !!init.signal })
    const hit = Object.entries(routes).find(([p]) => u.pathname.endsWith(p)) || Object.entries(routes).find(([p]) => p.endsWith('/') && u.pathname.includes(p))
    if (!hit) return Response.json({ error: { code: 404, message: 'Requested entity was not found.' } }, { status: 404 })
    const v = typeof hit[1] === 'function' ? hit[1]() : hit[1]
    if (v instanceof Error) throw v
    return v.status ? Response.json(v.body || {}, { status: v.status }) : Response.json(v)
  }
  return { calls, fetch }
}
const API = 'https://gmail.fake.example.test/gmail/v1/users/me'
async function withFetch(fake, fn) {
  const real = globalThis.fetch
  globalThis.fetch = fake.fetch
  try { return await fn() } finally { globalThis.fetch = real }
}

test('send-as 주소: 기본 주소는 내 주소, 별칭으로 다루는 확인된 주소만 별칭(그룹 · 대신 보내기 · 확인 대기는 아님) · 사람과 메일함마다 한 시간 기억 · 거절하면 빈 목록', async () => {
  const fake = fakeGmail({ '/settings/sendAs': { sendAs: [
    { sendAsEmail: ME.gmail, displayName: '한서윤', isPrimary: true, isDefault: true },
    { sendAsEmail: 'Sales@Daon.example.test', displayName: '다온 영업', treatAsAlias: true, verificationStatus: 'accepted' },
    { sendAsEmail: 'help@daon.example.test', displayName: '다온 고객지원(그룹)', treatAsAlias: false, verificationStatus: 'accepted' },
    { sendAsEmail: 'waiting@elsewhere.example.test', treatAsAlias: true, verificationStatus: 'pending' },
  ] } })
  await withFetch(fake, async () => {
    const got = await S.gmailSendAs('u-send-as', 'at-1', { api: API, account: ME.gmail })
    assert.deepEqual([got.own, got.aliases], [[ME.gmail], [ME.alias]])
    await S.gmailSendAs('u-send-as', 'at-1', { api: API, account: ME.gmail })
    // another mailbox connected by the same person: asked again
    await S.gmailSendAs('u-send-as', 'at-1', { api: API, account: 'other@inbox.example.test' })
  })
  assert.equal(fake.calls.length, 2, '같은 사람 · 같은 메일함은 기억한 것')
  assert.equal(fake.calls[0].auth, 'Bearer at-1')
  assert.equal(fake.calls[0].path, '/gmail/v1/users/me/settings/sendAs')
  assert.ok(fake.calls.every((c) => c.signal), '시간 제한이 있다')
  // a grant Gmail refuses (403) and a network failure: nothing, and the intake goes on
  await withFetch(fakeGmail({ '/settings/sendAs': { status: 403, body: { error: { message: 'Request had insufficient authentication scopes.' } } } }), async () => {
    assert.deepEqual(await S.gmailSendAs('u-refused', 'at-2', { api: API }), { own: [], aliases: [] })
  })
  await withFetch(fakeGmail({ '/settings/sendAs': () => new Error('ECONNRESET') }), async () => {
    assert.deepEqual(await S.gmailSendAs('u-offline', 'at-3', { api: API }), { own: [], aliases: [] })
  })
})

test('스레드: 원래 보낸 사람에게 간 내 나중 메일이면 이미 답함 — 동료에게 전달 · 초안 · 예약 발송 · 스팸 · 휴지통 · 상대의 더 나중 메일 · 읽지 못한 스레드는 아님', async () => {
  const mine = (id, at, thread, { to = CUSTOMER, cc = '', labels = ['SENT'], from = `"한서윤" <${ME.gmail}>` } = {}) => gm(id, { from, to, cc, labels, at, thread })
  const theirs = (id, at, thread, extra = {}) => gm(id, { from: CUSTOMER, to: ME.gmail, at, thread, ...extra })
  const threads = {
    t1: [theirs('m1', 100, 't1'), mine('r1', 200, 't1')], // my reply (SENT) to the customer
    t2: [theirs('m2', 100, 't2'), mine('d2', 200, 't2', { labels: ['DRAFT'] })], // a draft
    t3: [mine('s3', 100, 't3'), theirs('m3', 200, 't3')], // the customer's answer is the newest — waiting for me
    t4: [theirs('m4', 100, 't4'), mine('r4', 200, 't4', { from: `"한서윤" <${ME.lite}>`, labels: ['INBOX'] })], // my reply from the company address (a copy without SENT)
    // two mails of the customer's with my reply between them: the first is answered, the second is not
    t6: [theirs('m6a', 100, 't6'), mine('r6', 150, 't6', { from: `<${ME.alias}>` }), theirs('m6b', 300, 't6')],
    t7: [mine('r7', 900, 't7'), theirs('m7', 100, 't7')], // the order Gmail gave is not trusted over the time each arrived
    t8: [theirs('m8', 100, 't8'), mine('f8', 200, 't8', { to: COLLEAGUE })], // forwarded to a colleague — not an answer
    t9: [theirs('m9', 100, 't9'), mine('s9', 200, 't9', { labels: ['SCHEDULED'] })], // a scheduled send, not sent yet
    t10: [theirs('m10', 100, 't10'), mine('x10', 200, 't10', { labels: ['SENT', 'TRASH'] }), mine('y10', 300, 't10', { labels: ['SPAM'] })],
    t11: [theirs('m11', 100, 't11'), mine('c11', 200, 't11', { to: COLLEAGUE, cc: CUSTOMER })], // the customer in Cc of my mail: an answer
    // a group post rewritten "via" the group: my answer goes to its Reply-To
    t12: [gm('m12', { from: `"오하늘 via 다온 영업" <${ME.alias}>`, to: ME.alias, replyTo: CUSTOMER, xos: 'haneul@vendor.example.test', at: 100, thread: 't12' }), mine('r12', 200, 't12')],
  }
  const routes = Object.fromEntries(Object.entries(threads).map(([id, messages]) => [`/threads/${id}`, { id, messages }]))
  const fake = fakeGmail(routes)
  const mails = ['m1', 'm2', 'm3', 'm4', 'm6a', 'm6b', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'].map((id) => fetched(Object.values(threads).flat().find((x) => x.id === id)))
  // t5 is not found (a thread removed since)
  mails.push({ id: 'm5', thread: 't5', from: CUSTOMER, labels: ['INBOX'] })
  // a mail without a thread (IMAP, demo) is not read
  mails.push({ id: 'imap-1', from: CUSTOMER })
  const answered = await withFetch(fake, () => S.answeredOf(mails, me, 'at-9', { api: API }))
  assert.deepEqual([...answered].sort(), ['m1', 'm11', 'm12', 'm4', 'm6a', 'm7'])
  // one read per thread, metadata only (From · To · Cc), with the connection's token and a time limit
  assert.equal(fake.calls.length, 12)
  assert.ok(fake.calls.every((c) => c.query.format === 'metadata' && c.headers.join() === 'From,To,Cc' && c.auth === 'Bearer at-9' && c.signal))
  // Gmail not answering at all: nothing is taken as answered
  const down = await withFetch(fakeGmail({ '/threads/': () => new Error('ECONNREFUSED') }), () => S.answeredOf(mails, me, 'at-9', { api: API }))
  assert.equal(down.size, 0)
})

test('답장 카드: 메일 비서가 「reply」로 정했거나 「Reply」 단추면 답장, 그 밖의 카드는 아님', () => {
  assert.equal(S.repliesTo({ verb: 'Reply', kind: 'reply' }), true)
  assert.equal(S.repliesTo({ verb: 'Reply' }), true)
  assert.equal(S.repliesTo({ verb: 'Send', kind: 'reply' }), true)
  assert.equal(S.repliesTo({ verb: 'Review', kind: 'task' }), false)
  assert.equal(S.repliesTo({ verb: 'Add', kind: 'calendar' }), false)
  assert.equal(S.repliesTo(null), false)
})
