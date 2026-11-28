// 진행할지 묻는 카드(onto-entry)의 상태를 서버가 지킨다(PR #134 확인 검토, 2026-11-28): 한 카드에서는 건이 한 번만 시작하고, 시작한 · 거절한 카드는
// 다시 시작하지 않는다. 다른 화면이 「진행」한 것을 이 화면이 못 들었으면(알림을 놓침) 이 화면의 카드는 아직 묻고 있다 — 그 카드의 「진행」 ·
// 「아니요」는 409 와 함께 카드의 지금 내용(card)을 돌려받아 그대로 보인다.
//   claimStart: 「진행」 전에 묻는 카드를 조건부 UPDATE 하나로 잡는다(starting) — 시작 · 거절했거나 다른 화면이 시작하는 중이면 409
//   releaseStart: 건을 시작하지 못했으면 잡은 것을 놓는다(카드는 다시 묻는다)
import { q } from '../supa.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s) => UUID.test(String(s || ''))
// a start in progress counts for this long (a start that died leaves its claim behind: it goes stale)
export const STARTING_SECS = 120
const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra })
// the person's own card (any kind): their own threads (the thread index)
export const OWN = `m.thread_id in (select id from pro_threads where user_id = $2::uuid)`
// a start in progress on the card: its claim, younger than STARTING_SECS
// (coalesce: a card without a claim has none — NULL would make `not …` NULL and refuse every card)
export const STARTING_SQL = `coalesce(jsonb_typeof(m.content->'starting') = 'object' and (m.content->'starting'->>'at')::timestamptz > now() - make_interval(secs => ${STARTING_SECS}), false)`

export async function ownCard(me, id) {
  if (!isUuid(id) || !isUuid(me?.id)) return null
  const [m] = await q(`select m.id, m.thread_id, m.role, m.kind, m.content, m.created_at from pro_messages m where m.id = $1::uuid and m.kind = 'onto-entry' and ${OWN}`, [String(id), String(me.id)])
  return m || null
}
const startingNow = (c) => !!c?.starting?.at && Date.now() - Date.parse(c.starting.at) < STARTING_SECS * 1000
// 409 with the card as it is now (routes' h() puts `body` into the answer): the screen that missed the change shows it, and the
// person's other screens get it too
export async function refused(me, row) {
  const c = row?.content || {}
  const msg = c.state === 'declined' ? '이미 프로세스 없이 하기로 한 카드예요.'
    : c.state && c.state !== 'ask' ? '이미 진행한 카드예요 — 다른 화면에서 시작했어요.'
      : startingNow(c) ? '다른 화면에서 시작하는 중이에요.' : '이 카드는 지금 바꿀 수 없어요.'
  if (row) { const { emit } = await import('../bus.js'); emit(me.id, 'message', row) }
  return err(409, msg, { state: c.state || null, caseId: c.caseId || null, body: { card: row || null } })
}

// 「진행」 from a card: null when no card of theirs is named (a start from elsewhere — nothing to guard), else the claimed id
export async function claimStart(me, messageId) {
  if (!messageId) return null
  if (!isUuid(messageId)) throw err(400, '카드(messageId)가 올바르지 않아요.')
  if (!isUuid(me?.id)) return null
  const [row] = await q(`update pro_messages m set content = m.content || jsonb_build_object('starting', jsonb_build_object('at', to_jsonb(now()), 'by', $2::text))
      where m.id = $1::uuid and m.kind = 'onto-entry' and ${OWN} and coalesce(m.content->>'state', 'ask') = 'ask' and not ${STARTING_SQL}
      returning m.id`, [String(messageId), String(me.id)])
  if (row) return row.id
  const cur = await ownCard(me, messageId)
  if (!cur) return null
  throw await refused(me, cur)
}
// the start did not happen: the card asks again (only our own claim, only while the card still asks)
export async function releaseStart(me, id) {
  if (!id) return
  await q(`update pro_messages m set content = m.content - 'starting' where m.id = $1::uuid and ${OWN} and coalesce(m.content->>'state', 'ask') = 'ask'`, [String(id), String(me.id)])
}
