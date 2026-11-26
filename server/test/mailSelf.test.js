// 내가 보낸 메일은 내 할 일이 아니다 (lib/mailSelf.js, 스펙 openspec/specs/mail-card-actions). 2026-11-26 운영(휴대폰 Home): 사용자가
// 고객에게 보낸 메일이 받은 메일처럼 읽혀 「답장 · <자기 이름>님께 … 잘 받았다고 회신」 · 「검토 · <자기 이름>님의 … 자료 검토」 카드가
// 되었다 — 「이 메일은 내가 보낸건데 왜 내가 받은걸로 뜨는건가.」 Gmail 목록은 보낸편지함을 빼지만(-in:sent), 그 사람의 다른 주소
// (회사 주소에서 연결한 Gmail 을 참조로, send-as 별칭)로 보낸 메일의 사본에는 SENT 라벨이 없다.
// 이 파일은 DB · Google 없이 Gmail 모양의 고정물로: 보낸 사람 주소 읽기, 내 메일 가르기(SENT 라벨 · 별칭 · 자기 참조), Gmail 의 send-as
// 주소 읽기, 스레드에서 내 답장이 더 나중인 메일. (메일함을 읽어 Home 카드를 만드는 전체 길은 test/mail-own-sent.e2e.mjs — 실제 서버 ·
// 실제 DB · 가짜 Google · 가짜 모델.) 사람 · 회사 · 주소는 지어낸 것이다(*.example.test).
import test from 'node:test'
import assert from 'node:assert/strict'

const S = await import('../lib/mailSelf.js')

const ME = { lite: 'seoyun@daon.example.test', gmail: 'seoyun.han@inbox.example.test', alias: 'sales@daon.example.test' }
const me = new Set(Object.values(ME))
// a message as Gmail's API gives it (users.messages.get / users.threads.get format=metadata)
const gm = (id, { from, labels = ['INBOX'], at = 0, thread = 't' } = {}) => ({ id, threadId: thread, labelIds: labels, internalDate: String(at),
  payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: `제목 ${id}` }] } })
// the same mail as the intake (lib/mail.js fetchGmail) hands it on
const fetched = (m) => ({ id: m.id, thread: m.threadId, from: m.payload.headers.find((h) => h.name === 'From').value, labels: m.labelIds })

test('보낸 사람 주소: 표시 이름 · 꺾쇠 · 대소문자를 걷어 낸 주소, 주소가 아니면 빈 값', () => {
  assert.equal(S.addrOf('"한서윤" <Seoyun@Daon.Example.Test>'), 'seoyun@daon.example.test')
  assert.equal(S.addrOf('seoyun@daon.example.test'), 'seoyun@daon.example.test')
  assert.equal(S.addrOf('=?UTF-8?B?7ZWc7ISc7Jyk?= <seoyun@daon.example.test>'), 'seoyun@daon.example.test')
  assert.equal(S.addrOf('"Han, Seoyun <home>" <seoyun.han@inbox.example.test>'), 'seoyun.han@inbox.example.test', '꺾쇠는 마지막 것이 주소')
  for (const x of ['', null, undefined, 'undisclosed-recipients:;', '한서윤', '한서윤 <not an address>']) assert.equal(S.addrOf(x), '', String(x))
})

test('내 메일: SENT 라벨(Gmail 에서 나를 참조로 보낸 것 포함) · 회사 주소의 사본 · send-as 별칭, 같은 이름의 다른 주소는 남의 메일', () => {
  // sent from the connected Gmail with myself in Cc: Gmail files it as SENT and INBOX — mine whatever the addresses known
  const selfCc = gm('self-cc', { from: `"한서윤" <${ME.gmail}>`, labels: ['SENT', 'INBOX', 'IMPORTANT'] })
  assert.equal(S.isOwn(selfCc, new Set()), true)
  assert.equal(S.isOwn(fetched(selfCc), new Set()), true, '읽어 온 모양(labels)도')
  // sent from the company address (another mail system) with the connected Gmail in Cc: no SENT label, the sender is my Lite address
  assert.equal(S.isOwn(fetched(gm('company-copy', { from: `"한서윤" <${ME.lite.toUpperCase()}>` })), me), true)
  // a send-as alias of the connected account (a group sending members their own post): no SENT label
  assert.equal(S.isOwn(fetched(gm('alias', { from: `"다온 영업" <${ME.alias}>` })), me), true)
  // someone else
  assert.equal(S.isOwn(fetched(gm('customer', { from: '"오하늘" <haneul@vendor.example.test>' })), me), false)
  // the same display name at an address that is not mine: not taken for me (someone else may have the same name)
  assert.equal(S.isOwn(fetched(gm('namesake', { from: `"한서윤" <seoyun@other-company.example.test>` })), me), false)
  // no sender, no labels
  assert.equal(S.isOwn({ id: 'x' }, me), false)
  assert.equal(S.isOwn(null, me), false)
})

// a fake Gmail for gmailSendAs · answeredOf: the requests it got, and a reply per path
function fakeGmail(routes) {
  const calls = []
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), auth: init.headers?.Authorization })
    const hit = Object.entries(routes).find(([p]) => u.pathname.includes(p))
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

test('send-as 주소: 연결한 계정 · 확인된 별칭은 내 주소, 확인 메일을 기다리는 주소는 아님 · 한 시간 기억 · Gmail 이 거절하면 빈 목록', async () => {
  const fake = fakeGmail({ '/settings/sendAs': { sendAs: [
    { sendAsEmail: ME.gmail, displayName: '한서윤', isPrimary: true, isDefault: true },
    { sendAsEmail: 'Sales@Daon.example.test', displayName: '다온 영업', treatAsAlias: true, verificationStatus: 'accepted' },
    { sendAsEmail: 'waiting@elsewhere.example.test', treatAsAlias: true, verificationStatus: 'pending' },
  ] } })
  await withFetch(fake, async () => {
    assert.deepEqual(await S.gmailSendAs('u-send-as', 'at-1', { api: API }), [ME.gmail, ME.alias])
    assert.deepEqual(await S.gmailSendAs('u-send-as', 'at-1', { api: API }), [ME.gmail, ME.alias])
  })
  assert.equal(fake.calls.length, 1, '두 번째는 기억한 것')
  assert.equal(fake.calls[0].auth, 'Bearer at-1')
  assert.equal(fake.calls[0].path, '/gmail/v1/users/me/settings/sendAs')
  // a grant Gmail refuses (403) and a network failure: nothing, and the intake goes on
  await withFetch(fakeGmail({ '/settings/sendAs': { status: 403, body: { error: { message: 'Request had insufficient authentication scopes.' } } } }), async () => {
    assert.deepEqual(await S.gmailSendAs('u-refused', 'at-2', { api: API }), [])
  })
  await withFetch(fakeGmail({ '/settings/sendAs': () => new Error('ECONNRESET') }), async () => {
    assert.deepEqual(await S.gmailSendAs('u-offline', 'at-3', { api: API }), [])
  })
})

test('스레드: 내 답장(SENT · 별칭)이 더 나중이면 답한 메일, 내 초안 · 상대의 더 나중 답장 · 읽지 못한 스레드는 아님', async () => {
  const customer = '"오하늘" <haneul@vendor.example.test>'
  const threads = {
    // a customer's mail, then my reply from the connected Gmail (SENT)
    t1: [gm('m1', { from: customer, at: 100, thread: 't1' }), gm('r1', { from: `"한서윤" <${ME.gmail}>`, labels: ['SENT'], at: 200, thread: 't1' })],
    // a customer's mail, then my draft (not sent)
    t2: [gm('m2', { from: customer, at: 100, thread: 't2' }), gm('d2', { from: `"한서윤" <${ME.gmail}>`, labels: ['DRAFT'], at: 200, thread: 't2' })],
    // my mail first, then the customer's answer: their mail is the newest — waiting for me
    t3: [gm('s3', { from: `"한서윤" <${ME.gmail}>`, labels: ['SENT'], at: 100, thread: 't3' }), gm('m3', { from: customer, at: 200, thread: 't3' })],
    // a customer's mail, then my reply from the company address (a copy without SENT)
    t4: [gm('m4', { from: customer, at: 100, thread: 't4' }), gm('r4', { from: `"한서윤" <${ME.lite}>`, at: 200, thread: 't4' })],
    // two mails of the customer's with my reply between them: the first is answered, the second is not
    t6: [gm('m6a', { from: customer, at: 100, thread: 't6' }), gm('r6', { from: `<${ME.alias}>`, labels: ['SENT'], at: 150, thread: 't6' }), gm('m6b', { from: customer, at: 300, thread: 't6' })],
    // the order Gmail gave is not trusted over the time each arrived
    t7: [gm('r7', { from: `<${ME.gmail}>`, labels: ['SENT'], at: 900, thread: 't7' }), gm('m7', { from: customer, at: 100, thread: 't7' })],
  }
  const routes = Object.fromEntries(Object.entries(threads).map(([id, messages]) => [`/threads/${id}`, { id, messages }]))
  const fake = fakeGmail(routes)
  const mails = ['m1', 'm2', 'm3', 'm4', 'm6a', 'm6b', 'm7'].map((id) => fetched(Object.values(threads).flat().find((x) => x.id === id)))
  // t5 is not found (a thread removed since)
  mails.push({ id: 'm5', thread: 't5', from: customer, labels: ['INBOX'] })
  // a mail without a thread (IMAP, demo) is not read
  mails.push({ id: 'imap-1', from: customer })
  const answered = await withFetch(fake, () => S.answeredOf(mails, me, 'at-9', { api: API }))
  assert.deepEqual([...answered].sort(), ['m1', 'm4', 'm6a', 'm7'])
  // one read per thread, metadata only, with the connection's token
  assert.deepEqual(fake.calls.map((c) => c.path.split('/').pop()).sort(), ['t1', 't2', 't3', 't4', 't5', 't6', 't7'])
  assert.ok(fake.calls.every((c) => c.query.format === 'metadata' && c.query.metadataHeaders === 'From' && c.auth === 'Bearer at-9'))
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
