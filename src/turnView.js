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
