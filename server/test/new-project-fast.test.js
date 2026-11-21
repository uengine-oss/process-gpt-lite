// 새 프로젝트(POST /api/threads)는 제목 짓는 모델을 기다리지 않는다 (녹화 2026-11-21: 「시작이 안되네요」 — 20초 동안
// 방이 없었다). 요청 첫 줄로 임시 제목을 단 방이 바로 오고, 모델 제목은 뒤에서 와서 방 제목을 바꾼다.
// 실제 서버(index.js)를 따로 띄워 HTTP 로 잰다. 모델은 5초 늦게 답하는 가짜. 데이터베이스가 없으면 건너뜀.
// 시험 계정은 데모 로그인(000000)으로 만들고 끝나면 지운다.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { q, pool, admin } = await import('../lib/supa.js')
const up = await q('select 1').then(() => true, () => false)
const here = path.dirname(fileURLToPath(import.meta.url))

const SLOW_MS = 5000
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    // a model that answers the request instead of naming it (frentis, 2026-11-21)
    const rambles = /긴 답/.test(JSON.parse(raw).messages.at(-1).content)
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: rambles ? '링크된 영상은 YouTube의 첫 영상인 **“Me at the zoo”**로 판단했습니다  \n\n자세히 보면…' : '"느린 모델 제목".' } }] }))
    }, rambles ? 200 : SLOW_MS)
  })
})
let server, api, tok, me
const EMAIL = `pro-nb1121-route-np${Date.now()}@uengine.org`
const call = (method, p, body) => fetch(`${api}${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json', 'X-PGL-Lang': 'ko' }, body: body && JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }))

before(async () => {
  if (!up) return
  await new Promise((r) => llm.listen(0, '127.0.0.1', r))
  const port = 18000 + Math.floor(Math.random() * 1000)
  api = `http://127.0.0.1:${port}/api`
  server = spawn(process.execPath, ['index.js'], {
    cwd: path.join(here, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PRO_PORT: String(port), PRO_BACKGROUND: '0', PRO_CONTEXT_ROUTER_URL: '', PRO_JUDGE_URL: '',
      PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test' },
  })
  let log = ''
  server.stdout.on('data', (d) => { log += d })
  server.stderr.on('data', (d) => { log += d })
  const end = Date.now() + 30000
  while (!(await fetch(`${api}/config`).then((r) => r.ok).catch(() => false))) {
    if (Date.now() > end || server.exitCode != null) throw new Error(`server did not start:\n${log.slice(-2000)}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  const login = await (await fetch(`${api}/auth/email/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, code: '000000' }) })).json()
  tok = login.session.access_token
  me = login.user.id
})
after(async () => {
  server?.kill()
  llm.close()
  if (me) {
    await q('delete from pro_threads where user_id=$1', [me])
    await q('delete from pro_team_members where user_id=$1', [me]).catch(() => {})
    await q('delete from pro_role_assignments where user_id=$1', [me]).catch(() => {})
    await q('delete from pro_profile where user_id=$1', [me]).catch(() => {})
    await q('delete from users where id=$1', [me]).catch(() => {})
    await admin.auth.admin.deleteUser(me).catch(() => {})
  }
  await pool.end()
})

test('새 프로젝트는 모델이 5초 걸려도 1초 안에 오고, 제목은 요청 첫 줄 → 모델 제목으로 바뀐다', { skip: !up }, async () => {
  const text = '이 방에서 내가 주는 url이 있으면 그거를 받아다가 노트북엘엠으로 슬라이드를 만들고 그 팟캐스트를 하나 만들어 주면 돼\n둘째 줄'
  const t0 = Date.now()
  const r = await call('POST', '/threads', { text })
  const ms = Date.now() - t0
  console.log(`POST /api/threads ${r.status} in ${ms} ms, title '${r.body?.title}'`)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(ms < 1000, `${ms} ms`)
  assert.equal(r.body.kind, 'project')
  assert.equal(r.body.title, '이 방에서 내가 주는 url이 있으면 그거를…')
  const titled = async () => (await call('GET', '/threads?kind=project')).body.find((x) => x.id === r.body.id)?.title
  const end = Date.now() + SLOW_MS + 5000
  let title
  while ((title = await titled()) !== '느린 모델 제목' && Date.now() < end) await new Promise((x) => setTimeout(x, 200))
  assert.equal(title, '느린 모델 제목')
})

test('링크뿐인 요청은 링크를 뺀 말로, 아무 말도 없으면 「새 프로젝트」로 임시 제목', { skip: !up }, async () => {
  const a = await call('POST', '/threads', { text: 'https://youtu.be/abc 영상 정리' })
  assert.equal(a.body.title, '영상 정리')
  const b = await call('POST', '/threads', { text: 'https://youtu.be/abc' })
  assert.equal(b.body.title, '새 프로젝트')
})

test('제목 대신 답을 늘어놓은 모델 말은 제목이 되지 않고 임시 제목이 남는다', { skip: !up }, async () => {
  const r = await call('POST', '/threads', { text: '긴 답 시험: 이 영상 정리' })
  assert.equal(r.body.title, '긴 답 시험: 이 영상 정리')
  await new Promise((x) => setTimeout(x, 1500))
  const now = (await call('GET', '/threads?kind=project')).body.find((x) => x.id === r.body.id)?.title
  assert.equal(now, '긴 답 시험: 이 영상 정리')
})
