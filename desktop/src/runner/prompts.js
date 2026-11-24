'use strict'
// When the CLI in a step's terminal waits for its person (design docs/local-agents/design.md §5.11): what it asks and what its choices
// are — from the CLI's own hook events and records, never from the screen's text — and the keys that answer it, as the person would
// press them in that terminal. Only the CLI's owner answers (the server passes only theirs; session.answer checks the ask is still open).
//
// Claude Code (measured 2026-11-24 with 2.1.331 in a PTY, a throwaway config folder and the company model gateway):
//   · a permission prompt — its PermissionRequest hook {tool_name, tool_input, permission_suggestions}; the dialog shows
//       ❯ 1. Yes   2. Yes, and don't ask again for: <rule>   3. Yes, and switch to auto mode   4. No        Esc to cancel · Tab to amend
//     '1' allows it once · '2' allows it and adds the rule (only when there are permission_suggestions) · Esc refuses it: the tool use is
//     rejected and the turn stops (no Stop hook — "Interrupted · What should Claude do instead?", a [Request interrupted …] record).
//     (3 — auto mode — is never offered here: it would change the person's mode for the rest of the session.)
//   · AskUserQuestion — the tool's input {questions:[{question, header, options:[{label, description}], multiSelect}]}; the menu shows
//     each question's options numbered, then "Type something." and "Chat about this". The number of an option picks it and, for one
//     question, answers at once ("Answered Claude's questions: … → Plain text"). With several questions it shows them as tabs
//     ("← ☐ Currency ☐ VAT ✔ Submit →"): each number answers its question and moves to the next, then "Review your answers ❯ 1. Submit
//     answers 2. Cancel" — Enter submits (measured: '2', '1', Enter → "Currency? → USD · Include VAT? → Yes").
//   · an older Claude Code without PermissionRequest: its Notification hook (notification_type permission_prompt) — the tool it waits for
//     is the last tool call in its transcript without a result; choices yes ('1') and no (Esc).
// Codex: its approvals do not reach its rollout or a hook — not offered (the owner answers in the terminal).
const ESC = '\x1b'
const short = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

let seq = 0
const newId = () => `a${Date.now().toString(36)}${(seq++).toString(36)}`

// what the person is asked to allow, briefly (the tool and its command · path · url — the same the dialog shows)
function briefOf(input = {}, rel = (s) => s) {
  const i = input || {}
  if (i.command) return short(rel(Array.isArray(i.command) ? i.command.join(' ') : i.command), 400)
  if (i.file_path || i.path) return short(rel(i.file_path || i.path), 300)
  if (i.url) return short(i.url, 300)
  if (i.pattern) return short(i.pattern, 200)
  return ''
}
const questionsOf = (input) => (Array.isArray(input?.questions) ? input.questions : []).slice(0, 4).map((q) => ({
  question: short(q?.question, 500), header: short(q?.header, 60), multi: !!q?.multiSelect,
  options: (Array.isArray(q?.options) ? q.options : []).slice(0, 8).map((o) => ({ label: short(o?.label, 120), description: short(o?.description, 300) })),
}))

// PermissionRequest hook → the ask (Claude Code)
function fromPermissionRequest(data = {}, { rel } = {}) {
  const tool = short(data.tool_name, 80)
  if (!tool) return null
  if (tool === 'AskUserQuestion') {
    const questions = questionsOf(data.tool_input)
    if (!questions.length || questions.some((q) => !q.options.length)) return null
    return { id: newId(), kind: 'question', tool, questions }
  }
  const always = Array.isArray(data.permission_suggestions) && data.permission_suggestions.length > 0
  return { id: newId(), kind: 'permission', tool, brief: briefOf(data.tool_input, rel), description: short(data.tool_input?.description, 300) || undefined,
    choices: ['yes', ...(always ? ['always'] : []), 'no'] }
}
// Notification hook (permission_prompt) of a Claude Code without PermissionRequest → the ask, for the tool call that waits
function fromNotification(data = {}, pending = null, { rel } = {}) {
  if (data.notification_type !== 'permission_prompt') return null
  return { id: newId(), kind: 'permission', tool: short(pending?.name, 80) || 'tool', brief: briefOf(pending?.input, rel), choices: ['yes', 'no'] }
}

// the keys that give this answer, in order ([] — not an answer this ask has)
//   permission: 'yes' | 'always' | 'no'
//   question:   [optionIndex per question] (or one index)
function keysFor(ask, answer) {
  if (!ask) return []
  if (ask.kind === 'permission') {
    if (!ask.choices?.includes(answer)) return []
    return answer === 'yes' ? ['1'] : answer === 'always' ? ['2'] : [ESC]
  }
  if (ask.kind === 'question') {
    const picks = Array.isArray(answer) ? answer : [answer]
    if (picks.length !== ask.questions.length) return []
    const keys = []
    for (const [i, q] of ask.questions.entries()) {
      const n = Number(picks[i])
      if (!Number.isInteger(n) || n < 0 || n >= q.options.length || n > 8) return []
      keys.push(String(n + 1))
    }
    // (several questions end on their review: Enter submits)
    if (ask.questions.length > 1) keys.push('\r')
    return keys
  }
  return []
}

// what was answered, in words for the record (the conversation shows who answered what)
function answerText(ask, answer) {
  if (ask?.kind === 'permission') return { yes: 'yes', always: 'always', no: 'no' }[answer] || ''
  if (ask?.kind === 'question') return (Array.isArray(answer) ? answer : [answer]).map((n, i) => ask.questions[i]?.options?.[Number(n)]?.label || '').join(' · ')
  return ''
}

module.exports = { fromPermissionRequest, fromNotification, keysFor, answerText, briefOf, ESC }
