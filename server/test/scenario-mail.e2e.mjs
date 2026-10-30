// E2E: scenario 3 of the Agentic BPM PoC (외부 메일·자료 공유, lib/scenarios/mail.js) over HTTP against a running
// server, with database checks. The same kind of request ends four ways by the policies alone — internal → sent;
// external → sent, recorded, recalled within the window; external with personal data → held, the privacy officer
// approves, it goes out as the requester; 50+ personal data items → blocked, nothing in the outbox — and the 21st
// external mail of the day for one person waits for approval. Then one natural request in the chat, to see the
// router pick send_mail (a model's choice: reported, not asserted).
//
//   PRO_API=http://localhost:8791 node test/scenario-mail.e2e.mjs [--no-chat] [--keep]
//
// Accounts (tenant localhost): requester 장진영 pro-team-owner, approver 이도윤 pro-mine3-admin (개인정보 책임자,
// 보안 담당자, 관리자); the window step uses its own person (pro-agentic-mail-e2e), whose rows are cleared first.
// Everything made here is removed at the end (--keep leaves it for a look). Nothing is really e-mailed.
process.env.DOTENV_CONFIG_QUIET = 'true'
import assert from 'node:assert/strict'
import { q, pool } from '../lib/supa.js'
import { factsOf, findPii } from '../lib/scenarios/mail.js'

const API = process.env.PRO_API || 'http://localhost:8791'
const T = 'localhost'
const has = (k) => process.argv.includes(k)
const PARTNER = 'jimin.han@globex-demo.com'

async function call(tok, method, path, body) {
  const r = await fetch(`${API}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-PGL-Lang': 'ko', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  return { status: r.status, body: j }
}
async function signIn(email) {
  const r = await fetch(`${API}/api/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  const j = await r.json()
  assert.ok(j.session?.access_token, `sign-in ${email}: ${JSON.stringify(j).slice(0, 200)}`)
  return { id: j.user.id, tok: j.session.access_token }
}

const made = []          // decision ids
const threads = []       // threads made here
const chatMsgs = []      // messages the chat run left in the main thread
const out = {}
let failed = 0
const step = async (name, fn) => {
  try { out[name] = await fn(); console.log(`✓ ${name}`, JSON.stringify(out[name])) } catch (e) { failed++; console.log(`✗ ${name}`, e.message) }
}
const outboxOf = (decisionId) => q('select id, user_id, status, recipients, recalled_at from pro_outbox where decision_id=$1', [decisionId])
const decisionRow = async (id) => (await q('select status, decision, user_id, approved_by, facts, subject, approver_role from pro_policy_decisions where id=$1', [id]))[0]
const cardOf = async (threadId, decisionId) => (await q(`select id, content from pro_messages where thread_id=$1 and kind='policy' and content->>'decisionId'=$2`, [threadId, decisionId]))[0]
const send = async (who, mail) => {
  const r = await call(who.tok, 'POST', '/scenarios/mail/send', mail)
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 300))
  made.push(r.body.decisionId)
  return r.body
}

try {
  const owner = await signIn('pro-team-owner@uengine.org')       // 장진영
  const doyun = await signIn('pro-mine3-admin@uengine.org')      // 이도윤
  const [th] = await q(`insert into pro_threads(user_id, kind, title) values ($1, 'project', '메일 가드레일 E2E') returning id`, [owner.id])
  threads.push(th.id)
  const [{ n: already }] = await q(`select count(*)::int n from pro_policy_decisions where tenant_id=$1 and user_id=$2 and action_kind='mail.send' and not dry_run
    and created_at > now() - interval '1 day' and matched @> '[{"id":"mail-external"}]'`, [T, owner.id])
  assert.ok(already < 16, `장진영 already sent ${already} external mails today: run node scripts/reset-mail-demo.mjs first`)

  await step('facts: counts and kinds only, found without a model', async () => {
    const t = findPii('주민번호 900101-1234567, 010-1234-5678, 계좌 110-123-456789, 사업자 123-45-67890, 2026-10-30, a@globex-demo.com', { except: [PARTNER] })
    assert.deepEqual(t.byKind, { resident_id: 1, mobile: 1, email: 1, bank_account: 1 })
    const f = factsOf({ from: 'pro-team-owner@uengine.org', to: [PARTNER, 'pro-team-minji@uengine.org'], subject: '안건', body: `${PARTNER} 님, 010-1234-5678 로 연락 주세요`, attachments: [{ name: '대외비_계획.md', size: 10, source: 'inline', text: '...' }] })
    assert.equal(f.external, true); assert.equal(f.external_count, 1); assert.equal(f.pii_count, 1); assert.equal(f.classification, 'confidential')
    assert.ok(!JSON.stringify(f).includes('010-1234-5678') && !JSON.stringify(f).includes(PARTNER), 'facts hold no personal data')
    return { sample: t.byKind, facts: { external_count: f.external_count, pii_count: f.pii_count, classification: f.classification, recipients: f.recipients } }
  })

  await step('internal (김민지 by name) → allow, sent', async () => {
    const r = await send(owner, { to: ['김민지'], subject: '주간 회의 자료', body: '내일 회의 자료 공유드려요.', threadId: th.id })
    assert.equal(r.decision, 'allow'); assert.equal(r.status, 'executed')
    const [o] = await outboxOf(r.decisionId)
    assert.equal(o.status, 'sent'); assert.equal(String(o.user_id), owner.id); assert.deepEqual(o.recipients, ['pro-team-minji@uengine.org'])
    const card = await cardOf(th.id, r.decisionId)
    assert.equal(card.content.status, 'executed')
    const [chip] = await q(`select content from pro_messages where thread_id=$1 and kind='chip' and content->>'demo'='true' order by created_at desc limit 1`, [th.id])
    return { decision: r.decision, status: r.status, outbox: o.status, card: card.content.status, chip: chip?.content.text }
  })

  await step('external → allow_audit, sent, recalled within the window', async () => {
    const r = await send(owner, { to: [PARTNER], subject: '11월 파트너 미팅 안건', body: '다음 주 화요일 미팅 안건을 보내 드립니다.', attachment: '회사소개_요약.txt', threadId: th.id })
    assert.equal(r.decision, 'allow_audit'); assert.equal(r.status, 'executed')
    const mins = Math.round((new Date(r.undoUntil) - Date.now()) / 6e4)
    assert.ok(mins >= 9 && mins <= 10, `undo window ${mins} min`)
    assert.equal((await outboxOf(r.decisionId))[0].status, 'sent')
    const u = await call(owner.tok, 'POST', `/decisions/${r.decisionId}/undo`)
    assert.equal(u.status, 200, JSON.stringify(u.body)); assert.equal(u.body.status, 'undone')
    const [o] = await outboxOf(r.decisionId)
    assert.equal(o.status, 'recalled'); assert.ok(o.recalled_at)
    const again = await call(owner.tok, 'POST', `/decisions/${r.decisionId}/undo`)
    assert.equal(again.status, 409)
    const card = await cardOf(th.id, r.decisionId)
    assert.equal(card.content.status, 'undone')
    return { decision: r.decision, undoWindowMin: mins, outbox: o.status, secondUndo: again.status, card: card.content.status }
  })

  await step('external with personal data → pending → 이도윤 approves → sent as the requester', async () => {
    const r = await send(owner, { to: [PARTNER], subject: '세미나 참석자 명단', body: '요청하신 참석자 명단을 첨부합니다.', attachment: '세미나 참석자 명단', threadId: th.id })
    assert.equal(r.decision, 'require_approval'); assert.equal(r.status, 'pending'); assert.equal(r.approver, '개인정보 책임자')
    assert.equal(r.facts.pii_count, 6); assert.deepEqual(r.facts.pii_by_kind, { mobile: 3, email: 3 })
    assert.equal((await outboxOf(r.decisionId)).length, 0, 'nothing in the outbox before approval')
    const row = await decisionRow(r.decisionId)
    assert.ok(!/010-0000|@example\.com/.test(JSON.stringify(row.facts) + row.subject), 'no personal data in the ledger')
    const [note] = await q(`select title from notifications where user_id=$1 and type='policy' and url=$2`, [doyun.id, `/settings/policies?d=${r.decisionId}`])
    assert.ok(note, 'the approver is notified with a link to the row')
    const self = await call(owner.tok, 'POST', `/decisions/${r.decisionId}/approve`, { note: '' })
    assert.equal(self.status, 403, 'the requester cannot approve it')
    const list = await call(doyun.tok, 'GET', '/decisions?status=pending')
    assert.equal(list.body.decisions.find((d) => d.id === r.decisionId)?.mayDecide, true)
    const a = await call(doyun.tok, 'POST', `/decisions/${r.decisionId}/approve`, { note: '참석자 본인 동의 확인' })
    assert.equal(a.status, 200, JSON.stringify(a.body)); assert.equal(a.body.status, 'executed')
    const [o] = await outboxOf(r.decisionId)
    const after = await decisionRow(r.decisionId)
    assert.equal(o.status, 'sent'); assert.equal(String(o.user_id), owner.id, 'sent as the requester'); assert.equal(String(after.approved_by), doyun.id)
    const card = await cardOf(th.id, r.decisionId)
    assert.equal(card.content.status, 'executed'); assert.equal(card.content.approvedBy, '이도윤')
    return { decision: r.decision, approver: r.approver, pii: r.facts.pii_by_kind, notified: note.title, requesterApprove: self.status, outboxUser: '장진영', approvedBy: card.content.approvedBy }
  })

  await step('bulk personal data (60 customers) → deny, nothing in the outbox', async () => {
    const r = await send(owner, { to: [PARTNER], subject: '고객 명단 공유', body: '고객 명단 전체를 보내 드립니다.', attachment: '고객명단_전체_60명.csv', threadId: th.id })
    assert.equal(r.decision, 'deny'); assert.equal(r.status, 'blocked')
    assert.equal(r.facts.pii_count, 120); assert.equal(r.facts.attachments[0].rows, 60)
    assert.equal((await outboxOf(r.decisionId)).length, 0)
    const [{ n }] = await q('select count(*)::int n from pro_policy_actions where decision_id=$1', [r.decisionId])
    assert.equal(n, 0, 'a blocked action is not kept')
    const card = await cardOf(th.id, r.decisionId)
    return { decision: r.decision, status: r.status, pii_count: r.facts.pii_count, rows: r.facts.attachments[0].rows, matched: r.matched.map((m) => `${m.id}:${m.decision}`), card: card.content.status }
  })

  await step('confidential file outside → 보안 담당자 approval; rejected → not sent', async () => {
    const r = await send(owner, { to: [PARTNER], subject: '내년 로드맵', body: '참고용으로 공유드립니다.', attachment: '대외비_2027_제품로드맵.md', threadId: th.id })
    assert.equal(r.decision, 'require_approval'); assert.equal(r.approver, '보안 담당자'); assert.equal(r.facts.classification, 'confidential')
    const x = await call(doyun.tok, 'POST', `/decisions/${r.decisionId}/reject`, { note: '외부 공유 불가 자료' })
    assert.equal(x.body.status, 'rejected')
    assert.equal((await outboxOf(r.decisionId)).length, 0)
    return { decision: r.decision, approver: r.approver, after: x.body.status }
  })

  await step('the window: the 21st external mail of the day → pending (팀장)', async () => {
    const w = await signIn('pro-agentic-mail-e2e@uengine.org')
    // its own rows first: the window counts this person's day
    const old = (await q(`select id from pro_policy_decisions where user_id=$1 and action_kind='mail.send'`, [w.id])).map((r) => r.id)
    await q('delete from pro_outbox where user_id=$1 or decision_id = any($2::uuid[])', [w.id, old])
    await q('delete from pro_policy_decisions where id = any($1::uuid[])', [old])
    const seen = []
    for (let i = 1; i <= 20; i++) seen.push((await send(w, { to: [`buyer${i}@globex-demo.com`], subject: `견적 안내 ${i}`, body: '견적서를 보내 드립니다.', card: false })).decision)
    assert.ok(seen.every((d) => d === 'allow_audit'), seen.join(','))
    const r = await send(w, { to: ['buyer21@globex-demo.com'], subject: '견적 안내 21', body: '견적서를 보내 드립니다.', card: false })
    assert.equal(r.decision, 'require_approval'); assert.equal(r.approver, '팀장')
    const note = r.matched.find((m) => m.id === 'mail-external').notes[0]
    assert.equal(note.kind, 'window'); assert.equal(note.count, 21)
    const [{ n }] = await q(`select count(*)::int n from pro_outbox where user_id=$1 and status='sent'`, [w.id])
    assert.equal(n, 20)
    return { first20: 'allow_audit ×20', '21st': r.decision, approver: r.approver, note, outboxSent: n }
  })

  if (!has('--no-chat')) {
    await step('chat: a natural request → the router picks send_mail (observed)', async () => {
      const [main] = await q(`select id from pro_threads where user_id=$1 and kind='chat' order by created_at limit 1`, [owner.id])
      const [{ now }] = await q('select now()')
      const text = `${PARTNER} 에게 「11월 파트너 미팅 안건」 제목으로 메일 보내줘. 내용은 "다음 주 화요일 오후 2시에 판교 사무실에서 뵙겠습니다. 안건은 공동 제안서 범위와 역할 분담입니다."`
      const r = await fetch(`${API}/api/threads/${main.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PGL-Lang': 'ko', Authorization: `Bearer ${owner.tok}` }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(180000) })
      const sse = await r.text()
      const rows = await q(`select id, role, kind, content from pro_messages where thread_id=$1 and created_at >= $2 order by created_at`, [main.id, now])
      chatMsgs.push(...rows.map((m) => m.id))
      const card = rows.find((m) => m.kind === 'policy')
      if (card?.content.decisionId) made.push(card.content.decisionId)
      const said = rows.filter((m) => m.role === 'agent' && m.kind === 'text').map((m) => m.content.text)
      const res = { picked: card ? 'send_mail' : 'not send_mail', ack: said[0] || null, kinds: rows.map((m) => m.kind), streamEnded: /event: (done|error)/.test(sse) }
      if (card) {
        const row = await decisionRow(card.content.decisionId)
        Object.assign(res, { decision: row.decision, status: row.status, subject: row.subject, card: card.content.status })
      }
      if (!card) throw new Error(`the router did not pick send_mail: ${JSON.stringify(res)}`)
      return res
    })
  }
} finally {
  if (!has('--keep')) {
    const subjects = made.length ? (await q('select id, subject from pro_policy_decisions where id = any($1::uuid[])', [made])) : []
    await q(`delete from notifications where tenant_id=$1 and type='policy' and (url = any($2::text[]) or title = any($3::text[]))`,
      [T, made.map((d) => `/settings/policies?d=${d}`), subjects.flatMap((s) => [`승인됨 — ${s.subject}`, `반려됨 — ${s.subject}`])])
    await q('delete from pro_outbox where decision_id = any($1::uuid[])', [made])
    await q('delete from pro_policy_decisions where id = any($1::uuid[])', [made])
    if (chatMsgs.length) await q('delete from pro_messages where id = any($1::uuid[])', [chatMsgs])
    if (threads.length) await q('delete from pro_threads where id = any($1::uuid[])', [threads])
  }
  await pool.end()
  console.log(failed ? `\n${failed} step(s) failed` : '\nall steps passed', has('--keep') ? '(kept)' : '(cleaned up)')
  process.exitCode = failed ? 1 : 0
}
