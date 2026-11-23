// A month of decision-ledger history for the Agentic BPM report (/agentic, lib/policy/insights.js) — demo data,
// every row's subject starts with "[이력]" so it is told apart from what the scenarios really did. Safe to run again.
//   node scripts/seed-agentic-history.mjs            replace the history (the last 28 days, the cast of tenant localhost)
//   node scripts/seed-agentic-history.mjs --reset    remove it, and put the policies its suggestions touch back to the catalog
//   … --tenant <id>
// What it makes the report say: payments over ₩100,000 were all approved by the team lead after hours of waiting (→ loosen),
// external mail was often taken back (→ tighten), public releases with an open privacy finding keep being blocked
// (→ alternative path), plus internal mail sent unattended, a few personal-data approvals and one rejection.
// No pending rows: a pending decision needs its kept action (pro_policy_actions) to be approved, and history has none.
const { q, pool } = await import('../lib/supa.js')
const { policiesOf, savePolicy } = await import('../lib/policy/pdp.js')
const { CATALOG } = await import('../lib/policy/catalog.js')

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? (process.argv[i + 1] ?? d) : d }
const T = arg('--tenant', 'localhost')
const TAG = '[이력]'
const TOUCHED = ['payment-approval', 'mail-external', 'release-open-pii']

await q('delete from pro_policy_decisions where tenant_id=$1 and subject like $2', [T, `${TAG}%`])
if (process.argv.includes('--reset')) {
  for (const id of TOUCHED) {
    const spec = CATALOG.find((s) => s.id === id)
    const [now] = await q('select spec from pro_policies where tenant_id=$1 and id=$2', [T, id])
    if (spec && now && now.spec.decide !== spec.decide) await savePolicy(null, spec, { tenant: T })
  }
  console.log(`removed the ${TAG} history of ${T}; policies back to the catalog`)
  await pool.end()
  process.exit(0)
}

await policiesOf(T)
const who = Object.fromEntries((await q(`select lower(email) as email, id from users where tenant_id=$1 and lower(email) = any($2)`,
  [T, ['pro-team-owner@uengine.org', 'pro-team-minji@uengine.org', 'pro-mine3-admin@uengine.org']])).map((r) => [r.email, r.id]))
const JANG = who['pro-team-owner@uengine.org'], MINJI = who['pro-team-minji@uengine.org'], LEE = who['pro-mine3-admin@uengine.org']
if (!JANG || !MINJI || !LEE) throw new Error(`the cast of ${T} is missing (장진영·김민지·이도윤)`)
const spec = Object.fromEntries(CATALOG.map((s) => [s.id, s]))
const m = (id, decision) => ({ id, decision, category: spec[id].category, title: spec[id].title, sources: spec[id].sources || [] })

// deterministic "random": the same history every run
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
// a working-hours moment `day` days ago (KST 9–18)
const at = (day) => {
  const k = new Date(Date.now() + 9 * 36e5 - day * 864e5)
  k.setUTCHours(9 + Math.floor(rnd() * 9), Math.floor(rnd() * 60), 0, 0)
  return new Date(k.getTime() - 9 * 36e5)
}

let n = 0
async function row({ user, kind, subject, facts, decision, matched, status, approver = null, approvedBy = null, waitH = null, day }) {
  const created = at(day)
  if (created > new Date()) created.setTime(Date.now() - 36e5)
  const approvedAt = waitH != null ? new Date(created.getTime() + waitH * 36e5) : null
  await q(`insert into pro_policy_decisions(tenant_id, user_id, action_kind, subject, facts, decision, matched, dry_run, status, approver_role, approved_by, approved_at, created_at)
    values ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12)`,
  [T, user, kind, `${TAG} ${subject}`, facts, decision, JSON.stringify(matched), status, approver, approvedBy, approvedAt, created])
  n++
}

// payments over ₩100,000 by 김민지 — the team lead (장진영) approved every one, after a few hours
const buys = [['회의실 마이크 2대', 186000], ['디자인 툴 연간 구독', 264000], ['세미나 다과', 132000], ['외장 SSD 2TB', 219000], ['출장 KTX 왕복 2인', 238000], ['교육 도서 6권', 141000], ['모니터암 4개', 172000], ['행사 현수막', 118000]]
for (const [i, [name, amount]] of buys.entries()) {
  await row({ user: MINJI, kind: 'browser.payment', subject: `${name} 결제 ${amount.toLocaleString('ko-KR')}원`, facts: { amount, new_merchant: false },
    decision: 'require_approval', matched: [m('payment-approval', 'require_approval')], status: 'executed', approver: '팀장', approvedBy: JANG,
    waitH: [3.5, 6, 2, 9, 4.5, 5, 7, 3][i], day: 2 + i * 3 })
}
// external mail, recorded — and taken back five times out of fourteen
const partners = ['globex-demo.com', 'initech-demo.co.kr', 'hooli-demo.com']
for (let i = 0; i < 14; i++) {
  await row({ user: i % 3 ? MINJI : JANG, kind: 'mail.send', subject: `${partners[i % 3]}에게 메일 「${['견적 회신', '미팅 일정', '자료 송부', '계약 조건'][i % 4]}」`,
    facts: { external: true, external_count: 1, pii_count: 0, recipients: [partners[i % 3]] }, decision: 'allow_audit', matched: [m('mail-external', 'allow_audit')],
    status: [1, 4, 7, 10, 12].includes(i) ? 'undone' : 'executed', day: 1 + i * 2 })
}
// internal mail, sent unattended
for (let i = 0; i < 25; i++) {
  await row({ user: [JANG, MINJI, LEE][i % 3], kind: 'mail.send', subject: `사내 메일 「${['주간 회의 자료', '일정 공유', '보고서 초안', '회의록'][i % 4]}」`,
    facts: { external: false, pii_count: 0 }, decision: 'allow', matched: [m('mail-internal', 'allow')], status: 'executed', day: i })
}
// personal data to the outside: the 개인정보 책임자 (이도윤) approved three and rejected one
for (const [i, ok] of [true, true, false, true].entries()) {
  await row({ user: i % 2 ? JANG : MINJI, kind: 'mail.send', subject: `globex-demo.com에게 메일 「${['참석자 명단', '설문 응답 요약', '고객 연락처 전체', '수상자 명단'][i]}」`,
    facts: { external: true, pii_count: [6, 4, 38, 3][i] }, decision: 'require_approval', matched: [m('mail-external', 'allow_audit'), m('mail-external-pii', 'require_approval')],
    status: ok ? 'executed' : 'rejected', approver: '개인정보 책임자', approvedBy: LEE, waitH: [1.5, 2.5, 0.8, 1.2][i], day: 4 + i * 6 })
}
// public releases with an open privacy finding, blocked five times
for (let i = 0; i < 5; i++) {
  await row({ user: MINJI, kind: 'release.deploy', subject: `공개 출시 「클라우드 드라이브 4.${8 + i}」`, facts: { audience: 'public', open_findings: { privacy: 1 } },
    decision: 'deny', matched: [m('release-open-pii', 'deny')], status: 'decided', day: 3 + i * 5 })
}
console.log(`seeded ${n} ${TAG} ledger rows for ${T} (28 days)`)
await pool.end()
