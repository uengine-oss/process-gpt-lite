// 검색(GET /api/search): the person's messages whose words hold what was typed, newest first — with the room each is in (the chat, or a
// project and the sub-topic it is filed under: a conversation moved into a project is found there, never in the chat — spec thread-to-project)
import { q } from './supa.js'

export async function searchMessages(userId, text, { limit = 30 } = {}) {
  const like = `%${String(text || '')}%`
  return q(`select m.id, m.thread_id, t.kind, t.title, m.content->>'text' as text, m.created_at,
      case when t.kind = 'project' then (case jsonb_typeof(m.content->'conv') when 'object' then m.content->'conv'->>'id' when 'string' then m.content->>'conv' end) end as conv
    from pro_messages m join pro_threads t on t.id=m.thread_id
    where t.user_id=$1 and m.content->>'text' ilike $2 order by m.created_at desc limit $3`, [userId, like, limit])
}
