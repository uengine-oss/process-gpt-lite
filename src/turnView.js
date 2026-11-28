// What the plan card (components/TurnPlanCard.vue), the progress panel (TurnProgress.vue) and the pill show of a running turn
// (server lib/turnPlan.js — the turn.* events, kept in the store's `turns`). Korean text here is translated on screen in English mode
// (src/i18n/ko-en.json), the server's own texts (stage, handler, plan) come in the person's language.

// 48초 · 2분 14초 (the screen's translator reads both)
export function dur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000))
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`
}
// since the turn started, on this clock (skew: this clock against the server's)
export const elapsed = (t, now = Date.now()) => Math.max(0, now - (t.skew || 0) - (t.startedAt || now))
// since the last event came
export const idle = (t, now = Date.now()) => Math.max(0, now - (t.seenAt || now))

// the handler started: the first planned step is the one being done
const STARTED = ['queued', 'preparing', 'working', 'writing']
// The steps as they stand: the agent's to-dos once it wrote them (they are the truth from then on), else the plan's — the first one
// active once the work started. Nothing is marked done until something says so (design turnplan §3.2).
export function stepsOf(t) {
  if (t?.todos?.length) return t.todos
  const list = t?.plan?.steps || []
  const on = !!t?.handler || STARTED.includes(t?.stage?.stage)
  return list.map((s, i) => ({ ...s, state: i === 0 && on ? 'active' : 'pending' }))
}
export const doneOf = (steps) => steps.filter((s) => s.state === 'done').length

// where a trail step looked (the same words as the saved trail under an answer)
export const whereOf = (s) => [s.hosts?.join(', '), s.query && `「${s.query}」`, s.file].filter(Boolean).join(' · ')
export const stepText = (s) => [s.text || s.phase || s.tool, whereOf(s)].filter(Boolean).join(' · ')

// The card's live line: what is happening now → {text, raw} (raw: the agent's own words, left as they are on screen). After a tool
// ended with nothing since for 5 s, 「다음 단계를 쓰는 중 · 12초」 (the next model call writes for a while with nothing to stream —
// design turnplan §3.4).
export function liveLine(t, now = Date.now()) {
  if (!t) return { text: '' }
  const st = t.stage || {}
  const quiet = Math.floor(idle(t, now) / 1000)
  if (st.stage === 'writing') return { text: st.text || '' }
  if (st.detail === 'after_tool') {
    if (quiet >= 5) return { text: `${st.text} · ${quiet}초` }
    const last = t.steps?.[t.steps.length - 1]
    return { text: last ? stepText(last) : st.text }
  }
  if (t.open?.text) return { text: `“${t.open.text}”`, raw: true }
  const last = st.stage === 'working' ? t.steps?.[t.steps.length - 1] : null
  const base = last ? stepText(last) : st.text || ''
  return { text: quiet >= 5 && ['preparing', 'working', 'queued', 'routing', 'reading'].includes(st.stage) ? `${base} · ${quiet}초` : base }
}

// What the plan card shows (components/TurnPlanCard.vue): `reading` — the 「요청을 읽는 중」 head until the plan comes; `off` — the
// front call is switched off (PRO_FRONT_PLAN=off): no head at all, only the steps and the live line, once there are any (review
// 11-25 #10: 「요청을 읽는 중」 stood there for the whole turn). Nothing for the first 0.6 s without a plan: a message answered at once
// (a panel, a schedule) ends before its card would flash.
export function cardView(t, now = Date.now()) {
  const off = t?.planState === 'off' && !t?.plan
  const reading = !t?.plan && !off
  const steps = stepsOf(t)
  const live = liveLine(t, now)
  const late = elapsed(t || {}, now) >= 600
  const shown = !!t && (off ? late && (steps.length > 0 || !!live.text) : (!reading || late))
  return { shown, off, reading, steps, live }
}

// ---------- a saved answer's plan (server lib/turnPlan.js saved · settledPlan, lib/planGuard.js) ----------
// The line it folds to, as parts (each its own text — the screen's translator reads each): 「계획 3/4」 · 「1단계 못 함」 · 「2분 14초」.
// trouble: a step was missed or done another way, or the turn stopped to ask — the plan opens by itself and says which step
// (2026-11-28 녹화 20:49: 「계획 4/4」 over a step the turn never did, folded under a long answer — 「계획이 지금 사라져버렸는데」)
export const STEP_MARK = { done: '✓', missed: '✗', changed: '↷', active: '•' }
export function planParts(plan, notes = []) {
  if (!plan || typeof plan !== 'object' || !plan.understood) return null
  const steps = Array.isArray(plan.steps) ? plan.steps : []
  if (!steps.length && !notes.length && plan.source !== 'front') return null
  const missed = steps.findIndex((s) => s.state === 'missed')
  const changed = steps.findIndex((s) => s.state === 'changed')
  // (warn: a part that says something did not go as planned)
  const parts = [{ text: steps.length ? (plan.checking ? '계획 · 확인하는 중' : `계획 ${doneOf(steps)}/${steps.length}`) : '진행 기록' }]
  if (missed >= 0) parts.push({ text: `${missed + 1}단계 못 함`, warn: true })
  if (changed >= 0) parts.push({ text: `${changed + 1}단계 바꿈`, warn: true })
  if (plan.state === 'asked') parts.push({ text: '물어볼 게 있어요', warn: true })
  if (plan.ms) parts.push({ text: dur(plan.ms) })
  if (plan.state === 'stopped') parts.push({ text: '멈췄어요' })
  return { parts, trouble: missed >= 0 || changed >= 0 || plan.state === 'asked' }
}
