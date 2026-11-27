// 작업본은 한 곳에 — 변형의 자리 P0 (스펙 openspec/specs/variation-seats). 사용자(2026-11-26): 「폴더내 작업실을 누르면 일렉트론에 연결된 모바일이나
// 일렉트론내 해당 워크트리를 클론하여 작업할 수 있고 로컬 폴더 작업 결과를 서버로 동기화 할 수 있다. 작업본이 여러군데 흩어져서는 안되니 잘 설계해」.
// P0 은 서버 · 웹만: 변형마다 작업본이 있는 곳(자리)은 하나 — 보관 중 · 서버 작업실 · 서버 에이전트 · PC 하나 — 이고, 옮길 때는 저장 안 한 변경을
// 있는 그대로 커밋한 뒤 옛 자리를 치운다.
//   F-WL-01 변형 화면에 자리 알약: 작업실을 연 사람과 다른 사람 모두에게 「서버 작업실에서 · 그 사람」 (1280 · 밝은 · 어두운)
//   F-WL-02 남이 연 변형은 읽기 전용과 「돌려 달라고 하기」: 누르면 그 사람에게 알림, 작업실은 마지막 저장본을 읽기만(쓰기 · 셸 409)
//   F-WL-03 돌려놓으면 「보관 중」: 터미널에서 고치고 저장 안 한 파일까지 그 변형에 커밋된다
//   F-WL-04 390px 알약 · 읽기 전용 줄 (밝은 · 어두운), 옆으로 넘치지 않음
//   F-WL-05 세 사람 HTTP: 남의 변형 체크아웃 409(자리 정보 · 경로 없음), 남이 반영 409, 본인 반영은 저장 안 한 변경까지, 지난 회차의 터미널 표는 4409
// 화면 사진: openspec/specs/variation-seats/e2e/results. 모델은 부르지 않는다.
//   PGPT_URL=http://localhost:5368 API_URL=http://localhost:8978 npx playwright test --project=feature tests/feature/variation-seats.spec.js
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, uniq } from '../../lib/fixtures.js'
import { removeFolder } from '../../lib/seed.js'
import { upgrade } from '../../lib/net.js'
import { LOCAL_API } from '../../lib/env.js'

test.describe.configure({ mode: 'serial' })
const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/variation-seats/e2e/results')
fs.mkdirSync(SHOTS, { recursive: true })
const PHONE = { viewport: { width: 390, height: 844 }, dpr: 2, touch: true }
const enc = (s) => new TextEncoder().encode(s)
const NOTICE = '# 고객 세미나 안내\n\n일시: 11월 20일\n신청: 현장 접수\n'

const calm = (p) => p.evaluate(() => Promise.race([
  Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))),
  new Promise((ok) => setTimeout(ok, 2000)),
]))
const shot = async (p, name) => { await calm(p); await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const noSideways = async (p) => expect(await p.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)).toBeLessThanOrEqual(1)
// a page in a theme (the app keeps the choice in localStorage; it takes it once the sky has its place)
async function themed(pageAs, area, theme, opts) {
  const p = await pageAs(area, opts)
  await p.addInitScript((th) => { try { localStorage.setItem('pgpt-pro-theme', th); localStorage.setItem('pgl-lang', 'ko') } catch { /* opaque */ } }, theme)
  const go = p.goto.bind(p)
  p.goto = async (u, o) => { const r = await go(u, o); await expect(p.locator('html')).toHaveAttribute('data-theme', theme, { timeout: 20_000 }); return r }
  return p
}

let slug, vid, nameA

test('F-WL-01 변형 화면에 자리 알약 — 연 사람에게도 다른 사람에게도 「서버 작업실에서」', async ({ as, pageAs, db, cleanup }) => {
  const a = await as('ws-a'), b = await as('ws-b'), c = await as('ws-c')
  const f = await a.post('/folders', { name: uniq('회귀 작업본 한 곳'), description: '변형의 자리 회귀 시험' })
  expect(f.status, f.text).toBe(200)
  slug = f.body.slug
  // (the folder stays for the tests after this one; the last one removes it)
  const up = await a.post(`/folders/${slug}/files?path=${encodeURIComponent('안내문.md')}`, enc(NOTICE), { headers: { 'Content-Type': 'text/markdown' } })
  expect(up.status, up.text).toBe(200)
  for (const u of [b, c]) expect((await a.post(`/folders/${slug}/members`, { type: 'user', id: u.id, role: 'editor' })).status).toBe(200)
  const v = await a.post(`/folders/${slug}/variations`, { title: '마감일 추가' })
  expect(v.status, v.text).toBe(200)
  vid = v.body.id
  const before = await a.get(`/folders/${slug}/variations/${vid}/seat`)
  expect(before.body.place).toBe(null)
  const open = await a.post(`/folders/${slug}/variations/${vid}/seat`, { to: 'server' })
  expect(open.status, open.text).toBe(200)
  expect(open.body.workroom).toBe(`/workroom/variation/${vid}`)
  expect(open.body.seat).toMatchObject({ place: 'server', run: 'workroom', state: 'held', mine: true })
  nameA = open.body.seat.who.name
  for (const theme of ['light', 'dark']) {
    const pb = await themed(pageAs, 'ws-b', theme)
    await pb.goto(`/folders/${slug}/v/${vid}`)
    const pill = pb.locator('.vv .meta [data-test="seat-pill"]')
    await expect(pill).toContainText('서버 작업실에서')
    await expect(pill).toContainText(nameA)
    await expect(pb.locator('[data-test="seat-bar"]')).toContainText(`${nameA} 님이 이 변형을 고치는 중이에요`)
    await expect(pb.locator('[data-test="seat-recall"]')).toBeVisible()
    await expect(pb.locator('[data-test="seat-open"]')).toHaveCount(0)
    await shot(pb, `f-wl-01-seat-pill-other-${theme}`)
    expect(pb.errors).toEqual([])
    await pb.context().close()
  }
  const pa = await themed(pageAs, 'ws-a', 'light')
  await pa.goto(`/folders/${slug}/v/${vid}`)
  await expect(pa.locator('.vv .meta [data-test="seat-pill"]')).toContainText('서버 작업실에서')
  await expect(pa.locator('[data-test="seat-release"]')).toBeVisible()
  await expect(pa.locator('[data-test="seat-bar"]')).toHaveCount(0)
  // the folder's list says it too
  await pa.goto(`/folders/${slug}`)
  await expect(pa.locator('.vl .vc', { hasText: '마감일 추가' }).locator('[data-test="seat-pill"]')).toContainText('서버 작업실에서')
  await shot(pa, 'f-wl-01-folder-list-light')
  expect(pa.errors).toEqual([])
})

test('F-WL-02 남이 연 변형은 읽기 전용과 「돌려 달라고 하기」 — 누르면 그 사람에게 알림', async ({ as, pageAs, db }) => {
  const a = await as('ws-a'), b = await as('ws-b')
  // the server refuses what the screen does not offer: B's checkout, write and shell
  const co = await b.post(`/folders/${slug}/variations/${vid}/checkout`)
  expect(co.status).toBe(409)
  expect(co.body.seat.who.id).toBe(a.id)
  expect(JSON.stringify(co.body)).not.toMatch(/pgpt-folders|\.people/)
  expect((await b.put(`/workroom/variation/${vid}/file`, { path: '안내문.md', content: 'B 가 덮어쓰기' })).status).toBe(409)
  expect((await b.post(`/workroom/variation/${vid}/ticket`, { mode: 'shell' })).status).toBe(409)
  const room = await b.get(`/workroom/variation/${vid}`)
  expect(room.status).toBe(200)
  expect(room.body.readonly).toBe(true)
  expect(room.body.seat.who.id).toBe(a.id)
  expect(JSON.stringify(room.body)).not.toMatch(/pgpt-folders|\.people|seatRow|device_id/)
  expect((await b.get(`/workroom/variation/${vid}/file?path=${encodeURIComponent('안내문.md')}`)).body.content).toContain('현장 접수')

  const pb = await themed(pageAs, 'ws-b', 'light')
  await pb.goto(`/folders/${slug}/v/${vid}`)
  await pb.locator('[data-test="seat-recall"]').click()
  await expect(pb.locator('.toast')).toContainText('돌려 달라고 했어요')
  await expect(pb.locator('.vv .meta [data-test="seat-pill"]')).toContainText('돌려 달라는 요청')
  await expect(pb.locator('[data-test="seat-recall"]')).toHaveText('다시 돌려 달라고 하기')
  const [n] = await db.q(`select title, url from notifications where user_id=$1 and type='seat_recall' order by time_stamp desc limit 1`, [a.id])
  expect(n.url).toBe(`/folders/${slug}/v/${vid}`)
  expect(n.title).toContain('마감일 추가')
  await shot(pb, 'f-wl-02-recall-asked')
  // its workroom, read only: the branch as saved, no save button, no shell
  await pb.locator('[data-test="seat-readonly"]').first().click()
  await expect(pb).toHaveURL(new RegExp(`/workroom/variation/${vid}`))
  await expect(pb.locator('[data-test="wr-readonly"]')).toContainText('읽기 전용')
  await expect(pb.locator('[data-test="wr-readonly"]')).toContainText(`${nameA} 님이 고치는 중이에요`)
  await expect(pb.locator('[data-test="wr-recall"]')).toBeVisible()
  if (!(await pb.locator('.wr .body.side').count())) await pb.locator('.wr .hb', { hasText: '파일' }).click()
  await pb.locator('.wr .files .node', { hasText: '안내문.md' }).click()
  await expect(pb.locator('.wr .fbox')).toContainText('현장 접수')
  await expect(pb.locator('.wr .fbar .fb', { hasText: /저장/ })).toHaveCount(0)
  await shot(pb, 'f-wl-02-readonly-workroom')
  expect(pb.errors).toEqual([])
})

test('F-WL-03 돌려놓으면 「보관 중」 — 터미널에서 고치고 저장 안 한 파일까지 그 변형에 남는다', async ({ as, pageAs, db }) => {
  test.skip(!LOCAL_API, '서버 디스크의 작업본에 직접 써 보는 시험(터미널 대신) — 로컬 서버에서만')
  const a = await as('ws-a')
  const [row] = await db.q('select worktree_path from pro_folder_variations where id=$1', [vid])
  expect(row.worktree_path).toBeTruthy()
  // what a shell in the workroom leaves: a file nobody saved through the page
  fs.writeFileSync(path.join(row.worktree_path, '셸에서 쓴 메모.md'), '터미널에서 쓰고 저장 버튼은 안 누름\n')
  // and what git does not carry (a .gitignore'd log): kept on the server, listed on the variation with a download (review 2)
  fs.writeFileSync(path.join(row.worktree_path, '.gitignore'), '*.log\n')
  fs.writeFileSync(path.join(row.worktree_path, '디버그.log'), '셸이 남긴 로그\n')
  const pa = await themed(pageAs, 'ws-a', 'light')
  await pa.goto(`/folders/${slug}/v/${vid}`)
  await pa.locator('[data-test="seat-release"]').click()
  await expect(pa.locator('.vv .meta [data-test="seat-pill"]')).toHaveText(/보관 중/)
  await expect(pa.locator('[data-test="seat-release"]')).toHaveCount(0)
  await expect(pa.locator('[data-test="seat-open"]')).toBeVisible()
  await expect(pa.locator('[data-test="seat-kept"]')).toContainText('따로 남긴 파일')
  const get = pa.locator('[data-test="seat-kept-get"]').first()
  await expect(get).toContainText('1개')
  const zip = await a.get(new URL(await get.getAttribute('href'), 'http://x').pathname.replace(/^.*\/api/, '') + '?token=' + a.token(), { raw: true })
  expect(zip.status).toBe(200)
  expect(zip.headers.get('content-type')).toContain('zip')
  await shot(pa, 'f-wl-03-put-away-light')
  // the page asks first (within the download limits — size counted then); past them it says why instead of downloading (review 3)
  const keptPath = new URL(await get.getAttribute('href'), 'http://x').pathname.replace(/^.*\/api/, '')
  const pre = await a.get(`${keptPath}?check=1`)
  expect(pre.status).toBe(200)
  expect(pre.body).toMatchObject({ ok: true, count: 1 })
  await pa.route('**/kept/*check=1*', (r) => r.fulfill({ status: 413, contentType: 'application/json',
    body: JSON.stringify({ error: '남긴 파일의 전체 크기가 250 MB로, 한 번에 내려받을 수 있는 한도(200 MB)를 넘었어요. 남긴 파일은 보관 기간 동안 서버에 그대로 있으니 관리자에게 파일을 꺼내 달라고 요청해 주세요.', why: 'too-big' }) }))
  await get.click()
  await expect(pa.locator('.vv .toast')).toContainText('한 번에 내려받을 수 있는 한도(200 MB)를 넘었어요')
  await pa.unroute('**/kept/*check=1*')
  const raw = await a.get(`/folders/${slug}/raw?ref=${vid}&path=${encodeURIComponent('셸에서 쓴 메모.md')}`)
  expect(raw.status).toBe(200)
  expect(raw.text).toContain('저장 버튼은 안 누름')
  const seat = await a.get(`/folders/${slug}/variations/${vid}/seat`)
  expect(seat.body.place).toBe(null)
  expect((await a.get(`/folders/${slug}/variations/${vid}`)).body.status).toBe('ready')
  expect(fs.existsSync(row.worktree_path)).toBe(false)
  // the workroom: read only now, for her too — with 「내 작업실에서 열기」
  await pa.goto(`/workroom/variation/${vid}`)
  await expect(pa.locator('[data-test="wr-readonly"]')).toContainText('보관 중')
  await expect(pa.locator('[data-test="wr-open"]')).toBeVisible()
  await shot(pa, 'f-wl-03-workroom-put-away')
  await pa.locator('[data-test="wr-open"]').click()
  await expect(pa.locator('[data-test="wr-readonly"]')).toHaveCount(0)
  await expect(pa.locator('.wr .hd [data-test="seat-pill"]')).toContainText('서버 작업실에서')
  await expect(pa.locator('[data-test="wr-release"]')).toBeVisible()
  expect(pa.errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`F-WL-04 390px 알약 · 읽기 전용 줄 — ${theme === 'light' ? '밝은' : '어두운'} 테마`, async ({ pageAs }) => {
    const pb = await themed(pageAs, 'ws-b', theme, PHONE)
    await pb.goto(`/folders/${slug}/v/${vid}`)
    await expect(pb.locator('.vv .meta [data-test="seat-pill"]')).toContainText('서버 작업실에서')
    await expect(pb.locator('[data-test="seat-bar"]')).toBeVisible()
    await noSideways(pb)
    await shot(pb, `f-wl-04-variation-390-${theme}`)
    await pb.goto(`/folders/${slug}`)
    const row = pb.locator('.vl .vc', { hasText: '마감일 추가' })
    await row.scrollIntoViewIfNeeded()
    await expect(row.locator('[data-test="seat-pill"]')).toContainText('서버 작업실에서')
    await noSideways(pb)
    await shot(pb, `f-wl-04-folder-390-${theme}`)
    await pb.goto(`/workroom/variation/${vid}`)
    await expect(pb.locator('[data-test="wr-readonly"]')).toBeVisible()
    await noSideways(pb)
    await shot(pb, `f-wl-04-workroom-390-${theme}`)
    expect(pb.errors).toEqual([])
  })
}

test('F-WL-05 세 사람: 남은 반영 409, 본인 반영은 저장 안 한 변경까지 · 지난 회차의 터미널 표는 4409', async ({ as, db, cleanup }) => {
  cleanup(() => removeFolder(db, slug))
  const a = await as('ws-a'), c = await as('ws-c')
  // the seams of the next step (the desktop's working copy): the 「작업실」 sheet's one answer — my variations and seats, my computers by
  // name only — and a computer's place, not opened from here yet
  const choices = await a.get(`/folders/${slug}/workroom`)
  expect(choices.status).toBe(200)
  expect(choices.body.mine.find((x) => x.id === vid).seat).toMatchObject({ place: 'server', mine: true })
  expect(Array.isArray(choices.body.devices) && choices.body.devices.every((d) => !('id' in d))).toBe(true)
  expect(JSON.stringify(choices.body)).not.toMatch(/pgpt-folders|\.people/)
  // (a computer's working copy — desktop 0.2.6, P1: only a linked computer of hers, named by the app itself)
  const noPc = await a.post(`/folders/${slug}/variations/${vid}/seat`, { to: 'device' })
  expect(noPc.status).toBe(404)
  expect(noPc.body.why).toBe('no_device')
  // her own (writable) workroom says no server path (review #11)
  const mine = await a.get(`/workroom/variation/${vid}`)
  expect(mine.body.readonly).toBeFalsy()
  expect('cwd' in mine.body).toBe(false)
  expect(JSON.stringify(mine.body)).not.toMatch(/pgpt-folders|\.people/)
  // A saves a file in her workroom (a save point: ready to merge) and leaves one more unsaved in it
  const w = await a.put(`/workroom/variation/${vid}/file`, { path: '안내문.md', content: NOTICE.replace('일시: 11월 20일\n', '일시: 11월 20일\n신청 마감: 11월 14일\n') })
  expect(w.status, w.text).toBe(200)
  expect((await a.get(`/folders/${slug}/variations/${vid}`)).body.status).toBe('ready')
  if (LOCAL_API) {
    const [row] = await db.q('select worktree_path from pro_folder_variations where id=$1', [vid])
    fs.writeFileSync(path.join(row.worktree_path, '반영 직전.md'), '반영 직전에 셸에서 쓴 것\n')
  }
  const byC = await c.post(`/folders/${slug}/merge`, { ids: [vid], policy: 'stop' })
  expect(byC.status).toBe(409)
  expect(byC.body.why).toBe('held')
  // a terminal ticket from before a move does not open the shell of the next one
  const t = await a.post(`/workroom/variation/${vid}/ticket`, { mode: 'shell' })
  if (t.status === 200) {
    const seat = (await a.get(`/folders/${slug}/variations/${vid}/seat`)).body
    expect((await a.post(`/folders/${slug}/variations/${vid}/seat/release`, { epoch: seat.epoch - 1 })).status).toBe(409)
    expect((await a.post(`/folders/${slug}/variations/${vid}/seat/release`, { epoch: seat.epoch })).status).toBe(200)
    expect((await a.post(`/folders/${slug}/variations/${vid}/seat`, { to: 'server' })).status).toBe(200)
    if (LOCAL_API) {
      const [again] = await db.q('select worktree_path from pro_folder_variations where id=$1', [vid])
      fs.writeFileSync(path.join(again.worktree_path, '반영 직전 2.md'), '다시 연 작업실에서 저장 안 함\n')
    }
    const up = await upgrade(`/api/workroom/term?ticket=${t.body.ticket}`)
    expect(up.status).toBe(409)
    expect(up.reason).toContain('옮겨졌어요')
  } else expect(t.status).toBe(503) // (a server without terminals: no ticket to go stale)
  const byA = await a.post(`/folders/${slug}/merge`, { ids: [vid], policy: 'stop' })
  expect(byA.status, byA.text).toBe(200)
  expect(byA.body.status).toBe('done')
  expect((await a.get(`/folders/${slug}/raw?path=${encodeURIComponent('안내문.md')}`)).text).toContain('신청 마감: 11월 14일')
  if (LOCAL_API) {
    expect((await a.get(`/folders/${slug}/raw?path=${encodeURIComponent('반영 직전.md')}`)).text).toContain('셸에서 쓴 것')
    if (t.status === 200) expect((await a.get(`/folders/${slug}/raw?path=${encodeURIComponent('반영 직전 2.md')}`)).text).toContain('저장 안 함')
  }
  expect((await a.get(`/folders/${slug}/variations/${vid}/seat`)).body.place).toBe(null)
  const log = await db.q('select action from pro_variation_seat_log where variation_id=$1 order by id', [vid])
  expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['open', 'held', 'recall', 'release']))
})
