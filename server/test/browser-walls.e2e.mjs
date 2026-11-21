// 브라우저 에이전트가 멈출 때 사람이 할 일을 알려 주는지, 무엇을 누르는지 보여 주는지(녹화 회차 2026-11-21).
// 실제 Chromium · 실제 DB · 대본대로 움직이는 모델 · 시험 사이트(fixtures/walls.mjs). 구글 주소는 브라우저 안에서 가짜로 답한다.
//   - 프로필은 PRO_BROWSER_PROFILES 에, 바뀐 파드가 남긴 잠금 파일을 지우고 뜬다
//   - NotebookLM 첫 화면 = 로그인 벽: 모델 턴 없이 카드에 need 'login' + 할 일. 직접 제어로 로그인하면 저절로 이어진다
//   - 구글이 로그인을 거절하면 need 'blocked' 로 실패하고 다른 방법을 알린다
//   - 다른 사이트의 로그인 요구, 새 탭(옮겨 가서 일하고 닫히면 돌아옴), 누르는 자리(browser.click), 문구에 입력값 없음,
//     받은 파일은 열리는 형식의 링크, 같은 화면에서 헛돌면 need 'stuck'
//   node test/browser-walls.e2e.mjs
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { startWalls, routeGoogle, SPOTS } from './fixtures/walls.mjs'

// ---- 대본 모델: 계획, 그리고 목표마다 차례대로 한 수 ----
const scripts = {}
const llm = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    let message
    if (body.response_format) message = { role: 'assistant', content: JSON.stringify({ title: '시험 작업', steps: ['열기', '하기', '끝내기'] }) }
    else {
      const goal = /Goal: (.*)/.exec(body.messages[0].content)?.[1] || ''
      const s = scripts[goal]
      const move = s.moves[Math.min(s.i++, s.moves.length - 1)]
      const [name, args] = typeof move === 'function' ? move(body) : move
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'call_' + crypto.randomUUID().slice(0, 8), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message }] }))
  })
})
await new Promise((r) => llm.listen(0, '127.0.0.1', r))

const user = crypto.randomUUID()
// 운영처럼: 판정 서버 없음, 프로필은 정한 폴더에. 옛 파드가 남긴 잠금 파일을 미리 심어 둔다.
const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-profiles-'))
const mine = path.join(profiles, user)
fs.mkdirSync(mine, { recursive: true })
fs.symlinkSync('pgpt-lite-server-6d5f7c9b8-old-4321', path.join(mine, 'SingletonLock'))
fs.symlinkSync('/tmp/.org.chromium.Chromium.gone/SingletonSocket', path.join(mine, 'SingletonSocket'))
fs.symlinkSync('7700112233', path.join(mine, 'SingletonCookie'))
Object.assign(process.env, { PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test', PRO_CONTEXT_ROUTER_URL: '', PRO_BROWSER_PROFILES: profiles })

const browser = await import('../lib/browser.js')
const { subscribe } = await import('../lib/bus.js')
const { q, pool } = await import('../lib/supa.js')

const events = []
subscribe(user, { write: (line) => events.push({ type: /^event: (.*)$/m.exec(line)[1], data: JSON.parse(/^data: (.*)$/m.exec(line)[1]) }) })
const of = (type) => events.filter((e) => e.type === type).map((e) => e.data)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`); await sleep(100) } }
const card = async (goal) => (await q(`select id, content from pro_messages where thread_id=$1 and kind='task' and content->>'goal'=$2 order by created_at desc limit 1`, [threadId, goal]))[0]
const pick = (body, text) => {
  const last = [...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{'))
  const el = JSON.parse(last.content.split('\n')[0]).els.find((e) => e.text === text)
  if (!el) throw new Error(`no element "${text}"`)
  return el.i
}
const pageUrl = (body) => JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content.split('\n')[0]).url
// 사람이 라이브 화면을 누른다(직접 제어): 좌표는 화면의 0..1
const press = (spot) => browser.input(user, { type: 'click', x: spot.x / 1280, y: spot.y / 800 })
const near = (a, b) => Math.abs(a - b) <= 3

let site, threadId, google
const run = (goal, moves, startUrl) => { scripts[goal] = { i: 0, moves }; return browser.runBrowserTask({ userId: user, threadId, goal, startUrl }) }

before(async () => {
  browser.WAIT.watchMs = 300
  site = await startWalls()
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','browser walls e2e') returning id`, [user])
})
after(async () => {
  await browser.close(user).catch(() => {})
  await site?.close()
  llm.close()
  await q('delete from pro_threads where user_id=$1', [user]).catch(() => {})
  await pool.end().catch(() => {})
  fs.rmSync(profiles, { recursive: true, force: true })
})

test('프로필은 PRO_BROWSER_PROFILES 에 두고, 옛 파드가 남긴 잠금 파일을 지운 뒤 실제로 뜬다', async () => {
  assert.equal(browser.PROFILES, path.resolve(profiles))
  const ctx = await browser.contextFor(user)
  assert.ok(ctx.pages().length >= 1, 'Chromium 이 떴다')
  const lock = (() => { try { return fs.readlinkSync(path.join(mine, 'SingletonLock')) } catch { return null } })()
  assert.notEqual(lock, 'pgpt-lite-server-6d5f7c9b8-old-4321', '옛 잠금이 남아 있다')
  for (const f of ['SingletonSocket', 'SingletonCookie']) {
    const v = (() => { try { return fs.readlinkSync(path.join(mine, f)) } catch { return null } })()
    assert.ok(!['/tmp/.org.chromium.Chromium.gone/SingletonSocket', '7700112233'].includes(v), `${f} 가 남아 있다`)
  }
  google = { signedIn: false, refuse: false }
  await routeGoogle(ctx, google)
})

test('NotebookLM 첫 화면은 로그인 벽: 모델 턴 없이 카드에 할 일을 쓰고, 직접 로그인하면 저절로 이어진다', async () => {
  const goal = 'NotebookLM으로 이 링크의 슬라이드를 만들어 줘'
  const running = run(goal, [['note', { text: '노트북 목록이 보여요' }], ['finish', { summary: '로그인 뒤 노트북 목록을 확인했어요.' }]], 'https://notebook.google.com/')
  const waiting = await until(async () => { const c = await card(goal); return c?.content.state === 'needs_input' && c }, '로그인 기다림')
  assert.equal(waiting.content.need, 'login')
  assert.equal(waiting.content.siteName, 'NotebookLM', '카드 알약: 로그인 필요 · NotebookLM')
  assert.match(waiting.content.reason, /NotebookLM을 쓰려면 이 브라우저에서 구글 로그인이 한 번 필요해요/)
  assert.match(waiting.content.reason, /「직접 로그인」/)
  assert.match(waiting.content.reason, /다음에도 남아요/)
  assert.equal(scripts[goal].i, 0, '로그인 벽에서 모델을 부르지 않는다')
  // 사람이 직접 제어로: 「로그인」 → 구글 로그인 화면(아직 벽) → 「다음」 → 로그인된 NotebookLM
  await press(SPOTS.nbSignIn)
  await sleep(1200)
  assert.equal((await card(goal)).content.state, 'needs_input', '구글 로그인 화면에서는 계속 기다린다')
  await press(SPOTS.accountsNext)
  const r = await running
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.equal(scripts[goal].i, 2, '로그인 뒤에야 모델이 일한다')
  const done = (await card(goal)).content
  assert.equal(done.need, null)
  assert.equal(done.reason, '')
})

test('구글이 이 브라우저의 로그인을 거절하면 need blocked 로 끝내고, 할 수 있는 다른 방법을 말한다', async () => {
  google.signedIn = false
  google.refuse = true
  const goal = '노트북엘엠 사이트에 들어가서 슬라이드와 팟캐스트를 만들어 줘'
  const running = run(goal, [['finish', { summary: '돌면 안 됨' }]], 'https://notebook.google.com/')
  await until(async () => (await card(goal))?.content.need === 'login', '로그인 기다림')
  await press(SPOTS.nbSignIn)
  await sleep(800)
  await press(SPOTS.accountsNext)
  const r = await running
  assert.equal(r.state, 'failed')
  assert.equal(r.need, 'blocked')
  const c = (await card(goal)).content
  assert.equal(c.state, 'failed')
  assert.equal(c.need, 'blocked')
  assert.equal(c.siteName, 'NotebookLM')
  assert.match(c.reason, /구글이 이 서버 브라우저의 구글 로그인을 막았어요/)
  assert.match(c.reason, /NotebookLM에서 직접 만든 슬라이드·오디오 파일을 이 방에 올려 주면/)
  assert.equal(r.summary, c.reason, '채팅에 올라가는 요약도 같은 말')
  assert.equal(scripts[goal].i, 0, '모델 턴을 쓰지 않았다')
  google.refuse = false
})

test('다른 사이트가 로그인을 요구하면: 보관함 요청 카드와 함께 need login', async () => {
  const goal = '회원 전용 페이지 내용을 알려 줘'
  const running = run(goal, [['finish', { summary: '돌면 안 됨' }]], `${site.url}/members`)
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, '로그인 요청')
  assert.equal(c.content.need, 'login')
  assert.match(c.content.reason, /127\.0\.0\.1에 로그인해야 이어서 할 수 있어요/)
  assert.match(c.content.reason, /로그인 정보를 저장하거나/)
  const [vaultCard] = await q(`select content from pro_messages where thread_id=$1 and kind='vault' and content->>'taskId'=$2`, [threadId, c.id])
  assert.equal(vaultCard?.content.mode, 'request')
  assert.equal(scripts[goal].i, 0)
  assert.ok(browser.cancel(user, c.id))
  assert.equal((await running).state, 'cancelled')
})

test('새 탭이 열리면 그 탭에서 일하고 화면도 옮기며, 닫히면 돌아온다 · 누르는 자리와 요소 이름', async () => {
  const goal = '새 탭을 열었다 닫기'
  const seen = []
  events.length = 0
  const r = await run(goal, [
    (b) => ['click', { i: pick(b, '새 탭 열기') }],
    (b) => { seen.push(pageUrl(b)); return ['click', { i: pick(b, '창 닫기') }] },
    (b) => { seen.push(pageUrl(b)); return ['note', { text: '처음 화면으로 돌아옴' }] },
    ['finish', { summary: '새 탭을 열고 닫았어요.' }],
  ], `${site.url}/`)
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.equal(seen[0], `${site.url}/tab`, '새 탭에서 일한다')
  assert.equal(seen[1], `${site.url}/`, '닫히면 처음 탭으로')
  const [first] = of('browser.click')
  assert.ok(first && near(first.x, SPOTS.newTab.x) && near(first.y, SPOTS.newTab.y), JSON.stringify(first))
  assert.deepEqual([first.w, first.h, first.kind, first.taskId], [1280, 800, 'click', (await card(goal)).id])
  assert.ok(of('browser.frame').some((f) => f.url === `${site.url}/tab`), '라이브 화면이 새 탭으로 옮겨 갔다')
  const lines = of('status').map((s) => s.text)
  assert.ok(lines.includes('「새 탭 열기」 누르는 중') && lines.includes('「창 닫기」 누르는 중'), lines.join(' | '))
  assert.ok(lines.includes(`${new URL(site.url).hostname} 여는 중`))
  assert.ok(r.stats.turn_ms.length >= 4 && ['snap', 'shot', 'llm', 'act'].every((k) => typeof r.stats.avg_ms[k] === 'number'), '턴 시간을 잰다')
})

test('입력 중 문구는 칸 이름만, 입력한 값은 어디에도 없다', async () => {
  const goal = '검색 칸에 쓰기'
  const VALUE = `SECRET-WORD-${crypto.randomUUID().slice(0, 6)}`
  events.length = 0
  const r = await run(goal, [(b) => ['type', { i: pick(b, '검색어'), text: VALUE }], ['finish', { summary: '썼어요.' }]], `${site.url}/`)
  assert.equal(r.state, 'done')
  assert.ok(of('status').some((s) => s.text === '「검색」 칸에 입력 중'))
  const typed = of('browser.click').find((e) => e.kind === 'type')
  assert.ok(typed && near(typed.x, SPOTS.search.x) && near(typed.y, SPOTS.search.y), JSON.stringify(typed))
  assert.ok(!JSON.stringify(events.filter((e) => e.type !== 'browser.frame')).includes(VALUE), '입력값이 이벤트에 들어갔다')
  assert.match(r.summary, /'검색'에 입력/)
  assert.doesNotMatch(r.summary, new RegExp(VALUE))
})

test('받은 오디오는 파일 카드로 오고, 그 링크는 재생되는 형식으로 열린다', async () => {
  const goal = '오디오 받기'
  const r = await run(goal, [(b) => ['click', { i: pick(b, '오디오 받기') }], ['wait_for_page', { minutes: 0.05 }], ['finish', { summary: '받았어요.' }]], `${site.url}/`)
  assert.equal(r.state, 'done')
  const file = await until(async () => (await q(`select content from pro_messages where thread_id=$1 and kind='file' order by created_at desc limit 1`, [threadId]))[0]?.content, '파일 카드')
  assert.match(file.name, /\.mp3$/)
  assert.equal(file.type, 'audio/mpeg')
  assert.match(file.url, /^https?:\/\/.+\/storage\/v1\/object\/public\/files\//, '작업 폴더가 아닌 보관소 링크')
  const res = await fetch(file.url)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^audio\/mpeg/)
})

test('작업 폴더를 나눠 쓰지 않는 운영에서도(path 없이 보관소 사본만) 사람이 올린 파일을 사이트에 넣는다', async () => {
  const { saveAttachment } = await import('../lib/attachments.js')
  const { path: _local, ...stored } = await saveAttachment({ id: user }, '회의록.pdf', 'application/pdf', Buffer.from('%PDF-1.4 walls test'))
  assert.ok(stored.key && stored.url && !stored.path)
  scripts['파일 넣기'] = { i: 0, moves: [(b) => ['attach_file', { i: pick(b, '파일 올리기'), name: '회의록.pdf' }], ['wait_for_page', { minutes: 0.1, until_text: '소스 1개: 회의록.pdf' }], ['finish', { summary: '넣었어요.' }]] }
  const r = await browser.runBrowserTask({ userId: user, threadId, goal: '파일 넣기', startUrl: `${site.url}/`, files: [stored] })
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.ok(r.pageText.includes('소스 1개: 회의록.pdf'), '파일이 사이트에 들어가지 않았다')
})

test('같은 화면에서 아무것도 바뀌지 않으면 4번 넘게 헛돌지 않고 사람에게 넘긴다(need stuck)', async () => {
  const goal = '아무 일 없는 단추 누르기'
  const running = run(goal, [(b) => ['click', { i: pick(b, '아무 일 없음') }]], `${site.url}/`)
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, 'stuck', 30000)
  assert.equal(c.content.need, 'stuck')
  assert.match(c.content.reason, /같은 화면에서 5번 해 봤지만 화면이 바뀌지 않아 멈췄어요/)
  assert.match(c.content.reason, /'아무 일 없음' 누르기/)
  assert.match(c.content.reason, /「직접 제어」/)
  assert.equal(scripts[goal].i, browser.STUCK_TURNS, `모델 턴 ${browser.STUCK_TURNS}번에서 멈춘다(최대 40번까지 헛돌지 않음)`)
  assert.ok(browser.cancel(user, c.id))
  assert.equal((await running).state, 'cancelled')
})
