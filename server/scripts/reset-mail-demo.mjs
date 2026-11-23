// 「외부 메일·자료 공유」 — the Agentic BPM PoC's mail scenario (pgpt-pro/docs/agentic-bpm/plan.md §6 scenario 3,
// lib/scenarios/mail.js) back to a clean start, so a take of the demo can be repeated. Safe to run again.
//   node scripts/reset-mail-demo.mjs              the demo accounts' mail decisions (which is also what the 20-a-day
//                                                 window counts), their demo outbox, the policy cards and demo-outbox
//                                                 notes in their chats with the request and answer just before each,
//                                                 the approval notifications; the mail-* policies switched on again
//   node scripts/reset-mail-demo.mjs --status     only show what is there
//   node scripts/reset-mail-demo.mjs --window [20] [--as pro-team-minji@uengine.org]
//                                                 after the reset, that person's day already holds 20 external mails
//                                                 (sent through the policies, no chat cards): the next one is the 21st
//                                                 and waits for the team lead (장진영) — 김민지 by default, since the
//                                                 team lead approving his own request would show nothing
//   --keep-chat   leave the chat messages          --tenant <id>   (default localhost)
// Accounts (tenant localhost): 장진영 pro-team-owner (요청자·팀장), 김민지 pro-team-minji, 이도윤 pro-mine3-admin
// (개인정보 책임자·보안 담당자·관리자), and the E2E's own window-test person. An open page shows the change after a reload.
process.env.DOTENV_CONFIG_QUIET = 'true'
const { q, pool } = await import('../lib/supa.js')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? (process.argv[i + 1] ?? d) : d }
const has = (k) => process.argv.includes(k)
const T = arg('--tenant', 'localhost')
export const DEMO_EMAILS = ['pro-team-owner@uengine.org', 'pro-team-minji@uengine.org', 'pro-mine3-admin@uengine.org', 'pro-agentic-mail-e2e@uengine.org']
// a policy card of this scenario whose decision is already gone (an E2E removed it) is still a mail card
const MAIL_CARD = '(에게 메일 「|^Mail to )'

try {
  const people = await q('select id, username as name, email from users where tenant_id=$1 and lower(email) = any($2::text[])', [T, DEMO_EMAILS])
  const ids = people.map((p) => p.id)
  const decisions = (await q(`select id from pro_policy_decisions where tenant_id=$1 and action_kind='mail.send' and user_id = any($2::uuid[])`, [T, ids])).map((r) => r.id)
  const threads = (await q('select id from pro_threads where user_id = any($1::uuid[])', [ids])).map((r) => r.id)
  const cards = await q(`select m.id, m.thread_id, m.created_at from pro_messages m where m.thread_id = any($1::uuid[]) and m.kind='policy'
      and ((m.content->>'decisionId') = any($2::text[])
        or (not exists (select 1 from pro_policy_decisions d where d.id::text = m.content->>'decisionId') and coalesce(m.content->>'subject','') ~ $3))`,
  [threads, decisions.map(String), MAIL_CARD])
  const [{ n: outbox }] = await q('select count(*)::int n from pro_outbox where tenant_id=$1 and (user_id = any($2::uuid[]) or decision_id = any($3::uuid[]))', [T, ids, decisions])
  const [{ n: notes }] = await q(`select count(*)::int n from notifications where tenant_id=$1 and type='policy' and user_id = any($2::text[])
      and (url = any($3::text[]) or title ~ $4)`, [T, ids.map(String), decisions.map((d) => `/settings/policies?d=${d}`), '(에게 메일 「|Mail to )'])
  const window = await q(`select u.username as name, count(*)::int n from pro_policy_decisions d join users u on u.id=d.user_id and u.tenant_id=d.tenant_id
      where d.tenant_id=$1 and d.action_kind='mail.send' and not d.dry_run and d.user_id = any($2::uuid[]) and d.created_at > now() - interval '1 day'
      and d.matched @> '[{"id":"mail-external"}]' group by u.username`, [T, ids])
  const off = await q(`select id from pro_policies where tenant_id=$1 and id like 'mail-%' and not enabled`, [T])
  console.log(JSON.stringify({ tenant: T, people: people.map((p) => p.name), decisions: decisions.length, outbox, cards: cards.length, notifications: notes,
    externalToday: Object.fromEntries(window.map((w) => [w.name, w.n])), policiesOff: off.map((r) => r.id) }))
  if (has('--status')) process.exit(0)

  let chat = 0
  if (!has('--keep-chat')) {
    for (const c of cards) {
      // the request that led to the card (a send_mail turn: said just before it, about a mail) goes with it,
      // with the assistant's acknowledgement and any attached-file message in between — only those kinds, so
      // another scenario's card in the same thread stays. (Times compared in SQL: a JS Date drops microseconds.)
      const gone = await q(`with c as (select thread_id, created_at from pro_messages where id=$1),
          a as (select m.created_at from pro_messages m, c where m.thread_id=c.thread_id and m.role='user' and m.kind='text' and m.created_at <= c.created_at
            and m.created_at > c.created_at - interval '3 minutes' and m.content->>'text' ~* '(메일|mail)' order by m.created_at desc limit 1)
        delete from pro_messages m using c where m.thread_id=c.thread_id and m.kind in ('text', 'file', 'policy')
          and m.created_at >= coalesce((select created_at from a), c.created_at) and m.created_at <= c.created_at returning m.id`, [c.id])
      chat += gone.length
    }
    chat += (await q(`delete from pro_messages where thread_id = any($1::uuid[]) and kind='chip' and content->>'demo' = 'true' returning id`, [threads])).length
  }
  const removed = {
    outbox: (await q('delete from pro_outbox where tenant_id=$1 and (user_id = any($2::uuid[]) or decision_id = any($3::uuid[])) returning id', [T, ids, decisions])).length,
    notifications: (await q(`delete from notifications where tenant_id=$1 and type='policy' and user_id = any($2::text[]) and (url = any($3::text[]) or title ~ $4) returning id`,
      [T, ids.map(String), decisions.map((d) => `/settings/policies?d=${d}`), '(에게 메일 「|Mail to )'])).length,
    decisions: (await q('delete from pro_policy_decisions where id = any($1::uuid[]) returning id', [decisions])).length,
    chat,
    policiesOn: (await q(`update pro_policies set enabled=true, updated_at=now() where tenant_id=$1 and id like 'mail-%' and not enabled returning id`, [T])).map((r) => r.id),
  }
  console.log(JSON.stringify({ removed }))

  if (has('--window')) {
    const n = Number(arg('--window', 20)) || 20
    const who = people.find((p) => p.email === String(arg('--as', 'pro-team-minji@uengine.org')).toLowerCase())
    if (!who) throw new Error('--as: one of the demo accounts')
    const { withTenant } = await import('../lib/tenant.js')
    const { sendMail } = await import('../lib/scenarios/mail.js')
    const seen = []
    await withTenant(T, async () => {
      for (let i = 1; i <= n; i++) {
        const r = await sendMail({ id: who.id, email: who.email, name: who.name }, { to: [`buyer${String(i).padStart(2, '0')}@globex-demo.com`], subject: `견적 안내 ${i}`, body: '요청하신 견적서를 보내 드립니다.' }, { card: false })
        seen.push(r.decision)
      }
    })
    console.log(JSON.stringify({ window: { person: who.name, sent: n, decisions: [...new Set(seen)] } }))
  }
} finally {
  await pool.end()
}
