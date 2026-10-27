// 답을 기다리는 중에 보낸 메시지 (tutorial-findings #31·#32): 같은 대화의 턴은 하나씩, 다른 대화는 나란히.
// lib/turns.js — 모델·DB 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as T from '../lib/turns.js'

const tick = () => new Promise((r) => setTimeout(r, 5))

test('같은 대화: 뒤 턴은 앞 턴이 끝날 때까지 기다림(대기 표시 한 번), 끝나면 이어서', async () => {
  const a = T.enqueue({ userId: 'u', threadId: 't1', conv: 'c1' })
  assert.equal(await T.waitTurn(a), false)
  const b = T.enqueue({ userId: 'u', threadId: 't1', conv: 'c1' })
  let told = 0, started = false
  const w = T.waitTurn(b, () => { told++ }).then((x) => { started = true; return x })
  await tick()
  assert.equal(started, false)
  assert.equal(told, 1)
  assert.deepEqual(T.waiting({ userId: 'u', threadId: 't1' }).map((x) => x.id), [b.id])
  a.finish()
  assert.equal(await w, true)
  assert.deepEqual(T.running({ userId: 'u', threadId: 't1' }).map((x) => x.id), [b.id])
  b.finish()
  assert.equal(T._live.size, 0)
})

test('다른 대화는 기다리지 않음(나란히 진행)', async () => {
  const a = T.enqueue({ userId: 'u', threadId: 't1', conv: 'c1' })
  await T.waitTurn(a)
  const b = T.enqueue({ userId: 'u', threadId: 't1', conv: 'c2' })
  assert.equal(await T.waitTurn(b), false)
  a.finish(); b.finish()
})

test('앞 턴이 아직 대화를 모르면(라우터 결정 전) 그 결정을 기다렸다가 같은 대화면 줄을 섬', async () => {
  const a = T.enqueue({ userId: 'u', threadId: 't1' })
  await T.waitTurn(a)
  assert.equal(T.busyThread(T.enqueue({ userId: 'x', threadId: 't9' })), false)
  const b = T.enqueue({ userId: 'u', threadId: 't1', conv: 'c7' })
  assert.equal(T.busyThread(b), true)
  let started = false
  const w = T.waitTurn(b).then(() => { started = true })
  await tick()
  assert.equal(started, false)
  a.setConv('c7')
  await tick()
  assert.equal(started, false, '라우터가 같은 대화로 보냈으므로 계속 기다림')
  a.finish()
  await w
  assert.equal(started, true)
  b.finish()
  for (const x of T._live.values()) x.finish()
})

test('세 개가 오면 보낸 순서대로', async () => {
  const order = []
  const a = T.enqueue({ userId: 'u', threadId: 't', conv: 'c' }); await T.waitTurn(a)
  const b = T.enqueue({ userId: 'u', threadId: 't', conv: 'c' })
  const c = T.enqueue({ userId: 'u', threadId: 't', conv: 'c' })
  const wb = T.waitTurn(b).then(() => { order.push('b'); setTimeout(() => b.finish(), 5) })
  const wc = T.waitTurn(c).then(() => { order.push('c'); c.finish() })
  a.finish()
  await Promise.all([wb, wc])
  assert.deepEqual(order, ['b', 'c'])
})
