// 브라우저 에이전트가 멈출 때 사람이 할 일을 알려 주는지, 무엇을 누르는지 보여 주는지(녹화 회차 2026-11-21, 2차 지시 반영).
// 실제 Chromium · 실제 DB · 대본대로 움직이는 모델 · 가짜 판정 서버(PRO_JUDGE_URL, 판정 모델 자리) · 시험 사이트(fixtures/walls.mjs).
// 벽은 문구·주소 규칙이 아니라 판정으로: 새 페이지마다 한 번 묻고 0.7 이상일 때만 멈춘다. 사이트 지식은 브라우저 스킬로.
//   - 프로필은 PRO_BROWSER_PROFILES 에, 바뀐 파드가 남긴 잠금 파일을 지우고 뜬다
//   - 로그인 필요(login_needed): 모델 턴 없이 카드에 need 'login' + 할 일, 이름은 페이지 자신의 것. 기다리는 동안 판정을 되풀이하지 않고,
//     화면이 바뀌면 한 번, 직접 제어를 돌려주면 한 번 다시 판정한다. 직접 로그인하면 저절로 이어진다
//   - 거절(refused) → need 'blocked' 로 실패하고 다른 방법을 알린다 · 사람 확인(human_check) → need 'captcha'
//   - 판정이 0.7 미만이거나 판정을 못 받으면 평소처럼 에이전트가 진행한다
//   - 브라우저 스킬: 맡은 스킬은 이름·설명만 먼저, 본문은 read_skill 로. 시작 주소는 스킬의 start_url
//   - 새 탭(옮겨 가서 일하고 닫히면 돌아옴), 누르는 자리(browser.click), 문구에 입력값 없음, 받은 파일은 열리는 형식의 링크,
//     같은 화면에서 헛돌면 need 'stuck'
//   node test/browser-walls.e2e.mjs
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { startWalls, routeApp, startJudge, dropFiles, SPOTS, TITLES } from './fixtures/walls.mjs'

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

// 판정 모델 자리: 제목 → 확률. 나머지 화면은 ok
const verdicts = {
  [TITLES.front]: { login_needed: 0.93, refused: 0.02, human_check: 0.02, ok: 0.03 },
  [TITLES.signIn]: { login_needed: 0.95, refused: 0.02, human_check: 0.01, ok: 0.02 },
  [TITLES.refused]: { login_needed: 0.1, refused: 0.85, human_check: 0.02, ok: 0.03 },
  [TITLES.check]: { login_needed: 0.03, refused: 0.02, human_check: 0.9, ok: 0.05 },
  [TITLES.members]: { login_needed: 0.55, refused: 0.05, human_check: 0.05, ok: 0.35 }, // 애매: 에이전트가 진행
}
const judgeSrv = await startJudge(verdicts)

const user = crypto.randomUUID()
// 운영처럼 프로필은 정한 폴더에. 옛 파드가 남긴 잠금 파일을 미리 심어 둔다.
const profiles = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-profiles-'))
const mine = path.join(profiles, user)
fs.mkdirSync(mine, { recursive: true })
fs.symlinkSync('pgpt-lite-server-6d5f7c9b8-old-4321', path.join(mine, 'SingletonLock'))
fs.symlinkSync('/tmp/.org.chromium.Chromium.gone/SingletonSocket', path.join(mine, 'SingletonSocket'))
fs.symlinkSync('7700112233', path.join(mine, 'SingletonCookie'))
// 시험용 브라우저 스킬(시작 주소는 시험 사이트가 뜬 뒤에 쓴다)
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-bskills-'))
const SKILL_BODY_MARK = '본문-표식-WALLS'
Object.assign(process.env, {
  PRO_LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}`, PRO_LLM_API_KEY: 'test', PRO_CONTEXT_ROUTER_URL: '', PRO_BROWSER_PROFILES: profiles,
  PRO_JUDGE_URL: judgeSrv.url, PRO_JUDGE_LLM: '0', PRO_BROWSER_SKILLS_DIR: skillsDir,
})

const browser = await import('../lib/browser.js')
const { subscribe } = await import('../lib/bus.js')
const { q, pool } = await import('../lib/supa.js')
const { _resetBrowserSkills, readBrowserSkill } = await import('../lib/browserSkills.js')

const events = []
subscribe(user, { write: (line) => events.push({ type: /^event: (.*)$/m.exec(line)[1], data: JSON.parse(/^data: (.*)$/m.exec(line)[1]) }) })
const of = (type) => events.filter((e) => e.type === type).map((e) => e.data)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, what, ms = 20000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`기다렸지만 안 됨: ${what}`); await sleep(100) } }
const card = async (goal) => (await q(`select id, content from pro_messages where thread_id=$1 and kind='task' and content->>'goal'=$2 order by created_at desc limit 1`, [threadId, goal]))[0]
const lastSnap = (body) => JSON.parse([...body.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('{')).content.split('\n')[0])
const pick = (body, text) => {
  const el = lastSnap(body).els.find((e) => e.text === text)
  if (!el) throw new Error(`no element "${text}"`)
  return el.i
}
const pageUrl = (body) => lastSnap(body).url
// 사람이 라이브 화면을 누른다(직접 제어): 좌표는 화면의 0..1
const press = (spot) => browser.input(user, { type: 'click', x: spot.x / 1280, y: spot.y / 800 })
const near = (a, b) => Math.abs(a - b) <= 3
const judged = (title) => judgeSrv.calls[title] || 0

let site, threadId, app
const run = (goal, moves, startUrl, extra = {}) => { scripts[goal] = { i: 0, moves }; return browser.runBrowserTask({ userId: user, threadId, goal, startUrl, ...extra }) }

before(async () => {
  browser.WAIT.watchMs = 300
  site = await startWalls()
  fs.mkdirSync(path.join(skillsDir, 'walls-studio'))
  fs.writeFileSync(path.join(skillsDir, 'walls-studio', 'SKILL.md'), `---\nname: walls-studio\ndescription: 시험 사이트에서 검색하고 메모한다.\nmetadata:\n  runs_in: browser\n  start_url: ${site.url}/\n---\n\n# ${SKILL_BODY_MARK}\n검색 칸에 쓰고 메모한다.\n`)
  // a site that signs people in elsewhere (as NotebookLM → Google): sign_in names that host
  fs.mkdirSync(path.join(skillsDir, 'walls-app'))
  fs.writeFileSync(path.join(skillsDir, 'walls-app', 'SKILL.md'), `---\nname: walls-app\ndescription: 스튜디오에서 최근 문서를 본다. 로그인은 아이디 서비스에서 한다.\nmetadata:\n  runs_in: browser\n  start_url: https://studio.example/\n  sign_in: id.example\n---\n\n# 스튜디오\n첫 화면의 「로그인」을 누르고 아이디 서비스에 저장된 로그인으로 들어간다.\n`)
  _resetBrowserSkills()
  ;[{ id: threadId }] = await q(`insert into pro_threads(user_id,kind,title) values ($1,'project','browser walls e2e') returning id`, [user])
})
after(async () => {
  await browser.close(user).catch(() => {})
  await site?.close()
  await judgeSrv.close()
  llm.close()
  await q('delete from pro_threads where user_id=$1', [user]).catch(() => {})
  await dropFiles(user)
  await pool.end().catch(() => {})
  fs.rmSync(profiles, { recursive: true, force: true })
  fs.rmSync(skillsDir, { recursive: true, force: true })
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
  app = { signedIn: false, refuse: false }
  await routeApp(ctx, app)
})

test('로그인 필요(판정): 모델 턴 없이 카드에 할 일을 쓰고, 기다리는 동안 판정을 되풀이하지 않으며, 직접 로그인하면 저절로 이어진다', async () => {
  const goal = '스튜디오에서 최근 문서를 확인해 줘'
  const running = run(goal, [['note', { text: '최근 문서 목록이 보여요' }], ['finish', { summary: '로그인 뒤 최근 문서를 확인했어요.' }]], 'https://studio.example/')
  const waiting = await until(async () => { const c = await card(goal); return c?.content.state === 'needs_input' && c }, '로그인 기다림')
  assert.equal(waiting.content.need, 'login')
  assert.equal(waiting.content.site, 'studio.example')
  assert.equal(waiting.content.siteName, '스튜디오', '카드 알약의 이름은 페이지 자신의 것(og:site_name)')
  assert.equal(waiting.content.reason, '이 브라우저에서 스튜디오에 한 번 로그인해야 이어서 할 수 있어요. 카드의 「직접 로그인」을 눌러 로그인하면 이어서 진행해요. 로그인은 다음에도 남아요.')
  assert.equal(scripts[goal].i, 0, '로그인 벽에서 모델을 부르지 않는다')
  assert.equal(judged(TITLES.front), 1, '첫 화면을 한 번 판정')
  await sleep(1500) // watch 를 다섯 번쯤 돈다: 화면이 그대로면 묻지 않는다
  assert.equal(judged(TITLES.front), 1, '기다리는 동안 판정을 되풀이하지 않는다')
  // 사람이 직접 제어로: 「로그인」 → 로그인 화면(아직 벽, 한 번 판정) → 「다음」 → 로그인된 앱(판정 ok → 이어짐)
  await press(SPOTS.appSignIn)
  await until(() => judged(TITLES.signIn) === 1, '로그인 화면 판정')
  await sleep(900)
  assert.equal((await card(goal)).content.state, 'needs_input', '로그인 화면에서는 계속 기다린다')
  assert.equal(judged(TITLES.signIn), 1, '바뀌지 않은 로그인 화면은 다시 묻지 않는다')
  await press(SPOTS.idNext)
  const r = await running
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.equal(scripts[goal].i, 2, '로그인 뒤에야 모델이 일한다')
  assert.equal(judged(TITLES.app), 1, '로그인한 화면을 한 번 판정(그 뒤 같은 화면은 다시 묻지 않음)')
  const done = (await card(goal)).content
  assert.equal(done.need, null)
  assert.equal(done.reason, '')
  assert.ok(r.stats.wall_checks.length >= 3 && r.stats.wall_checks.every((w) => w.via === 'server' && typeof w.ms === 'number'), JSON.stringify(r.stats.wall_checks))
  assert.equal(typeof r.stats.avg_ms.judge, 'number', '턴 시간에 판정 시간도 잰다')
})

test('직접 제어를 돌려주면 한 번 다시 판정하고, 여전히 로그인 화면이면 다시 기다린다', async () => {
  app.signedIn = false
  const goal = '스튜디오 문서 하나 열어 줘'
  const running = run(goal, [['finish', { summary: '돌면 안 됨' }]], 'https://studio.example/')
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, '로그인 기다림')
  const before = judged(TITLES.front)
  browser.resume(user, 'The user took over and finished the manual part. Re-check the page and continue.')
  await until(() => judged(TITLES.front) === before + 1, '돌려준 뒤 다시 판정')
  const again = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x.content.reason.startsWith('아직') && x }, '다시 기다림')
  assert.equal(again.content.reason, '아직 스튜디오 로그인이 끝나지 않았어요. 카드의 「직접 로그인」을 눌러 로그인을 마치면 이어서 진행해요.')
  assert.equal(scripts[goal].i, 0)
  assert.ok(browser.cancel(user, c.id))
  assert.equal((await running).state, 'cancelled')
})

test('로그인하던 중 사이트가 이 브라우저를 거절하면(판정 refused) need blocked 로 끝내고, 할 수 있는 다른 방법을 말한다', async () => {
  app.signedIn = false
  app.refuse = true
  const goal = '스튜디오에 들어가서 보고서를 만들어 줘'
  const running = run(goal, [['finish', { summary: '돌면 안 됨' }]], 'https://studio.example/')
  await until(async () => (await card(goal))?.content.need === 'login', '로그인 기다림')
  await press(SPOTS.appSignIn)
  await until(() => judged(TITLES.signIn) >= 2, '로그인 화면')
  await press(SPOTS.idNext)
  const r = await running
  assert.equal(r.state, 'failed')
  assert.equal(r.need, 'blocked')
  const c = (await card(goal)).content
  assert.equal(c.state, 'failed')
  assert.equal(c.need, 'blocked')
  assert.equal(c.site, 'id.example')
  assert.equal(c.siteName, '스튜디오', '거절은 로그인 서비스 화면에서 났어도 카드는 이 작업의 사이트 이름')
  assert.equal(c.reason, '스튜디오 쪽에서 이 서버 브라우저의 로그인을 받아 주지 않아요. 그래서 이 브라우저로는 스튜디오 작업을 할 수 없어요. 그 사이트에서 직접 만든 결과 파일을 이 방에 올려 주면 이어서 할게요.')
  assert.equal(r.summary, c.reason, '채팅에 올라가는 요약도 같은 말')
  assert.equal(scripts[goal].i, 0, '모델 턴을 쓰지 않았다')
  app.refuse = false
})

test('사람 확인 화면(판정 human_check)은 need captcha, 이름은 제목에서', async () => {
  const goal = '확인 페이지 내용을 알려 줘'
  const running = run(goal, [['finish', { summary: '돌면 안 됨' }]], `${site.url}/check`)
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, '사람 확인')
  assert.equal(c.content.need, 'captcha')
  assert.equal(c.content.siteName, TITLES.check, 'og:site_name 이 없으면 제목')
  assert.equal(c.content.reason, `${TITLES.check}에서 사람인지 확인하는 화면이 나왔어요. 카드의 「직접 제어」로 확인을 마치면 이어서 진행해요.`)
  assert.equal(scripts[goal].i, 0)
  assert.ok(browser.cancel(user, c.id))
  assert.equal((await running).state, 'cancelled')
})

test('판정이 0.7 미만이면 벽으로 보지 않고 에이전트가 평소대로 진행한다', async () => {
  const goal = '회원 전용 페이지 제목을 알려 줘'
  const r = await run(goal, [['note', { text: '제목: 회원 전용' }], ['finish', { summary: '제목은 회원 전용이에요.' }]], `${site.url}/members`)
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.equal(scripts[goal].i, 2, '모델이 일했다')
  assert.equal(r.stats.walls, 0)
  assert.deepEqual(r.stats.wall_checks.map((w) => [w.key, w.p]), [['login_needed', 0.55]])
})

test('로그인을 다른 곳에서 받는 사이트(스킬 sign_in): 그 로그인이 보관함에 있으면 첫 화면에서 기다리지 않고 에이전트가 보관함으로 로그인한다', async () => {
  app.signedIn = false
  const vault = await import('../lib/vault.js')
  const item = await vault.putItem(user, 'login', 'id.example', { username: 'tester@id.example', password: 'pw-1' })
  const fills = async () => (await q(`select count(*)::int n from pro_vault_audit where user_id=$1 and item_id=$2 and action='fill'`, [user, item.id]))[0].n
  // the front page has no form: the model goes to the sign-in page; there the vault types the username itself (vault
  // first at a sign-in wall) and, as Enter does not send that page's form, the model is told to press its button
  let told = ''
  const SIGN_IN_MOVES = [
    (b) => ['click', { i: pick(b, '로그인') }],
    (b) => { told = b.messages.filter((m) => m.role === 'user' && typeof m.content === 'string').at(-1).content; return ['click', { i: pick(b, '다음') }] },
    ['note', { text: '최근 문서 목록이 보여요' }],
    ['finish', { summary: '보관함의 로그인으로 들어가 최근 문서를 확인했어요.' }],
  ]
  try {
    const goal = '스튜디오에 로그인해서 최근 문서를 봐 줘'
    const r = await run(goal, SIGN_IN_MOVES, undefined, { skill: 'walls-app' })
    assert.equal(r.state, 'done', JSON.stringify(r))
    assert.equal(r.stats.walls, 0, '첫 화면 · 로그인 화면 어디서도 사람을 기다리지 않았다')
    assert.ok(app.signedIn, '로그인됐다')
    assert.equal(await fills(), 1, '보관함에서 채웠다')
    assert.match(told, /\[vault: the saved login for id\.example is typed into the sign-in form \(you cannot see it\)\. Press the form's sign-in button now/)

    // 지난번에 거부된 비밀번호는 그대로 다시 넣지 않는다: 카드에서 고친 뒤에 넣는다
    app.signedIn = false
    await vault.setStatus(user, item.id, 'rejected')
    const goal2 = '스튜디오에 다시 로그인해서 최근 문서를 봐 줘'
    const running = run(goal2, SIGN_IN_MOVES, undefined, { skill: 'walls-app' })
    const ask = await until(async () => (await q(`select id, content from pro_messages where thread_id=$1 and kind='vault' and content->>'mode'='update' and content->>'state'='pending' order by created_at desc limit 1`, [threadId]))[0], '비밀번호 고침 요청')
    assert.equal(ask.content.itemId, item.id)
    assert.match((await card(goal2)).content.reason, /지난번에 저장된 비밀번호를 받아들이지 않았어요/)
    assert.equal(await fills(), 1, '고치기 전에는 넣지 않는다')
    await vault.updateItem(user, item.id, { username: 'tester@id.example', password: 'pw-2' })
    browser.resume(user, 'the user updated the saved login for id.example; use fill_secret again')
    const r2 = await running
    assert.equal(r2.state, 'done', JSON.stringify(r2))
    assert.equal(await fills(), 2, '고친 비밀번호로 채웠다')
  } finally {
    await vault.deleteItem(user, item.id).catch(() => {})
    await q(`delete from pro_messages where thread_id=$1 and kind='vault'`, [threadId]).catch(() => {})
  }
})

test('브라우저 스킬: 맡은 스킬은 이름·설명과 read_skill 만 먼저 보이고, 본문은 read_skill 이 돌려준다. 시작 주소는 스킬의 것', async () => {
  const goal = '시험 사이트에서 검색 칸을 찾아 메모해 줘'
  let toolOut = '', firstAsk = null
  const r = await run(goal, [
    (b) => { firstAsk = structuredClone(b.messages); return ['read_skill', { name: 'walls-studio' }] },
    (b) => { toolOut = b.messages.filter((m) => m.role === 'tool').at(-1).content; return ['note', { text: '검색 칸이 있어요' }] },
    ['finish', { summary: '검색 칸이 있어요.' }],
  ], undefined, { skill: 'walls-studio' })
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.doesNotMatch(firstAsk[0].content, new RegExp(SKILL_BODY_MARK), '스킬 본문이 시스템 프롬프트에 없다')
  assert.doesNotMatch(firstAsk[0].content, /walls-studio/, '스킬 이름도 시스템 프롬프트에는 없다')
  assert.equal(firstAsk[1].role, 'user')
  assert.match(firstAsk[1].content, /walls-studio — 시험 사이트에서 검색하고 메모한다\./)
  assert.match(firstAsk[1].content, /read_skill\("walls-studio"\)/)
  assert.doesNotMatch(firstAsk[1].content, new RegExp(SKILL_BODY_MARK), '첫 메시지에도 본문은 없다')
  assert.equal(toolOut, readBrowserSkill('walls-studio'))
  assert.match(toolOut, new RegExp(SKILL_BODY_MARK))
  assert.deepEqual(r.stats.skills_read, ['walls-studio'])
  assert.equal((await card(goal)).content.url, `${site.url}/`, '시작 주소가 없으면 스킬의 start_url')
  assert.ok(of('status').some((s) => s.text === 'walls-studio 스킬 읽는 중'))
})

test('맡은 스킬이 없으면 스킬 목록(이름·설명)만 보이고, 없는 이름은 목록과 함께 오류로 답한다', async () => {
  const goal = '스킬 없이 메모'
  let listed = '', out = ''
  const r = await run(goal, [
    (b) => { listed = b.messages[1].content; return ['read_skill', { name: 'no-such-skill' }] },
    (b) => { out = b.messages.filter((m) => m.role === 'tool').at(-1).content; return ['note', { text: '메모' }] },
    ['finish', { summary: '메모했어요.' }],
  ], `${site.url}/`)
  assert.equal(r.state, 'done')
  assert.match(listed, /- walls-studio: 시험 사이트에서 검색하고 메모한다\./)
  assert.match(listed, /read_skill\(name\)/)
  assert.doesNotMatch(listed, new RegExp(SKILL_BODY_MARK))
  assert.match(out, /^error: no browser skill named "no-such-skill"\. The skills are: .*walls-studio/)
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
  assert.ok(r.stats.turn_ms.length >= 4 && ['snap', 'judge', 'shot', 'llm', 'act'].every((k) => typeof r.stats.avg_ms[k] === 'number'), '턴 시간을 잰다')
})

test('입력 중 문구는 칸 이름만, 입력한 값은 어디에도 없다(판정에 보낸 글에도)', async () => {
  const goal = '검색 칸에 쓰기'
  const VALUE = `SECRET-WORD-${crypto.randomUUID().slice(0, 6)}`
  events.length = 0
  const r = await run(goal, [(b) => ['type', { i: pick(b, '검색어'), text: VALUE }], ['finish', { summary: '썼어요.' }]], `${site.url}/`)
  assert.equal(r.state, 'done')
  assert.ok(of('status').some((s) => s.text === '「검색」 칸에 입력 중'))
  const typed = of('browser.click').find((e) => e.kind === 'type')
  assert.ok(typed && near(typed.x, SPOTS.search.x) && near(typed.y, SPOTS.search.y), JSON.stringify(typed))
  assert.ok(!JSON.stringify(events.filter((e) => e.type !== 'browser.frame')).includes(VALUE), '입력값이 이벤트에 들어갔다')
  assert.ok(!judgeSrv.states.some((s) => s.includes(VALUE)), '입력값이 판정에 갔다')
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

test('이름 없이 받은 파일(NotebookLM 오디오 개요)은 내용으로 형식을 알아 이름 · 형식을 붙이고, 그 링크는 재생된다', async () => {
  const goal = '이름 없는 파일 받기'
  const r = await run(goal, [(b) => ['click', { i: pick(b, '이름 없는 파일 받기') }], ['wait_for_page', { minutes: 0.05 }], ['finish', { summary: '받았어요.' }]], `${site.url}/`)
  assert.equal(r.state, 'done')
  const file = await until(async () => (await q(`select content from pro_messages where thread_id=$1 and kind='file' and content->>'name' like 'download%' order by created_at desc limit 1`, [threadId]))[0]?.content, '파일 카드')
  assert.equal(file.name, 'download.m4a')
  assert.equal(file.type, 'audio/mp4')
  assert.match(file.url, /\.m4a$/, '보관소 키도 .m4a(예전엔 .bin)')
  const res = await fetch(file.url)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /^audio\/mp4/)
  assert.match(r.summary, /download\.m4a 받기/)
})

test('새 탭에서 받은 파일: 받기만 한 빈 탭은 닫고(크롬처럼) 원래 화면으로 돌아와, 끝난 카드에 마지막 화면이 남는다', async () => {
  const goal = '새 탭에서 받기'
  const seen = []
  const r = await run(goal, [
    (b) => ['click', { i: pick(b, '새 탭에서 받기') }],
    ['wait_for_page', { minutes: 0.05 }],
    (b) => { seen.push(pageUrl(b)); return ['finish', { summary: '받았어요.' }] },
  ], `${site.url}/`)
  assert.equal(r.state, 'done', JSON.stringify(r))
  const c = await card(goal)
  const file = (await q(`select content from pro_messages where thread_id=$1 and kind='file' and content->>'taskId'=$2`, [threadId, c.id]))[0]?.content
  assert.equal(file?.name, 'download.m4a', '새 탭에서 받은 파일도 채팅에 올라온다')
  assert.equal(seen[0], `${site.url}/`, '받기만 한 탭은 닫히고 처음 탭에서 이어서 한다')
  assert.equal(r.url, `${site.url}/`)
  assert.equal(c.content.url, `${site.url}/`, '카드 주소가 비지 않는다')
  assert.ok(c.content.shot, '끝난 카드에 마지막 화면이 있다(예전엔 빈 탭이라 null)')
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

test('모델이 사람에게 부탁할 때 무엇인지(need)는 모델이 말한다: 낱말로 짐작하지 않는다', async () => {
  const goal = '사람에게 부탁하기'
  const running = run(goal, [['need_user', { reason: '이 화면은 직접 봐 주세요', need: 'login' }], ['finish', { summary: '끝' }]], `${site.url}/`)
  const c = await until(async () => { const x = await card(goal); return x?.content.state === 'needs_input' && x }, '부탁')
  assert.equal(c.content.need, 'login', '이유 글에 「로그인」이 없어도 모델이 login 이라 했으면 login')
  assert.equal(c.content.siteName, TITLES.home)
  assert.ok(browser.cancel(user, c.id))
  await running
  const goal2 = '사람에게 그냥 부탁하기'
  const running2 = run(goal2, [['need_user', { reason: '로그인 버튼 옆의 그림을 확인해 주세요' }], ['finish', { summary: '끝' }]], `${site.url}/`)
  const c2 = await until(async () => { const x = await card(goal2); return x?.content.state === 'needs_input' && x }, '부탁')
  assert.equal(c2.content.need, 'other', '이유 글의 「로그인」 낱말로 login 을 짐작하지 않는다')
  assert.ok(browser.cancel(user, c2.id))
  await running2
})

// 마지막에: 판정 서버가 쓰러지면 1분 동안 다시 묻지 않으므로(lib/judge.js)
test('판정을 받지 못하면(판정 서버 오류, 모델 판정 꺼짐) 에이전트가 평소대로 진행한다', async () => {
  verdicts[TITLES.front] = 'down'
  app.signedIn = false
  const goal = '판정 없이 스튜디오 보기'
  const r = await run(goal, [['note', { text: '로그인 단추가 보여요' }], ['finish', { summary: '로그인 단추만 보여요.' }]], 'https://studio.example/')
  assert.equal(r.state, 'done', JSON.stringify(r))
  assert.equal(scripts[goal].i, 2, '모델이 일했다')
  assert.equal(r.stats.walls, 0)
})
