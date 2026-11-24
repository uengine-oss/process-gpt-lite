'use strict'
// When a step run in the person's terminal is over (design docs/local-agents/design.md §6.2 「단계의 끝」, decided 2026-11-24): after
// the CLI's turn ends the run waits — the people on the instance read the first draft and suggest, its owner puts words in. It ends
// when, for finishMs (default 5 minutes — the desktop setting, or PGL_RUNNER_SETTLE_MS), nothing new came, or at once when the owner
// presses 「끝내기」. Anything new starts the wait again:
//   · a new turn (the CLI works again — there is no wait while it works)
//   · a suggestion from anyone who sees the instance, an input (a steer) from the owner, the owner typing in the terminal
// A steer typed into the CLI but not yet in its records holds the end (up to graceMs) — it is about to start a turn.
// (Before, the run ended 3 s after the turn: a participant's suggestion on the first draft came too late — the user's requirement,
// 2026-11-24: 「여러 사람이 참여하고 있는 인스턴스에 … 타인이 의견을 넣을 수 있다」.)

const DEFAULT_FINISH_MS = 5 * 60_000

// state: {now, turnEnded, busy, lastInput, typedAt, pending (steers typed in, not yet taken), finishNow, finishMs}
// → {done, until (when it ends by itself, ms — null while the CLI works or before its first turn ended), check (ms until it is worth
//    looking again)}
function settleState({ now = Date.now(), turnEnded = 0, busy = false, lastInput = 0, typedAt = 0, pending = false, finishNow = false, finishMs = DEFAULT_FINISH_MS } = {}) {
  if (busy || !turnEnded) return { done: false, until: null, check: null }
  if (pending) return { done: false, until: null, check: 500 }
  if (finishNow) return { done: true, until: now, check: null }
  const last = Math.max(turnEnded, lastInput || 0, typedAt || 0)
  const until = last + Math.max(0, finishMs)
  return now >= until ? { done: true, until, check: null } : { done: false, until, check: until - now }
}

// how long the run waits after a turn: an explicit value (tests, PGL_RUNNER_SETTLE_MS) over the person's desktop setting (minutes)
function finishMsOf({ explicit = null, env = process.env.PGL_RUNNER_SETTLE_MS, minutes = null } = {}) {
  if (Number.isFinite(Number(explicit)) && explicit !== null && explicit !== '') return Math.max(0, Number(explicit))
  if (env != null && env !== '' && Number.isFinite(Number(env))) return Math.max(0, Number(env))
  const m = Number(minutes)
  if (Number.isFinite(m) && m > 0) return Math.min(120, m) * 60_000
  return DEFAULT_FINISH_MS
}

module.exports = { settleState, finishMsOf, DEFAULT_FINISH_MS }
