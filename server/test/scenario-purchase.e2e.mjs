// E2E of the purchase scenario (pgpt-pro/docs/agentic-bpm/plan.md §5 P2) over HTTP against a running BFF and the
// shared process-gpt engine (completion :8099 + its polling service): real instances of 「구매 요청」.
//   1. ₩3,000,000 → a brief for 팀장 with three options and a recommendation, the order draft made before approval
//   2. ₩15,000,000 → its brief shows the extra 재무 승인; the inbox puts it first (critical path) though it came later
//   3. an order before approval is blocked by the policy (purchase-order-before-approval)
//   4. 팀장 approves the ₩3M one → 구매 담당 places the order from the draft (policy: allowed now) → completed
//   5. the ₩15M one goes 팀장 → 재무 (its brief carries 팀장's decision) → order from the draft → completed
//   6. a rejected request → the speculative draft is cancelled (and its ledger row marked undone)
//   7. before / after numbers (lib/scenarios/purchase/measure.js)
// Run (after scripts/seed-purchase-demo.mjs):  node test/scenario-purchase.e2e.mjs [--api http://localhost:8792] [--reset]
//   --reset first runs `seed-purchase-demo.mjs --reset` (a clean start; the seeded history stays)
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const API = `${arg('--api', process.env.PURCHASE_API || 'http://localhost:8792')}/api`
const here = path.dirname(fileURLToPath(import.meta.url))
const PEOPLE = { requester: 'pro-bd-member@uengine.org', lead: 'pro-team-owner@uengine.org', finance: 'pro-mine3-admin@uengine.org', buyer: 'pro-team-minji@uengine.org' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
let failed = 0
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  if (!ok) failed++
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
async function login(email) {
  const r = await fetch(`${API}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code: '000000' }) })
  if (!r.ok) throw new Error(`login ${email}: ${r.status}`)
  return (await r.json()).session.access_token
}
const tok = {}
async function call(who, method, p, body) {
  const r = await fetch(`${API}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text()
  return { status: r.status, body: t ? JSON.parse(t) : null }
}
async function waitFor(fn, what, ms = 150000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await sleep(2500)
  }
}
const inboxOf = async (who) => (await call(who, 'GET', '/purchase/inbox')).body?.items || []
const itemFor = (who, instId, step) => waitFor(async () => (await inboxOf(who)).find((x) => x.instId === instId && x.activityId === step && x.brief?.state === 'ready'), `${step} of ${instId} for ${who}`)
const completed = (who, instId) => waitFor(async () => {
  const r = (await call(who, 'GET', '/purchase/requests')).body?.requests?.find((x) => x.instId === instId)
  return r?.status === 'COMPLETED' ? r : null
}, `${instId} completed`)
const opt = (b, id) => b.options.find((o) => o.id === id)
const hours = (s) => (s == null ? '-' : s < 360 ? `${s}s` : `${(s / 3600).toFixed(1)}h`)

const t0 = Date.now()
if (process.argv.includes('--reset')) execFileSync('node', [path.join(here, '..', 'scripts', 'seed-purchase-demo.mjs'), '--reset'], { stdio: 'inherit' })
for (const [k, e] of Object.entries(PEOPLE)) tok[k] = await login(e)

console.log('1. requests (정하은)')
const start = async (body) => {
  const r = await call('requester', 'POST', '/purchase/requests', body)
  if (r.status !== 200) throw new Error(`start: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.instId
}
const A = await start({ item: '27인치 모니터', quantity: 6, unitPrice: 500000, supplier: '한빛컴퓨터', supplierNew: false, reason: '신규 입사자 6명 자리 세팅' })
await sleep(1500)
const B = await start({ item: '노트북 (개발용)', quantity: 8, unitPrice: 1875000, supplier: '누리네트웍스', supplierNew: false, reason: 'AI 팀 개발 장비 교체' })
await sleep(1500)
const C = await start({ item: '사무용 의자', quantity: 14, unitPrice: 400000, supplier: '에이원상사', supplierNew: true, reason: '2층 휴게 공간 의자 교체' })
console.log(`  started ${A} (₩3M), ${B} (₩15M), ${C} (₩5.6M, new supplier)`)

const a = await itemFor('lead', A, 'lead_approval')
const ab = a.brief
check('₩3M: brief for 팀장 with 승인 / 수량 조정 후 승인 / 반려', ['approve', 'adjust', 'reject'].every((id) => opt(ab, id)), ab.options.map((o) => o.label).join(' / '))
check('₩3M: a recommendation with evidence', ab.recommendation?.text && ab.recommendation.evidence?.length >= 2 && opt(ab, ab.recommendation.option), `${ab.recommendation?.option} (${ab.recommendation?.by}): ${ab.recommendation?.text}`)
check('₩3M: no extra approval when approved', opt(ab, 'approve').effects.extraApprovals.length === 0, `next: ${opt(ab, 'approve').effects.next.join(' → ')}, ${hours(opt(ab, 'approve').effects.remainingSec)} left if decided now (usual ${hours(ab.usualSec)})`)
const draftA = ab.speculative.find((s) => s.id === 'po_draft')
check('₩3M: speculative order draft and stock check done before approval', draftA?.status === 'done' && ab.speculative.find((s) => s.id === 'stock_check')?.status === 'done', `${draftA?.text} · ${ab.speculative.find((s) => s.id === 'stock_check')?.text}`)

console.log('2. ₩15M and the inbox order')
const b = await itemFor('lead', B, 'lead_approval')
const bb = b.brief
check('₩15M: approving adds 재무 승인 (purchase-finance dry run)', opt(bb, 'approve').effects.extraApprovals.includes('재무 책임자'), `next: ${opt(bb, 'approve').effects.next.join(' → ')}`)
check('₩15M: 수량 조정 to stay within ₩10M drops it', opt(bb, 'adjust') && opt(bb, 'adjust').amount <= 10000000 && !opt(bb, 'adjust').effects.extraApprovals.includes('재무 책임자'),
  opt(bb, 'adjust') ? `${opt(bb, 'adjust').quantity}대 · ₩${opt(bb, 'adjust').amount.toLocaleString()} · ${hours(opt(bb, 'adjust').effects.remainingSec)} vs ${hours(opt(bb, 'approve').effects.remainingSec)}` : 'no adjust option')
const c = await itemFor('lead', C, 'lead_approval')
check('new supplier: approving asks 구매 담당 to check (purchase-new-supplier)', opt(c.brief, 'approve').effects.extraApprovals.includes('구매 담당'))
const order = (await inboxOf('lead')).filter((x) => [A, B, C].includes(x.instId))
const posA = order.findIndex((x) => x.instId === A), posB = order.findIndex((x) => x.instId === B)
check('inbox: the critical-path item (₩15M, goes on to 재무) comes first although it came later', posB >= 0 && posB < posA && order[posB].critical,
  order.map((x) => `#${x.rank} ${x.instName} — ${x.reason}`).join(' | '))

console.log('3. an order before approval')
const notBuyer = await call('requester', 'POST', `/purchase/orders/${encodeURIComponent(B)}/place`, {})
check('only purchasing may place an order', notBuyer.status === 403, `${notBuyer.status} ${notBuyer.body?.error || ''}`)
const early = await call('buyer', 'POST', `/purchase/orders/${encodeURIComponent(B)}/place`, {})
check('blocked by the policy before approval', early.status === 409 && early.body?.policy?.decision === 'deny' && early.body.policy.matched.some((m) => m.id === 'purchase-order-before-approval'), `${early.status} ${early.body?.error || ''}`)

console.log('4. ₩3M: 팀장 approves → 구매 담당 orders from the draft')
const da = await call('lead', 'POST', `/purchase/briefs/${a.todoId}/decide`, { option: 'approve' })
check('팀장 decides from the brief', da.status === 200 && da.body.decision.option === 'approve', da.body?.error || '')
const ha = await itemFor('buyer', A, 'order')
check('hand-over for 구매 담당: the decision, its reasons and the draft', ha.brief.kind === 'handover' && ha.brief.draft?.poNo === draftA?.poNo && ha.brief.decisions?.[0]?.decision === '승인' && ha.brief.reasons?.length >= 1,
  `${ha.brief.draft?.poNo} · ${ha.brief.decisions?.map((d) => `${d.step} ${d.by} ${d.decision}`).join(', ')} · prefill ${JSON.stringify(ha.brief.prefill)}`)
const pa = await call('buyer', 'POST', `/purchase/orders/${encodeURIComponent(A)}/place`, {})
check('order placed from the draft (policy: allowed now)', pa.status === 200 && pa.body.placed && pa.body.fromDraft && pa.body.order?.poNo === draftA?.poNo && pa.body.policy.decision === 'allow', `${pa.body?.order?.poNo} ${pa.body?.order?.status} · ${pa.body?.policy?.decision}`)
const ra = await completed('requester', A)
check('₩3M request completed', ra.status === 'COMPLETED' && ra.order?.status === 'placed')

console.log('5. ₩15M: 팀장 → 재무 → order')
const db = await call('lead', 'POST', `/purchase/briefs/${b.todoId}/decide`, { option: 'approve', comment: '분기 장비 계획에 있던 교체예요.' })
check('팀장 approves the ₩15M request', db.status === 200, db.body?.error || '')
const fb = await itemFor('finance', B, 'finance_approval')
check('재무 승인 brief for 이도윤 carries 팀장\'s decision', fb.brief.previous?.[0]?.decision === '승인' && fb.brief.previous[0].comment.includes('분기'), `${fb.brief.previous?.[0]?.by}: ${fb.brief.previous?.[0]?.comment} · rec ${fb.brief.recommendation?.option}`)
const dfb = await call('finance', 'POST', `/purchase/briefs/${fb.todoId}/decide`, { option: 'approve' })
check('재무 책임자 approves', dfb.status === 200, dfb.body?.error || '')
const hb = await itemFor('buyer', B, 'order')
check('hand-over lists both decisions', hb.brief.decisions?.length === 2, hb.brief.decisions?.map((d) => `${d.step}: ${d.by}`).join(', '))
const pb = await call('buyer', 'POST', `/purchase/orders/${encodeURIComponent(B)}/place`, {})
check('₩15M order placed from its draft', pb.status === 200 && pb.body.fromDraft && pb.body.policy.decision === 'allow', `${pb.body?.order?.poNo}`)
const rb = await completed('requester', B)
check('₩15M request completed', rb.status === 'COMPLETED' && rb.order?.status === 'placed')

console.log('6. a rejected request')
const draftC = c.brief.speculative.find((s) => s.id === 'po_draft')
const dc = await call('lead', 'POST', `/purchase/briefs/${c.todoId}/decide`, { option: 'reject', comment: '신규 공급사는 견적 비교 후 다시 요청해 주세요.' })
check('팀장 rejects; the speculative draft is compensated', dc.status === 200 && dc.body.compensation?.status === 'cancelled' && dc.body.compensation.poNo === draftC?.poNo, `${dc.body?.compensation?.poNo} ${dc.body?.compensation?.status}`)
const oc = (await call('requester', 'GET', `/purchase/orders/${encodeURIComponent(C)}`)).body.orders
check('the draft is cancelled in the order book', oc.length === 1 && oc[0].status === 'cancelled', oc.map((o) => `${o.poNo} ${o.status} (${o.cancelReason})`).join(', '))
const ledger = (await call('requester', 'GET', '/decisions')).body?.decisions?.find((d) => d.id === draftC?.decisionId)
check('the speculative action is marked undone in the decision ledger', ledger?.status === 'undone', ledger ? `${ledger.subject} → ${ledger.status}` : 'not visible')
const rc = await completed('requester', C)
check('rejected request ends (반려 종료) without an order', rc.status === 'COMPLETED' && rc.rejected && rc.order?.status === 'cancelled')
const bc = (await call('lead', 'GET', `/purchase/briefs/${c.todoId}`)).body.brief
check('the brief shows the draft cancelled', bc.speculative.find((s) => s.id === 'po_draft')?.status === 'cancelled' && bc.decidedOption === 'reject')

console.log('7. before / after')
const m = (await call('lead', 'GET', '/purchase/measure')).body
const line = (g) => `n=${g.instances} lead time median ${hours(g.leadTime.median)} (p80 ${hours(g.leadTime.p80)}), approval wait per instance median ${hours(g.approvalWait.perInstance.median)}, 팀장 wait ${hours(g.approvalWait.lead.median)}, 재무 wait ${hours(g.approvalWait.finance.median)}, 발주 work ${hours(g.order.work.median)}`
console.log(`  before: ${line(m.before)}`)
console.log(`  after:  ${line(m.after)}`)
console.log(`  what-if 사전 초안 (all three steps, work −50%): ${hours(m.prediction.all.beforeSec)} → ${hours(m.prediction.all.afterSec)} · order only ${hours(m.prediction.order.beforeSec)} → ${hours(m.prediction.order.afterSec)}`)
console.log(`  ${m.caveat}`)
check('measurements cover both groups', m.before.instances > 0 && m.after.instances >= 3)

console.log(`\n${results.length - failed}/${results.length} passed in ${Math.round((Date.now() - t0) / 1000)}s`)
console.log(JSON.stringify({ instances: { A, B, C }, measure: m }))
process.exit(failed ? 1 : 0)
