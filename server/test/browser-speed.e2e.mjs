// 브라우저 작업 한 번의 턴당 시간(페이지 읽기 · 화면 사진 · 모델 · 동작)을 실제 모델(server/.env, 운영과 같은 모델)로 잰다.
// 시험 사이트는 fixtures/studio.mjs(생성 → 몇 초 뒤 다운로드). 판정 서버 없음(운영처럼). 모델을 부르므로 필요할 때만 돌린다.
//   node test/browser-speed.e2e.mjs
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { startStudio } from './fixtures/studio.mjs'
// (this test's made-up sites run on this machine: the server's browser may open them — lib/privateNet.js)
process.env.PRO_BROWSER_PRIVATE_ALLOW ??= '127.0.0.1,localhost'

process.env.PRO_CONTEXT_ROUTER_URL = ''
const browser = await import('../lib/browser.js')
const { q, pool } = await import('../lib/supa.js')
const { config } = await import('../config.js')

const user = crypto.randomUUID()
let site, threadId
before(async () => {
  browser.WAIT.everyMs = 1000
  site = await startStudio()
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','browser speed') returning id`, [user])
})
after(async () => {
  await browser.close(user)
  await site.close()
  await q('delete from pro_threads where user_id=$1', [user])
  await pool.end()
  fs.rmSync(path.join(browser.PROFILES, user), { recursive: true, force: true })
})

test('실제 모델로 생성 → 기다림 → 다운로드: 턴마다 걸린 시간', async () => {
  const t0 = Date.now()
  const r = await browser.runBrowserTask({ userId: user, threadId, goal: '이 스튜디오 사이트에서 「생성」을 눌러 만들고, 완료되면 「다운로드」를 눌러 파일을 받아 줘.', startUrl: `${site.url}?ms=3000` })
  const ms = Date.now() - t0
  const files = await q(`select content from pro_messages where thread_id=$1 and kind='file'`, [threadId])
  console.log(`\nmodel ${config.llm.model} · ${r.state} in ${(ms / 1000).toFixed(1)}s · plan ${r.stats.plan_ms}ms · ${r.stats.turns} turns · files ${files.length}`)
  console.log('turn  tool            snap   shot      llm     act')
  r.stats.turn_ms.forEach((t, i) => console.log(`${String(i + 1).padStart(4)}  ${t.tool.padEnd(14)} ${String(t.snap).padStart(5)} ${String(t.shot).padStart(6)} ${String(t.llm).padStart(8)} ${String(t.act).padStart(7)}`))
  console.log(`avg   ${''.padEnd(14)} ${String(r.stats.avg_ms.snap).padStart(5)} ${String(r.stats.avg_ms.shot).padStart(6)} ${String(r.stats.avg_ms.llm).padStart(8)} ${String(r.stats.avg_ms.act).padStart(7)}`)
  console.log(`summary: ${r.summary.split('\n')[0]}`)
  assert.notEqual(r.state, 'failed', r.summary)
})
