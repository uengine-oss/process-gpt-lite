// Process GPT's enum values are not the same in every database: its migrations give todo_status CANCELLED and
// draft_status HUMAN_ASKED, but a database that was made another way (the production one) can lack them, and a
// write or an uncast comparison with a value the enum does not have fails the whole statement. What this database
// has is asked once (enum_range) and kept; a lookup that fails counts as "missing" for now and is asked again later.
//   cancelling a work item: status CANCELLED, else DONE with Lite's mark in its output (cancelSet) — the reads that
//     tell a cancelled item from a done one read the mark back as CANCELLED (statusSql · notCancelledSql)
//   an agent's step waiting for a person: draft_status HUMAN_ASKED, else COMPLETED (also off the step pool:
//     fetch_pending_task takes only a NULL draft_status or FB_REQUESTED; COMPLETED is written by every finished agent step)
import { q } from './supa.js'

const known = new Map() // 'type:value' → { ok, at }
const RETRY_MS = 60_000
const TYPE = /^[a-z_][a-z0-9_]*$/

export async function enumHas(type, value) {
  if (!TYPE.test(type)) throw new Error(`enum type ${type}`)
  const k = `${type}:${value}`
  const hit = known.get(k)
  if (hit && (hit.ok !== null || Date.now() - hit.at < RETRY_MS)) return !!hit.ok
  try {
    const [r] = await q(`select $1::text = any(enum_range(null::${type})::text[]) as ok`, [String(value)])
    known.set(k, { ok: !!r?.ok, at: Date.now() })
    return !!r?.ok
  } catch (e) {
    console.warn(`[enums] ${type} ${value}: could not read the enum (${e.message}) — treated as missing`)
    known.set(k, { ok: null, at: Date.now() })
    return false
  }
}
// (tests)
export const forgetEnums = () => known.clear()

// ---------- a cancelled work item (todolist) ----------
export const CANCEL_MARK = 'lite_cancelled'
// the SET part of an UPDATE that cancels work items. Without CANCELLED: DONE (the closest Process GPT status — the item is over and
// nobody works on it) with {"lite_cancelled": true} on its output, a scalar so nothing that merges a step's output values picks it up
export async function cancelSet() {
  if (await enumHas('todo_status', 'CANCELLED')) return `status='CANCELLED'`
  return `status='DONE', output = (case when jsonb_typeof(output) = 'object' then output else '{}'::jsonb end) || jsonb_build_object('${CANCEL_MARK}', true)`
}
// a work item's status as text, a marked DONE read as CANCELLED (p: the table's alias with its dot, e.g. 't.')
export const statusSql = (p = '') => `(case when ${p}status::text = 'DONE' and coalesce(${p}output ? '${CANCEL_MARK}', false) then 'CANCELLED' else ${p}status::text end)`
// not a marked DONE (for reads that take DONE as "this step was done")
export const notCancelledSql = (p = '') => `not coalesce(${p}output ? '${CANCEL_MARK}', false)`
// (pure) the same for a row already read with its output
export const statusOf = (t) => (t?.status === 'DONE' && t?.output && typeof t.output === 'object' && t.output[CANCEL_MARK] === true ? 'CANCELLED' : t?.status)

// ---------- an agent's step held for a person ----------
export async function humanAsked() {
  return (await enumHas('draft_status', 'HUMAN_ASKED')) ? 'HUMAN_ASKED' : 'COMPLETED'
}
