// 끊김에 강한 채팅 — 응답 스트림이 중간에 끊겨도 "생각하는 중"에 멈추지 않고, SSE 가 막힌 경로에서는 롱폴링으로,
// 에이전트가 오래 말이 없으면 기다리기를 멈추고 안내, DB 연결이 끊겨도 서버가 죽지 않는다.
import { test, expect, api } from '../../lib/fixtures.js'
import http from 'node:http'
import { LOCAL_API } from '../../lib/env.js'

test('F-RS-01 답 스트림이 done 없이 끊기면 "생각하는 중"을 거두고 메시지를 다시 읽는다', async ({ pageAs, db }) => {
  const page = await pageAs('rs-user')
  const th = await db.clearMain(page.user.id)
  let reloads = 0
  await page.route('**/api/threads/*/messages', async (route) => {
    if (route.request().method() === 'GET') { reloads++; return route.continue() }
    // a proxy cut the long request after the first bytes
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: delta\ndata: {"d":"잠시만"}\n\n' })
  })
  await page.goto('/chat')
  await expect.poll(() => reloads).toBeGreaterThan(0)
  const before = reloads
  await page.locator('.composer textarea').first().fill('끊김 시험')
  await page.keyboard.press('Enter')
  await expect.poll(() => reloads, { timeout: 10_000 }).toBeGreaterThan(before)
  await expect(page.locator('.foot .working')).toHaveCount(0, { timeout: 10_000 })
  expect(th).toBeTruthy()
})

test('F-RS-02 SSE 가 hello 를 못 받으면 /api/events/poll 롱폴링으로 바꾼다', async ({ pageAs }) => {
  const page = await pageAs('rs-user')
  let polls = 0
  // a proxy that holds the event stream back (Cloudflare quick tunnels): never answer
  await page.route(/\/api\/events\?/, () => {})
  page.on('request', (r) => { if (r.url().includes('/api/events/poll')) polls++ })
  await page.goto('/chat')
  await expect.poll(() => polls, { timeout: 15_000 }).toBeGreaterThan(0)
})

test('F-RS-03 에이전트가 PRO_STREAM_IDLE_MS 동안 말이 없으면 기다리기를 멈추고 안내한다', async ({ as, lib, db }) => {
  test.setTimeout(60_000)
  // a deepagents stand-in that accepts the request and then stays silent
  const held = []
  const stub = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': hi\n\n'); held.push(res) })
  await new Promise((r) => stub.listen(0, '127.0.0.1', r))
  // the server's own delegate(), in this process: a fresh agent.js reads PRO_STREAM_IDLE_MS at load;
  // config.js is shared with modules already loaded in this worker, so point it at the stand-in
  const { config } = await lib('config.js')
  const saved = { deepagentsUrl: config.deepagentsUrl, contextRouterUrl: config.contextRouterUrl }
  const prevIdle = process.env.PRO_STREAM_IDLE_MS
  process.env.PRO_STREAM_IDLE_MS = '1500'
  Object.assign(config, { deepagentsUrl: `http://127.0.0.1:${stub.address().port}`, contextRouterUrl: '' })
  try {
    const u = await as('rs-user')
    const th = await db.clearMain(u.id)
    const { delegate } = await lib(`lib/agent.js?idle=${Date.now()}`)
    const t0 = Date.now()
    const msg = await delegate({ user: { id: u.id, email: u.email, name: 'rt' }, session: { access_token: u.token() }, threadId: th, text: '대답하지 않는 에이전트', silent: true })
    expect(Date.now() - t0).toBeLessThan(20_000)
    expect(msg.content.text).toContain('에이전트가 한동안 응답하지 않아')
    const [t] = await db.q('select status from pro_threads where id=$1', [th])
    expect(t.status).toBeNull()
  } finally {
    Object.assign(config, saved)
    if (prevIdle === undefined) delete process.env.PRO_STREAM_IDLE_MS; else process.env.PRO_STREAM_IDLE_MS = prevIdle
    for (const r of held) r.destroy()
    stub.close()
  }
})

test('F-RS-04 DB 가 쉬는 연결을 끊어도(재시작·유휴 정리) 서버 풀은 죽지 않고 다음 질의에 답한다', async ({ lib, db }) => {
  // the server's own pool module, in this process: without its 'error' handler an idle client that
  // the database drops raises an unhandled 'error' event and takes the whole process down
  const { pool, q } = await lib('lib/supa.js')
  expect(pool.listenerCount('error')).toBeGreaterThan(0)
  const c = await pool.connect()
  const [{ p }] = (await c.query('select pg_backend_pid() as p')).rows
  c.release() // idle in the pool now
  const [{ ok }] = await db.q('select pg_terminate_backend($1) as ok', [p])
  expect(ok).toBe(true)
  await new Promise((r) => setTimeout(r, 1000))
  expect((await q('select 1 as one'))[0].one).toBe(1)
  // and the running BFF answers too
  if (LOCAL_API) expect((await api.call(null, 'GET', '/config')).status).toBe(200)
})
