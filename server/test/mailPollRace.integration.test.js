// 메일함을 두 번 동시에 확인해도 메일 한 통은 한 번만 처리한다. 실제 데이터베이스에서 (2026-11-10):
// 연습 메일 두 통이 함께 도착해 확인이 겹치자, 두 확인이 모두 두 통을 새 메일로 읽어 초안을 두 번 만들고
// 사례에 '요청 메일 접수' 를 두 번 남겼다. 그 사례들로 마이닝한 정의는 단계 순서를 잃었다
// ('요청 메일·견적서 작성' 이 접수·견적서 작성·제안서 작성 택일로 그려짐).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

const { pool, q } = await import('../lib/supa.js')
const { claimFresh } = await import('../lib/mail.js')

const user = crypto.randomUUID()
after(async () => {
  await q('delete from pro_mail_seen where user_id=$1', [user])
  await pool.end()
})

test('동시에 두 번 확인하면 메일마다 한 확인만 새 메일로 가져간다', async () => {
  const mails = [{ id: `race-a-${user.slice(0, 8)}` }, { id: `race-b-${user.slice(0, 8)}` }]
  const [one, two] = await Promise.all([claimFresh(user, mails), claimFresh(user, mails)])
  const taken = [...one, ...two].map((m) => m.id).sort()
  assert.deepEqual(taken, mails.map((m) => m.id).sort(), `두 확인이 가져간 메일: ${JSON.stringify([one, two])}`)
})

test('이미 본 메일은 다시 가져가지 않는다', async () => {
  const mails = [{ id: `race-a-${user.slice(0, 8)}` }, { id: `race-c-${user.slice(0, 8)}` }]
  const fresh = await claimFresh(user, mails)
  assert.deepEqual(fresh.map((m) => m.id), [`race-c-${user.slice(0, 8)}`])
})
