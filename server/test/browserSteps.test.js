// 서버 브라우저의 단계마다 한도(lib/browserSteps.js) — 2026-11-24 「브라우저가 먹통이 된」:
//   - 걸음마다 한도: 다 되면 멈추고 알린다, 취소·다시 시도는 그 자리에서 끝낸다
//   - 조용해지지 않는 페이지(networkidle·load 가 오지 않음)를 기다리지 않는다 — 문서까지 + 짧게
//   - 아주 큰 페이지도 정해진 시간·크기 안에서 읽는다, 화면에 있는 것과 입력 칸 먼저, 지난 번호는 남지 않는다
//   - 실시간 화면은 초당 장수가 정해져 있고, 느린 연결에는 쌓지 않는다
//   - 아무것도 움직이지 않으면 감시가 한 번 알리고, 움직이면 거둔다
//   - 멈춘 Chromium 이 남긴 프로필 잠금은 이 서버의 것일 때만 풀어 준다
// 진짜 Chromium(Playwright)과 이 폴더의 시험 사이트(fixtures/heavy.mjs)만 쓴다. 인터넷·모델·데이터베이스 없음.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { startHeavy, CAFES } from './fixtures/heavy.mjs'
import { STEP, StepError, bounded, pause, navigate, SNAPSHOT_JS, lookAll, watchdog, throttledScreencast, releaseProfile, lockHolder, browserPidFor } from '../lib/browserSteps.js'
import * as bus from '../lib/bus.js'

let site, browser, page
before(async () => {
  site = await startHeavy()
  browser = await chromium.launch({ headless: true })
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
})
after(async () => {
  await browser?.close()
  await site?.close()
})

test('한도 안에 끝나지 않으면 StepError(timeout) — 취소는 cancel, 다시 시도는 retry 로 곧바로 끝난다', async () => {
  const never = new Promise(() => {})
  let t = Date.now()
  await assert.rejects(bounded(never, 200, { label: 'model' }), (e) => e instanceof StepError && e.kind === 'timeout' && e.label === 'model')
  assert.ok(Date.now() - t < 1000)
  const c = new AbortController()
  t = Date.now()
  setTimeout(() => c.abort('cancel'), 50)
  await assert.rejects(bounded(never, Infinity, { signal: c.signal }), (e) => e.kind === 'cancel')
  assert.ok(Date.now() - t < 1000)
  const r = new AbortController()
  setTimeout(() => r.abort('retry'), 50)
  await assert.rejects(pause(60_000, r.signal), (e) => e.kind === 'retry')
  assert.equal(await bounded(Promise.resolve(7), 100), 7)
  await assert.rejects(bounded(() => { throw new Error('boom') }, 100), /boom/)
})

test('조용해지지 않는 페이지(load·networkidle 이 오지 않음): 문서가 오면 짧게만 기다리고 진행한다', async () => {
  const r = await navigate(page, `${site.url}/never-idle`, { timeoutMs: 8000, settleMs: 800 })
  assert.equal(r.ok, true)
  assert.equal(r.partial, false, '문서(DOMContentLoaded)는 왔다')
  assert.ok(r.ms < 3000, `load 를 기다리지 않아야 한다: ${r.ms}ms`)
  assert.equal(await page.title(), '끝나지 않는 페이지')
})

test('문서가 끝까지 오지 않는 페이지: 한도에서 멈추고(window.stop) 온 만큼 읽는다', async () => {
  const t = Date.now()
  const r = await navigate(page, `${site.url}/slow-doc`, { timeoutMs: 2000, settleMs: 500 })
  assert.equal(r.ok, true)
  assert.equal(r.partial, true)
  assert.ok(Date.now() - t < 4500, `${Date.now() - t}ms`)
  const snap = await page.evaluate(SNAPSHOT_JS, {})
  assert.match(snap.text, /반쯤 온 문서/)
})

test('응답이 오지 않는 주소: 한도에서 실패로 돌려준다(예외로 작업을 멈추지 않는다)', async () => {
  const t = Date.now()
  const r = await navigate(page, `${site.url}/slow?ms=20000`, { timeoutMs: 1500, settleMs: 300 })
  assert.equal(r.ok, false)
  assert.ok(r.error)
  assert.ok(Date.now() - t < 4000, `${Date.now() - t}ms`)
  // the navigation that never got its answer is stopped: the next one is not refused at once (net::ERR_ABORTED)
  const next = await navigate(page, `${site.url}/never-idle`, { timeoutMs: 5000, settleMs: 300 })
  assert.equal(next.ok, true, next.error)
})

test('이동 중 취소: 그 자리에서 끝난다', async () => {
  const c = new AbortController()
  const t = Date.now()
  setTimeout(() => c.abort('cancel'), 200)
  await assert.rejects(navigate(page, `${site.url}/slow?ms=20000`, { timeoutMs: 15000, signal: c.signal }), (e) => e.kind === 'cancel')
  assert.ok(Date.now() - t < 1500, `${Date.now() - t}ms`)
})

test('아주 큰 페이지(링크 3만 개): 정해진 시간·크기 안에 읽고, 입력 칸이 먼저 번호를 받는다', async () => {
  await navigate(page, `${site.url}/huge?n=30000`, { timeoutMs: 15000 })
  const total = await page.evaluate(() => document.querySelectorAll('*').length)
  assert.ok(total > 60000, `노드 ${total}`)
  const t = Date.now()
  const snap = await page.evaluate(SNAPSHOT_JS, { maxEls: 20, maxText: 3000, budgetMs: 1500 })
  const ms = Date.now() - t
  assert.ok(ms < 2500, `읽기 ${ms}ms`)
  assert.ok(snap.els.length <= 20)
  assert.ok(snap.text.length <= 3000)
  assert.ok(snap.more?.visible > 20, '더 있다고 말한다')
  assert.ok(snap.els.some((e) => e.tag === 'input' && e.text === '여행지 검색'), '입력 칸이 잘리지 않는다')
  // numbers carry no element of an older look: as many marked elements as numbered ones
  await page.evaluate(SNAPSHOT_JS, { maxEls: 20 })
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-pro-idx]').length), 20)
  // the text is what is on screen: after scrolling it is new text, not the top of the document again
  await page.mouse.wheel(0, 40_000)
  await page.waitForTimeout(300)
  const later = await page.evaluate(SNAPSHOT_JS, { maxEls: 20 })
  assert.notEqual(later.text.slice(0, 200), snap.text.slice(0, 200))
  assert.doesNotMatch(later.text.split('\n')[0], /링크 0\b/)
})

test('화면 안의 iframe(다른 출처)도 읽는다: 번호는 이어지고, 어느 프레임의 것인지 알며, 1×1 추적 프레임은 건너뛴다', async () => {
  await navigate(page, `${site.url}/framed`, { timeoutMs: 8000 })
  await page.waitForTimeout(300)
  const snap = await lookAll(page, { maxEls: 50 })
  for (const c of CAFES) assert.match(snap.text, new RegExp(c))
  assert.match(snap.text, /\[frame localhost:\d+\]/)
  assert.doesNotMatch(snap.text, /숨은 링크/)
  assert.deepEqual(snap.els.map((e) => e.i), snap.els.map((_, k) => k), '번호는 0부터 이어진다')
  const more = snap.els.find((e) => e.text === '더 보기')
  assert.ok(more && snap.frameOf.get(more.i), '프레임 안의 단추')
  assert.equal(JSON.parse(JSON.stringify(snap)).frameOf, undefined, '모델이 읽는 JSON 에는 없다')
  await snap.frameOf.get(more.i).locator(`[data-pro-idx="${more.i}"]`).click()
  assert.match((await lookAll(page)).text, /가상동 넷째 카페/)
})

test('감시: 아무것도 움직이지 않으면 한 번 알리고, 다음 걸음이 시작되면 거둔다 — 사람을 기다리는 동안은 알리지 않는다', () => {
  let now = 0
  const seen = []
  const dog = watchdog({ stallMs: 1000, every: 0, now: () => now, onStall: (x) => seen.push(['stall', x.what]), onResume: () => seen.push(['resume']) })
  dog.beat('model', 'AI 모델의 답')
  now = 900; dog.check()
  assert.deepEqual(seen, [])
  now = 1000; dog.check(); now = 5000; dog.check()
  assert.deepEqual(seen, [['stall', 'AI 모델의 답']], '한 번만')
  dog.beat('act', '동작')
  assert.deepEqual(seen.at(-1), ['resume'])
  // a wait that counts up says more about itself without starting the clock again
  dog.beat('wait', '「완료」 나오기')
  now = 5500; dog.label('「완료」 나오기 · 0:30'); now = 6000; dog.check()
  assert.deepEqual(seen.at(-1), ['stall', '「완료」 나오기 · 0:30'])
  dog.hold()
  assert.deepEqual(seen.at(-1), ['resume'])
  now = 60_000; dog.check()
  assert.equal(seen.filter((x) => x[0] === 'stall').length, 2, '사람을 기다리는 동안은 멈춤이 아니다')
  dog.go('read', '페이지 읽기')
  now = 60_500; dog.check()
  assert.equal(seen.filter((x) => x[0] === 'stall').length, 2)
  dog.stop()
})

test('실시간 화면: 초당 장수에 한도가 있고, 확인(ack)을 늦춰 Chromium 이 더 만들지 않게 한다', async () => {
  const cdp = new EventEmitter()
  const acks = []
  cdp.send = async (m, p) => { if (m === 'Page.screencastFrameAck') acks.push(p.sessionId) }
  const got = []
  throttledScreencast(cdp, { minMs: 200, onFrame: (f) => got.push([f.sessionId, Date.now()]) })
  // Chromium sends the next frame only after the last ack: frames as fast as it is allowed
  let id = 0
  const t0 = Date.now()
  cdp.on('Page.screencastFrame', () => {})
  const send = () => cdp.emit('Page.screencastFrame', { sessionId: ++id, data: 'x' })
  send()
  while (Date.now() - t0 < 1050) {
    await new Promise((r) => setTimeout(r, 5))
    if (acks.length >= id) send()
  }
  assert.ok(got.length >= 5 && got.length <= 7, `1초에 ${got.length}장`)
  for (let i = 1; i < got.length; i++) assert.ok(got[i][1] - got[i - 1][1] >= 190, '간격')
})

test('느린 연결의 시청자에게는 프레임을 쌓지 않는다(메시지는 간다) — 긴 폴링 버퍼에는 작업마다 마지막 프레임만', async () => {
  const user = `u-${Date.now()}`
  const fast = { writableLength: 0, lines: [], write(l) { this.lines.push(l); return true } }
  const slow = { writableLength: bus.FRAME_BACKLOG + 1, lines: [], write(l) { this.lines.push(l); return true } }
  const off1 = bus.subscribe(user, fast)
  const off2 = bus.subscribe(user, slow)
  const from = bus.lastSeq()
  for (let i = 0; i < 5; i++) bus.emit(user, 'browser.frame', { taskId: 't1', data: `f${i}` })
  bus.emit(user, 'message', { id: 'm1' })
  bus.emit(user, 'browser.frame', { taskId: 't2', data: 'g0' })
  assert.equal(fast.lines.length, 7)
  assert.equal(slow.lines.filter((l) => l.startsWith('event: browser.frame')).length, 0)
  assert.equal(slow.lines.filter((l) => l.startsWith('event: message')).length, 1)
  const kept = await bus.poll(user, from, 10)
  assert.deepEqual(kept.map((e) => e.type === 'browser.frame' ? e.data.data : e.data.id), ['f4', 'm1', 'g0'])
  off1(); off2()
})

test('프로필 잠금: 이 서버가 띄운 멈춘 브라우저면 멈추고 풀고, 다른 프로그램의 것이나 이 프로세스 자신은 그대로 둔다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-profile-'))
  const plant = (holder) => { for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) { try { fs.unlinkSync(path.join(dir, f)) } catch { /* none */ } fs.symlinkSync(f === 'SingletonLock' ? holder : 'x', path.join(dir, f)) } }
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 200))
    plant(`${os.hostname()}-${child.pid}`)
    assert.equal(lockHolder(dir).alive, true)
    const r = await releaseProfile(dir)
    assert.equal(r.stopped, child.pid, '이 서버의 자식이라 멈춘다')
    assert.equal(r.cleared.length, 3)
    await new Promise((r) => setTimeout(r, 200))
    assert.equal(child.exitCode !== null || child.signalCode !== null, true)
    plant(`${os.hostname()}-${process.pid}`)
    assert.deepEqual(await releaseProfile(dir), { stopped: 0, kept: process.pid, cleared: [] }, '자기 자신은 멈추지 않는다')
    plant(`${os.hostname()}-1`)
    assert.equal((await releaseProfile(dir)).kept, 1, '다른 프로그램의 것은 그대로')
    plant('another-pod-7c9b8-4321')
    assert.equal((await releaseProfile(dir)).cleared.length, 3, '다른 기계가 남긴 잠금은 지운다')
  } finally {
    child.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('잠금 링크가 없는 프로필(headless shell): 세션이 띄운 브라우저가 그 프로필로 아직 돌면 멈추고, 같은 번호의 다른 프로세스는 그대로', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pro-profile-'))
  const onIt = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${dir}`], { stdio: 'ignore' })
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  try {
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(lockHolder(dir), null)
    assert.equal(browserPidFor(dir), onIt.pid, '프로필로 도는 자식')
    assert.deepEqual(await releaseProfile(dir, { pid: other.pid }), { stopped: 0, kept: 0, cleared: [] }, '이 프로필이 아닌 프로세스는 멈추지 않는다')
    assert.equal((await releaseProfile(dir, { pid: onIt.pid })).stopped, onIt.pid)
    await new Promise((r) => setTimeout(r, 200))
    assert.ok(onIt.exitCode !== null || onIt.signalCode !== null)
    assert.equal(other.exitCode, null)
  } finally {
    onIt.kill('SIGKILL'); other.kill('SIGKILL')
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('기본 한도', () => {
  assert.ok(STEP.navMs <= 30000 && STEP.settleMs <= 3000 && STEP.stallMs <= 30000 && STEP.modelMs <= 120000)
})
