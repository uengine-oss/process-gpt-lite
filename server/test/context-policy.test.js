// 팀원 맥락 참고를 회사 정책으로(lib/context/sensitive.js + 카탈로그 context-*): 주제 찾기·사실·원장 한 줄은 순수 함수로,
// 결정은 실제 정책 엔진(PDP)으로 — 시험 전용 테넌트(끝나면 지움)에 카탈로그를 깔고 사례(context-policy-cases.json)를 하나씩 판단한다.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CATALOG, SENSITIVE_TOPICS } from '../lib/policy/catalog.js'
import { validate } from '../lib/policy/dsl.js'
import { evaluate, policiesOf, setEnabled, savePolicy } from '../lib/policy/pdp.js'
import { compileTopics, topicHit, factsOf, subjectOf, combine, relationName, topicsOf, contextPolicies, KIND } from '../lib/context/sensitive.js'
import { sensitiveHit, SENSITIVE_RULES } from '../lib/context/grade.js'
import { tenantStore } from '../lib/tenantStore.js'
import { q, pool } from '../lib/supa.js'

const CASES = JSON.parse(readFileSync(new URL('./context-policy-cases.json', import.meta.url))).cases
const CLEAN = 'context-policy-rt'
// 시험 테넌트는 호스트 목록에 없으니 withTenant 대신 저장소에 바로 넣는다(그 테넌트의 정책을 읽게)
const withTenant = (t, fn) => tenantStore.run({ tenant: t }, fn)
const REL = {
  team: { member: true, sameTeam: true, sameDept: true }, department: { member: true, sameTeam: false, sameDept: true },
  company: { member: true, sameTeam: false, sameDept: false }, outside: { member: false, sameTeam: false, sameDept: false },
}
const itemOf = (c) => ({ title: c.title, purpose: c.purpose || '', summary: c.summary || '', sensitive: c.sensitive || 'none', dismissed_at: c.dismissed ? new Date() : null })
after(async () => { await q('delete from pro_policies where tenant_id = $1', [CLEAN]); await pool.end() })

test('카탈로그: 맥락 정책 셋은 검증을 통과하고, 주제 목록은 grade 의 기본 규칙과 같다', () => {
  const ctx = CATALOG.filter((s) => s.scope.action.includes(KIND))
  assert.deepEqual(ctx.map((s) => s.id).sort(), ['context-access-record', 'context-sensitive-owner', 'context-sensitive-topic'])
  for (const s of ctx) assert.deepEqual(validate(s), [], s.id)
  assert.equal(SENSITIVE_RULES.length, SENSITIVE_TOPICS.length)
  assert.equal(validate({ ...ctx.find((s) => s.id === 'context-sensitive-topic'), topics: [{ name: '깨짐', pattern: '(' }] }).length, 1)
  assert.equal(validate({ ...ctx.find((s) => s.id === 'context-sensitive-topic'), topics: [{ name: '', pattern: 'x' }] }).length, 1)
})

test('주제 찾기: 낱말 경계(인사이트 ≠ 인사), 깨진 패턴은 건너뛴다, 정책이 꺼지면 찾지 않는다', () => {
  assert.equal(sensitiveHit('하반기 인사 평가'), '인사')
  assert.equal(sensitiveHit('고객 인사이트', '인사말 다듬기'), null)
  assert.equal(sensitiveHit('근로 계약 갱신'), '계약 조건')
  assert.equal(sensitiveHit('주민 번호 뒷자리'), '주민등록')
  const rules = compileTopics([{ name: '깨짐', pattern: '(' }, { name: '프로젝트X', pattern: '프로젝트\\s*X' }])
  assert.equal(rules.length, 1)
  assert.equal(topicHit(rules, '프로젝트 X 인수 검토'), '프로젝트X')
  assert.equal(topicHit(null, '연봉'), null)
})

test('사실·원장 한 줄: 무시한 제안은 주제를 보지 않고, 민감할 수 있으면 제목을 가린다', () => {
  const rules = compileTopics()
  const f = factsOf(itemOf({ title: '급여 조정' }), { rel: REL.team, depth: 'content', ownerRule: 'allow', rules })
  assert.deepEqual(f, { sensitive: false, topic: '급여', relation: 'team', depth: 'content', owner_rule: 'allow' })
  assert.equal(factsOf(itemOf({ title: '급여 조정', dismissed: true }), { rel: REL.team, depth: 'content', ownerRule: 'allow', rules }).topic, null)
  assert.equal(subjectOf({ title: '급여 조정' }, f, '박하늘'), '박하늘의 민감할 수 있는 맥락(제목 가림) 원문 참고')
  assert.equal(subjectOf({ title: '경쟁 동향' }, { ...f, topic: null }, '박하늘'), '박하늘의 「경쟁 동향」 원문 참고')
  assert.equal(relationName(REL.outside), 'outside')
  assert.deepEqual(combine('deny', 'allow'), { decision: 'deny', by: 'policy' })
  assert.deepEqual(combine('require_approval', 'allow'), { decision: 'ask', by: 'policy' })
  assert.deepEqual(combine('allow_audit', 'deny'), { decision: 'deny', by: 'rule' })
})

test(`판단 사례 ${CASES.length}개: 실제 정책 엔진이 사례대로 결정한다`, async () => {
  await q('delete from pro_policies where tenant_id = $1', [CLEAN])
  await policiesOf(CLEAN)
  const rules = await withTenant(CLEAN, () => topicsOf())
  assert.ok(rules?.length, '주제 정책이 켜져 있다')
  const bad = []
  for (const c of CASES) {
    const facts = factsOf(itemOf(c.item), { rel: REL[c.rel], depth: c.depth, ownerRule: c.owner_rule, rules })
    const r = await evaluate({ tenant: CLEAN, action: { kind: KIND, facts } })
    const fin = combine(r.decision, c.owner_rule)
    const matched = r.matched.filter((m) => m.decision === r.decision).map((m) => m.id).sort()
    const want = c.expect
    const got = { policy: r.decision, final: fin.decision, by: fin.by, matched, ...('topic' in want ? { topic: facts.topic } : {}) }
    const exp = { policy: want.policy, final: want.final, by: want.by, matched: [...want.matched].sort(), ...('topic' in want ? { topic: want.topic } : {}) }
    if (JSON.stringify(got) !== JSON.stringify(exp)) bad.push(`${c.name}\n  기대 ${JSON.stringify(exp)}\n  실제 ${JSON.stringify(got)}`)
    if (r.decision === 'require_approval') assert.equal(r.approver, '맥락 주인', c.name)
  }
  assert.deepEqual(bad, [])
})

test('회사가 정책을 끄고 고치면: 주제 정책을 끄면 주제로 묻지 않고, 목록을 고치면 그 목록으로 찾는다', async () => {
  await policiesOf(CLEAN)
  await setEnabled(null, 'context-sensitive-topic', false, CLEAN)
  assert.equal(await withTenant(CLEAN, () => topicsOf()), null)
  const p = await withTenant(CLEAN, () => contextPolicies())
  assert.deepEqual([p.sensitive, p.topic, p.record], [true, false, true])
  const facts = factsOf(itemOf({ title: '2분기 급여 조정 논의' }), { rel: REL.team, depth: 'content', ownerRule: 'allow', rules: null })
  assert.equal((await evaluate({ tenant: CLEAN, action: { kind: KIND, facts } })).decision, 'allow_audit')
  // 표시 정책을 끄면 민감 표시도 주인 규칙을 따른다(회사의 결정 — 원장에는 그대로 남는다)
  await setEnabled(null, 'context-sensitive-owner', false, CLEAN)
  assert.equal((await evaluate({ tenant: CLEAN, action: { kind: KIND, facts: { ...facts, sensitive: true } } })).decision, 'allow_audit')
  // 다시 켜고 목록을 회사 것으로
  const spec = CATALOG.find((s) => s.id === 'context-sensitive-topic')
  await savePolicy(null, { ...spec, topics: [{ name: '인수합병', pattern: '인수\\s*합병|M&A' }] }, { tenant: CLEAN })
  await setEnabled(null, 'context-sensitive-owner', true, CLEAN)
  const rules = await withTenant(CLEAN, () => topicsOf())
  assert.deepEqual(rules.map(([k]) => k), ['인수합병'])
  assert.equal(topicHit(rules, '경쟁사 M&A 검토'), '인수합병')
  assert.equal(topicHit(rules, '급여 조정'), null)
  await assert.rejects(savePolicy(null, { ...spec, topics: [{ name: 'x', pattern: '(' }] }, { tenant: CLEAN }), /topics/)
})
