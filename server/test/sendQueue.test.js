// 보낸 말이 사라지지 않는다 — 화면의 순수한 부분(src/sendQueue.js)과 서버의 「한 이름은 한 번만」(lib/sendOnce.js, 실제 DB).
// 2026-11-27 녹화 「지금 입력한게 왜 날라갔지」(배포가 서버를 다시 켜는 동안 보낸 말이 사라짐). 스펙 chat-thread-list.
// Run: node --test --test-concurrency=1 test/sendQueue.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_BACKGROUND = '0'
const Q = await import('../../src/sendQueue.js')
const { q, pool } = await import('../lib/supa.js')
const SO = await import('../lib/sendOnce.js')
const db = await q('select 1').then(() => true, () => false)
const made = []
after(async () => {
  for (const id of made) { await q('delete from pro_messages where thread_id=$1', [id]).catch(() => {}); await q('delete from pro_threads where id=$1', [id]).catch(() => {}) }
  await pool.end()
})

test('다시 보낼 실패: 받지 않았고(accepted false) 서버가 잠시 없는 때(상태 없음 · 502 · 503 · 504 · 520~524)만 — 거절 · 로그인 끝 · 그만두기는 아님', () => {
  for (const status of [undefined, 0, 502, 503, 504, 520, 524]) assert.ok(Q.retryable({ accepted: false, status }), String(status))
  for (const status of [400, 401, 403, 404, 409, 413, 500]) assert.ok(!Q.retryable({ accepted: false, status }), String(status))
  assert.ok(!Q.retryable({ accepted: true }), '받은 뒤 끊긴 것은 다시 보내지 않는다')
  assert.ok(!Q.retryable({ accepted: false, unauthorized: true }))
  assert.ok(!Q.retryable({ accepted: false, aborted: true }), '그만두기로 멈춘 것은 아님')
  assert.ok(Q.retryable({ accepted: false, aborted: true, timedOut: true }), '답이 없어 화면이 그만둔 것은 다시')
  assert.ok(!Q.retryable(null))
})

test('기다림은 2초부터 15초까지 · 까닭은 사람의 말로(브라우저의 「Failed to fetch」 아님) · 짧게 보이기', () => {
  assert.deepEqual([1, 2, 3, 7, 8, 30].map(Q.backoff), [2000, 4000, 6000, 14000, 15000, 15000])
  assert.equal(Q.why({ accepted: false, message: 'Failed to fetch' }), '서버에 연결하지 못했어요')
  assert.equal(Q.why({ status: 502, message: '<html>' }), '서버가 잠시 응답하지 않았어요 (502)')
  assert.equal(Q.why({ status: 0, proxyPage: true }), '서버 대신 다른 페이지가 응답했어요')
  assert.equal(Q.why({ status: 400, message: '보낼 말이나 파일이 없어요.' }), '보낼 말이나 파일이 없어요.')
  assert.equal(Q.why({ unauthorized: true }), '로그인이 끝났어요')
  assert.equal(Q.clip('가'.repeat(45)), `${'가'.repeat(40)}…`)
  const id = Q.newId()
  assert.ok(SO.validId(id), '서버가 받는 이름')
  assert.notEqual(Q.newId(), id)
})

test('이 브라우저에 남기기: 모양이 맞는 것만 읽고, 비면 지우고, 저장소가 막혀도 던지지 않는다', () => {
  const box = new Map()
  const storage = { getItem: (k) => box.get(k) ?? null, setItem: (k, v) => box.set(k, v), removeItem: (k) => box.delete(k) }
  const u = { id: 'abcdefgh12', threadId: 't1', key: 't1', text: '보내지 못한 말', files: [{ name: 'a.pdf' }], state: 'retrying', tries: 2, at: 1, job: () => {} }
  Q.saveUnsent('me', [u], storage)
  assert.deepEqual(Q.loadUnsent('me', storage), [{ id: 'abcdefgh12', threadId: 't1', key: 't1', text: '보내지 못한 말', files: [{ name: 'a.pdf' }], state: 'retrying', tries: 2, at: 1 }])
  box.set('pgl-unsent:other', JSON.stringify([{ id: 1 }, null, { id: 'x', threadId: 't', text: 'ok' }]))
  assert.deepEqual(Q.loadUnsent('other', storage).map((x) => x.text), ['ok'])
  Q.saveUnsent('me', [], storage)
  assert.equal(box.has('pgl-unsent:me'), false)
  // sign-out · another person's session: every kept list goes, nothing else
  box.set('pgl-unsent:a', '[]'); box.set('pgl-unsent:b', '[]'); box.set('pgl-lang', 'ko')
  const store = { get length() { return box.size }, key: (i) => [...box.keys()][i], getItem: (k) => box.get(k) ?? null, removeItem: (k) => box.delete(k) }
  Q.forgetAllUnsent(store)
  assert.deepEqual([...box.keys()].filter((k) => k.startsWith('pgl-unsent:')), [])
  assert.equal(box.get('pgl-lang'), 'ko')
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('full') }, removeItem: () => {} }
  assert.deepEqual(Q.loadUnsent('me', broken), [])
  assert.doesNotThrow(() => Q.saveUnsent('me', [u], broken))
})

test('서버: 한 이름은 한 번만 — 도는 동안 두 번째 요청 거절, 끝난 뒤에는 메시지에 남은 이름으로 거절, 다른 방 · 다른 이름은 받음', { skip: !db && 'no database' }, async () => {
  const user = crypto.randomUUID()
  const [t] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','보내기 시험') returning id`, [user])
  const [t2] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'chat','다른 방') returning id`, [user])
  made.push(t.id, t2.id)
  const id = Q.newId()
  assert.equal(await SO.claim(t.id, id), true)
  assert.equal(await SO.claim(t.id, id), false, '도는 동안 같은 이름')
  assert.equal(await SO.claim(t2.id, id), true, '다른 방')
  SO.release(t2.id, id)
  await q(`insert into pro_messages(thread_id, role, kind, content) values ($1,'user','text',$2)`, [t.id, { text: '견적서 초안 만들어 줘', clientId: id }])
  SO.release(t.id, id)
  assert.equal(await SO.claim(t.id, id), false, '끝난 뒤에도 — 메시지에 남은 이름')
  const other = Q.newId()
  assert.equal(await SO.claim(t.id, other), true)
  SO.release(t.id, other)
  assert.equal(SO.validId('짧'), null)
  assert.equal(SO.validId('a'.repeat(65)), null)
  assert.equal(SO.validId("abc'; drop"), null)
})
