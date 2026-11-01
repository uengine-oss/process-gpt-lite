// 대화 맥락(context-router 가 나눈 context_threads)을 보는 사람의 깊이로 읽는다(spec pgpt-pro_context-visibility).
// 맥락의 원문은 그 사람의 메인 채팅(pro_messages: 요청)과 에이전트의 답이다. 다른 사람에게는 이 모듈이 깊이 판정
// (visibility.depthOf)을 거친 것만 내보낸다: 제목 = 제목·주인·기간·한 줄 목적, 요약 = 맥락 요약·결정·열린 질문, 원문 = 턴.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { orgOf, relation, personName } from './org.js'
import { depthOf, atLeast } from './visibility.js'

export class ContextError extends Error { constructor(status, msg) { super(msg); this.status = status } }
const T = () => config.tenantId

export async function viewerOf(me, via = 'jwt') {
  const org = await orgOf(T())
  return { org, viewer: String(me.id), via, name: personName(org, me.id) }
}

// 등급: 맥락별 행 → 없으면 주인의 기본 등급(규칙 행) → 규칙 행도 없으면 private(이 기능 전 사용자는 그대로)
export async function contextRows({ owners = null, convs = null } = {}) {
  const rows = await q(`select t.user_id as owner, t.conversation_id as id, t.title, t.turns, t.created_at, t.updated_at,
        s.visibility, s.reach, s.sensitive, coalesce(s.purpose, '') as purpose,
        r.default_visibility, r.default_reach,
        d.summary, d.decisions, d.questions, d.kinds, d.prompt_types, d.built_at
      from context_threads t
      left join pro_context_shares s on s.tenant_id = t.tenant_id and s.user_id::text = t.user_id and s.conversation_id = t.conversation_id
      left join pro_sharing_rules r on r.tenant_id = t.tenant_id and r.user_id::text = t.user_id
      left join pro_context_digests d on d.tenant_id = t.tenant_id and d.user_id::text = t.user_id and d.conversation_id = t.conversation_id
      where t.tenant_id = $1 ${owners ? 'and t.user_id = any($2::text[])' : ''} ${convs ? `and t.conversation_id = any($${owners ? 3 : 2}::text[])` : ''}
      order by t.updated_at desc`, [T(), ...(owners ? [owners] : []), ...(convs ? [convs] : [])])
  return rows.map((r) => ({ ...r, owner: String(r.owner),
    visibility: r.visibility || (r.default_visibility ? r.default_visibility : 'private'),
    reach: r.reach || r.default_reach || 'team', sensitive: r.sensitive || 'none', shared_row: !!r.visibility }))
}

export async function grantsOf(viewer, convs) {
  if (!convs.length) return []
  const rows = await q(`select * from pro_grants where tenant_id = $1 and grantee = $2 and conversation_id = any($3::text[]) and revoked_at is null`, [T(), viewer, convs])
  return rows.map((g) => ({ ...g, room: g.thread_id ? String(g.thread_id) : null }))   // visibility.grantLive 는 room 으로 본다
}

export function depthFor(vc, item, grants = [], threadId = null) {
  const rel = relation(vc.org, vc.viewer, item.owner, { via: vc.via })
  const mine = grants.filter((g) => g.conversation_id === item.id && String(g.owner) === String(item.owner))
  return { ...depthOf(item, rel, { grants: mine, room: threadId ? String(threadId) : null }), rel }
}

// 이 회사의 맥락 + 보는 사람의 깊이. none(비공개·조직도 밖)은 뺀다 — 존재도 숨긴다
export async function contextsFor(vc, { threadId = null, owners = null, withNone = false } = {}) {
  const rows = (await contextRows({ owners })).filter((r) => r.owner === vc.viewer || vc.org.people.has(r.owner))
  const grants = await grantsOf(vc.viewer, [...new Set(rows.map((r) => r.id))])
  const out = []
  for (const r of rows) {
    const d = depthFor(vc, r, grants, threadId)
    if (d.depth === 'none' && !withNone) continue
    out.push({ ...r, depth: d.depth, why: d.why, grant: d.grant || null, rel: d.rel, mine: r.owner === vc.viewer, owner_name: personName(vc.org, r.owner) })
  }
  return out
}

// 맥락의 턴: 주인의 메인 채팅에서 그 맥락(conv)으로 간 요청과 답. 답 메시지는 context.conversationId(라우터가 고른 맥락)나
// conv(이 기능이 남기는 표지)로, 요청은 바로 앞의 사람 메시지로 짝짓는다.
export async function turnsOf(owner, conv, { since = null, limit = 60 } = {}) {
  const rows = await q(`select m.id, m.role, m.content, m.created_at from pro_messages m join pro_threads t on t.id = m.thread_id
      where t.user_id = $1 and t.kind = 'chat' and m.role in ('user', 'agent') ${since ? 'and m.created_at >= $2' : ''} order by m.created_at`,
    since ? [owner, since] : [owner])
  const out = []
  let ask = null
  for (const m of rows) {
    const c = m.content || {}
    if (m.role === 'user') { ask = m; continue }
    const id = c.conv || c.context?.conversationId
    if (id === conv && (c.text || '').trim()) out.push({ id: String(m.id), prompt: String(ask?.content?.text || '').trim(), answer: String(c.text).trim(), at: m.created_at, refer_id: ask?.content?.refer?.refer_id || null })
    ask = null
  }
  return out.slice(-limit)
}

// 깊이에 맞게 자른 맥락 보기(남에게 나가는 모양). 원문이면 턴까지 — 허락에서 뺀 턴은 빠지고, 그 턴이 참고한 다른 사람의 맥락은 출처로만
export async function contextView(vc, conv, { threadId = null, log = true } = {}) {
  const [r] = (await contextRows({ convs: [conv] })).filter((x) => x.owner === vc.viewer || vc.org.people.has(x.owner))
  if (!r) throw new ContextError(404, '없는 맥락입니다')
  const d = depthFor(vc, r, await grantsOf(vc.viewer, [conv]), threadId)
  if (d.depth === 'none') throw new ContextError(404, '없는 맥락입니다')
  const view = { id: r.id, title: r.title, purpose: r.purpose, owner: r.owner, owner_name: personName(vc.org, r.owner), visibility: r.visibility, reach: r.reach,
    sensitive: r.sensitive, depth: d.depth, why: d.why, updated_at: r.updated_at, turns_count: r.turns, mine: r.owner === vc.viewer }
  if (atLeast(d.depth, 'summary')) Object.assign(view, { summary: r.summary || '', decisions: r.decisions || [], questions: r.questions || [] })
  if (atLeast(d.depth, 'content')) {
    const exclude = new Set((d.grant?.exclude || []).map(String))
    const turns = await turnsOf(r.owner, conv, { since: new Date(new Date(r.created_at).getTime() - 60000) })
    const rids = turns.map((t) => t.refer_id).filter(Boolean)
    const srcs = rids.length ? await q(`select refer_id, conversation_id, item_title, owner from pro_context_refs where tenant_id = $1 and refer_id = any($2::uuid[]) and owner <> $3`, [T(), rids, r.owner]) : []
    view.turns = turns.filter((t) => !exclude.has(t.id)).map((t) => ({ ...t, sources: srcs.filter((s) => String(s.refer_id) === String(t.refer_id)).map((s) => ({ id: s.conversation_id, title: s.item_title, owner_name: personName(vc.org, s.owner) })) }))
    view.excluded = turns.length - view.turns.length
  }
  if (log && !view.mine) await logView(vc, { id: r.id, title: r.title, owner: r.owner }, d.depth, d.why.join(', '))
  return view
}

// 열람 기록: 원문은 건마다, 요약은 사람·맥락·날짜별로 모은다(제목만 본 것은 남기지 않는다)
export async function logView(vc, item, depth, basis = '') {
  if (!atLeast(depth, 'summary') || String(item.owner) === vc.viewer || vc.via === 'token') return
  if (depth === 'content') {
    await q(`insert into pro_context_views (tenant_id, viewer, owner, conversation_id, item_title, depth, basis) values ($1,$2,$3,$4,$5,'content',$6)`, [T(), vc.viewer, item.owner, item.id || null, item.title || '', basis])
    return
  }
  const [hit] = await q(`update pro_context_views set count = count + 1, last_at = now() where tenant_id = $1 and viewer = $2 and owner = $3 and coalesce(conversation_id, '') = coalesce($4, '')
      and depth = 'summary' and day = current_date returning id`, [T(), vc.viewer, item.owner, item.id || null])
  if (!hit) await q(`insert into pro_context_views (tenant_id, viewer, owner, conversation_id, item_title, depth, basis) values ($1,$2,$3,$4,$5,'summary',$6)`, [T(), vc.viewer, item.owner, item.id || null, item.title || '', basis])
}
