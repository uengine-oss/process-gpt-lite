// 공개 등급 바꾸기·민감 표시·등급 미리보기·내 맥락 목록·열람 기록(spec pgpt-pro_context-visibility).
// 깊이 판정은 visibility.depthOf 하나로 한다 — 미리보기도 같은 함수로 「지금」과 「바꾼 뒤」를 잰다.
// 쓰기(등급·민감)는 주인 본인만: 남이 부르면 403 이 아니라 없는 맥락과 같은 404(존재도 숨김).
// Lite 의 대화 맥락에는 상위 항목(공간·묶음)이 없어 「하위는 상위보다 넓게 열 수 없다」 상속·좁힘 전파는 없다.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { GRADES, REACHES, DEPTHS, GRADE_LABEL, REACH_LABEL, depthOf, sensitiveBlocks } from './visibility.js'
import { relation, personName, teamName } from './org.js'
import { viewerOf, contextRows, ContextError } from './items.js'
import { rulesOf, saveRules } from './access.js'
import { compileTopics, topicHit, scanOwner, topicsOf } from './sensitive.js'
import { SENSITIVE_TOPICS } from '../policy/catalog.js'

const T = () => config.tenantId
const NOT_FOUND = '없는 맥락입니다'
export const SENSITIVE_OPEN = '민감 항목은 전체 공개로 열 수 없습니다'
const rank = (list, v) => list.indexOf(v)

// ── 순수 함수(시험: test/context-grade.test.js) ─────────────────────────────
// 끝 글자 받침으로 조사 고르기(이/가, 은/는, 을/를, 과/와). 한글이 아니면 숫자 읽기·영문 끝소리로 어림한다.
const tail = (word) => {
  const s = String(word || '').replace(/[\s\p{P}\p{S}]+$/u, '')
  const ch = s.slice(-1)
  if (!ch) return { has: false, rieul: false }
  const c = ch.charCodeAt(0)
  if (c >= 0xac00 && c <= 0xd7a3) { const j = (c - 0xac00) % 28; return { has: j > 0, rieul: j === 8 } }
  if (/[0-9]/.test(ch)) return { has: '0136781'.includes(ch), rieul: '178'.includes(ch) }   // 영·일·삼·육·칠·팔 / 일·칠·팔은 ㄹ
  if (/[lr]/i.test(ch)) return { has: true, rieul: true }                                     // 엘·알
  if (/[mn]/i.test(ch)) return { has: true, rieul: false }                                    // 엠·엔
  return { has: false, rieul: false }
}
export function josa(word, withB = '이', without = '가') { return tail(word).has ? withB : without }
// 「으로/로」: 받침이 없거나 ㄹ 받침이면 「로」
export function ro(word) { const t = tail(word); return t.has && !t.rieul ? '으로' : '로' }

// 「요약 공개 · 팀」 — 범위는 요약·전체 공개에서만 뜻이 있다
export const gradeLabel = (v, r) => (v === 'summary' || v === 'open' ? `${GRADE_LABEL[v]} · ${REACH_LABEL[r] || REACH_LABEL.team}` : GRADE_LABEL[v] || GRADE_LABEL.private)

// 민감 판단(규칙, 모델 없음): 주제 목록은 회사 정책 context-sensitive-topic 이 갖는다(lib/context/sensitive.js). 제안일 뿐이고 주인이 승인해야 적용된다.
// 여기 것은 카탈로그 기본 목록 — 시험과, 정책을 읽기 전의 기본값
export const SENSITIVE_RULES = compileTopics(SENSITIVE_TOPICS)
export function sensitiveHit(...texts) { return topicHit(SENSITIVE_RULES, ...texts) }

// 판정 근거를 화면용으로: 장·관리자 덧씌움과 허락은 따로 표시한다
export function reasonOf(r, rel, org) {
  const w = r.why?.[0] || ''
  if (r.grant) return { via: 'grant', reason: w }
  if (w === '장(조직도)') return { via: 'lead', reason: `${org.nodes.get(rel.lead)?.name || '조직도 '}장` }
  if (w === '관리자') return { via: 'admin', reason: '관리자' }
  return { via: 'grade', reason: w }
}

// 미리보기: 주인 말고 조직도의 모든 사람이 지금(cur)과 바꾼 뒤(next) 각각 어떤 깊이를 갖는지 → 깊이별 묶음
// + 새로 보게 되는 사람(added)·덜 보게 되는 사람(lost). 허락은 방과 관계없이 있는 것으로 본다(「이 작업 동안」 허락도 칸에 보인다).
export function previewGroups(org, owner, cur, next, grants = [], { now = new Date() } = {}) {
  const out = { title: [], summary: [], content: [], hidden: 0, lost: [] }
  for (const p of org.people.values()) {
    if (String(p.id) === String(owner)) continue
    const rel = relation(org, p.id, owner)
    const mine = grants.filter((g) => String(g.grantee) === String(p.id)).map((g) => ({ ...g, room: null }))
    const a = depthOf(cur, rel, { grants: mine, now }), b = depthOf(next, rel, { grants: mine, now })
    if (rank(DEPTHS, b.depth) < rank(DEPTHS, a.depth)) out.lost.push({ id: p.id, name: p.name, from: a.depth, to: b.depth })
    if (b.depth === 'none') { out.hidden++; continue }
    out[b.depth].push({ id: p.id, name: p.name, team: teamName(org, p.id), ...reasonOf(b, rel, org), was: a.depth, added: rank(DEPTHS, b.depth) > rank(DEPTHS, a.depth) })
  }
  const order = { grant: 0, grade: 1, lead: 2, admin: 3 }
  for (const k of ['title', 'summary', 'content']) out[k].sort((x, y) => (y.added - x.added) || (order[x.via] - order[y.via]) || x.name.localeCompare(y.name, 'ko'))
  out.added = Object.fromEntries(['title', 'summary', 'content'].map((k) => [k, out[k].filter((x) => x.added).map((x) => x.name)]))
  return out
}

// ── DB ──────────────────────────────────────────────────────────────────
const itemOut = (r) => ({ id: r.id, title: r.title, purpose: r.purpose || '', visibility: r.visibility, reach: r.reach, sensitive: r.sensitive,
  inherited: !r.shared_row, label: gradeLabel(r.visibility, r.reach) })

// 주인 본인의 맥락만(남이 부르면 없는 것과 같다)
async function owned(me, conv) {
  if (!conv) throw new ContextError(404, NOT_FOUND)
  const [row] = await contextRows({ owners: [String(me.id)], convs: [String(conv)] })
  if (!row) throw new ContextError(404, NOT_FOUND)
  return row
}
// 등급 행 쓰기(행이 없던 맥락은 이때부터 기본 등급을 따르지 않고 자기 행을 갖는다)
async function upsert(me, row, { visibility, reach, sensitive, purpose, dismissed = undefined }) {
  await q(`insert into pro_context_shares (tenant_id, user_id, conversation_id, visibility, reach, sensitive, purpose, sensitive_dismissed_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7, case when $8::boolean then now() else null end, now())
           on conflict (tenant_id, user_id, conversation_id) do update set visibility = excluded.visibility, reach = excluded.reach, sensitive = excluded.sensitive,
             purpose = excluded.purpose, updated_at = now(),
             sensitive_dismissed_at = case when $8::boolean is null then pro_context_shares.sensitive_dismissed_at when $8::boolean then now() else null end`,
    [T(), String(me.id), row.id, visibility, reach, sensitive, purpose, dismissed === undefined ? null : !!dismissed])
}

export async function setGrade(me, conv, body = {}) {
  const row = await owned(me, conv)
  const visibility = body.visibility ?? row.visibility, reach = body.reach ?? row.reach
  if (!GRADES.includes(visibility)) throw new ContextError(400, `등급은 ${GRADES.join('|')}`)
  if (!REACHES.includes(reach)) throw new ContextError(400, `범위는 ${REACHES.join('|')}`)
  const purpose = body.purpose === undefined || body.purpose === null ? row.purpose : String(body.purpose).replace(/\s+/g, ' ').trim().slice(0, 120)
  if (sensitiveBlocks({ sensitive: row.sensitive, visibility })) throw new ContextError(422, SENSITIVE_OPEN)
  await upsert(me, row, { visibility, reach, sensitive: row.sensitive, purpose })
  const item = itemOut({ ...row, visibility, reach, purpose, shared_row: true })
  const same = row.shared_row && visibility === row.visibility && (reach === row.reach || !['summary', 'open'].includes(visibility))
  const note = same && purpose !== row.purpose ? '한 줄 목적을 저장했습니다' : `「${row.title}」${josa(row.title, '을', '를')} ${item.label}${ro(item.label)} 바꿨습니다`
  return { item, note }
}

// 민감 표시: mark(직접 붙임)·confirm(제안 승인) → confirmed, 전체 공개였으면 요약 공개로 좁힌다. dismiss(제안 무시)·clear(떼기) → none,
// 그 맥락에는 다시 제안하지 않는다(sensitive_dismissed_at).
export async function setSensitive(me, conv, action) {
  if (!['mark', 'confirm', 'dismiss', 'clear'].includes(action)) throw new ContextError(400, 'action 은 mark|confirm|dismiss|clear')
  const row = await owned(me, conv)
  if (action === 'mark' || action === 'confirm') {
    const narrowed = row.visibility === 'open'
    const visibility = narrowed ? 'summary' : row.visibility
    await upsert(me, row, { visibility, reach: row.reach, sensitive: 'confirmed', purpose: row.purpose, dismissed: false })
    const item = itemOut({ ...row, visibility, sensitive: 'confirmed', shared_row: true })
    return { item, sensitive: 'confirmed', narrowed_to: narrowed ? 'summary' : null,
      note: narrowed ? `민감 항목이 되었습니다. 전체 공개였으므로 ${item.label}${ro(item.label)} 좁혔습니다` : '민감 항목이 되었습니다' }
  }
  await upsert(me, row, { visibility: row.visibility, reach: row.reach, sensitive: 'none', purpose: row.purpose, dismissed: true })
  return { item: itemOut({ ...row, sensitive: 'none', shared_row: true }), sensitive: 'none', narrowed_to: null,
    note: action === 'dismiss' ? '민감 표시 제안을 무시했습니다(다시 제안하지 않습니다)' : '민감 표시를 뗐습니다' }
}

// 민감 제안(회사 정책의 주제 목록): 내 맥락 중 표시가 없고 전에 무시하지 않은 것 → proposed. 맥락 요약을 만들 때도 같은 것이 돈다(digest.js).
// 돌려주는 것은 지금 제안 중인 모든 맥락(new = 이번에 새로 제안함). 정책이 꺼져 있으면 새로 제안하지 않는다.
export async function scanSensitive(me) {
  const { rows, fresh, rules } = await scanOwner(me.id)
  const isNew = new Set(fresh.map((r) => r.id))
  const proposed = rows.filter((r) => r.sensitive === 'proposed')
  return { rules, proposed: proposed.map((r) => ({ id: r.id, title: r.title, visibility: r.visibility, reach: r.reach, label: gradeLabel(r.visibility, r.reach), hit: topicHit(rules || SENSITIVE_RULES, r.title, r.purpose, r.summary), new: isNew.has(r.id) })) }
}

// 내 대화 맥락(context_threads)과 그 공개 등급. 먼저 민감 제안을 돌린다(conv 하나만 물으면 돌리지 않는다).
export async function myContexts(me, { conv = null } = {}) {
  const scan = conv ? null : await scanSensitive(me)
  const topics = scan?.rules || (await topicsOf().catch(() => null)) || SENSITIVE_RULES
  const rows = await contextRows({ owners: [String(me.id)], convs: conv ? [String(conv)] : null })
  if (conv && !rows.length) throw new ContextError(404, NOT_FOUND)
  const live = new Map((await q(`select conversation_id, count(*)::int as n from pro_grants where tenant_id = $1 and owner = $2 and revoked_at is null and (until is null or until > now()) group by 1`, [T(), String(me.id)])).map((r) => [r.conversation_id, r.n]))
  const rules = await rulesOf(String(me.id))
  return {
    items: rows.map((r) => ({ ...itemOut(r), turns: r.turns, updated_at: r.updated_at, created_at: r.created_at, summary: r.summary || '', grants: live.get(r.id) || 0,
      hit: r.sensitive === 'proposed' ? topicHit(topics, r.title, r.purpose, r.summary) : null })),
    proposed: scan?.proposed || [],
    // 규칙 행이 없으면 기본 등급이 아직 없다 — 행 없는 맥락은 비공개로 다룬다(이 기능 전 사용자는 그대로)
    defaults: { enabled: rules.enabled, default_visibility: rules.default_visibility, default_reach: rules.default_reach,
      effective: rules.enabled ? gradeLabel(rules.default_visibility, rules.default_reach) : GRADE_LABEL.private },
  }
}

// 바꿀 등급을 미리: 깊이마다 누가(장·관리자·허락은 이유와 함께), 새로 보게 되는 사람·덜 보게 되는 사람. 아무것도 바꾸지 않는다.
export async function previewGrade(me, { conv, visibility, reach } = {}) {
  const row = await owned(me, conv)
  const vc = await viewerOf(me)
  const want = { visibility: visibility || row.visibility, reach: reach || row.reach }
  if (!GRADES.includes(want.visibility)) throw new ContextError(400, `등급은 ${GRADES.join('|')}`)
  if (!REACHES.includes(want.reach)) throw new ContextError(400, `범위는 ${REACHES.join('|')}`)
  const next = { ...row, ...want }
  const grants = await q(`select * from pro_grants where tenant_id = $1 and owner = $2 and conversation_id = $3 and revoked_at is null`, [T(), String(me.id), row.id])
  const g = previewGroups(vc.org, String(me.id), row, next, grants)
  return { item: itemOut(row), current: gradeLabel(row.visibility, row.reach), next: { ...want, label: gradeLabel(want.visibility, want.reach) },
    problem: sensitiveBlocks(next) ? SENSITIVE_OPEN : null, in_org: vc.org.people.has(String(me.id)), ...g }
}

// 내 맥락을 다른 사람이 본 기록(items.logView 가 남긴다): 원문은 건마다, 요약은 사람·맥락·날짜별로 모은 줄
export async function myViews(me) {
  const vc = await viewerOf(me)
  const rows = await q(`select id, viewer, conversation_id, item_title, depth, basis, to_char(day, 'YYYY-MM-DD') as day, count, last_at
      from pro_context_views where tenant_id = $1 and owner = $2 order by last_at desc limit 200`, [T(), vc.viewer])
  return rows.map((r) => ({ ...r, viewer_name: personName(vc.org, r.viewer), viewer_team: teamName(vc.org, r.viewer) }))
}

// 새 맥락의 기본 등급(자동 허용 규칙은 그대로 둔다)
export async function saveDefaults(me, body = {}) {
  const dv = body.default_visibility, dr = body.default_reach ?? 'team'
  if (!GRADES.includes(dv)) throw new ContextError(400, `등급은 ${GRADES.join('|')}`)
  if (!REACHES.includes(dr)) throw new ContextError(400, `범위는 ${REACHES.join('|')}`)
  const cur = await rulesOf(String(me.id))
  return saveRules(me, { rules: cur.custom ? cur.rules : [], default_visibility: dv, default_reach: dr })
}
