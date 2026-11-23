// Home is notifications: every card on it can be put away (2026-11-23: 「이메일이나 bpm todolist 는, 다른 곳에서
// 목록을 볼 수 있을것이므로 … 삭제 가능해야 한다... 홈은 일종의 노티피케이션이므로」). Putting a card away
// changes nothing but Home:
//   - a work item (todolist) stays the person's to do — 루틴 lists it under 「내 입력이 필요해요」. Home
//     remembers it was put away as a dismissed Home card (pro_actions, source.todo_id), on every device.
//   - a mail's card stays in 팀 메시지 › 받은 편지함 (mailCards), where it opens the same mail sheet.
import { q } from './supa.js'

// the work items put away from Home, by todo id
export async function hiddenTodos(userId) {
  const rows = await q(`select source->>'todo_id' as id from pro_actions where user_id=$1 and status='dismissed' and source ? 'todo_id'`, [userId])
  return new Set(rows.map((r) => r.id))
}

// put a work item's Home card away (once; the work item itself is untouched)
export async function hideTodo(userId, todoId, text = '') {
  const id = String(todoId || '')
  if (!id) return false
  await q(`insert into pro_actions(user_id, verb, text, source, status)
           select $1, 'Submit', $2, jsonb_build_object('todo_id', $3::text), 'dismissed'
           where not exists (select 1 from pro_actions where user_id=$1 and source->>'todo_id' = $3::text)`, [userId, String(text || '').slice(0, 200), id])
  return true
}

// the cards made from mail in the last days, newest first — open, put away or answered
export async function mailCards(userId, { days = 30, limit = 50 } = {}) {
  return q(`select * from pro_actions where user_id=$1 and source ? 'mail_id' and status <> 'deleted'
            and created_at > now() - make_interval(days => $2) order by created_at desc limit $3`, [userId, days, limit])
}
