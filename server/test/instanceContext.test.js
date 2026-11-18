// Work of a process instance stays with the instance (2026-11-18): a step of mine, a mail or a schedule that
// started it, its end — a Home card that opens the instance page (/routines/<instId>) and the instance's
// own conversation, never cards appended to the main chat. On the local database, without an engine run.
// Run: node --test test/instanceContext.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const { q, pool } = await import('../lib/supa.js')
const db = await q('select 1 from pro_threads limit 1').then(() => true).catch(() => false)
const made = { threads: [], notes: [] }
after(async () => {
  for (const t of made.threads) await q('delete from pro_threads where id=$1', [t]).catch(() => {})
  for (const u of made.notes) await q('delete from notifications where user_id=$1', [u]).catch(() => {})
  await pool.end()
})

test('인스턴스 대화: 사람마다 하나, 다시 불러도 같은 대화', { skip: !db }, async () => {
  const { instanceThread } = await import('../lib/engine.js')
  const user = (await q('select gen_random_uuid()::text as id'))[0].id
  const instId = `test_instance_context.${user}`
  const a = await instanceThread(user, instId, '세미나 견적 · 카페나무')
  made.threads.push(a)
  assert.equal(await instanceThread(user, instId), a)
  const [t] = await q('select kind, title, ref from pro_threads where id=$1', [a])
  assert.deepEqual(t, { kind: 'process', title: '세미나 견적 · 카페나무', ref: instId })
})

test('홈 카드: 인스턴스 화면을 여는 알림(메일로 시작 · 예약 실행 · 완료)', { skip: !db }, async () => {
  const { notifyInstance } = await import('../lib/engine.js')
  const { listFor } = await import('../lib/notify.js')
  const user = (await q('select gen_random_uuid()::text as id'))[0].id
  made.notes.push(user)
  const instId = `test_instance_context.${user}`
  await notifyInstance(user, instId, { type: 'process_started', title: '메일로 시작 · 세미나 견적', text: '카페나무 메일은 …' })
  const [n] = (await listFor({ id: user })).filter((x) => x.url === `/routines/${instId}`)
  assert.equal(n?.type, 'process_started')
  assert.equal(n.title, '메일로 시작 · 세미나 견적')
})

test('업무·시작·완료를 전체 채팅에 붙이는 코드가 남아 있지 않다', async () => {
  const engine = await fs.readFile(new URL('../lib/engine.js', import.meta.url), 'utf8')
  assert.doesNotMatch(engine, /addMessage\(/, 'engine.js: 단계·완료는 홈 카드로')
  const mining = await fs.readFile(new URL('../lib/mining/service.js', import.meta.url), 'utf8')
  const route = mining.slice(mining.indexOf('async function routeMailIn'), mining.indexOf('export function routeNote'))
  assert.doesNotMatch(route, /mainThread|'process', \{/, '메일로 시작: 전체 채팅에 붙이지 않음')
  const missions = await fs.readFile(new URL('../lib/missions.js', import.meta.url), 'utf8')
  const run = missions.slice(missions.indexOf('async function runProcessSchedule'), missions.indexOf('export async function createMission'))
  assert.doesNotMatch(run, /mainThread|'process', \{/, '예약 실행: 전체 채팅에 붙이지 않음')
  const agent = await fs.readFile(new URL('../lib/agent.js', import.meta.url), 'utf8')
  assert.doesNotMatch(agent, /addMessage\([^)]*'todo'/, '내 할 일: 양식 카드 대신 인스턴스 목록')
})
