// 제안을 거절한 까닭(2026-11-28 녹화: 「Spec Kit 커리큘럼을 PMO 자료로 설계해 줘」에 「요청 보고 · 구현」을 권했다 — 「전혀 관계도 없는 거 자꾸
// 추천하기도 하고 … 내가 이거 안 하려고 이렇게 하면 아닌 이유를 좀 파악을 해야 될 것 같아」). 채팅 카드(onto-entry)의 「아니요, 이번엔 그냥 할게요」와
// 그 뒤에 고른 까닭은 그 카드 메시지의 content.declined 에 남는다 — 모든 화면이 같은 카드를 보고, 다음 제안이 읽는다.
//   reason: 'unrelated'(이 일과 관계없어요) · 'not-now'(맞지만 이번엔 그냥 — 프로세스 없이) · 'other'(직접 적은 말을 모델이 둘 중 어느 것으로도 읽지 못함)
// 다음 채팅 요청을 프로세스에 견줄 때(events.js identify): 「관계없어요」만 그 프로세스의 반례(요청 첫 줄 · 까닭)가 되고, 최근 여러 번이면
// 그 프로세스를 채팅 요청에 한동안 권하지 않는다(쉬는 프로세스). 셈 · 기간은 스킬 규칙 events.declines.
import { q } from '../supa.js'
import { choose } from '../decide.js'
import { config } from '../../config.js'

const DAY = 86_400_000
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const err = (status, message) => Object.assign(new Error(message), { status })
export const REASONS = ['unrelated', 'not-now', 'other']
export const DECLINE_DEFAULTS = {
  // 반례: 이만큼 지난 거절까지, 프로세스마다 이만큼
  days: 30, negatives: 4, requestChars: 120,
  // 쉬기: 마지막 「관계없어요」와 그 앞 restWindowDays 일 안에 restAfter 번이면 마지막 거절부터 restDays 일
  restAfter: 3, restWindowDays: 14, restDays: 7,
  // 직접 적은 까닭(모델이 읽는다): 이 확률 이상일 때만 그 까닭
  reasonMin: 0.7, noteChars: 200, readLimit: 500,
  reasonQuestion: '이 사람은 왜 이 업무로 진행하지 않겠다고 했나?',
  reasonOptions: {
    unrelated: '이 요청은 그 업무와 관계없다 — 다른 종류의 일이다',
    'not-now': '그 업무가 맞지만 이번에는 프로세스 없이 하겠다',
    other: '둘 다 아니다(다른 까닭)',
  },
  negativeIntro: '이 회사 사람들이 최근 「{name}」 업무가 아니라고 한 채팅 요청이에요(지금 요청이 이것들과 같은 종류의 일이면 아니요):',
  negativeLine: '- 「{request}」 — {why}',
  unrelatedText: '이 일과 관계없어요',
}
export const declineRules = (R = {}) => ({ ...DECLINE_DEFAULTS, ...(R?.declines || {}) })
const fill = (tpl, vars) => String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')
const atOf = (d) => Date.parse(d?.at || '') || 0

// which processes a declined card was about: its offered choices (or its one choice) — not one a person started from the same card
export function declinedProcs(content) {
  const c = content || {}
  const list = (Array.isArray(c.choices) && c.choices.length ? c.choices : [c.choice]).filter((x) => x?.proc)
  const started = new Set(Object.keys(c.starts || {}))
  return [...new Map(list.filter((x) => !started.has(x.proc)).map((x) => [x.proc, { proc: String(x.proc), name: String(x.procName || '') }])).values()]
}

// ---------- reading the declines (pure: rows are {request, declined}) ----------
// the 「관계없어요」 declines of one process
const unrelatedOf = (rows, proc) => (rows || []).filter((r) => r?.declined?.reason === 'unrelated' && atOf(r.declined) && (r.declined.procs || []).some((p) => p?.proc === proc))

// a process's negative examples for the model: its 「관계없어요」 declines of the last `days` days, newest first, one per request's first line
export function negativesFor(rows, proc, R = {}, now = Date.now()) {
  const D = declineRules(R)
  const seen = new Set(), out = []
  for (const r of unrelatedOf(rows, proc).sort((a, b) => atOf(b.declined) - atOf(a.declined))) {
    const at = atOf(r.declined)
    if (at > now || now - at > D.days * DAY) continue
    const request = clean(String(r.request || '').split('\n')[0]).slice(0, D.requestChars)
    if (!request || seen.has(request)) continue
    seen.add(request)
    out.push({ request, note: clean(r.declined.note).slice(0, D.noteChars), at: new Date(at).toISOString() })
    if (out.length >= D.negatives) break
  }
  return out
}

// whether a process rests from chat requests: its last 「관계없어요」 and those in the restWindowDays before it are restAfter or more →
// it rests restDays from that last one. A count, not a meaning: what each decline meant was the person's chip, or the model's reading.
export function restOf(rows, proc, R = {}, now = Date.now()) {
  const D = declineRules(R)
  const times = unrelatedOf(rows, proc).map((r) => atOf(r.declined)).filter((t) => t <= now).sort((a, b) => b - a)
  if (!times.length || !(D.restAfter > 0)) return null
  const last = times[0]
  const count = times.filter((t) => last - t <= D.restWindowDays * DAY).length
  if (count < D.restAfter) return null
  const until = last + D.restDays * DAY
  return until > now ? { until: new Date(until).toISOString(), count } : null
}

// everything a chat request's reading needs, from one read of the rows: negative examples and resting processes, per process key
export function forMatchingFrom(rows, R = {}, now = Date.now()) {
  const procs = new Set((rows || []).flatMap((r) => (r?.declined?.procs || []).map((p) => p?.proc)).filter(Boolean))
  const negatives = new Map(), resting = new Map()
  for (const p of procs) {
    const n = negativesFor(rows, p, R, now)
    if (n.length) negatives.set(p, n)
    const rest = restOf(rows, p, R, now)
    if (rest) resting.set(p, rest)
  }
  return { negatives, resting }
}

// the block the model reads after the request, for one process
export function negativeText(proc, list, R = {}) {
  if (!list?.length) return ''
  const D = declineRules(R)
  return [fill(D.negativeIntro, { name: proc?.name || '' }), ...list.map((n) => fill(D.negativeLine, { request: n.request, why: n.note || D.unrelatedText }))].join('\n')
}

// ---------- the database ----------
// this company's declined chat cards, recent enough for both the examples and the resting (one read per chat request)
export async function recentDeclines(R = {}) {
  const D = declineRules(R)
  const days = Math.max(D.days, D.restWindowDays + D.restDays)
  const rows = await q(`select m.content->'mail'->>'subject' as request, m.content->'declined' as declined
      from pro_messages m join pro_threads t on t.id = m.thread_id
      join users u on u.id::text = t.user_id::text and u.tenant_id = $1
     where m.kind = 'onto-entry' and m.content->>'source' = 'chat' and m.content->>'state' = 'declined'
       and jsonb_typeof(m.content->'declined') = 'object' and m.created_at > now() - make_interval(days => $2)
     order by m.created_at desc limit $3`, [config.tenantId, days, D.readLimit])
  return rows
}
export async function forMatching(R = {}, now = Date.now()) { return forMatchingFrom(await recentDeclines(R), R, now) }

// what a person's own words for declining mean (the model reads them; under reasonMin, or nothing read: 'other' — never a negative)
export async function readNote({ request = '', procs = [], note = '' }, R = {}, read = choose) {
  const D = declineRules(R)
  const options = REASONS.map((key) => ({ key, label: D.reasonOptions?.[key] || DECLINE_DEFAULTS.reasonOptions[key] }))
  const state = [`이 채팅 요청을 「${procs.map((p) => p.name || p.proc).join('」 · 「')}」 업무로 진행하자고 권했고, 이 사람이 거절했어요.`,
    `요청: ${clean(request).slice(0, 300)}`, `거절하며 쓴 말: ${clean(note).slice(0, D.noteChars)}`].join('\n')
  const r = await read(state, D.reasonQuestion, options).catch(() => null)
  const best = Object.entries(r?.probabilities || {}).sort((a, b) => b[1] - a[1])[0]
  if (!best) return { reason: 'other', p: null, measured: false }
  const p = +Number(best[1]).toFixed(3)
  return { reason: p >= D.reasonMin && REASONS.includes(best[0]) ? best[0] : 'other', p, choice: best[0], measured: r?.strategy !== 'json' }
}

// 「아니요」 and its reason on the card (only the person's own card): state 'declined' and declined {at, by, procs, reason?, note?, skipped?}.
// The first call (no reason) declines; a later one adds the reason, the person's own words (read by the model), or that they skipped it.
export async function declineCard(me, messageId, { reason = null, note = '', skip = false } = {}, { rules = null, read = choose } = {}) {
  const id = String(messageId || '')
  if (!id) throw err(400, '카드(messageId)가 없어요.')
  const [m] = await q(`select m.id, m.content from pro_messages m join pro_threads t on t.id = m.thread_id
                        where m.id::text = $1 and t.user_id::text = $2 and m.kind = 'onto-entry'`, [id, String(me.id)])
  if (!m) throw err(404, '카드를 찾지 못했어요.')
  const c = m.content || {}
  if (c.state && !['ask', 'declined'].includes(c.state)) throw err(409, '이미 진행한 카드예요.')
  const R = rules || await (await import('./events.js')).eventRules()
  const D = declineRules(R)
  const now = new Date().toISOString()
  const prev = c.declined && typeof c.declined === 'object' ? c.declined : {}
  const procs = prev.procs?.length ? prev.procs : declinedProcs(c)
  const words = clean(note).slice(0, D.noteChars)
  let kind = REASONS.includes(reason) && reason !== 'other' ? reason : null
  let readAs = null
  if (!kind && words) {
    readAs = await readNote({ request: c.mail?.subject || c.mail?.text || '', procs, note: words }, R, read)
    kind = readAs.reason
  }
  const declined = { ...prev, at: prev.at || now, by: String(me.id), procs,
    ...(kind ? { reason: kind, reasonAt: now } : {}), ...(words ? { note: words } : {}), ...(readAs ? { readAs: { p: readAs.p, choice: readAs.choice || null, measured: readAs.measured } } : {}),
    ...(skip && !kind ? { skipped: true } : {}) }
  const { updateMessage } = await import('../store.js')
  const saved = await updateMessage(me.id, m.id, { state: 'declined', declined })
  console.log(`[ontology] declined ${procs.map((p) => p.name || p.proc).join(' · ') || '-'}: ${kind || (skip ? 'skipped' : 'no reason yet')}${readAs ? ` (read ${readAs.choice} ${readAs.p ?? '?'})` : ''}`)
  return { ok: true, state: 'declined', declined, content: saved?.content || null }
}
