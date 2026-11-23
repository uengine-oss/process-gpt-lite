// 팀원 메시지 알림에 보낸 사람 — 운영(2026-11-23)에서 팀원의 1:1 메시지 「보자기」가 Home 에 「메시지 · 보자기 ·
// process-gpt 채팅」으로만 떴다(「직원에게서 메시지를 받았을때 누구한테서 온건지가 표시가 없음」). process-gpt 의 채팅
// 트리거는 쓴 사람의 이름을 from_user_id 에 넣는다. 그 값이 없으면(이름 없는 계정 · 다른 트리거) 그 방의 같은 글을 쓴
// 사람을 찾는다. 실제 DB.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const { config } = await import('../config.js')
const { q, pool } = await import('../lib/supa.js')
const { senderOf, listFor } = await import('../lib/notify.js')

const T = config.tenantId
const room = `rt-room-${crypto.randomUUID().slice(0, 8)}`
const me = { id: crypto.randomUUID(), email: `rt-notice-${Date.now()}@uengine.example` }
const notices = []
after(async () => {
  await q('delete from notifications where id = any($1)', [notices])
  await q('delete from chats where id=$1', [room])
  await pool.end()
})

async function chat(content, { name = '', email = 'jiwoo.han@northwind.example' } = {}) {
  await q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4)',
    [crypto.randomUUID(), room, { content, name, email, timeStamp: new Date().toISOString(), role: 'user' }, T])
}
async function notice(title, from = null) {
  const id = crypto.randomUUID()
  notices.push(id)
  await q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values ($1,$2,$3,'chat',$4,$5,$6,$7)`,
    [id, me.email, title, '한지우', `/chats?id=${room}`, from, T])
  return id
}

test('트리거가 넣은 쓴 사람 이름을 그대로', async () => {
  assert.equal(await senderOf({ type: 'chat', url: `/chats?id=${room}`, title: '보자기', from_user_id: '한지우' }), '한지우')
})

test('알림에 쓴 사람이 없으면 그 방에서 같은 글을 쓴 사람(이름, 없으면 주소)', async () => {
  await chat('보자기', { name: '한지우' })
  assert.equal(await senderOf({ type: 'chat', url: `/chats?id=${room}`, title: '보자기', from_user_id: null }), '한지우')
  await chat('이름 없는 계정의 글', { name: '', email: 'noname@uengine.example' })
  assert.equal(await senderOf({ type: 'chat', url: `/chats?id=${room}`, title: '이름 없는 계정의 글' }), 'noname@uengine.example')
  assert.equal(await senderOf({ type: 'chat', url: '/other', title: '보자기' }), null)
})

test('Home 목록의 팀원 메시지 알림에는 from(쓴 사람)이 실린다', async () => {
  await notice('보자기') // no writer in the notice: found in the room
  const list = await listFor(me)
  const n = list.find((x) => x.type === 'chat' && x.title === '보자기')
  assert.ok(n, JSON.stringify(list))
  assert.equal(n.from, '한지우')
})
