// 서버가 예약 시계가 되는 경우(PRO_CRON_MODE=server) — 운영 Supabase 가 클러스터 밖이라 pg_cron 의
// 콜백이 Service 주소에 닿지 않는다. 실제 데이터베이스에서:
//   등록은 pg_cron 작업을 만들지 않고, 매 분 그 분을 가리키는 예약만 고르며, 멈춘 예약은 고르지 않는다.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

process.env.PRO_CRON_MODE = 'server'
const { pool, q } = await import('../lib/supa.js')
const S = await import('../lib/scheduler.js')

const KST = (s) => new Date(`${s}+09:00`)
const ids = []

test('KST 식이 가리키는 분만 맞다', () => {
  assert.equal(S.dueAt('0 8 * * *', KST('2026-10-30T08:00:00')), true)
  assert.equal(S.dueAt('0 8 * * *', KST('2026-10-30T08:01:00')), false)
  assert.equal(S.dueAt('0 8 * * *', new Date('2026-10-30T08:00:00Z')), false) // UTC 8시는 KST 17시
  assert.equal(S.dueAt('30 9 * * 1', KST('2026-11-02T09:30:00')), true) // 월요일
  assert.equal(S.dueAt('30 9 * * 1', KST('2026-11-03T09:30:00')), false)
  assert.equal(S.dueAt('*/15 * * * *', KST('2026-10-30T13:45:00')), true)
  assert.equal(S.nextRun('0 8 * * *', KST('2026-10-30T08:00:00')).getTime(), KST('2026-10-31T08:00:00').getTime())
})

test('서버 모드 등록은 pg_cron 작업 없이 남고, 그 분에만 골라진다', async () => {
  const user = crypto.randomUUID()
  const s = await S.createSchedule({ userId: user, name: '시계 시험', cron: '7 3 * * *', prompt: '시험', threadId: null })
  ids.push(s.id)
  assert.equal(s.job_name, null)
  const [row] = await q('select job_name from pro_schedules where id=$1', [s.id])
  assert.equal(row.job_name, null)
  assert.ok((await S.dueSchedules(KST('2026-10-30T03:07:00'))).includes(s.id))
  assert.ok(!(await S.dueSchedules(KST('2026-10-30T03:08:00'))).includes(s.id))
  await q('update pro_schedules set paused=true where id=$1', [s.id])
  assert.ok(!(await S.dueSchedules(KST('2026-10-30T03:07:00'))).includes(s.id))
})

after(async () => {
  if (ids.length) await q('delete from pro_schedules where id = any($1::uuid[])', [ids])
  await pool.end()
})
