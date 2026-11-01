// 같은 요청 알아보기(spec pgpt-pro_context-repeat-request): 메인 채팅의 요청이 에이전트로 가기 전에, 나나 팀원이 이미 같은 요청을 해서 답이
// 있는지 본다. 있으면 답하지 않고 카드로 묻는다 — 「그 답 보기」(참조만, 보는 깊이 그대로) · 「요청하기」(제목만 보이면 — 같은 팀은 자동 허용) ·
// 「그래도 새로 하기」. 앞단 라우터(context-router)가 맥락을 고른 뒤, 자동 참고(refer.js)보다 먼저 돈다.
//   후보는 보는 사람이 볼 수 있는 것만으로 매긴다: 내 턴·원문 깊이 팀원 턴은 요청 문장, 요약 깊이는 제목·목적·요약·요청 유형 이름,
//   제목 깊이는 제목·목적(refer 의 요청 후보와 같은 원칙 — 남의 맥락 내용을 짐작하게 하지 않는다).
//   임베딩으로 좁히고, 회사 게이트웨이 모델이 「같은 결과물을 원하는 같은 요청인가 · 이전 답이 아직 쓸 만한가」를 판단한다(임베딩만으로는
//   「고객 B ↔ 고객 C」 0.92, 「이번 주 ↔ 지난주 회의록」 0.95 — 다른 요청을 같다고 본다). 모델이 답하지 못하면 묻지 않고 에이전트로 간다.
//   바로 앞 내 요청과 같은 문장을 30분 안에 다시 보낸 것(다시 시켜 보기)과 「새로 하기」로 다시 보낸 것은 보지 않는다.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { chatJson } from '../llm.js'
import { vectors, cosine } from './embed.js'
import { viewerOf, contextsFor, contextView, ContextError } from './items.js'
import { atLeast } from './visibility.js'

export const PARAMS = { retryMin: 30, turnBar: 0.8, contextBar: 0.6, maxTurns: 4, maxContexts: 2, maxHits: 2, judgeMs: Number(process.env.PRO_REPEAT_JUDGE_MS || 2500), timeoutMs: Number(process.env.PRO_REPEAT_TIMEOUT_MS || 4000) }
const T = () => config.tenantId
const short = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
const withTimeout = (p, ms) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve(null), ms).unref?.())])
const norm = (s) => String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()

// ── 순수 함수(시험: test/repeat.test.js) ─────────────────────────────────
// 「3일 전」「오늘 오전 10:12」 — 모델과 카드가 같은 말을 쓴다
export function ago(at, now = new Date()) {
  const t = new Date(at), ms = now - t, m = Math.round(ms / 6e4)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  const sameDay = t.toDateString() === now.toDateString()
  if (sameDay) return `오늘 ${t.getHours() < 12 ? '오전' : '오후'} ${((t.getHours() + 11) % 12) + 1}:${String(t.getMinutes()).padStart(2, '0')}`
  const d = Math.max(1, Math.round(ms / 864e5))
  return d === 1 ? '어제' : d < 30 ? `${d}일 전` : `${Math.round(d / 30)}달 전`
}
// 보이는 깊이의 맥락 글(요약 깊이는 요청 유형 이름까지, 예문은 원문 깊이에서만)
export function contextText(c) {
  const head = `${c.title}\n${c.purpose || ''}`
  if (!atLeast(c.depth, 'summary')) return head
  return `${head}\n${c.summary || ''}\n${(c.prompt_types || []).map((t) => t.name).filter(Boolean).join(', ')}`
}
// 후보 단위: 볼 수 있는 턴은 요청 문장으로, 그 밖에는 맥락 하나로
export function unitsOf(contexts, turnsByConv, { skipTurn = () => false } = {}) {
  const out = []
  for (const c of contexts) {
    const turns = atLeast(c.depth, 'content') ? (turnsByConv.get(`${c.owner}:${c.id}`) || []) : []
    for (const t of turns) {
      if (!t.prompt || skipTurn(t)) continue
      out.push({ kind: 'turn', conv: c.id, owner: c.owner, title: c.title, mine: c.mine, owner_name: c.owner_name, depth: c.depth, turn_id: t.id, prompt: t.prompt, answer: t.answer, at: t.at, text: t.prompt })
    }
    if (!turns.length && !c.mine) out.push({ kind: 'context', conv: c.id, owner: c.owner, title: c.title, mine: false, owner_name: c.owner_name, depth: c.depth, at: c.updated_at, text: contextText(c) })
  }
  return out
}
// 점수가 매겨진 후보 → 모델에 물을 것(턴은 0.8, 맥락은 0.6 이상, 같은 문장은 그대로 최상위)
export function shortlist(units, { params = PARAMS } = {}) {
  const turns = units.filter((u) => u.kind === 'turn' && u.score >= params.turnBar).sort((a, b) => b.score - a.score)
  const seen = new Set(), keep = []
  for (const u of turns) { const k = `${u.conv}|${norm(u.prompt)}`; if (seen.has(k)) continue; seen.add(k); keep.push(u) }
  const ctx = units.filter((u) => u.kind === 'context' && u.score >= params.contextBar).sort((a, b) => b.score - a.score).slice(0, params.maxContexts)
  return [...keep.slice(0, params.maxTurns), ...ctx]
}
// 모델의 답 {"same": [번호], "stale": [번호]} → 카드에 올릴 것(맥락마다 하나, 점수순, 최대 2)
export function pick(cands, verdict, { params = PARAMS } = {}) {
  const same = new Set((verdict?.same || []).map(Number)), stale = new Set((verdict?.stale || []).map(Number))
  const hits = cands.filter((_, i) => same.has(i + 1) && !stale.has(i + 1))
  const byConv = new Map()
  for (const h of hits) if (!byConv.has(`${h.owner}:${h.conv}`)) byConv.set(`${h.owner}:${h.conv}`, h)
  return [...byConv.values()].sort((a, b) => (b.mine ? 0.01 : 0) + b.score - ((a.mine ? 0.01 : 0) + a.score)).slice(0, params.maxHits)
}
// 카드에 나가는 모양: 보이는 것만(원문 깊이가 아니면 요청 문장도 답도 없다)
export const hitOut = (h) => ({ kind: h.kind, conv: h.conv, title: h.title, owner: h.owner, owner_name: h.owner_name, mine: h.mine, depth: h.depth, at: h.at,
  ...(h.kind === 'turn' ? { turn_id: h.turn_id, prompt: short(h.prompt, 200) } : {}), can_request: !h.mine && h.depth !== 'content' ? 'content' : null, score: Math.round(h.score * 1000) / 1000 })

const JUDGE_SYS = `너는 업무 요청 중복 판별기다. 지금 요청과 이전 기록을 비교한다.
same: 이전 요청(또는 그 맥락에서 이미 한 일)이 지금 요청과 같은 결과물을 원한다 — 대상·범위·형식·기간이 같다. 대상이 다르면(고객 B ↔ 고객 C), 형식이 다르면(표 ↔ 그래프), 기간이 다르면(이번 주 ↔ 지난주) same 이 아니다.
stale: same 이지만 시간이 지나 이전 답이 쓸모없을 요청이다(오늘 날씨·실시간 시세·「이번 주」처럼 기간이 바뀐 것).
JSON {"same": [번호], "stale": [번호]} 만 답한다.`

export async function judge(message, cands, now = new Date()) {
  const lines = cands.map((c, i) => `${i + 1}. [${ago(c.at, now)}] ${c.kind === 'turn' ? `요청: ${short(c.prompt, 240)}` : `맥락: ${short(c.text, 400)} (이 맥락에서 이미 한 일)`}`)
  return withTimeout(chatJson(JUDGE_SYS, `지금(${now.toISOString().slice(0, 10)}) 요청: ${short(message, 600)}\n\n이전 기록:\n${lines.join('\n')}`, { maxTokens: 60, temperature: 0, think: false, timeoutMs: PARAMS.judgeMs }).catch(() => null), PARAMS.judgeMs)
}

// 주인별 메인 채팅 턴(요청 → 답)을 맥락별로 한 번에(items.turnsOf 와 같은 짝짓기, 대화 id 와 함께)
async function turnsByOwner(owners) {
  const out = new Map()
  if (!owners.length) return out
  const rows = await q(`select m.id, m.role, m.content, m.created_at, m.thread_id, t.user_id from pro_messages m join pro_threads t on t.id = m.thread_id
      where t.user_id::text = any($1::text[]) and t.kind = 'chat' and (m.role = 'agent' or (m.role = 'user' and m.kind = 'text')) order by m.created_at`, [owners])
  const ask = new Map()
  for (const m of rows) {
    const c = m.content || {}
    if (m.role === 'user') { ask.set(m.thread_id, m); continue }
    const a = ask.get(m.thread_id)
    ask.delete(m.thread_id)
    const id = c.conv || c.context?.conversationId
    if (!id || !(c.text || '').trim() || !a) continue
    const k = `${m.user_id}:${id}`
    if (!out.has(k)) out.set(k, [])
    out.get(k).push({ id: String(m.id), ask_id: String(a.id), thread: String(m.thread_id), prompt: String(a.content?.text || '').trim(), answer: String(c.text).trim(), at: m.created_at })
  }
  return out
}

/**
 * 이 요청이 이미 한 요청인가: {repeat_id, hits} 또는 null(없음·못 봄 — 그냥 에이전트로).
 * userMsgId: 지금 사람 메시지(그 앞 요청을 다시 보낸 것이면 보지 않는다).
 */
export async function findRepeat(me, { threadId, message, userMsgId = null }) {
  const t0 = Date.now()
  const work = (async () => {
    const vc = await viewerOf(me)
    const contexts = await contextsFor(vc, { threadId })
    if (!contexts.length) return null
    const owners = [...new Set(contexts.filter((c) => atLeast(c.depth, 'content')).map((c) => c.owner))]
    const byConv = await turnsByOwner(owners)
    // 바로 앞 내 요청(같은 대화)을 30분 안에 같은 문장으로 다시 보낸 것은 「다시 시켜 보기」다
    const [prev] = userMsgId ? await q(`select id, content->>'text' as text, created_at from pro_messages where thread_id = $1 and role = 'user' and kind = 'text' and id <> $2 and created_at <= (select created_at from pro_messages where id = $2) order by created_at desc limit 1`, [threadId, userMsgId]) : []
    if (prev && norm(prev.text) === norm(message) && Date.now() - new Date(prev.created_at) < PARAMS.retryMin * 6e4) return null
    const skipTurn = (t) => t.ask_id === String(userMsgId)
    const units = unitsOf(contexts, byConv, { skipTurn })
    if (!units.length) return null
    const [mv, ...uv] = await vectors([message, ...units.map((u) => u.text)])
    units.forEach((u, i) => { u.score = cosine(mv, uv[i]) })
    const cands = shortlist(units)
    if (!cands.length) return { hits: [], cands: 0 }
    const verdict = await judge(message, cands)
    if (process.env.PRO_REPEAT_DEBUG) console.log('[repeat]', JSON.stringify({ units: units.length, cands: cands.map((c) => [c.kind, c.title, short(c.text, 60), c.score.toFixed(3)]), verdict }))
    if (!verdict) return { hits: [], cands: cands.length, judge: 'none' }
    return { hits: pick(cands, verdict), cands: cands.length, verdict }
  })()
  const r = await withTimeout(work.catch((e) => { console.warn('[context] repeat', e.message); return null }), PARAMS.timeoutMs)
  if (!r?.hits?.length) return null
  const hits = r.hits.map(hitOut)
  const [row] = await q(`insert into pro_context_repeats (tenant_id, user_id, thread_id, message_id, message, hits, ms) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [T(), String(me.id), threadId, userMsgId, String(message).slice(0, 2000), JSON.stringify(hits), Date.now() - t0])
  return { repeat_id: row.id, hits, ms: Date.now() - t0 }
}

// 「그 답 보기」: 지금 깊이로 다시 본다(허락이 생겼거나 회수됐을 수 있다). 원문이면 그 턴(없으면 요청과 가장 가까운 턴)의 답, 요약이면 요약
export async function repeatAnswer(me, id, n = 0) {
  const [row] = await q(`select * from pro_context_repeats where id = $1 and tenant_id = $2 and user_id = $3`, [id, T(), String(me.id)])
  if (!row) throw new ContextError(404, '없는 카드입니다')
  const hit = row.hits?.[Number(n)]
  if (!hit) throw new ContextError(404, '없는 후보입니다')
  const vc = await viewerOf(me)
  const view = await contextView(vc, hit.conv, { threadId: row.thread_id })
  // 제목만 보이면 볼 답이 없다 — 카드의 「요청하기」로(같은 팀은 자동 허용). 회수된 뒤에도 여기로 온다(답은 복사해 두지 않았다)
  if (!atLeast(view.depth, 'summary')) throw new ContextError(403, `지금은 제목만 볼 수 있어요 — ${view.owner_name}님에게 요청하세요`)
  const out = { conv: hit.conv, title: view.title, owner_name: view.owner_name, mine: view.mine, depth: view.depth }
  if (view.turns?.length) {
    let turn = view.turns.find((t) => t.id === hit.turn_id)
    if (!turn) {
      const [mv, ...tv] = await vectors([row.message, ...view.turns.map((t) => t.prompt || '')])
      turn = view.turns.map((t, i) => ({ t, s: cosine(mv, tv[i]) })).sort((a, b) => b.s - a.s)[0].t
    }
    Object.assign(out, { turn: { id: turn.id, prompt: turn.prompt, answer: turn.answer, at: turn.at } })
  } else if (atLeast(view.depth, 'summary')) Object.assign(out, { summary: view.summary, decisions: view.decisions || [] })
  await q(`update pro_context_repeats set choice = coalesce(choice, 'view'), chosen_at = coalesce(chosen_at, now()) where id = $1`, [id])
  return out
}

// 카드에서 고른 것(요청하기·새로 하기)을 남긴다 — 얼마나 다시 썼나(설정·리포트)
export async function repeatChoice(me, id, choice) {
  if (!['view', 'request', 'fresh'].includes(choice)) throw new ContextError(400, 'choice 는 view|request|fresh')
  const [row] = await q(`update pro_context_repeats set choice = $4, chosen_at = now() where id = $1 and tenant_id = $2 and user_id = $3 returning id, choice`, [id, T(), String(me.id), choice])
  if (!row) throw new ContextError(404, '없는 카드입니다')
  return row
}
