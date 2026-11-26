// 내가 이미 답한 메일이 문서를 요청할 때 (lib/mail.js pollUser · lib/mailSelf.js answeredOf, 스펙 openspec/specs/mail-card-actions).
// 검토(PR #80): 이미 답한 메일은 문서 초안과 함께 회사 프로세스 지도 · 프로세스 마이닝으로 가는 길까지 잃었다(초안 목록에서 통째로 빠짐).
// 고친 뒤: 답장 카드만 없고, 지도 · 프로세스 마이닝이 그 메일을 읽으며, 초안은 「이미 답함」을 알고 만든다(회신 카드가 아니라 검토 카드 —
// 실제 카드 모양은 test/mail-own-sent.e2e.mjs). 실제 DB, 모델 · Gmail 은 가짜 fetch, 지도 · 마이닝 · 초안의 시작은 대역(deps).
// 사람 · 회사 · 주소는 지어낸 것이다(*.example.test).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.PRO_LLM_BASE_URL = 'http://127.0.0.1:59994/v1'
process.env.PRO_ONTOLOGY_BOLT_URL = ''
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-mailself-test-'))
const kek = crypto.randomBytes(32)
const kid = crypto.createHash('sha256').update(kek).digest('hex').slice(0, 12)
fs.writeFileSync(path.join(dir, 'keyring.json'), JSON.stringify({ current: kid, keys: [{ id: kid, key: kek.toString('base64') }] }), { mode: 0o600 })
process.env.PRO_VAULT_KEYRING = path.join(dir, 'keyring.json')
delete process.env.PRO_VAULT_KEK

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const vault = await import('../lib/vault.js')
const { pollUser } = await import('../lib/mail.js')

const users = []
after(async () => {
  for (const u of users) {
    for (const t of ['pro_actions', 'pro_mail_accounts', 'pro_mail_seen', 'pro_vault_items', 'pro_vault_keys', 'pro_vault_audit', 'pro_profile']) await q(`delete from ${t} where user_id=$1`, [u]).catch(() => {})
    await q('delete from pro_mail_archive where owner_id=$1', [u]).catch(() => {})
    await q('delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)', [u])
    await q('delete from pro_threads where user_id=$1', [u])
  }
  await pool.end()
  fs.rmSync(dir, { recursive: true, force: true })
})

// ---------- fake model and Gmail ----------
const GOOGLE = 'seoyun.han@inbox.example.test'
const PARTNER = '"강도윤" <doyun@partner.example.test>'
const CUSTOMER = '"오하늘" <haneul@vendor.example.test>'
const real = globalThis.fetch
const gmail = { messages: [] } // [{ id, threadId, from, to, subject, text, labels, at }]
let triage = { actions: [], brief: '', drafts: [] }
const seen = { triage: [] }
globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  if (u === `${config.llm.baseUrl}/chat/completions`) {
    const body = JSON.parse(init.body || '{}')
    const sys = String(body.messages?.[0]?.content || '')
    if (sys.startsWith("You read a user's newest emails")) { seen.triage.push(JSON.parse(body.messages[1].content)); return Response.json({ choices: [{ message: { content: JSON.stringify(triage) }, finish_reason: 'stop' }] }) }
    return Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })
  }
  if (u.startsWith(config.google.gmailUrl)) {
    const p = new URL(u)
    const headers = (m) => [['From', m.from], ['To', m.to], ['Subject', m.subject], ['Date', new Date(m.at).toUTCString()]].filter(([, v]) => v).map(([name, value]) => ({ name, value }))
    const shape = (m) => ({ id: m.id, threadId: m.threadId, labelIds: m.labels, internalDate: String(m.at), snippet: m.text, payload: { mimeType: 'text/plain', headers: headers(m), body: { data: Buffer.from(m.text).toString('base64url') } } })
    if (p.pathname.endsWith('/messages')) return Response.json({ messages: gmail.messages.filter((m) => !m.labels.includes('SENT')).map((m) => ({ id: m.id, threadId: m.threadId })) })
    const msg = /\/messages\/([^/]+)$/.exec(p.pathname)
    if (msg) { const m = gmail.messages.find((x) => x.id === msg[1]); return m ? Response.json(shape(m)) : Response.json({}, { status: 404 }) }
    const th = /\/threads\/([^/]+)$/.exec(p.pathname)
    if (th) { const ms = gmail.messages.filter((x) => x.threadId === th[1]); return ms.length ? Response.json({ id: th[1], messages: ms.map(shape) }) : Response.json({}, { status: 404 }) }
    if (p.pathname.endsWith('/settings/sendAs')) return Response.json({ sendAs: [{ sendAsEmail: GOOGLE, isPrimary: true }] })
    return Response.json({ error: { message: 'not found' } }, { status: 404 })
  }
  return real(url, init)
}

// stand-ins for the company map's, process mining's and the ad-hoc drafts' start: what each was handed
function stands() {
  const calls = { map: [], mining: [], draft: [] }
  return {
    calls,
    deps: {
      mapMail: async (userId, mail, d) => { calls.map.push({ mail: mail.id, items: d.items.map((i) => i.name) }); return false },
      miningMail: async (userId, mail, d) => { calls.mining.push({ mail: mail.id, items: d.items.map((i) => i.name) }); return null },
      draft: async (userId, mail, d, opts) => { calls.draft.push({ mail: mail.id, answered: !!opts?.answered }) },
    },
  }
}
const until = async (fn, what, ms = 5000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`); await new Promise((r) => setTimeout(r, 50)) } }

test('이미 답한 메일이 견적서를 요청한다: 답장 카드는 없고, 지도 · 프로세스 마이닝이 그 메일을 읽으며, 초안은 「이미 답함」으로 — 답하지 않은 메일은 지금처럼', async () => {
  const user = crypto.randomUUID()
  users.push(user)
  await q('insert into pro_profile(user_id, email, name) values ($1,$2,$3)', [user, 'seoyun@daon.example.test', '한서윤'])
  await q(`insert into pro_mail_accounts(user_id, provider, address) values ($1,'gmail',$2)`, [user, GOOGLE])
  await vault.putItem(user, 'oauth', 'google', { username: GOOGLE, access_token: 'at-test', refresh_token: 'rt-test', expires_at: Date.now() + 3600_000, scope: 'openid', client_id: 'cid' }, { actor: 'mail' })
  const run = crypto.randomBytes(3).toString('hex')
  const ans = `g-ans-${run}`, fwd = `g-fwd-${run}`, fresh = `g-new-${run}`
  const now = Date.now()
  gmail.messages = [
    // a partner asks for a quote; I answered the partner since (SENT, to the partner)
    { id: ans, threadId: `t-ans-${run}`, from: PARTNER, to: GOOGLE, subject: '견적서 요청', text: '30명 기준 견적서를 부탁드립니다.', labels: ['INBOX'], at: now - 30 * 60_000 },
    { id: `${ans}-r`, threadId: `t-ans-${run}`, from: `"한서윤" <${GOOGLE}>`, to: PARTNER, subject: 'Re: 견적서 요청', text: '내일 보내 드리겠습니다.', labels: ['SENT'], at: now - 20 * 60_000 },
    // a customer asks for a quote; I only forwarded it to a colleague (not an answer)
    { id: fwd, threadId: `t-fwd-${run}`, from: CUSTOMER, to: GOOGLE, subject: '견적 문의', text: '견적서를 보내 주세요.', labels: ['INBOX'], at: now - 15 * 60_000 },
    { id: `${fwd}-f`, threadId: `t-fwd-${run}`, from: `"한서윤" <${GOOGLE}>`, to: '"윤가람" <garam@daon.example.test>', subject: 'Fwd: 견적 문의', text: '확인 부탁해요.', labels: ['SENT'], at: now - 10 * 60_000 },
    // a third quote request, nothing in its thread after it
    { id: fresh, threadId: `t-new-${run}`, from: '"정하윤" <hayun@client.example.test>', to: GOOGLE, subject: '견적 부탁', text: '견적서 부탁드립니다.', labels: ['INBOX'], at: now - 5 * 60_000 },
  ]
  const quote = (id, who) => ({ mail_id: id, customer: who, items: [{ kind: '견적서', format: 'xlsx', name: `${who} 견적서.xlsx` }], summary: '견적서' })
  triage = {
    actions: [ans, fwd, fresh].map((id) => ({ mail_id: id, verb: 'Reply', kind: 'reply', text: `${id} 회신`, icon_domain: '', due: null, prompt: '' })),
    brief: '', drafts: [quote(ans, '파트너상사'), quote(fwd, '하늘상사'), quote(fresh, '클라이언트')],
  }
  const s = stands()
  const r = await pollUser(user, { deps: s.deps })
  assert.deepEqual(r, { fresh: 3, actions: 2, answered: 1 })
  // the mail assistant was told which one is answered
  assert.deepEqual(seen.triage.at(-1).map((m) => [m.id, !!m.answered]), [[ans, true], [fwd, false], [fresh, false]])
  // no reply card for the answered mail; the forwarded one (not an answer) and the new one keep theirs
  const cards = await q(`select source->>'mail_id' as id, verb from pro_actions where user_id=$1 order by created_at`, [user])
  assert.deepEqual(cards.map((c) => c.id).sort(), [fresh, fwd].sort())
  // every mail asking for a document still goes to the company map and process mining (the answered one too), then to the drafts — which
  // know it is answered
  await until(() => s.calls.draft.length === 3, '초안 셋')
  assert.deepEqual(s.calls.map.map((c) => c.mail), [ans], '카드가 없는 메일은 지도가 읽는다(카드가 있는 메일은 routeMailCards)')
  assert.deepEqual(s.calls.mining.map((c) => c.mail).sort(), [ans, fwd, fresh].sort())
  assert.deepEqual(s.calls.mining.find((c) => c.mail === ans).items, ['파트너상사 견적서.xlsx'])
  assert.deepEqual(Object.fromEntries(s.calls.draft.map((c) => [c.mail, c.answered])), { [ans]: true, [fwd]: false, [fresh]: false })
})
