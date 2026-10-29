// 알림 감시(startNotificationFeed) 통합 시험 — 실제 데이터베이스에서:
//   새 알림 행은 한 번만 새것으로 잡히고, 새 행이 없으면 다음 바퀴에 아무것도 잡히지 않는다.
//   time_stamp 는 마이크로초까지라, 위치를 JS Date(밀리초)로 들고 있으면 가장 최근 행이 매 바퀴 다시 잡혔다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { pool, q } from '../lib/supa.js'
import { withTenant } from '../lib/tenant.js'
import { feedOnce } from '../lib/notify.js'

const TENANT = 'localhost'
const ids = []

test('새 알림은 한 번만 잡히고, 다음 바퀴에는 다시 잡히지 않는다', async () => {
  await withTenant(TENANT, async () => {
    await feedOnce() // 위치를 지금으로
    await new Promise((r) => setTimeout(r, 20))
    const id = crypto.randomUUID(); ids.push(id)
    // 마이크로초가 붙은 시각(밀리초로는 담기지 않는 값)
    await q(`insert into notifications (id, user_id, title, type, tenant_id, time_stamp)
             values ($1, 'notify-feed-test', '감시 시험', 'chat', $2, now() + interval '123 microseconds')`, [id, TENANT])
    assert.ok(await feedOnce() >= 1, '새 행이 잡혀야 한다')
    assert.equal(await feedOnce(), 0, '새 행이 없으면 아무것도 잡히지 않아야 한다')
    assert.equal(await feedOnce(), 0)
  })
})

after(async () => {
  if (ids.length) await q('delete from notifications where id = any($1::uuid[])', [ids])
  await pool.end()
})
