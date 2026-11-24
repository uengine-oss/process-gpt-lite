// What the live editor's edit tools did for a person (mcp/office.js passes every office_live_* call through, so it sees each
// result): an edit counts as done only when IeumOffice says it changed something. Production 2026-11-25: the agent answered
// 「표 안 글씨의 세로 정렬을 중앙으로 맞췄습니다」 and the document had not changed — the editor had reported the batch as
// valid with nothing changed, and the agent took that for done. Now
//   - a call that changed nothing goes back to the agent as an error that says so (it may try the right target, or say it
//     could not), and
//   - a turn whose edit calls all failed or changed nothing ends with that said plainly instead of the agent's words
//     (lib/agent.js delegate), and its review is not asked to judge a formatting change it cannot see (lib/review.js).
// Deterministic: IeumOffice's own report (isError, ok:false, mutated:false), never what the answer's words say.
import { L } from './lang.js'

const EDIT = /^office_live_(write|replace|apply_ops|hwp_table|hwp_text)$/
const textOf = (result) => (result?.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join('\n')

/** null for a tool that does not edit; else { applied, summary?, why? } from the editor's own answer */
export function editOutcome(name, args, result) {
  if (!EDIT.test(String(name || ''))) return null
  // (the 한글 table tool also reads)
  if (/^office_live_hwp_/.test(name) && args?.action === 'read') return null
  const text = textOf(result)
  if (result?.isError) return { applied: false, why: text.slice(0, 300) || 'error' }
  let j = null
  try { j = JSON.parse(text) } catch { /* plain text: taken as done */ }
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    if (j.ok === false) return { applied: false, why: String(j.error || j.summary || '').slice(0, 300) }
    if (j.mutated === false) return { applied: false, nothing: true, why: String(j.summary || j.output || '').slice(0, 300) }
    return { applied: true, summary: String(j.summary || '').slice(0, 300) }
  }
  return { applied: true, summary: text.slice(0, 300) }
}

/** what the agent gets back for an edit that changed nothing: an error that says so, with the editor's own words */
export function notAppliedResult(outcome) {
  const said = outcome.why ? L(` 편집기의 답: ${outcome.why}`, ` The editor said: ${outcome.why}`) : ''
  return { isError: true, content: [{ type: 'text', text: L(
    `이 편집은 문서에 적용되지 않았어요 — 바뀐 곳이 없어요.${said} 대상(target·range·블록 번호)이 맞는지 office_live_read 로 다시 확인하고 고쳐 보내거나, 고치지 못했다고 그대로 알리세요. 했다고 답하지 마세요.`,
    `This edit was not applied to the document — nothing changed.${said} Check the target (target, range, block index) with office_live_read and send it again, or say plainly that you could not make the change. Do not say it was done.`) }] }
}

// ---- per person: the edit calls since a turn began
const calls = new Map() // userId → [{ at, tool, applied, summary, why }]
export function recordEdit(userId, tool, outcome) {
  if (!userId || !outcome) return
  const list = calls.get(userId) || []
  list.push({ at: Date.now(), tool, ...outcome })
  calls.set(userId, list.slice(-50))
}
/** the edit calls of this person since `since` (a turn's start) */
export function editsSince(userId, since) {
  return (calls.get(userId) || []).filter((c) => c.at >= since)
}

/** a turn's edits → 'applied' (at least one changed the document), 'none' (some were made, none changed it), or null (no edit made) */
export function editVerdict(edits) {
  if (!edits?.length) return null
  return edits.some((e) => e.applied) ? 'applied' : 'none'
}

/** the answer a turn ends with when its edits changed nothing: said plainly, with the editor's reason */
export function notAppliedAnswer(edits, file) {
  const why = [...edits].reverse().find((e) => e.why)?.why || ''
  const short = why.replace(/\s+/g, ' ').trim().slice(0, 160)
  return L(
    `요청한 수정이 ${file ? `'${file}' ` : ''}문서에 반영되지 않았어요. 편집기가 바뀐 곳이 없다고 알려 왔어요${short ? ` (${short})` : ''}. 고칠 부분을 문서에서 다시 골라 보내 주세요.`,
    `The change you asked for was not applied to ${file ? `'${file}'` : 'the document'}. The editor reported that nothing changed${short ? ` (${short})` : ''}. Select the part in the document again and send it once more.`)
}
