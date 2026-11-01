// 참고 요청과 허락(spec pgpt-pro_context-access-request).
//   요청하기 → 주인의 자동 허용 규칙(기본: 같은 팀은 원문까지 자동 허용, 이 작업 동안) → 허락 / 주인의 홈 카드(묻기) / 거절.
//   허락은 깊이·기간 안에서만 쓰이고(visibility.depthOf), 주인은 언제든 회수한다. 받은 맥락은 복사하지 않는다(참조만).
//   알림은 Process GPT notifications(홈 카드·알림 종·푸시가 그대로 받는다): context_access(주인이 결정할 요청),
//   context_access_result(요청자에게 결과), context_access_digest(오늘 자동으로 허락한 참고 — 하루 한 장).
//   결정은 회사 정책이 먼저(lib/context/sensitive.js — 민감 표시·민감할 수 있는 주제면 주인에게 묻기), 주인 규칙은 그 안에서. 모든 결정은 결정 원장에.
import { q, pool } from '../supa.js'
import { config } from '../../config.js'
import { emit } from '../bus.js'
import { viewerOf, contextRows, depthFor, grantsOf, turnsOf, ContextError } from './items.js'
import { relation, personName } from './org.js'
import { ruleFor, atLeast, DEFAULT_RULES, DEPTH_LABEL, durationLabel } from './visibility.js'
import { judgeRequest, ledgerUpdate, contextPolicies } from './sensitive.js'

export const DAILY_LIMIT = 30
const DUR = ['task', '7d', 'forever']
const DAY = 86400000
const T = () => config.tenantId
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function tx(fn) {
  const c = await pool.connect()
  try { await c.query('begin'); const r = await fn((t, p) => c.query(t, p).then((x) => x.rows)); await c.query('commit'); return r }
  catch (e) { await c.query('rollback').catch(() => {}); throw e }
  finally { c.release() }
}
export async function notifyContext(user, { type, title, description = '', url, from = null }) {
  await q(`insert into notifications (id, user_id, title, type, description, is_checked, time_stamp, url, from_user_id, tenant_id)
           values (gen_random_uuid(), $1, $2, $3, $4, false, now(), $5, $6, $7)`, [String(user), title.slice(0, 200), type, description.slice(0, 1000), url, from, T()])
  emit(String(user), 'notifications', {})
}
const emailOf = async (id) => (await q(`select email from users where id::text = $1 and tenant_id = $2`, [String(id), T()]))[0]?.email || null

// 자동 허용은 바로 알리지 않고 하루 한 장으로 모은다(같은 날 그 카드를 고쳐 쓴다)
async function digest(owner) {
  const today = await q(`select target_title, depth, requester from pro_access_requests where tenant_id = $1 and owner = $2 and via = 'auto' and status = 'granted' and decided_at >= date_trunc('day', now()) order by decided_at`, [T(), owner])
  const { orgOf } = await import('./org.js')
  const org = await orgOf(T())
  const title = `오늘 자동으로 허락한 참고 ${today.length}건`
  const description = today.map((r) => `${personName(org, r.requester)} · 「${r.target_title}」 ${DEPTH_LABEL[r.depth]}`).join('\n')
  const [row] = await q(`select id from notifications where tenant_id = $1 and user_id = $2 and type = 'context_access_digest' and time_stamp >= date_trunc('day', now()) order by time_stamp desc limit 1`, [T(), String(owner)])
  if (row) { await q(`update notifications set title = $2, description = $3, is_checked = false where id = $1`, [row.id, title, description]); emit(String(owner), 'notifications', {}) }
  else await notifyContext(owner, { type: 'context_access_digest', title, description, url: '/settings/sharing' })
}

// 고정 줄(민감 항목 → 묻기)은 주인 규칙이 아니라 회사 정책이다: 관리자가 설정 › 정책에서 끄면 민감 항목도 주인 규칙을 따른다
export async function rulesOf(owner) {
  const [r] = await q(`select rules, default_visibility, default_reach from pro_sharing_rules where tenant_id = $1 and user_id = $2`, [T(), owner])
  const policy = await contextPolicies().catch(() => ({ sensitive: true, topic: true, record: true, titles: {} }))
  return { enabled: !!r, rules: r?.rules?.length ? r.rules : DEFAULT_RULES, custom: !!r?.rules?.length, default_visibility: r?.default_visibility || 'summary', default_reach: r?.default_reach || 'team',
    fixed: { who: 'sensitive', decision: policy.sensitive ? 'ask' : 'rule', policy,
      note: policy.sensitive ? '민감 항목은 언제나 묻기(회사 정책 · 지울 수 없음)' : '회사 정책이 꺼져 있어 민감 항목도 내 규칙을 따릅니다' }, defaults: DEFAULT_RULES }
}
export async function saveRules(me, body = {}) {
  const ok = (r) => r && (['team', 'department', 'company'].includes(r.who) || /^user:[0-9a-f-]{36}$/i.test(String(r.who))) && ['allow', 'ask', 'deny'].includes(r.decision)
  const rules = (Array.isArray(body.rules) ? body.rules : []).filter(ok).map((r) => ({ who: r.who, decision: r.decision,
    ...(r.decision === 'allow' ? { depth: r.depth === 'summary' ? 'summary' : 'content', duration: DUR.includes(r.duration) ? r.duration : 'task' } : {}) })).slice(0, 12)
  const dv = ['private', 'listed', 'summary', 'open'].includes(body.default_visibility) ? body.default_visibility : 'summary'
  const dr = ['team', 'department', 'company'].includes(body.default_reach) ? body.default_reach : 'team'
  await q(`insert into pro_sharing_rules (tenant_id, user_id, rules, default_visibility, default_reach) values ($1,$2,$3,$4,$5)
           on conflict (tenant_id, user_id) do update set rules = excluded.rules, default_visibility = excluded.default_visibility, default_reach = excluded.default_reach, updated_at = now()`,
    [T(), me.id, JSON.stringify(rules), dv, dr])
  return rulesOf(me.id)
}

function grantWindow(duration, threadId, now = new Date()) {
  if (duration === 'forever') return { thread: null, until: null }
  return { thread: duration === 'task' ? threadId || null : null, until: new Date(now.getTime() + 7 * DAY).toISOString() }
}
async function makeGrant(x, req, { depth, duration, exclude = [], via }) {
  const w = grantWindow(duration, req.thread_id)
  return (await x(`insert into pro_grants (tenant_id, owner, grantee, conversation_id, target_title, depth, duration, thread_id, until, exclude, via, request_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
    [T(), req.owner, req.requester, req.conversation_id, req.target_title, depth, duration, w.thread, w.until, JSON.stringify(exclude), via, req.id]))[0]
}

// 응답 없는 요청은 3일 뒤 만료(읽을 때 쓸어 담는다)
export async function sweep() {
  const gone = await q(`update pro_access_requests set status = 'expired', via = 'expiry', decided_at = now() where tenant_id = $1 and status = 'pending' and expires_at <= now() returning *`, [T()])
  for (const r of gone) {
    await ledgerUpdate(r.policy_decision, { status: 'expired', result: { outcome: 'expired' } }).catch(() => {})
    await notifyContext(r.requester, { type: 'context_access_result', title: `참고 요청 만료 · 「${r.target_title}」`, description: '주인이 3일 동안 답하지 않아 응답 없음으로 만료되었습니다.', url: '/settings/sharing', from: await emailOf(r.owner) })
    await q(`update notifications set is_checked = true where tenant_id = $1 and type = 'context_access' and url = $2`, [T(), `/pro/context-access/${r.id}`])
  }
  return gone.length
}

export async function createRequest(me, body = {}, { via: callerVia = 'jwt' } = {}) {
  const vc = await viewerOf(me, callerVia)
  const conv = String(body.conversationId || body.target?.id || '')
  const depth = body.depth === 'summary' ? 'summary' : 'content'
  if (!conv) throw new ContextError(400, '맥락(conversationId)이 필요합니다')
  const [item] = (await contextRows({ convs: [conv] })).filter((x) => x.owner === vc.viewer || vc.org.people.has(x.owner))
  if (!item) throw new ContextError(404, '없는 맥락입니다')
  const threadId = body.threadId && UUID.test(String(body.threadId)) ? String(body.threadId) : null
  const d = depthFor(vc, item, await grantsOf(vc.viewer, [conv]), threadId)
  if (d.depth === 'none') throw new ContextError(404, '없는 맥락입니다')
  if (item.owner === vc.viewer || atLeast(d.depth, depth)) return { status: 'granted', already: true, depth: d.depth, why: d.why, grant: d.grant || null, request_id: null }
  const [dup] = await q(`select * from pro_access_requests where tenant_id = $1 and requester = $2 and conversation_id = $3 and depth = $4 and status = 'pending'`, [T(), vc.viewer, conv, depth])
  if (dup) return { status: 'pending', request_id: dup.id, request: dup, duplicate: true }
  const [{ n }] = await q(`select count(*)::int as n from pro_access_requests where tenant_id = $1 and requester = $2 and created_at >= now() - interval '1 day'`, [T(), vc.viewer])
  if (n >= DAILY_LIMIT) throw new ContextError(429, `참고 요청은 하루 ${DAILY_LIMIT}건까지입니다`)
  const rules = await rulesOf(item.owner)
  const rel = relation(vc.org, item.owner, vc.viewer)       // 규칙은 주인 입장에서 요청자를 본다
  // 회사 정책이 먼저(민감 표시·민감할 수 있는 주제 → 주인에게 묻기), 주인 규칙은 그 안에서. 판단은 결정 원장에 남는다
  const own = ruleFor(rules.custom ? rules.rules : null, rel, { requester: vc.viewer, depth })
  const pd = await judgeRequest({ requester: vc.viewer, item, rel, depth, ownerRule: own, ownerName: personName(vc.org, item.owner) })
  const r = pd.final.decision === 'allow' ? own : { decision: pd.final.decision, line: pd.final.by === 'policy' ? 'policy' : own.line }
  // 요청자에게는 어떤 정책이 결정했는지만(주제 이름은 주인 화면에만 — 남의 맥락 내용을 짐작하게 하지 않는다)
  const policy = { decision_id: pd.id, decision: pd.decision, by: pd.final.by,
    matched: (pd.matched || []).filter((m) => m.decision === pd.decision).map((m) => ({ id: m.id, title: m.title?.[0] || m.id })) }
  const doing = String(body.doing || '').slice(0, 200), note = String(body.note || '').slice(0, 500)
  const out = await tx(async (x) => {
    let req = (await x(`insert into pro_access_requests (tenant_id, requester, owner, conversation_id, target_title, depth, doing, note, thread_id, status, policy_decision)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10) returning *`, [T(), vc.viewer, item.owner, conv, item.title, depth, doing, note, threadId, pd.id]))[0]
    if (r.decision === 'allow') {
      const g = await makeGrant(x, req, { depth: r.depth, duration: r.duration, via: 'auto' })
      req = (await x(`update pro_access_requests set status = 'granted', via = 'auto', grant_id = $2, decided_at = now(), decision = $3 where id = $1 returning *`, [req.id, g.id, { depth: r.depth, duration: r.duration, rule: r.line }]))[0]
      return { status: 'granted', request_id: req.id, request: req, grant: g, via: 'auto' }
    }
    if (r.decision === 'deny') {
      req = (await x(`update pro_access_requests set status = 'denied', via = 'auto', decided_at = now(), decision = $2 where id = $1 returning *`, [req.id, { rule: r.line }]))[0]
      return { status: 'denied', request_id: req.id, request: req, via: 'auto' }
    }
    return { status: 'pending', request_id: req.id, request: req, via: r.line === 'policy' ? 'sensitive' : 'ask' }
  })
  out.policy = policy
  await q(`update pro_policy_decisions set ref = $2 where id = $1`, [pd.id, `context-request:${out.request_id}`]).catch(() => {})
  await ledgerUpdate(pd.id, out.status === 'granted' ? { status: 'executed', result: { outcome: 'granted', via: 'auto', depth: out.grant.depth, duration: out.grant.duration } }
    : out.status === 'denied' ? { status: 'rejected', result: { outcome: 'denied', via: 'auto' } }
      : { status: 'pending', result: { outcome: 'asked', by: pd.final.by } }).catch((e) => console.warn('[context] ledger', e.message))
  if (out.via === 'auto' && out.status === 'granted') await digest(item.owner).catch((e) => console.warn('[context] digest', e.message))
  // 정책이 묻게 한 이유(정책·주제)는 홈 카드가 미리보기로 보여 준다(AccessDecide) — 알림 글에는 지금 하는 일만
  if (out.status === 'pending') await notifyContext(item.owner, { type: 'context_access', title: `참고 요청 · ${vc.name} · 「${item.title}」 ${DEPTH_LABEL[depth]}`, description: doing ? `지금 하는 일: ${doing}` : '', url: `/pro/context-access/${out.request_id}`, from: await emailOf(vc.viewer) })
  return out
}

export async function listRequests(me, box = 'incoming') {
  await sweep()
  const vc = await viewerOf(me)
  const col = box === 'outgoing' ? 'requester' : 'owner'
  const rows = await q(`select * from pro_access_requests where tenant_id = $1 and ${col} = $2 order by (status = 'pending') desc, created_at desc limit 60`, [T(), vc.viewer])
  return rows.map((r) => ({ ...r, requester_name: personName(vc.org, r.requester), owner_name: personName(vc.org, r.owner) }))
}

// 허락하면 나가게 될 것의 미리보기(주인만): 턴 수·결정 수, 뺄 수 있는 턴 목록
export async function preview(me, id) {
  const [req] = await q(`select * from pro_access_requests where id = $1 and tenant_id = $2 and owner = $3`, [id, T(), me.id])
  if (!req) throw new ContextError(404, '없는 요청입니다')
  const [d] = await q(`select decisions, questions from pro_context_digests where tenant_id = $1 and user_id = $2 and conversation_id = $3`, [T(), me.id, req.conversation_id])
  const turns = await turnsOf(String(me.id), req.conversation_id)
  const vc = await viewerOf(me)
  // 정책이 자동 허용 대신 묻게 했으면 그 정책과 주제(주인에게만)
  const [pd] = req.policy_decision ? await q(`select decision, facts, matched from pro_policy_decisions where id = $1 and tenant_id = $2`, [req.policy_decision, T()]) : []
  const policy = pd ? { decision_id: req.policy_decision, decision: pd.decision, topic: pd.facts?.topic || null, sensitive: !!pd.facts?.sensitive,
    matched: (pd.matched || []).filter((m) => m.decision === pd.decision).map((m) => ({ id: m.id, title: m.title?.[0] || m.id })) } : null
  return { request: { ...req, requester_name: personName(vc.org, req.requester) }, turns: turns.map((t) => ({ id: t.id, prompt: String(t.prompt || '').slice(0, 80), at: t.at })), decisions: (d?.decisions || []).length, questions: (d?.questions || []).length, policy }
}

export async function decideRequest(me, id, body = {}) {
  const vc = await viewerOf(me)
  const decision = body.decision === 'deny' ? 'deny' : 'allow'
  const out = await tx(async (x) => {
    const req = (await x(`select * from pro_access_requests where id = $1 and tenant_id = $2 and owner = $3 for update`, [id, T(), vc.viewer]))[0]
    if (!req) throw new ContextError(404, '없는 요청입니다')
    if (req.status !== 'pending') throw new ContextError(409, `이미 처리된 요청입니다(${req.status})`)
    if (decision === 'deny') {
      const reason = String(body.reason || '').slice(0, 300)
      return { status: 'denied', request: (await x(`update pro_access_requests set status = 'denied', via = 'owner', decided_at = now(), decision = $2 where id = $1 returning *`, [id, { reason }]))[0], req, reason }
    }
    // 요청한 깊이보다 낮게는 허락할 수 있지만 높게는 아니다
    const depth = req.depth === 'summary' || body.depth === 'summary' ? 'summary' : 'content'
    const duration = DUR.includes(body.duration) ? body.duration : 'task'
    const exclude = (Array.isArray(body.exclude) ? body.exclude : []).filter((v) => UUID.test(String(v)))
    const g = await makeGrant(x, req, { depth, duration, exclude, via: 'owner' })
    return { status: 'granted', request: (await x(`update pro_access_requests set status = 'granted', via = 'owner', grant_id = $2, decided_at = now(), decision = $3 where id = $1 returning *`, [id, g.id, { depth, duration, exclude }]))[0], grant: g, req }
  })
  await q(`update notifications set is_checked = true where tenant_id = $1 and type = 'context_access' and url = $2`, [T(), `/pro/context-access/${id}`])
  emit(vc.viewer, 'notifications', {})
  await ledgerUpdate(out.req.policy_decision, out.status === 'denied' ? { status: 'rejected', by: vc.viewer, result: { outcome: 'denied', via: 'owner', reason: out.reason || '' } }
    : { status: 'approved', by: vc.viewer, result: { outcome: 'granted', via: 'owner', depth: out.grant.depth, duration: out.grant.duration, excluded: out.grant.exclude.length } }).catch((e) => console.warn('[context] ledger', e.message))
  const from = await emailOf(vc.viewer)
  if (out.status === 'denied') await notifyContext(out.req.requester, { type: 'context_access_result', title: `참고 요청 거절 · 「${out.req.target_title}」`, description: out.reason ? `사유: ${out.reason}` : '', url: '/settings/sharing', from })
  else await notifyContext(out.req.requester, { type: 'context_access_result', title: `참고 허락 · 「${out.req.target_title}」 ${DEPTH_LABEL[out.grant.depth]} · ${durationLabel(out.grant)}`, description: out.grant.exclude.length ? `${out.grant.exclude.length}개 턴은 빼고 허락했습니다` : '', url: '/settings/sharing', from })
  return { status: out.status, request: out.request, grant: out.grant || null }
}

export async function grantsList(me) {
  const vc = await viewerOf(me)
  const given = await q(`select * from pro_grants where tenant_id = $1 and owner = $2 order by revoked_at nulls first, created_at desc limit 100`, [T(), vc.viewer])
  const received = await q(`select * from pro_grants where tenant_id = $1 and grantee = $2 order by revoked_at nulls first, created_at desc limit 100`, [T(), vc.viewer])
  return { given: given.map((g) => ({ ...g, grantee_name: personName(vc.org, g.grantee) })), received: received.map((g) => ({ ...g, owner_name: personName(vc.org, g.owner) })) }
}

export async function revoke(me, id) {
  const [g] = await q(`update pro_grants set revoked_at = now() where id = $1 and tenant_id = $2 and owner = $3 and revoked_at is null returning *`, [id, T(), me.id])
  if (!g) throw new ContextError(404, '없는 허락입니다')
  const [req] = g.request_id ? await q(`select policy_decision from pro_access_requests where id = $1`, [g.request_id]) : []
  await ledgerUpdate(req?.policy_decision, { status: 'undone', result: { revoked_at: g.revoked_at } }).catch(() => {})
  await notifyContext(g.grantee, { type: 'context_access_result', title: `참고 허락 회수 · 「${g.target_title}」`, description: '주인이 허락을 회수했습니다. 이미 만든 답에는 제목과 주인만 남습니다.', url: '/settings/sharing', from: await emailOf(me.id) })
  return { revoked: true, grant: g }
}

// 「내 맥락이 쓰인 곳」: 다른 사람이 내 맥락을 참고한 기록
export async function usedBy(me) {
  const vc = await viewerOf(me)
  const rows = await q(`select * from pro_context_refs where tenant_id = $1 and owner = $2 and viewer <> $2 order by created_at desc limit 100`, [T(), vc.viewer])
  return rows.map((r) => ({ ...r, viewer_name: personName(vc.org, r.viewer) }))
}
