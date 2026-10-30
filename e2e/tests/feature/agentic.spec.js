// Agentic BPM — 정책·가드레일(PDP·PEP), 결정 원장, 직무 분리, 실행 후 기록과 회수, 원장 리포트.
// spec process-gpt openspec/specs/pgpt-pro_agentic-guardrails, 영상 메일 가드레일·금요일 출시(e2e/README.md 16절).
// 판단 사례 30개는 server/test/agentic-regression.test.js, 시나리오 전체는 server/test/scenario-{mail,release}.e2e.mjs.
// "보낸" 메일은 시연용 보낸편지함(pro_outbox)에만 들어가고 실제로 나가지 않는다.
import { test, expect, uniq } from '../../lib/fixtures.js'

const PARTNER = 'rt-partner@globex-demo.com'
// what one test's mail requests left: their ledger rows, outbox rows and the approvers' notices
async function forget(db, user, subject) {
  const ids = (await db.q(`select id from pro_policy_decisions where tenant_id=$1 and user_id=$2 and subject like $3`, [db.tenant, user.id, `%${subject}%`])).map((r) => r.id)
  if (ids.length) {
    await db.q('delete from pro_outbox where decision_id = any($1::uuid[])', [ids])
    await db.q('delete from pro_policy_decisions where id = any($1::uuid[])', [ids])
  }
  await db.q(`delete from notifications where tenant_id=$1 and type='policy' and title like $2`, [db.tenant, `%${subject}%`])
}
const admin = async (db, c, cleanup) => { await db.q('update users set is_admin=true where id=$1', [c.id]); cleanup(() => db.q('update users set is_admin=false where id=$1', [c.id])); return c }

test('F-AG-01 정책 카탈로그 — 근거·승인자 역할과 함께, 바꾸기는 관리자만, 틀린 정책은 400', async ({ as, db, cleanup }) => {
  const u = await as('ag-user')
  const r = await u.get('/policies')
  expect(r.status, r.text).toBe(200)
  const pii = r.body.policies.find((p) => p.id === 'mail-external-pii')
  expect(pii?.enabled).toBe(true)
  expect(pii.spec).toMatchObject({ decide: 'require_approval', approver: { role: '개인정보 책임자' } })
  expect(pii.spec.sources.length).toBeGreaterThan(0)
  expect((await u.put('/policies/mail-external-pii', { enabled: false })).status).toBe(403)
  const a = await admin(db, await as('ag-admin'), cleanup)
  const bad = await a.put('/policies/rt-bad', { spec: { id: 'rt-bad', category: 'audit', scope: { action: ['mail.send'] }, when: { nope: [1] }, decide: 'maybe' } })
  expect(bad.status).toBe(400)
  expect((await db.q('select 1 from pro_policies where tenant_id=$1 and id=$2', [db.tenant, 'rt-bad'])).length).toBe(0)
})

test('F-AG-02 시험해 보기 — 가장 엄격한 판단과 승인자, 원장에는 남지 않음', async ({ as, db }) => {
  const u = await as('ag-user')
  const count = async () => (await db.q('select count(*)::int n from pro_policy_decisions where tenant_id=$1 and user_id=$2', [db.tenant, u.id]))[0].n
  const before = await count()
  const ev = (kind, facts) => u.post('/policies/evaluate', { kind, facts })
  const pii = (await ev('mail.send', { external: true, pii_count: 3 })).body
  expect(pii).toMatchObject({ decision: 'require_approval', approver: '개인정보 책임자' })
  expect(pii.matched.map((m) => m.id)).toEqual(expect.arrayContaining(['mail-external', 'mail-external-pii']))
  expect((await ev('mail.send', { external: false, pii_count: 80 })).body.decision).toBe('deny')
  expect((await ev('browser.payment', { amount: 105000 })).body.decision).toBe('allow_audit')
  expect((await ev('calendar.create', {})).body).toMatchObject({ decision: 'allow', matched: [] })
  expect(await count()).toBe(before)
})

test('F-AG-03 외부 메일 — 실행 후 기록, 10분 안에 회수, 두 번째 회수는 409, 남이 회수하면 403', async ({ as, db, cleanup }) => {
  const u = await as('ag-user')
  const subject = uniq('회귀 외부 메일')
  cleanup(() => forget(db, u, subject))
  const r = await u.post('/scenarios/mail/send', { to: [PARTNER], subject, body: '다음 주 화요일 오후 2시에 뵙겠습니다.', card: false })
  expect(r.status, r.text).toBe(200)
  expect(r.body).toMatchObject({ decision: 'allow_audit', status: 'executed' })
  expect(new Date(r.body.undoUntil) - Date.now()).toBeGreaterThan(9 * 60e3)
  const [box] = await db.q('select status from pro_outbox where decision_id=$1', [r.body.decisionId])
  expect(box.status).toBe('sent')
  expect((await (await as('ag-other')).post(`/decisions/${r.body.decisionId}/undo`)).status).toBe(403)
  expect((await u.post(`/decisions/${r.body.decisionId}/undo`)).body.status).toBe('undone')
  expect((await db.q('select status from pro_outbox where decision_id=$1', [r.body.decisionId]))[0].status).toBe('recalled')
  expect((await u.post(`/decisions/${r.body.decisionId}/undo`)).status).toBe(409)
})

test('F-AG-04 개인정보가 든 외부 메일 — 보내지 않고 보관, 본인 승인은 403(관리자여도), 다른 관리자가 승인하면 요청자 이름으로 실행, 원장에는 건수만', async ({ as, db, cleanup }) => {
  const u = await admin(db, await as('ag-user'), cleanup)
  const subject = uniq('회귀 참석자 명단')
  cleanup(() => forget(db, u, subject))
  const body = '참석자: 홍길동 010-0000-1111 hong@example.com, 김철수 010-0000-2222 kim@example.com'
  const r = await u.post('/scenarios/mail/send', { to: [PARTNER], subject, body, card: false })
  expect(r.status, r.text).toBe(200)
  expect(r.body).toMatchObject({ decision: 'require_approval', status: 'pending', approver: '개인정보 책임자' })
  expect((await db.q('select count(*)::int n from pro_outbox where decision_id=$1', [r.body.decisionId]))[0].n).toBe(0)
  // the ledger keeps counts and kinds, never the text
  const [row] = await db.q('select facts::text as facts from pro_policy_decisions where id=$1', [r.body.decisionId])
  expect(row.facts).not.toContain('010-0000-1111')
  expect(row.facts).not.toContain('hong@example.com')
  expect(JSON.parse(row.facts).pii_count).toBe(4)
  const self = await u.post(`/decisions/${r.body.decisionId}/approve`, { note: '내가 승인' })
  expect(self.status).toBe(403)
  expect(self.body.error).toContain('본인 요청')
  expect((await (await as('ag-other')).post(`/decisions/${r.body.decisionId}/approve`, {})).status).toBe(403)
  const a = await admin(db, await as('ag-admin'), cleanup)
  const ok = await a.post(`/decisions/${r.body.decisionId}/approve`, { note: '동의 확인' })
  expect(ok.status, ok.text).toBe(200)
  expect(ok.body.status).toBe('executed')
  const [box] = await db.q('select user_id, status from pro_outbox where decision_id=$1', [r.body.decisionId])
  expect(box).toMatchObject({ user_id: u.id, status: 'sent' })
  expect((await a.post(`/decisions/${r.body.decisionId}/reject`, {})).status).toBe(409)
})

test('F-AG-05 원장 공개 범위와 리포트 — 팀원은 자기 판단만, 리포트는 관리자만', async ({ as, db, cleanup }) => {
  const u = await as('ag-user')
  const o = await as('ag-other')
  const subject = uniq('회귀 원장 범위')
  cleanup(() => forget(db, u, subject))
  const r = await u.post('/scenarios/mail/send', { to: [PARTNER], subject, body: '안내드립니다.', card: false })
  expect(r.status, r.text).toBe(200)
  expect((await u.get('/decisions')).body.decisions.some((d) => d.id === r.body.decisionId)).toBe(true)
  expect((await o.get('/decisions')).body.decisions.some((d) => d.id === r.body.decisionId)).toBe(false)
  expect((await o.get('/agentic/report')).status).toBe(403)
  const a = await admin(db, await as('ag-admin'), cleanup)
  const rep = await a.get('/agentic/report?days=7')
  expect(rep.status, rep.text).toBe(200)
  expect(rep.body.totals.decisions).toBeGreaterThan(0)
  expect(Array.isArray(rep.body.suggestions)).toBe(true)
})
