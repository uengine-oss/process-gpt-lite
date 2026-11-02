// 민감 판단과 참고 요청의 결정을 회사 정책(lib/policy, 설정 › 정책)에 맡긴다(spec pgpt-pro_context-visibility · pgpt-pro_context-access-request).
//   민감한 글인지 읽기(spec pgpt-pro_guardrail-reading): 주민번호·계좌·전화 형식이 보이면 그것으로 사람에게 보내고, 아니면 모델이 글을 읽어
//   확률을 낸다(logprob). 낱말 목록(정책 context-sensitive-topic 의 topics)은 주제 이름이고, 모델이 답하지 못할 때만 판별을 대신한다.
//   읽은 값은 정책의 입력일 뿐이다 — 묻기·허용은 정책 엔진이 정한다. 회사가 그 정책을 끄면 읽지도, 제안하지도, 주제로 묻지도 않는다.
//   참고 요청: 정책 엔진(PDP)이 결정하고 결정 원장(pro_policy_decisions)에 남긴다 — 민감 표시·민감할 수 있는 주제면 주인에게 묻기,
//   그 밖에는 주인의 자동 허용 규칙. 허락·거절·만료·회수는 같은 원장 행을 고쳐 쓴다(pro_access_requests.policy_decision).
//   읽기(깊이 판정 visibility.depthOf)는 원장을 거치지 않는다 — 턴마다 부르는 빠른 길이다.
import crypto from 'node:crypto'
import { q } from '../supa.js'
import { config } from '../../config.js'
import { oddsOf } from '../decide.js'
import { findPii, maskPii } from '../policy/pii.js'
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
// 모델이 답하지 못한 맥락을 낱말로 대신 볼 때도, 판별한 뒤 주제 이름을 붙일 때도 쓰는 글
export const contextText = (item) => [item.title, item.purpose, item.summary].filter(Boolean).join('\n')
const FORMAT_TOPICS = { resident_id: '주민등록번호', bank_account: '계좌번호', mobile: '전화번호' }
export function formatHit(text) {
  const { kinds } = findPii(text)
  const k = Object.keys(FORMAT_TOPICS).find((x) => kinds.includes(x))
  return k ? FORMAT_TOPICS[k] : null
}
export const READING = { bar: 0.5, maxChars: 1500, scanMax: 12, version: 2 }
export const OTHER_TOPIC = '민감한 사항'
export const SENSITIVE_QUESTION = '이 업무 맥락을 다른 팀원에게 보여 주기 전에 주인 확인이 필요한가?'
export const NAME_QUESTION = '이 업무 맥락의 민감한 내용은 어떤 주제에 가장 가까운가?'
export const sensitiveOptions = (rules) => [
  { key: 'sensitive', label: `특정 직원·고객이나 직원 무리에 관한 ${rules.map(([k]) => k).join('·')}·사생활처럼, 당사자 모르게 퍼지면 곤란한 내용을 다룬다` },
  { key: 'normal', label: '일반 업무 내용이다(제품·기술·시장·고객 응대 자료, 특정인이 드러나지 않는 규정·통계·양식·전사 공지 포함)' },
]
export const readingState = (item) => `업무 맥락:\n${maskPii(contextText(item)).slice(0, READING.maxChars)}`

// 맥락 하나를 읽는다: {topic, source: format|logprob|regex, p, model}. ask 는 시험에서 바꿔 끼운다.
export async function readContext(item, { rules, ask = oddsOf } = {}) {
  const fmt = formatHit(contextText(item))
  if (fmt) return { topic: fmt, source: 'format', p: null, model: null }
  const state = readingState(item)
  const d = await ask(state, SENSITIVE_QUESTION, sensitiveOptions(rules))
  if (!d) return { topic: topicHit(rules, item.title, item.purpose, item.summary), source: 'regex', p: null, model: null }
  const p = Number(d.probabilities.sensitive.toFixed(4))
  if (p < READING.bar) return { topic: null, source: 'logprob', p, model: d.model }
  const options = [...rules.slice(0, 24).map(([k], i) => ({ key: `t${i}`, label: k, name: k })), { key: 'other', label: OTHER_TOPIC, name: OTHER_TOPIC }]
  const named = await ask(state, NAME_QUESTION, options)
  return { topic: options.find((o) => o.key === named?.choice)?.name || OTHER_TOPIC, source: 'logprob', p, model: d.model }
}

export const relationName = (rel) => (rel.sameTeam ? 'team' : rel.sameDept ? 'department' : rel.member ? 'company' : 'outside')
// 정책에 넘길 사실. 주인이 제안을 무시한 맥락은 주제를 보지 않는다(주인이 「민감 아님」이라고 했다)
export function factsOf(item, { rel, depth, ownerRule, reading = null }) {
  const sensitive = item.sensitive === 'confirmed'
  const r = sensitive || item.dismissed_at ? null : reading
  return { sensitive, topic: r?.topic || null, topic_source: r?.source || null, topic_p: r?.p ?? null, topic_model: r?.model || null,
    relation: relationName(rel), depth, owner_rule: ownerRule }
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

// 읽은 값을 맥락마다 남겨 둔다(글이 그대로면 모델을 다시 부르지 않는다). 낱말로 대신한 값은 남기지 않는다 — 모델이 돌아오면 다시 읽게.
const hashOf = (item, rules) => crypto.createHash('sha1').update(`${READING.version}\n${contextText(item)}\n${rules.map(([k]) => k).join(',')}`).digest('hex')
const savedReadings = async (rows) => (rows.length ? q(`select * from pro_context_readings where tenant_id = $1 and (user_id, conversation_id) in (select * from unnest($2::text[], $3::text[]))`,
  [T(), rows.map((r) => String(r.owner)), rows.map((r) => String(r.id))]) : [])
async function readAndSave(item, rules, hash, ask) {
  const r = await readContext(item, { rules, ask })
  if (r.source !== 'regex') {
    await q(`insert into pro_context_readings (tenant_id, user_id, conversation_id, text_hash, topic, p, source, model) values ($1,$2,$3,$4,$5,$6,$7,$8)
             on conflict (tenant_id, user_id, conversation_id) do update set text_hash = $4, topic = $5, p = $6, source = $7, model = $8, read_at = now()`,
    [T(), String(item.owner), String(item.id), hash, r.topic, r.p, r.source, r.model])
  }
  return r
}
const rowReading = (s) => ({ topic: s.topic, source: s.source, p: s.p == null ? null : Number(Number(s.p).toFixed(4)), model: s.model, saved: true })

// 맥락마다 읽은 값(Map id → 값). 새로 읽는 수는 max 까지 — 나머지는 다음에 읽는다(스캔이 화면을 붙잡지 않게).
export async function readingsOf(rows, rules, { ask = oddsOf, max = READING.scanMax } = {}) {
  const out = new Map()
  const saved = new Map((await savedReadings(rows)).map((s) => [s.conversation_id, s]))
  let left = max
  for (const r of rows) {
    const hash = hashOf(r, rules), s = saved.get(String(r.id))
    if (s?.text_hash === hash) out.set(r.id, rowReading(s))
    else if (left > 0) { left--; out.set(r.id, await readAndSave(r, rules, hash, ask)) }
  }
  return out
}
// 제안 중인 맥락에 붙일 주제 이름: 읽은 값이 있으면 그것, 없으면 낱말
export async function hitsOf(rows, rules) {
  const saved = new Map((await savedReadings(rows)).map((s) => [s.conversation_id, s.topic]))
  return new Map(rows.map((r) => [r.id, saved.get(String(r.id)) || topicHit(rules, r.title, r.purpose, r.summary)]))
}

// 참고 요청 하나를 정책으로 판단하고 원장에 남긴다: {id, decision(정책), matched, facts, final: {decision: allow|ask|deny, by}}
// 정책 엔진이 답하지 못하면 닫힌 쪽으로(주인에게 묻기) — 원장 행 없이.
export async function judgeRequest({ requester, item, rel, depth, ownerRule, ownerName }) {
  const rules = await topicsOf().catch(() => compileTopics())
  const reading = rules && item.sensitive !== 'confirmed' && !item.dismissed_at
    ? (await readingsOf([item], rules).catch(() => new Map())).get(item.id) || { topic: topicHit(rules, item.title, item.purpose, item.summary), source: 'regex', p: null, model: null }
    : null
  const facts = factsOf(item, { rel, depth, ownerRule: ownerRule.decision, reading })
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

// 민감 표시 제안: 표시가 없고 전에 무시하지 않은 맥락의 제목·한 줄 목적·맥락 요약을 읽는다 → proposed.
// convs 를 주면 그 맥락만(맥락 요약을 만든 직후), notify 면 새로 제안한 맥락마다 주인에게 홈 카드를 보낸다.
export async function scanOwner(owner, { convs = null, notify = false } = {}) {
  const rules = await topicsOf()
  const rows = await contextRows({ owners: [String(owner)], convs })
  const fresh = []
  if (!rules) return { rows, fresh, rules }
  const todo = rows.filter((r) => r.sensitive === 'none' && !r.dismissed_at)
  const readings = await readingsOf(todo, rules)
  for (const r of todo) {
    const reading = readings.get(r.id)
    const hit = reading?.topic
    if (!hit) continue
    // 행이 없던 맥락은 지금 보이는 등급(기본 등급) 그대로 행을 만든다
    await q(`insert into pro_context_shares (tenant_id, user_id, conversation_id, visibility, reach, sensitive, purpose) values ($1,$2,$3,$4,$5,'proposed',$6)
             on conflict (tenant_id, user_id, conversation_id) do update set sensitive = 'proposed', updated_at = now() where pro_context_shares.sensitive = 'none'`,
      [T(), String(owner), r.id, r.visibility, r.reach, r.purpose || ''])
    r.sensitive = 'proposed'
    fresh.push({ ...r, hit, reading })
  }
  if (notify && fresh.length) {
    const { notifyContext } = await import('./access.js')
    for (const r of fresh) {
      await notifyContext(owner, { type: 'context_sensitive', title: `민감 표시 제안 · 「${r.title}」`, url: '/settings/sharing',
        description: `${r.reading?.source === 'format' ? `글에 ${r.hit}로 보이는 값이 있어요.` : `「${r.hit}」에 관한 내용으로 보여요.`} 민감으로 표시하면 전체 공개는 요약까지로 좁혀지고, 참고 요청은 언제나 내게 물어요. 아니면 무시하세요.` })
    }
  }
  return { rows, fresh, rules }
}
