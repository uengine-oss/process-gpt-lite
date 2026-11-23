// Home 은 알림이다 — 메일 카드 · 업무 카드도 닫는다(2026-11-23 「이메일이나 bpm todolist 는, 다른 곳에서 목록을 볼 수
// 있을것이므로 … 삭제 가능해야 한다... 홈은 일종의 노티피케이션이므로」). 닫아도 Home 만 바뀐다: 업무는 그대로 내 것이고
// (루틴), 메일 카드는 받은 편지함 › 메일에 남는다. 워크아이템 알림을 닫으면 그 업무의 Home 카드도 함께 닫힌다. 실제 DB.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const { hideTodo, hiddenTodos, mailCards } = await import('../lib/homeCards.js')
const notify = await import('../lib/notify.js')

const me = { id: crypto.randomUUID(), email: `rt-home-${Date.now()}@uengine.example` }
const notices = []
after(async () => {
  await q('delete from pro_actions where user_id=$1', [me.id])
  await q('delete from notifications where id = any($1)', [notices])
  await pool.end()
})

test('업무 카드를 닫으면 한 번만 기억하고, 업무 목록에는 그대로(Home 카드 목록에는 나오지 않음)', async () => {
  const todo = crypto.randomUUID()
  await hideTodo(me.id, todo, '고객 요구사항 작성')
  await hideTodo(me.id, todo, '고객 요구사항 작성')
  assert.ok((await hiddenTodos(me.id)).has(todo))
  const rows = await q(`select status, verb from pro_actions where user_id=$1 and source->>'todo_id'=$2`, [me.id, todo])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'dismissed')
  // the Home's own list of cards (open · running) never shows it
  const open = await q(`select id from pro_actions where user_id=$1 and status in ('open','running')`, [me.id])
  assert.equal(open.length, 0)
})

test('워크아이템 알림을 닫으면 그 업무의 Home 카드도 닫힌다', async () => {
  const todo = crypto.randomUUID(), id = crypto.randomUUID()
  notices.push(id)
  // (an hour old: the notification feed's own test, running alongside, watches for rows newer than its start)
  await q(`insert into notifications(id,user_id,title,type,description,url,tenant_id,time_stamp) values ($1,$2,'계약 요청 등록','workitem','계약관리 프로세스',$3,$4, now() - interval '1 hour')`, [id, me.email, `/todolist/${todo}`, config.tenantId])
  assert.equal(await notify.dismiss(me, id), true)
  assert.ok((await hiddenTodos(me.id)).has(todo))
})

test('닫은 메일 카드는 받은 편지함 › 메일에 남고, 업무 카드 표시는 거기 섞이지 않는다', async () => {
  const [open] = await q(`insert into pro_actions(user_id, verb, text, source) values ($1,'Reply','열린 메일 카드',$2) returning id`, [me.id, { mail_id: 'm-open', subject: 'a' }])
  const [closed] = await q(`insert into pro_actions(user_id, verb, text, source, status) values ($1,'Review','닫은 메일 카드',$2,'dismissed') returning id`, [me.id, { mail_id: 'm-closed', subject: 'b' }])
  const list = await mailCards(me.id)
  const ids = list.map((a) => a.id)
  assert.ok(ids.includes(open.id) && ids.includes(closed.id))
  assert.ok(list.every((a) => a.source?.mail_id), '업무 카드 표시(todo_id)는 메일 목록에 없다')
})
