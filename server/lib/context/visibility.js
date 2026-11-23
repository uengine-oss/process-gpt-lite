// 공개 계층의 판정(순수 함수): 누구에게(범위 사다리) × 얼마나 깊이(제목·요약·원문) + 역할 덧씌움(장·관리자) + 민감 + 허락.
// 모든 경로(자동 참고·검색·팩·팀 활동·항목 보기·MCP)가 이 함수 하나로 깊이를 정한다(spec hanjang-db_context-visibility).
export const GRADES = ['private', 'listed', 'summary', 'open']
export const REACHES = ['team', 'department', 'company']
export const DEPTHS = ['none', 'title', 'summary', 'content']
export const GRADE_LABEL = { private: '비공개', listed: '제목 공개', summary: '요약 공개', open: '전체 공개' }
export const REACH_LABEL = { team: '팀', department: '부서', company: '회사' }
export const DEPTH_LABEL = { none: '없음', title: '제목', summary: '요약', content: '원문' }
const rank = (list, v) => list.indexOf(v)
export const deeper = (a, b) => (rank(DEPTHS, a) >= rank(DEPTHS, b) ? a : b)
export const atLeast = (d, need) => rank(DEPTHS, d) >= rank(DEPTHS, need)

// rel: 보는 사람과 주인의 관계(org.relation 이 만든다)
//   { self, member (둘 다 조직도에 있음), sameTeam, sameDept, lead (보는 사람이 주인 위 노드의 장), admin, via: 'jwt'|'token' }
export function inReach(rel, reach) {
  if (reach === 'company') return !!rel.member
  if (reach === 'department') return !!(rel.sameDept || rel.sameTeam)
  return !!rel.sameTeam
}

// 허락이 지금 이 방에서 유효한가
export function grantLive(g, { now = new Date(), room = null } = {}) {
  if (!g || g.revoked_at) return false
  if (g.until && new Date(g.until) <= now) return false
  if (g.duration === 'task' && g.room && room !== g.room) return false
  return true
}

/**
 * @param item { owner, visibility, reach, sensitive }
 * @param rel  관계
 * @param grants 이 항목에 대해 보는 사람이 받은 허락들
 * @returns { depth: none|title|summary|content, why: [근거…], grant: 쓴 허락 }
 */
export function depthOf(item, rel, { grants = [], now = new Date(), room = null } = {}) {
  if (rel.self) return { depth: 'content', why: ['본인'] }
  // 외부 AI(개인 키)는 남의 항목을 언제나 받지 않는다
  if (rel.via === 'token') return { depth: 'none', why: ['외부 AI 에는 팀원 맥락이 나가지 않음'] }
  if (!rel.member) return { depth: 'none', why: ['조직도 밖'] }
  const v = GRADES.includes(item.visibility) ? item.visibility : 'private'
  if (v === 'private') return { depth: 'none', why: ['비공개'] }
  const sensitive = item.sensitive === 'confirmed'
  const reach = REACHES.includes(item.reach) ? item.reach : 'team'
  let depth = 'title', why = [`${GRADE_LABEL[v]}(제목은 회사 전체)`]
  if (v === 'summary' && inReach(rel, reach)) { depth = 'summary'; why = [`요약 공개 · ${REACH_LABEL[reach]} 범위`] }
  // 민감 항목은 전체 공개여도 원문이 열리지 않는다(요약까지)
  if (v === 'open' && inReach(rel, reach)) { depth = sensitive ? 'summary' : 'content'; why = [`전체 공개 · ${REACH_LABEL[reach]} 범위${sensitive ? ' · 민감(원문 닫힘)' : ''}`] }
  // 장·관리자: private 아닌 항목을 요약까지(민감 항목은 제목만)
  if (!sensitive && (rel.lead || rel.admin) && !atLeast(depth, 'summary')) { depth = 'summary'; why = [rel.lead ? '장(조직도)' : '관리자'] }
  let used = null
  for (const g of grants) {
    if (!grantLive(g, { now, room })) continue
    if (rank(DEPTHS, g.depth) > rank(DEPTHS, depth)) { depth = g.depth; used = g; why = [`허락(${g.via === 'auto' ? '자동 허용' : '주인'} · ${durationLabel(g)})`] }
  }
  return { depth, why, grant: used }
}

export function durationLabel(g) {
  return g.duration === 'task' ? '이 작업 동안' : g.duration === '7d' ? '7일' : '회수할 때까지'
}

// 하위 항목은 상위보다 넓게 열 수 없다(등급·범위 둘 다). 반환: 문제가 없으면 null, 있으면 이유
export function widerThan(child, parent) {
  if (!parent) return null
  if (rank(GRADES, child.visibility) > rank(GRADES, parent.visibility)) return 'visibility'
  if (child.visibility !== 'private' && parent.visibility !== 'private' && rank(REACHES, child.reach) > rank(REACHES, parent.reach)) return 'reach'
  return null
}
// 상위를 좁히면 하위도 그만큼 좁힌다 → 바뀐 값
export function clampTo(child, parent) {
  const out = { visibility: child.visibility, reach: child.reach }
  if (rank(GRADES, out.visibility) > rank(GRADES, parent.visibility)) out.visibility = parent.visibility
  if (rank(REACHES, out.reach) > rank(REACHES, parent.reach)) out.reach = parent.reach
  return out
}
// 민감 항목은 전체 공개로 열 수 없다
export const sensitiveBlocks = (item) => item.sensitive === 'confirmed' && item.visibility === 'open'

// ── 자동 허용 규칙 ───────────────────────────────────────────────────────
export const DEFAULT_RULES = [
  { who: 'team', decision: 'allow', depth: 'content', duration: 'task' },
  { who: 'department', decision: 'ask' },
  { who: 'company', decision: 'ask' },
]
// 맞는 첫 줄. 민감 항목은 규칙과 관계없이 묻기(지울 수 없는 줄)
export function ruleFor(rules, rel, { sensitive = false, requester = null, depth = 'content' } = {}) {
  if (sensitive) return { decision: 'ask', line: 'sensitive' }
  const list = Array.isArray(rules) && rules.length ? rules : DEFAULT_RULES
  for (const [i, r] of list.entries()) {
    const hit = r.who === 'team' ? rel.sameTeam : r.who === 'department' ? (rel.sameDept || rel.sameTeam) : r.who === 'company' ? rel.member
      : String(r.who || '').startsWith('user:') ? String(r.who).slice(5) === String(requester) : false
    if (!hit) continue
    if (r.decision === 'allow') {
      // 깊이 상한을 넘는 요청은 상한까지만 자동 허용한다
      const cap = r.depth || 'content'
      return { decision: 'allow', depth: atLeast(cap, depth) ? depth : cap, duration: r.duration || 'task', line: i }
    }
    return { decision: r.decision === 'deny' ? 'deny' : 'ask', line: i }
  }
  return { decision: 'ask', line: null }
}
