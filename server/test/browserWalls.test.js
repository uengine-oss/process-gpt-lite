// 브라우저 에이전트가 혼자 넘을 수 없는 화면(로그인 벽 · 구글의 로그인 거절 · 로봇 확인)을 규칙으로 알아보고,
// 카드에 무엇을 하면 이어지는지 쓰기 위한 조각들, 프로필 자리와 남은 잠금 파일 — 브라우저·모델 없이.
//   cd server && node --test test/browserWalls.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { wallOf, siteName, guideFor } from '../lib/browserGuides.js'
import { profilesDir, clearStaleLocks, actionLine, mediaType, STUCK_TURNS } from '../lib/browser.js'

// notebook.google.com 을 로그인 없이 열면 보이는 첫 화면(2026-11-21 실제 화면에서 옮김)
const NB_FRONT = {
  url: 'https://notebook.google.com/trynow', title: 'Gemini Notebook',
  text: 'notebook.google.com 은(는) 쿠키를 사용합니다.\n동의함\n나중에\n로그인\n무엇이든\n이해할 수 있습니다\nGemini Notebook에 로그인\n파일을\n슬라이드 자료\n로 바꾸기',
  els: [{ text: '자세히 알아보세요' }, { text: '동의함' }, { text: '나중에' }, { text: 'Gemini Notebook 홈' }, { text: '로그인' }, { text: 'Gemini Notebook에 로그인' }, { text: '쿠키 관리' }],
}

test('NotebookLM 첫 화면(로그인 단추만 있는 화면)은 로그인 벽', () => {
  assert.deepEqual(wallOf(NB_FRONT), { need: 'login', site: 'notebook.google.com', google: true })
  assert.equal(wallOf({ ...NB_FRONT, url: 'https://notebook.google.com/' }).need, 'login', '주소가 / 여도 로그인 단추만 있으면 벽')
  assert.equal(wallOf({ ...NB_FRONT, url: 'https://notebooklm.google.com/' }).need, 'login')
})

test('로그인한 NotebookLM 화면은 벽이 아니다', () => {
  assert.equal(wallOf({ url: 'https://notebook.google.com/', title: 'Gemini Notebook', text: '최근 노트북', els: [{ text: '새 노트북' }, { text: 'Google 계정: 홍길동' }] }), null)
  assert.equal(wallOf({ url: 'https://notebook.google.com/notebook/abc', text: '', els: [{ text: '소스 추가' }, { text: '로그인' }] }), null, '앱 단추가 있으면 벽이 아님')
})

test('accounts.google.com 은 로그인, 구글이 거절한 화면은 blocked', () => {
  assert.equal(wallOf({ url: 'https://accounts.google.com/v3/signin/identifier?continue=x', text: '로그인\nGoogle 계정 사용' }).need, 'login')
  for (const text of ['로그인할 수 없음\n이 브라우저 또는 앱은 안전하지 않을 수 있습니다. 자세히 알아보기', "Couldn't sign you in\nThis browser or app may not be secure. Try using a different browser."]) {
    assert.deepEqual(wallOf({ url: 'https://accounts.google.com/v3/signin/challenge/x', text }), { need: 'blocked', site: 'accounts.google.com', google: true }, text)
  }
  assert.equal(wallOf({ url: 'https://accounts.google.com/v3/signin/rejected?x=1', text: '' }).need, 'blocked', '주소만으로도')
  assert.equal(wallOf({ url: 'https://www.google.com/search?q=This+browser+or+app+may+not+be+secure', text: 'This browser or app may not be secure 해결 방법' }), null, '검색 결과의 같은 문구는 벽이 아님')
})

test('로봇 확인 화면', () => {
  assert.equal(wallOf({ url: 'https://www.google.com/sorry/index?continue=x', text: 'Our systems have detected unusual traffic from your computer network.' }).need, 'captcha')
  assert.equal(wallOf({ url: 'https://shop.example/', text: '잠시만요. 사람인지 확인하는 중입니다' }).need, 'captcha')
})

test('다른 사이트는 로그인을 요구할 때만(로그인 칸이 있거나 읽을 것이 거의 없을 때) 벽', () => {
  assert.deepEqual(wallOf({ url: 'https://members.example/a', text: '회원 전용\n로그인이 필요합니다.', els: [{ text: '로그인' }] }), { need: 'login', site: 'members.example', generic: true })
  assert.equal(wallOf({ url: 'https://shop.example/login', text: `${'긴 본문 '.repeat(100)} 로그인해 주세요`, els: [{ text: '', type: 'password', secret: true }] }).need, 'login')
  assert.equal(wallOf({ url: 'https://news.example/', text: `${'기사 본문 '.repeat(100)}\n로그인하세요`, els: [{ text: '로그인' }] }), null, '읽을 본문이 있는 페이지의 로그인 링크는 벽이 아님')
  assert.equal(wallOf({ url: 'http://127.0.0.1:5000/login', text: '테스트 상점 로그인\n이메일\n비밀번호', els: [{ text: '', type: 'password', secret: true }] }), null, '로그인 칸만 있고 요구하는 말이 없으면 모델이 보관함으로 채운다')
  assert.equal(wallOf({ url: 'about:blank', text: '', els: [] }), null)
})

test('카드에 쓰는 사이트 이름', () => {
  assert.equal(siteName('notebook.google.com'), 'NotebookLM')
  assert.equal(siteName('accounts.google.com', '노트북 lm으로 슬라이드 만들어 줘'), 'NotebookLM')
  assert.equal(siteName('accounts.google.com', '메일 정리'), 'accounts.google.com')
  assert.equal(siteName('www.example.com'), 'example.com')
})

test('NotebookLM 안내는 로그인 단추를 누르지 말라고 한다', () => {
  const g = guideFor('노트북엘엠으로 슬라이드', '')
  assert.match(g, /never type a Google password/)
  assert.match(g, /do not press those sign-in buttons/)
})

test('누르는 중·입력 중 문구는 요소 이름으로, 값은 넣지 않는다', () => {
  assert.equal(actionLine('click', { name: '새 노트북' }, 'notebook.google.com'), '「새 노트북」 누르는 중')
  assert.equal(actionLine('click', {}, 'notebook.google.com'), 'notebook.google.com에서 누르는 중')
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
