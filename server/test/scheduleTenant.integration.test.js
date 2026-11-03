// ProcessGPT 게이트웨이 뒤(PRO_TENANT_FROM_HEADER=1)에서 예약이 만든 테넌트에서 실행되는가. 실제 데이터베이스에서:
// 운영에서 ohsy 사람이 건 예약이 매 분 시계(요청 없음)에서 기본 테넌트 localhost 로 돌아, 에이전트가
// X-Tenant-Id localhost 를 거부했고("에이전트에 연결하지 못했어요") 알림도 localhost 로 저장됐다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_TENANT_FROM_HEADER = '1'
process.env.PRO_TENANT_ID = 'localhost'
process.env.PRO_CRON_MODE = 'server'
const { config } = await import('../config.js')
const { pool, q } = await import('../lib/supa.js')
const S = await import('../lib/scheduler.js')
const T = await import('../lib/tenant.js')
const { inScheduleTenant } = await import('../lib/missions.js')

const one = crypto.randomUUID()   // ohsy 에만 속한 사람
const both = crypto.randomUUID()  // ohsy 와 localhost 둘 다
const schedules = []
await q(`insert into users (id, email, username, tenant_id) values ($1,$2,'t','ohsy'), ($3,$4,'t','ohsy'), ($3,$4,'t','localhost')`,
  [one, `sched-tenant-one-${one.slice(0, 8)}@example.test`, both, `sched-tenant-both-${both.slice(0, 8)}@example.test`])

after(async () => {
  if (schedules.length) await q('delete from pro_schedules where id = any($1::uuid[])', [schedules])
  await q('delete from users where id = any($1::uuid[])', [[one, both]])
  await pool.end()
})

test('요청의 테넌트로 예약을 저장한다', async () => {
  const s = await T.withTenant('ohsy', () => S.createSchedule({ userId: one, name: 'tenant check', cron: '0 9 * * *', prompt: 'x', threadId: null, notify: 'always' }))
  schedules.push(s.id)
  assert.equal(s.tenant_id, 'ohsy')
})

test('요청 없는 실행도 예약의 테넌트에서 돈다 (사람이 두 테넌트에 속해도)', async () => {
  // 매 분 시계처럼 테넌트 없이 시작한다
  assert.equal(T.currentTenant(), undefined)
  const seen = await inScheduleTenant({ user_id: both, tenant_id: 'ohsy' }, async () => config.tenantId)
  assert.equal(seen, 'ohsy')
})

test('테넌트가 없는 예전 예약은 그 사람의 유일한 테넌트에서 돈다', async () => {
  assert.equal(await inScheduleTenant({ user_id: one, tenant_id: null }, async () => config.tenantId), 'ohsy')
})

test('여러 테넌트에 속한 사람은 추측하지 않고 기본 테넌트에 남는다', async () => {
  assert.equal(await inScheduleTenant({ user_id: both, tenant_id: null }, async () => config.tenantId), 'localhost')
})

test('이미 테넌트가 정해진 일(요청)은 사람의 테넌트로 바꾸지 않는다', async () => {
  const seen = await T.withTenant('localhost', () => T.asTenantOf(one, async () => config.tenantId))
  assert.equal(seen, 'localhost')
})
