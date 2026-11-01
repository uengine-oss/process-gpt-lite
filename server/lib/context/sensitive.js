// 민감 판단과 참고 요청의 결정을 회사 정책(lib/policy, 설정 › 정책)에 맡긴다(spec pgpt-pro_context-visibility · pgpt-pro_context-access-request).
//   주제 목록: 정책 context-sensitive-topic 의 topics. 회사가 그 정책을 끄면 민감 표시 제안도, 주제로 묻기도 멈춘다.
//   참고 요청: 정책 엔진(PDP)이 결정하고 결정 원장(pro_policy_decisions)에 남긴다 — 민감 표시·민감할 수 있는 주제면 주인에게 묻기,
//   그 밖에는 주인의 자동 허용 규칙. 허락·거절·만료·회수는 같은 원장 행을 고쳐 쓴다(pro_access_requests.policy_decision).
//   읽기(깊이 판정 visibility.depthOf)는 원장을 거치지 않는다 — 턴마다 부르는 빠른 길이다.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { policiesOf, decide } from '../policy/pdp.js'
import { SENSITIVE_TOPICS } from '../policy/catalog.js'
import { contextRows } from './items.js'
import { DEPTH_LABEL } from './visibility.js'

const T = () => config.tenantId
export const KIND = 'context.access'
export const OWNER_POLICY = 'context-sensitive-owner'
export const TOPIC_POLICY = 'context-sensitive-topic'
export const RECORD_POLICY = 'context-access-record'

// ── 순수 함수(시험: test/context-policy.test.js) ─────────────────────────────
export function compileTopics(topics = SENSITIVE_TOPICS) {
  const out = []
  for (const t of topics || []) { try { out.push([t.name, new RegExp(t.pattern)]) } catch { /* 저장할 때 dsl.validate 가 거른다 */ } }
  return out
}
export function topicHit(rules, ...texts) {
  if (!rules) return null
  const t = texts.filter(Boolean).join('\n')
  for (const [k, re] of rules) if (re.test(t)) return k
  return null
}
export const relationName = (rel) => (rel.sameTeam ? 'team' : rel.sameDept ? 'department' : rel.member ? 'company' : 'outside')
// 정책에 넘길 사실. 주인이 제안을 무시한 맥락은 주제를 보지 않는다(주인이 「민감 아님」이라고 했다)
export function factsOf(item, { rel, depth, ownerRule, rules }) {
  const sensitive = item.sensitive === 'confirmed'
  const topic = sensitive || item.dismissed_at ? null : topicHit(rules, item.title, item.purpose, item.summary)
  return { sensitive, topic, relation: relationName(rel), depth, owner_rule: ownerRule }
}
// 원장의 한 줄: 민감 표시나 민감할 수 있는 주제가 보이면 제목을 가린다(관리자도 원장으로 제목을 알게 되지 않게)
export function subjectOf(item, facts, ownerName) {
  const what = facts.sensitive || facts.topic ? '민감할 수 있는 맥락(제목 가림)' : `「${item.title}」`
  return `${ownerName || '팀원'}의 ${what} ${DEPTH_LABEL[facts.depth] || facts.depth} 참고`
}
// 정책 결정과 주인 규칙을 합친다: deny → 거절, require_approval → 주인에게 묻기, 그 밖에는 주인 규칙대로
export function combine(policyDecision, ownerRule) {
  if (policyDecision === 'deny') return { decision: 'deny', by: 'policy' }
  if (policyDecision === 'require_approval') return { decision: 'ask', by: 'policy' }
  return { decision: ownerRule, by: 'rule' }
}

// ── 회사 정책 ─────────────────────────────────────────────────────────────
// 회사가 켠 주제 목록(정책이 꺼져 있으면 null — 제안하지 않는다)
export async function topicsOf() {
  const spec = (await policiesOf()).find((s) => s.id === TOPIC_POLICY)
  return spec ? compileTopics(spec.topics?.length ? spec.topics : SENSITIVE_TOPICS) : null
}
// 지금 켜진 맥락 정책(설정 › 공유와 허락의 고정 줄이 보여 준다)
export async function contextPolicies() {
  const specs = await policiesOf()
  const on = (id) => specs.find((s) => s.id === id)
  return { sensitive: !!on(OWNER_POLICY), topic: !!on(TOPIC_POLICY), record: !!on(RECORD_POLICY),
    titles: { sensitive: on(OWNER_POLICY)?.title?.[0] || null, topic: on(TOPIC_POLICY)?.title?.[0] || null } }
}

// 참고 요청 하나를 정책으로 판단하고 원장에 남긴다: {id, decision(정책), matched, facts, final: {decision: allow|ask|deny, by}}
// 정책 엔진이 답하지 못하면 닫힌 쪽으로(주인에게 묻기) — 원장 행 없이.
export async function judgeRequest({ requester, item, rel, depth, ownerRule, ownerName }) {
  const facts = factsOf(item, { rel, depth, ownerRule: ownerRule.decision, rules: await topicsOf().catch(() => compileTopics()) })
  try {
    const d = await decide({ userId: requester, action: { kind: KIND, subject: subjectOf(item, facts, ownerName), facts } })
    return { ...d, facts, final: combine(d.decision, ownerRule.decision) }
  } catch (e) {
    console.warn('[context] policy', e.message)
    return { id: null, decision: 'require_approval', matched: [], facts, failed: true, final: { decision: 'ask', by: 'policy' } }
  }
}

// 요청이 어떻게 끝났는지 원장 행에 적는다. status: pending|executed|approved|rejected|expired|undone
export async function ledgerUpdate(decisionId, { status, by = null, result = {} }) {
  if (!decisionId) return
  await q(`update pro_policy_decisions set status = $3, approved_by = coalesce($4::uuid, approved_by), approved_at = case when $4::uuid is null then approved_at else now() end,
             approver_role = case when $3 = 'pending' then coalesce(approver_role, '맥락 주인') else approver_role end,
             result = coalesce(result, '{}'::jsonb) || $5::jsonb
           where id = $1 and tenant_id = $2 and action_kind = '${KIND}'`, [decisionId, T(), status, by, JSON.stringify(result)])
}

// 민감 표시 제안(규칙): 표시가 없고 전에 무시하지 않은 맥락을 제목·한 줄 목적·맥락 요약으로 본다 → proposed.
// convs 를 주면 그 맥락만(맥락 요약을 만든 직후), notify 면 새로 제안한 맥락마다 주인에게 홈 카드를 보낸다.
export async function scanOwner(owner, { convs = null, notify = false } = {}) {
  const rules = await topicsOf()
  const rows = await contextRows({ owners: [String(owner)], convs })
  const fresh = []
  if (!rules) return { rows, fresh, rules }
  for (const r of rows) {
    if (r.sensitive !== 'none' || r.dismissed_at) continue
    const hit = topicHit(rules, r.title, r.purpose, r.summary)
    if (!hit) continue
    // 행이 없던 맥락은 지금 보이는 등급(기본 등급) 그대로 행을 만든다
    await q(`insert into pro_context_shares (tenant_id, user_id, conversation_id, visibility, reach, sensitive, purpose) values ($1,$2,$3,$4,$5,'proposed',$6)
             on conflict (tenant_id, user_id, conversation_id) do update set sensitive = 'proposed', updated_at = now() where pro_context_shares.sensitive = 'none'`,
      [T(), String(owner), r.id, r.visibility, r.reach, r.purpose || ''])
    r.sensitive = 'proposed'
    fresh.push({ ...r, hit })
  }
  if (notify && fresh.length) {
    const { notifyContext } = await import('./access.js')
    for (const r of fresh) {
      await notifyContext(owner, { type: 'context_sensitive', title: `민감 표시 제안 · 「${r.title}」`, url: '/settings/sharing',
        description: `「${r.hit}」에 관한 내용으로 보여요. 민감으로 표시하면 전체 공개는 요약까지로 좁혀지고, 참고 요청은 언제나 내게 물어요. 아니면 무시하세요.` })
    }
  }
  return { rows, fresh, rules }
}
