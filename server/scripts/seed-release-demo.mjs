// 시나리오 1 「금요일 출시」(pgpt-pro/docs/agentic-bpm/plan.md §6) 시드 — 다시 돌려도 된다(같은 id 를 덮어쓴다).
//   . <scratchpad>/agentic-env.sh && node scripts/seed-release-demo.mjs      전략 그래프 · 출시 계획 · QA 에이전트의 발견
//   … --no-llm     QA 에이전트를 모델 없이(정해 둔 발견 문구로)
//   … --reset      한 번 더 찍기(녹화): 전략 그래프를 기본값(우선순위·위험 허용)으로 되돌리고, 이 시나리오의 출시 요청·
//                  최적화·대화 카드·시연 배포 기록·결정 원장(release.deploy)·알림을 지운다. 발견은 다시 열린 상태로
//   … --fix        발견을 고친 것으로(status fixed) — 다시 계산하면 공개 출시가 정책을 통과한다
//   … --tenant <id>  다른 테넌트(lib/seedTenant.js)
// 회사: 클라우드 스토리지 서비스. 전략목표 4개(BSC 4관점) — 고객 신뢰(1순위, 개인정보·보안 위험 허용 낮음, 필수 제약
// release-open-pii · release-security-scan), 출시 일정 준수(2, 품질 위험 보통, 권장 제약 release-friday-public),
// 매출 성장(2), 개발 생산성(3). 간선: 기능 → 기여하는 목표(가중치), 정책 → 보호하는 목표, 프로세스 단계 → 목표.
// 출시 계획: 금요일 16:00 공개 출시, 기능 3개(공유 링크는 개인정보를 다룸). QA 에이전트가 공유 링크 diff 에서 개인정보 노출을 찾음.
process.env.DOTENV_CONFIG_QUIET = 'true'
const { q, pool } = await import('../lib/supa.js')
const { enterSeedTenant } = await import('../lib/seedTenant.js')
const { saveObjective, saveLink, graphOf } = await import('../lib/strategy/graph.js')
const { policiesOf, setEnabled } = await import('../lib/policy/pdp.js')
const { DEMO_PLAN, DEMO_FINDING, qaReview } = await import('../lib/scenarios/release.js')

const T = enterSeedTenant()
const has = (k) => process.argv.includes(k)

export const OBJECTIVES = [
  { id: 'revenue-growth', perspective: 'financial', name: '매출 성장', priority: 2, risk_appetite: {}, constraints: [],
    kpi: { name: '유료 전환율', target: 4.5, current: 3.8, unit: '%', direction: 'up', measure: 'reach' } },
  { id: 'customer-trust', perspective: 'customer', name: '고객 신뢰', priority: 1, parent: 'revenue-growth',
    risk_appetite: { privacy: 'low', security: 'low' },
    constraints: [{ policy: 'release-open-pii', level: 'must' }, { policy: 'release-security-scan', level: 'must' }],
    kpi: { name: '고객 신뢰 지수(NPS)', target: 45, current: 38, unit: '점', direction: 'up', measure: 'reach' } },
  { id: 'release-on-time', perspective: 'process', name: '출시 일정 준수', priority: 2, parent: 'customer-trust',
    risk_appetite: { quality: 'medium' }, constraints: [{ policy: 'release-friday-public', level: 'should' }],
    kpi: { name: '계획 기능 적시 배포율', target: 90, current: 82, unit: '%', direction: 'up', measure: 'on_time' } },
  { id: 'dev-productivity', perspective: 'learning', name: '개발 생산성', priority: 3, parent: 'release-on-time',
    risk_appetite: { quality: 'high' }, constraints: [],
    kpi: { name: '출시 후 2주 사용 피드백 확보율', target: 80, current: 55, unit: '%', direction: 'up', measure: 'feedback' } },
]
// [source, objective, relation, weight]
export const LINKS = [
  ['feature:공유 링크', 'customer-trust', 'contributes', 0.3], ['feature:공유 링크', 'revenue-growth', 'contributes', 0.6],
  ['feature:공유 링크', 'release-on-time', 'contributes', 1], ['feature:공유 링크', 'dev-productivity', 'contributes', 0.3],
  ['feature:대용량 업로드', 'customer-trust', 'contributes', 0.2], ['feature:대용량 업로드', 'revenue-growth', 'contributes', 0.8],
  ['feature:대용량 업로드', 'release-on-time', 'contributes', 1], ['feature:대용량 업로드', 'dev-productivity', 'contributes', 0.3],
  ['feature:폴더 동기화 개선', 'customer-trust', 'contributes', 0.8], ['feature:폴더 동기화 개선', 'revenue-growth', 'contributes', 0.3],
  ['feature:폴더 동기화 개선', 'release-on-time', 'contributes', 1], ['feature:폴더 동기화 개선', 'dev-productivity', 'contributes', 0.4],
  ['policy:release-open-pii', 'customer-trust', 'protects', 1], ['policy:release-security-scan', 'customer-trust', 'protects', 1],
  ['policy:release-friday-public', 'customer-trust', 'protects', 0.5], ['policy:release-internal', 'dev-productivity', 'protects', 0.3],
  ['activity:release/qa-review', 'customer-trust', 'contributes', 0.6], ['activity:release/deploy', 'release-on-time', 'contributes', 0.8],
  ['activity:release/beta-feedback', 'dev-productivity', 'contributes', 0.7],
]
const RELEASE_POLICIES = ['release-open-pii', 'release-security-scan', 'release-internal', 'release-friday-public']

try {
  // the strategy graph
  for (const o of OBJECTIVES) await saveObjective(o, T)
  const ours = OBJECTIVES.map((o) => o.id)
  const keep = new Set(LINKS.map(([s, o, r]) => `${s}|${o}|${r}`))
  for (const l of await q('select source, objective, relation from pro_strategy_links where tenant_id=$1 and objective = any($2)', [T, ours])) {
    if (!keep.has(`${l.source}|${l.objective}|${l.relation}`)) await q('delete from pro_strategy_links where tenant_id=$1 and source=$2 and objective=$3 and relation=$4', [T, l.source, l.objective, l.relation])
  }
  for (const [source, objective, relation, weight] of LINKS) await saveLink({ source, objective, relation, weight }, T)

  // the release policies exist and are on
  const all = await policiesOf(T, { all: true })
  for (const id of RELEASE_POLICIES) {
    const p = all.find((x) => x.id === id)
    if (!p) throw new Error(`policy ${id} is not in the catalog`)
    if (!p.enabled) { await setEnabled(null, id, true, T); console.log(`  policy ${id}: turned on`) }
  }

  // the release plan and the QA agent's finding
  await q(`insert into pro_release_plans(tenant_id, id, title, planned_for, audience, features, security_scan) values ($1,$2,$3,$4,$5,$6,$7)
    on conflict (tenant_id, id) do update set title=$3, planned_for=$4, audience=$5, features=$6, security_scan=$7`,
  [T, DEMO_PLAN.id, DEMO_PLAN.title, DEMO_PLAN.planned_for, DEMO_PLAN.audience, JSON.stringify(DEMO_PLAN.features), DEMO_PLAN.security_scan])
  const [had] = await q('select title, detail, fix_days from pro_release_findings where tenant_id=$1 and id=$2', [T, DEMO_FINDING.id])
  // the QA agent writes the finding once (a re-seed keeps its words unless there were none)
  const f = had && !has('--requalify') ? { ...DEMO_FINDING, ...had } : has('--no-llm') ? DEMO_FINDING : await qaReview()
  await q(`insert into pro_release_findings(id, tenant_id, plan_id, feature, category, severity, title, detail, fix_days, status, found_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    on conflict (tenant_id, id) do update set feature=$4, category=$5, severity=$6, title=$7, detail=$8, fix_days=$9, status=$10, found_by=$11`,
  [f.id, T, DEMO_PLAN.id, f.feature, f.category, f.severity, f.title, f.detail, f.fix_days, has('--fix') ? 'fixed' : 'open', f.found_by])

  if (has('--reset')) {
    const opts = (await q(`select id from pro_optimizations where tenant_id=$1 and trigger->'action'->>'kind'='release.deploy'`, [T])).map((r) => r.id)
    const msgs = (await q('select message_id from pro_optimization_cards where optimization_id = any($1::uuid[])', [opts])).map((r) => r.message_id)
    if (msgs.length) await q('delete from pro_messages where id = any($1::uuid[])', [msgs])
    await q('delete from pro_optimization_cards where optimization_id = any($1::uuid[])', [opts])
    await q('delete from pro_optimizations where id = any($1::uuid[])', [opts])
    await q('delete from pro_release_requests where tenant_id=$1 and plan_id=$2', [T, DEMO_PLAN.id])
    await q('delete from pro_release_deployments where tenant_id=$1 and plan_id=$2', [T, DEMO_PLAN.id])
    // the ledger rows of release.deploy (the requests, the dry runs, the runs) and the 'policy' cards they posted
    const refs = (await q(`select ref from pro_policy_decisions where tenant_id=$1 and action_kind='release.deploy' and ref like 'message:%'`, [T])).map((r) => r.ref.slice(8))
    if (refs.length) await q('delete from pro_messages where id = any($1::uuid[])', [refs])
    const led = await q(`delete from pro_policy_decisions where tenant_id=$1 and action_kind='release.deploy' returning id`, [T])
    // the notifications this scenario sent (their titles carry the plan's title)
    const notes = await q(`delete from notifications where tenant_id=$1 and title like $2 returning id`, [T, `%${DEMO_PLAN.title}%`]).catch(() => [])
    console.log(`  reset: ${opts.length} optimizations, ${msgs.length + refs.length} cards, ${led.length} ledger rows, ${notes.length} notifications`)
  }

  const g = await graphOf(T)
  console.log(`seeded ${T}: ${g.objectives.length} objectives, ${g.links.length} links · plan ${DEMO_PLAN.id} (${DEMO_PLAN.features.length} features)`)
  console.log(`  finding [${has('--fix') ? 'fixed' : 'open'}] ${f.title}${f.by_model ? ' (QA agent, model)' : ''}`)
} finally {
  await pool.end()
}
