// 브라우저 에이전트가 혼자 넘을 수 없는 화면(로그인 벽 · 사이트의 거절 · 사람 확인)은 문구 규칙이 아니라 판정(lib/judge.js)으로,
// 사이트 지식은 브라우저 스킬(이름·설명만 먼저)로 — 그 조각들과 프로필 자리 · 남은 잠금 파일. 브라우저·모델 없이(가짜 판정 서버).
//   cd server && node --test test/browserWalls.test.js
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
// (this test's made-up sites run on this machine: the server's browser may open them — lib/privateNet.js)
process.env.PRO_BROWSER_PRIVATE_ALLOW ??= '127.0.0.1,localhost,*.localhost'

// ---- 가짜 판정 서버: 상태 글의 제목 줄로 확률을 돌려준다. 모델(LLM)로 넘어가지 않게 PRO_JUDGE_LLM=0 ----
const answers = {} // page title → probabilities, or 'down'
const asked = []
const judgeServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    const body = JSON.parse(raw)
    asked.push(body)
    const title = /^Page title: (.*)$/m.exec(body.state)?.[1]
    const a = answers[title]
    if (a === 'down') { res.writeHead(500); return res.end('{}') }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ probabilities: a || { login_needed: 0.1, refused: 0.05, human_check: 0.05, ok: 0.8 }, model: 'fake-judge', ms: 1 }))
  })
})
await new Promise((r) => judgeServer.listen(0, '127.0.0.1', r))
const skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-bskills-'))
fs.mkdirSync(path.join(skillsDir, 'unit-studio'))
fs.writeFileSync(path.join(skillsDir, 'unit-studio', 'SKILL.md'), `---
name: unit-studio
description: 시험용 스튜디오 사이트에서 보고서를 만든다.
metadata:
  runs_in: browser
  start_url: https://studio.example/
---

# 본문-표식-UNIT
「생성」을 누른다.
`)
Object.assign(process.env, { PRO_JUDGE_URL: `http://127.0.0.1:${judgeServer.address().port}/judge`, PRO_JUDGE_LLM: '0', PRO_BROWSER_SKILLS_DIR: skillsDir })

const { profilesDir, clearStaleLocks, actionLine, mediaType, STUCK_TURNS, judgeWall, wallState, pageName, skillNote, WALL_BAR, CONNECT_NEED } = await import('../lib/browser.js')
const { browserSkill } = await import('../lib/browserSkills.js')
after(() => { judgeServer.close(); fs.rmSync(skillsDir, { recursive: true, force: true }) })

const page = (title, extra = {}) => ({ url: 'https://app.example/start', title, text: '내용', els: [], fields: { password: false, signIn: false }, ...extra })

test('판정이 0.7 이상일 때만 벽: 로그인 필요 → login, 거절 → blocked, 사람 확인 → captcha', async () => {
  answers['로그인 앞'] = { login_needed: 0.91, refused: 0.03, human_check: 0.02, ok: 0.04 }
  answers['거절'] = { login_needed: 0.1, refused: 0.86, human_check: 0.02, ok: 0.02 }
  answers['확인'] = { login_needed: 0.05, refused: 0.02, human_check: 0.9, ok: 0.03 }
  answers['애매'] = { login_needed: 0.62, refused: 0.03, human_check: 0.05, ok: 0.3 }
  assert.deepEqual(await judgeWall(page('로그인 앞', { site: 'App Example' })), { need: 'login', site: 'app.example', name: 'App Example', key: 'login_needed', p: 0.91 })
  assert.equal((await judgeWall(page('거절'))).need, 'blocked')
  assert.equal((await judgeWall(page('확인'))).need, 'captcha')
  assert.equal(await judgeWall(page('애매')), null, `${WALL_BAR} 미만은 벽으로 보지 않는다(에이전트가 평소대로)`)
  assert.equal(await judgeWall(page('보통 페이지')), null, 'ok')
  assert.equal(WALL_BAR, 0.7)
})

test('사이트 오류 화면(site_error): 보통 작업은 벽이 아니고(에이전트가 다른 길로), Google 연결에서는 거절과 같다', async () => {
  answers['오류'] = { login_needed: 0.04, refused: 0.05, human_check: 0.01, site_error: 0.87, ok: 0.03 }
  assert.equal(await judgeWall(page('오류')), null)
  assert.deepEqual(await judgeWall(page('오류'), null, CONNECT_NEED), { need: 'blocked', site: 'app.example', name: '오류', key: 'site_error', p: 0.87 })
  // 선택지에 오류 화면이 있다(판정이 고를 수 있게)
  const before = asked.length
  await judgeWall(page('보통 페이지'))
  assert.ok(asked.slice(before)[0].options.some((o) => o.key === 'site_error'))
})

test('판정에 묻는 것: 제목 · 호스트 · 비밀번호/로그인 칸(구조) · 단추 이름 · 보이는 글 앞부분 — 칸에 친 값은 없다', async () => {
  const n = asked.length
  await judgeWall(page('상태', {
    text: `첫 줄\n\n\n둘째 줄 ${'긴 글 '.repeat(400)}`,
    fields: { password: true, signIn: true },
    els: [{ tag: 'button', text: '다음' }, { tag: 'a', text: '도움말' }, { tag: 'input', type: 'email', text: 'typed-value@example.com' }, { tag: 'input', type: 'submit', text: '보내기' }],
  }))
  const { state, question, options } = asked[n]
  assert.match(state, /^Page title: 상태$/m)
  assert.match(state, /^Site address: app\.example$/m)
  assert.match(state, /^Has a password field: yes$/m)
  assert.match(state, /^Has a sign-in field \(e-mail or username\): yes$/m)
  assert.match(state, /^Buttons and links: 다음 \| 도움말 \| 보내기$/m)
  assert.ok(!state.includes('typed-value@example.com'), '칸의 값은 판정에 보내지 않는다')
  assert.ok(state.length < 1400, '보이는 글은 앞부분만')
  assert.ok(question.length > 0)
  assert.deepEqual(options.map((o) => o.key), ['login_needed', 'refused', 'human_check', 'site_error', 'ok'])
  assert.equal(wallState(page('x')).includes('Has a password field: no'), true)
})

test('http(s) 가 아닌 화면은 묻지 않는다', async () => {
  const n = asked.length
  assert.equal(await judgeWall({ url: 'about:blank', title: '', text: '', els: [] }), null)
  assert.equal(asked.length, n)
})

test('카드에 쓰는 사이트 이름은 페이지 자신에게서: og:site_name / application-name → 제목 → 호스트', () => {
  assert.equal(pageName({ url: 'https://www.a.example/x', site: 'A 스튜디오', title: '첫 화면 - A' }), 'A 스튜디오')
  assert.equal(pageName({ url: 'https://www.a.example/x', site: '', title: '  첫 화면\n- A  ' }), '첫 화면 - A')
  assert.equal(pageName({ url: 'https://www.a.example/x', site: '', title: '' }), 'a.example')
  assert.equal(pageName({ url: 'https://a.example/', title: '가'.repeat(60) }).length, 40)
})

test('브라우저 스킬: 맡은 스킬이 있으면 이름·설명과 read_skill 만, 없으면 목록(이름·설명)만 — 본문은 넣지 않는다', () => {
  const sk = browserSkill('unit-studio')
  assert.equal(sk.startUrl, 'https://studio.example/')
  const one = skillNote(sk)
  assert.match(one, /unit-studio — 시험용 스튜디오 사이트에서 보고서를 만든다\./)
  assert.match(one, /read_skill\("unit-studio"\)/)
  assert.doesNotMatch(one, /본문-표식-UNIT/)
  const all = skillNote(null)
  assert.match(all, /- unit-studio: 시험용 스튜디오 사이트에서 보고서를 만든다\. \(start: https:\/\/studio\.example\/\)/)
  assert.match(all, /read_skill\(name\)/)
  assert.doesNotMatch(all, /본문-표식-UNIT/)
})

test('누르는 중·입력 중 문구는 요소 이름으로, 값은 넣지 않는다', () => {
  assert.equal(actionLine('click', { name: '새 노트북' }, 'app.example'), '「새 노트북」 누르는 중')
  assert.equal(actionLine('click', {}, 'app.example'), 'app.example에서 누르는 중')
  assert.equal(actionLine('type', { name: '검색', field: true }), '「검색」 칸에 입력 중')
  assert.equal(actionLine('type', { name: '비밀번호', secret: 'password' }), '비밀번호 칸에 입력 중')
  assert.equal(actionLine('type', { name: '', secret: 'card' }), '카드 번호 칸에 입력 중')
  assert.equal(actionLine('type', {}, 'a.example'), 'a.example에서 입력 중')
})

test('같은 화면에서 4번 넘게 헛돌면 사람에게 넘긴다', () => {
  assert.equal(STUCK_TURNS, 5)
})

test('받은 파일은 열리는 형식으로 보관한다(오디오는 재생, PDF 는 보기), 마크업은 받기만', () => {
  assert.equal(mediaType('Code Mode 팟캐스트.mp3'), 'audio/mpeg')
  assert.equal(mediaType('slides.PDF'), 'application/pdf')
  assert.equal(mediaType('deck.pptx'), 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
  assert.equal(mediaType('page.html'), '')
  assert.equal(mediaType('image.svg'), '')
})

test('프로필 자리: PRO_BROWSER_PROFILES > 쓸 수 있는 /data > server/.browser-profiles', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-prof-'))
  try {
    assert.equal(profilesDir({ PRO_BROWSER_PROFILES: path.join(tmp, 'p') }, tmp), path.join(tmp, 'p'))
    assert.equal(profilesDir({}, tmp), path.join(tmp, 'browser-profiles'), '쓸 수 있는 데이터 볼륨')
    assert.match(profilesDir({}, path.join(tmp, 'none')), /server[/\\]\.browser-profiles$/, '데이터 볼륨이 없으면 서버 옆')
    const ro = path.join(tmp, 'ro')
    fs.mkdirSync(ro, { mode: 0o500 })
    if (process.getuid?.() !== 0) assert.match(profilesDir({}, ro), /\.browser-profiles$/, '쓸 수 없는 /data 는 쓰지 않는다')
    fs.chmodSync(ro, 0o700)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('다른 호스트(바뀐 파드)가 남긴 잠금 파일은 지우고, 이 기계에서 살아 있는 크로미움의 것은 둔다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-lock-'))
  const plant = (holder) => {
    // rmSync({ force }) leaves a dangling link in place: unlink it
    for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* not there */ } }
    fs.symlinkSync(holder, path.join(dir, 'SingletonLock'))
    fs.symlinkSync('/tmp/.org.chromium.Chromium.gone/SingletonSocket', path.join(dir, 'SingletonSocket'))
    fs.symlinkSync('1234567890', path.join(dir, 'SingletonCookie'))
  }
  const links = () => fs.readdirSync(dir).filter((f) => f.startsWith('Singleton')).sort()
  try {
    plant('pgpt-lite-server-6d5f7c9b8-x2x4q-4321')
    assert.deepEqual(clearStaleLocks(dir).sort(), ['SingletonCookie', 'SingletonLock', 'SingletonSocket'])
    assert.deepEqual(links(), [])
    plant(`${os.hostname()}-${process.pid}`)
    assert.deepEqual(clearStaleLocks(dir), [], '살아 있는 프로세스의 잠금')
    assert.equal(links().length, 3)
    plant(`${os.hostname()}-999999`)
    assert.equal(clearStaleLocks(dir).length, 3, '이 기계지만 끝난 프로세스의 잠금')
    assert.deepEqual(clearStaleLocks(dir), [], '없으면 할 일 없음')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// 마지막에: 판정 서버가 쓰러지면 1분 동안 다시 묻지 않으므로(lib/judge.js)
test('판정을 받지 못하면(서버 오류, 모델 판정 꺼짐) 벽으로 보지 않는다 — 에이전트가 평소대로 진행', async () => {
  answers['쓰러짐'] = 'down'
  assert.equal(await judgeWall(page('쓰러짐')), null)
  assert.equal(await judgeWall(page('로그인 앞')), null, '쓰러진 동안에는 묻지 않고 지나간다')
})
