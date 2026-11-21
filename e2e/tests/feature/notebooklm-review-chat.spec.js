// 녹화 검토 2026-11-21 (Lite · NotebookLM 시나리오) — 채팅 화면 쪽 고침, 모델 없이 고정 메시지로.
//   F-NB-01 기다리는 작업 카드: 알약은 무엇이 필요한지(로그인 필요 · NotebookLM), 이유는 잘리지 않고, 첫 단추가 크게(직접 로그인)
//   F-NB-02 need·상태마다 알약과 첫 단추(구글이 막음 → 멈추기, 같은 화면 → 직접 확인, 실패 → 다시 시도)
//   F-NB-03 브라우저 에이전트가 누르는 자리에 물결(browser.click) — 카드·독·확장 화면, 화면 맞춤(cover)까지 계산한 자리
//   F-NB-04 소리 파일 카드 아래 바로 재생되는 플레이어 — 공개 주소·서명 주소·작업 공간 파일, Range 206
//   F-NB-05 새 프로젝트: 방을 만드는 요청이 늦어도 내 메시지와 「생각하는 중」이 바로, 실패하면 글이 입력창으로
//   F-NB-06 방 규칙 막대(새 API 모양: 안내 메시지의 content.roomRule) — 휴대폰 폭
// (src/components/TaskCard.vue · BrowserDock.vue · ChatColumn.vue · Message.vue · RoomRuleBar.vue, src/stores/app.js, src/views/MainView.vue)
// 휴대폰 사진: NB_SHOTS=<폴더> 를 주면 거기에, 아니면 시험 결과 폴더에 남긴다.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect, uniq } from '../../lib/fixtures.js'
import { PNG } from '../../lib/seed.js'
import { WORKSPACE } from '../../lib/env.js'

const AREA = 'nb1121-chatui'
const PHONE = { viewport: { width: 390, height: 844 } }
const shot = (w = 640, h = 400) => PNG(w, h, [40, 120, 200]).toString('base64')
const REASON = 'NotebookLM 은 구글 계정으로 로그인해야 열려요. 서버 브라우저에는 아직 구글 로그인이 없어요. 「직접 로그인」을 눌러 화면에서 한 번 로그인하면, 그 뒤로는 이 작업이 이어서 슬라이드와 오디오 개요를 만들어요.'
const steps = [{ text: 'notebooklm.google.com 접속 후 새 노트북을 만든다', done: false }, { text: '소스로 YouTube URL 을 추가한다', done: false }]

async function room(db, u, title = 'NotebookLM 방') {
  const [{ id }] = await db.q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning id`, [u.id, title])
  return id
}
// the page's own store (pinia 'app'): what an SSE event does, without a server that sends it
const emit = (page, type, data) => page.evaluate(([t, d]) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').onEvent(t, d), [type, data])
const setFrame = (page, taskId, data) => page.evaluate(([id, d]) => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').frames[id] = { taskId: id, data: d } }, [taskId, data])
async function photo(page, testInfo, name) {
  const dir = process.env.NB_SHOTS || testInfo.outputDir
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  await page.screenshot({ path: file })
  await testInfo.attach(name, { path: file, contentType: 'image/png' })
  return file
}
// nothing wider than the phone: the card, and the scrolling column it sits in
async function fitsPhone(page, loc) {
  const b = await loc.boundingBox()
  expect(b.x).toBeGreaterThanOrEqual(0)
  expect(b.x + b.width).toBeLessThanOrEqual(390.5)
  const over = await page.evaluate(() => { const m = document.querySelector('.msgs'); return m.scrollWidth - m.clientWidth })
  expect(over).toBeLessThanOrEqual(0)
}
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

test.describe('녹화 검토 11-21 · 채팅 화면', () => {
  test('F-NB-01 로그인을 기다리는 작업: 알약 「로그인 필요 · NotebookLM」, 이유 전체, 크게 「직접 로그인」 → 직접 제어가 켜진 확장 화면', async ({ pageAs, db, cleanup }, testInfo) => {
    const page = await pageAs(AREA, PHONE)
    const id = await room(db, page.user)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    const [, task] = await db.addMessages(id, [
      { role: 'user', kind: 'text', content: { text: '노트북엘엠 사이트에 들어가서 생성해야' } },
      { role: 'agent', kind: 'task', content: { title: 'NotebookLM 슬라이드·팟캐스트 만들기', goal: 'g', steps, state: 'needs_input', need: 'login', site: 'notebooklm.google.com', reason: REASON, shot: shot() } },
      // what came after: the card has scrolled away when the orange ring is pressed
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'agent', kind: 'text', content: { text: `뒤에 온 메시지 ${i + 1}\n\n줄을 채우는 문장이에요.` } })),
    ])
    await page.goto(`/projects/${id}`)
    const card = page.locator(`.row[data-id="${task.id}"]`)
    await expect(card.locator('.ctl .attn')).toHaveText('로그인 필요 · NotebookLM', { timeout: 20_000 })
    // the whole reason, not cut
    const why = card.getByTestId('task-reason')
    await expect(why).toHaveText(REASON)
    expect(await why.evaluate((e) => e.scrollHeight - e.clientHeight <= 1 && e.scrollWidth - e.clientWidth <= 1)).toBe(true)
    const go = card.getByTestId('task-login')
    await expect(go).toHaveText('직접 로그인')
    await expect(card.getByTestId('task-stop')).toHaveText('멈추기')
    expect((await go.boundingBox()).height).toBeGreaterThanOrEqual(44)

    // the orange ring by the composer goes to this card
    await expect(page.locator('.foot .dock.attn')).toBeVisible()
    await expect(card.getByTestId('task-ask')).not.toBeInViewport()
    await page.locator('.foot .dock').click()
    await expect(card.getByTestId('task-ask')).toBeInViewport()
    await page.waitForTimeout(600)
    await fitsPhone(page, card)
    await fitsPhone(page, card.getByTestId('task-ask'))
    await photo(page, testInfo, 'nb01-login-card-390')

    // 멈추기: this task's own cancel
    let body = null
    page.on('request', (r) => { if (r.url().endsWith('/api/browser/cancel')) body = r.postDataJSON() })
    await card.getByTestId('task-stop').click()
    await expect.poll(() => body).toEqual({ taskId: task.id })

    // 직접 로그인: the full view, 직접 제어 already on
    await go.click()
    await expect(page.locator('.handoff')).toBeVisible()
    await expect(page.getByRole('button', { name: '제어 돌려주기' })).toBeVisible()
    await page.waitForTimeout(600) // (the overlay fades in)
    // a phone has no keys for the screen: tap the field on the page, then type in the box under it
    const inputs = []
    page.on('request', (r) => { if (r.url().endsWith('/api/browser/input')) inputs.push(r.postDataJSON()) })
    const kb = page.getByTestId('takeover-kbd')
    await expect(kb).toBeVisible()
    await page.locator('.handoff .screen').click({ position: { x: 90, y: 40 } })
    await expect(kb).toBeFocused()
    await page.keyboard.type('ab')
    await page.keyboard.press('Backspace')
    await page.keyboard.type('c')
    await page.keyboard.press('Enter')
    await expect.poll(() => inputs.map((b) => b.text || b.key || b.type)).toEqual(['click', 'a', 'b', 'Backspace', 'c', 'Enter'])
    expect(inputs[0].x).toBeGreaterThan(0)
    await expect(kb).toHaveValue('')
    await photo(page, testInfo, 'nb01-login-takeover-390')
    await page.locator('.handoff .x').click()
    await expect(page.locator('.handoff')).toHaveCount(0)
    // 확장 again: not taken over by itself
    await card.getByRole('button', { name: '확장' }).click()
    await expect(page.getByRole('button', { name: '직접 제어', exact: true })).toBeVisible()
    expect(page.errors).toEqual([])
  })

  test('F-NB-02 need·상태마다 알약과 첫 단추: 구글이 막음 → 멈추기 · 같은 화면 → 직접 확인 · 실패 → 다시 시도 · 옛 카드도', async ({ pageAs, db, cleanup }, testInfo) => {
    const page = await pageAs(AREA, PHONE)
    const id = await room(db, page.user)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    const base = { goal: 'g', steps, shot: shot() }
    const rows = await db.addMessages(id, [
      { role: 'agent', kind: 'task', content: { ...base, title: '구글 로그인', state: 'needs_input', need: 'blocked', site: 'accounts.google.com', reason: '구글이 이 브라우저에서의 로그인을 막았어요(「안전하지 않은 브라우저」). 여기서는 더 할 수 없어요. 멈추고, 구글 로그인이 된 내 컴퓨터에서 해 주세요.' } },
      { role: 'agent', kind: 'task', content: { ...base, title: '노트북 만들기', state: 'needs_input', need: 'stuck', site: 'notebooklm.google.com', reason: '같은 화면에서 같은 단추를 세 번 눌렀는데 바뀌지 않았어요. 화면을 직접 보고 다음 단추를 눌러 주세요.' } },
      { role: 'agent', kind: 'task', content: { ...base, title: '잔액 확인', state: 'needs_input', reason: '' } },
      { role: 'agent', kind: 'task', content: { ...base, title: '팟캐스트 만들기', state: 'failed', summary: '브라우저 작업을 끝내지 못했어요. 잠시 후 다시 시도해 주세요.' } },
      { role: 'agent', kind: 'task', content: { ...base, title: 'NotebookLM 슬라이드', state: 'needs_review', need: 'login', site: 'notebooklm.google.com', reason: '로그인 화면에서 멈췄어요. 다시 시도한 뒤 「직접 로그인」으로 한 번 로그인해 주세요.' } },
    ])
    await page.goto(`/projects/${id}`)
    const at = (m) => page.locator(`.row[data-id="${m.id}"]`)
    const want = [
      [rows[0], '구글이 로그인을 막음', 'task-stop', '멈추기'],
      [rows[1], '같은 화면에서 멈춤', 'task-look', '직접 확인'],
      [rows[2], '조치 필요', 'task-look', '직접 확인'],
      [rows[3], '하지 못했어요 · 팟캐스트 만들기', 'task-retry', '다시 시도'],
      [rows[4], '로그인 필요 · NotebookLM', 'task-retry', '다시 시도'],
    ]
    for (const [m, pill, first, label] of want) {
      await expect(at(m).locator('.ctl .tt')).toHaveText(pill, { timeout: 20_000 })
      await expect(at(m).locator('.acts button').first()).toHaveAttribute('data-testid', first)
      await expect(at(m).locator('.acts button').first()).toHaveText(label)
      await fitsPhone(page, at(m))
    }
    // the old 조치 필요 name stays for the waiting card (server/test/takeover.e2e.mjs presses it)
    await expect(at(rows[1]).locator('.ctl').getByRole('button', { name: '조치 필요' })).toBeVisible()
    // 다시 시도 says so in the room (no model here: the stream is answered at once)
    let sent = null
    await page.route(`**/api/threads/${id}/messages`, (r) => {
      if (r.request().method() !== 'POST') return r.continue()
      sent = r.request().postDataJSON()
      return r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
    })
    await at(rows[3]).getByTestId('task-retry').click()
    await expect.poll(() => sent?.text).toBe('다시 시도해 줘: 팟캐스트 만들기')
    await at(rows[3]).scrollIntoViewIfNeeded()
    await photo(page, testInfo, 'nb02-states-390')
    expect(page.errors).toEqual([])
  })

  test('F-NB-03 browser.click → 누르는 자리에 물결: 작업 카드 · 독 · 확장 화면, 4:3 화면도 맞춘 자리에', async ({ pageAs, db, cleanup }, testInfo) => {
    const page = await pageAs(AREA)
    const id = await room(db, page.user)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    const [, task] = await db.addMessages(id, [
      { role: 'user', kind: 'text', content: { text: '노트북엘엠 사이트에 들어가서 생성해야' } },
      { role: 'agent', kind: 'task', content: { title: 'NotebookLM 슬라이드·팟캐스트 만들기', goal: 'g', steps, state: 'running', site: 'notebooklm.google.com', shot: shot() } },
    ])
    await page.goto(`/projects/${id}`)
    const screen = page.locator(`.row[data-id="${task.id}"] .screen`)
    await expect(screen.locator('img')).toBeVisible({ timeout: 20_000 })
    const click = (x, y) => emit(page, 'browser.click', { taskId: task.id, x, y, w: 1280, h: 800, kind: 'click' })
    // a ring right where the page is clicked: 3/4 across, 1/4 down
    const expectAt = async (ring, box, fx, fy) => {
      await expect(ring).toHaveCount(1)
      const c = center(await ring.boundingBox())
      expect(Math.abs(c.x - (box.x + fx * box.width))).toBeLessThan(2)
      expect(Math.abs(c.y - (box.y + fy * box.height))).toBeLessThan(2)
    }
    await click(960, 200)
    const ring = screen.getByTestId('click-ring')
    await expectAt(ring, await screen.boundingBox(), 0.75, 0.25)
    // the dock's small screen too
    const mini = page.locator('.foot .dock .mini')
    await expect(page.locator('.foot .dock .rip')).toHaveCount(1)
    await expectAt(page.locator('.foot .dock .rip'), await mini.boundingBox(), 0.75, 0.25)
    // it swells and goes (0.8 s)
    await expect(ring).toHaveCount(0, { timeout: 2000 })
    await expect(page.locator('.foot .dock .rip')).toHaveCount(0)

    // the full view (확장): the same point on the big screen
    await screen.getByRole('button', { name: '확장' }).click()
    const big = page.locator('.handoff .screen')
    await expect(big.locator('img')).toBeVisible()
    await click(320, 600)
    await expectAt(big.getByTestId('click-ring'), await big.boundingBox(), 0.25, 0.75)
    await page.waitForTimeout(180)
    await photo(page, testInfo, 'nb03-ripple-full-1280')
    await page.locator('.handoff .x').click()
    // (every view of the screen drew that click: the card's ring goes too)
    await expect(screen.getByTestId('click-ring')).toHaveCount(0, { timeout: 2000 })

    // a 4:3 page in the 16:10 card (object-fit: cover from the top): the point goes through the same fit
    await setFrame(page, task.id, PNG(400, 300, [200, 120, 40]).toString('base64'))
    await expect.poll(() => screen.locator('img').evaluate((i) => i.naturalWidth)).toBe(400)
    await click(640, 600)
    const box = await screen.boundingBox()
    const s = Math.max(box.width / 400, box.height / 300)
    const want = { x: box.x + (box.width - 400 * s) / 2 + 0.5 * 400 * s, y: box.y + 0.75 * 300 * s }
    const c = center(await screen.getByTestId('click-ring').boundingBox())
    expect(Math.abs(c.x - want.x)).toBeLessThan(2)
    expect(Math.abs(c.y - want.y)).toBeLessThan(2)
    // (not where the uncropped 16:10 would put it)
    expect(Math.abs(c.y - (box.y + 0.75 * box.height))).toBeGreaterThan(20)

    // the phone: the card in the column
    const phone = await pageAs(AREA, PHONE)
    await phone.goto(`/projects/${id}`)
    const ps = phone.locator(`.row[data-id="${task.id}"] .screen`)
    await expect(ps.locator('img')).toBeVisible({ timeout: 20_000 })
    await emit(phone, 'browser.click', { taskId: task.id, x: 640, y: 400, w: 1280, h: 800, kind: 'click' })
    await expectAt(ps.getByTestId('click-ring'), await ps.boundingBox(), 0.5, 0.5)
    await phone.waitForTimeout(200)
    await photo(phone, testInfo, 'nb03-ripple-card-390')
    expect(page.errors).toEqual([])
    expect(phone.errors).toEqual([])
  })

  test('F-NB-04 소리 파일은 카드 아래에서 바로 재생: 공개 주소 · 서명 주소 · 작업 공간 파일 (Range 206), 슬라이드는 그대로', async ({ pageAs, db, lib, cleanup }, testInfo) => {
    const page = await pageAs(AREA, PHONE)
    const { admin } = await lib('lib/supa.js')
    const mp3 = MP3()
    const up = await page.user.post('/attachments', mp3, { headers: { 'Content-Type': 'audio/mpeg', 'X-File-Name': encodeURIComponent('팟캐스트.mp3') } })
    expect(up.status).toBe(200)
    const keys = [up.body.key]
    cleanup(() => admin.storage.from('files').remove(keys))
    const signed = (await admin.storage.from('files').createSignedUrl(up.body.key, 600)).data.signedUrl
    expect(signed).toMatch(/\/object\/sign\//)
    // a file the agent left in its workspace: no address yet (lib/agent.js delegate posts {name, path})
    const rel = `nb1121-chatui/${uniq('pod')}.mp3`
    fs.mkdirSync(path.dirname(path.join(WORKSPACE, rel)), { recursive: true })
    fs.writeFileSync(path.join(WORKSPACE, rel), mp3)
    cleanup(() => fs.rmSync(path.join(WORKSPACE, rel), { force: true }))

    const id = await room(db, page.user)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    const rows = await db.addMessages(id, [
      { role: 'agent', kind: 'file', content: { name: '팟캐스트.mp3', url: up.body.url } },
      { role: 'agent', kind: 'file', content: { name: '팟캐스트-서명.mp3', url: signed } },
      { role: 'agent', kind: 'file', content: { name: '팟캐스트-작업.mp3', path: `/workspace/${rel}` } },
      { role: 'agent', kind: 'file', content: { name: '슬라이드.pptx', url: `${up.body.url.replace(/[^/]+$/, '')}x.pptx` } },
    ])
    await page.goto(`/projects/${id}`)
    for (const m of rows.slice(0, 3)) {
      const audio = page.locator(`.row[data-id="${m.id}"]`).getByTestId('file-audio')
      await expect(audio).toBeVisible({ timeout: 20_000 })
      await expect(audio).toHaveAttribute('preload', 'none')
      await expect(audio).toHaveAttribute('controls', '')
      const src = await audio.getAttribute('src')
      if (m === rows[2]) keys.push(decodeURIComponent(src.split('/object/public/files/')[1]))
      // a seek asks for a part of the file: storage answers 206
      const part = await page.request.get(src, { headers: { Range: 'bytes=0-99' } })
      expect(part.status()).toBe(206)
      // it plays: metadata, then time moves (muted: no autoplay rule in the way)
      const played = await audio.evaluate((a) => new Promise((ok) => {
        a.muted = true
        const t = setTimeout(() => ok({ err: `timeout ${a.networkState}/${a.readyState} ${a.error?.code || ''}` }), 15000)
        a.addEventListener('timeupdate', () => { if (a.currentTime > 0.1) { clearTimeout(t); a.pause(); ok({ duration: a.duration, at: a.currentTime }) } })
        a.play().catch((e) => ok({ err: e.message }))
      }))
      expect(played.err).toBeUndefined()
      expect(played.duration).toBeGreaterThan(0.5)
      const b = await audio.boundingBox()
      expect(b.height).toBeGreaterThanOrEqual(40)
      expect(b.x + b.width).toBeLessThanOrEqual(390.5)
    }
    // the slide deck: a card that opens the editor, no player
    await expect(page.locator(`.row[data-id="${rows[3].id}"] .file`)).toContainText('눌러서 바로 편집')
    await expect(page.locator(`.row[data-id="${rows[3].id}"]`).getByTestId('file-audio')).toHaveCount(0)
    await page.locator(`.row[data-id="${rows[0].id}"]`).scrollIntoViewIfNeeded()
    await photo(page, testInfo, 'nb04-audio-390')
    expect(page.errors).toEqual([])
  })

  test('F-NB-05 새 프로젝트: 방 만들기가 늦어도 내 메시지·「생각하는 중」이 바로 → 방 주소로, 실패하면 글이 입력창으로', async ({ pageAs, db, cleanup }, testInfo) => {
    const page = await pageAs(AREA, PHONE)
    const text = '이 방에서 내가 주는 url이 있으면 그거를 받아다가 노트북엘엠으로 슬라이드를 만들고 그 팟캐스트를 하나 만들어 주면 돼'
    let made = null, fail = false
    const sent = []
    // POST /api/threads answers late (2.5 s) — or fails; the chat stream is answered at once (no model)
    await page.route('**/api/threads', async (r) => {
      if (r.request().method() !== 'POST') return r.continue()
      await new Promise((ok) => setTimeout(ok, fail ? 1000 : 2500))
      if (fail) return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) })
      ;[made] = await db.q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning *`, [page.user.id, 'NotebookLM 슬라이드'])
      cleanup(() => db.q('delete from pro_threads where id=$1', [made.id]))
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(made) })
    })
    await page.route('**/api/threads/*/messages', (r) => {
      if (r.request().method() !== 'POST') return r.continue()
      sent.push(r.request().postDataJSON().text)
      return r.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: 'event: done\ndata: {}\n\n' })
    })
    await page.goto('/projects')
    const box = page.getByPlaceholder('새 프로젝트에서 할 일을 적어 주세요')
    await box.fill(text)
    const t0 = Date.now()
    await box.press('Enter')
    const mine = page.locator('.bubble.user', { hasText: text })
    await expect(mine).toBeVisible({ timeout: 1500 })
    await expect(page.getByTestId('chat-working')).toHaveText('생각하는 중', { timeout: 1500 })
    const shown = Date.now() - t0
    expect(shown).toBeLessThan(1500)
    expect(made).toBeNull() // still being made
    await expect(page.locator('.plist')).toHaveCount(0) // the project list gave way to the chat
    await page.waitForTimeout(500) // (the message has blurred in; the room is still being made)
    expect(made).toBeNull()
    await photo(page, testInfo, 'nb05-new-project-instant-390')
    // one more while the room is still being made: on screen at once, sent after the first once it exists
    await page.getByPlaceholder('process gpt에 메시지 보내기').fill('유튜브 링크도 곧 줄게')
    await page.getByPlaceholder('process gpt에 메시지 보내기').press('Enter')
    await expect(page.locator('.bubble.user')).toHaveCount(2, { timeout: 1500 })
    expect(made).toBeNull()

    await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/, { timeout: 10_000 })
    expect(page.url()).toContain(made.id)
    await expect.poll(() => sent, { timeout: 5000 }).toEqual([text, '유튜브 링크도 곧 줄게'])
    await expect(mine).toHaveCount(1)
    await expect(page.locator('.bubble.user')).toHaveCount(2)
    // the server's own copy of the message takes the place of the one on screen (no double)
    const real = { id: crypto.randomUUID(), thread_id: made.id, role: 'user', kind: 'text', content: { text }, created_at: new Date().toISOString() }
    await emit(page, 'message', real)
    await expect(page.locator('.bubble.user')).toHaveCount(2)
    await expect(page.locator('.row.r-user').first()).toHaveAttribute('data-id', real.id)

    // making the room fails: the message goes, its text is back in the box, and it says so
    fail = true
    await page.goto('/projects')
    const box2 = page.getByPlaceholder('새 프로젝트에서 할 일을 적어 주세요')
    await box2.fill('두 번째 프로젝트')
    await box2.press('Enter')
    await expect(page.locator('.bubble.user', { hasText: '두 번째 프로젝트' })).toBeVisible({ timeout: 1500 })
    await expect(page.getByTestId('chat-notice')).toContainText('보낸 글은 입력창에 돌려놓았어요', { timeout: 5000 })
    await expect(page.locator('.bubble.user')).toHaveCount(0)
    await expect(page.getByPlaceholder('새 프로젝트에서 할 일을 적어 주세요')).toHaveValue('두 번째 프로젝트')
    await expect(page).toHaveURL(/\/projects$/)
    await photo(page, testInfo, 'nb05-new-project-failed-390')
    testInfo.annotations.push({ type: 'shown-ms', description: String(shown) })
    expect(page.errors).toEqual([])
  })

  test('F-NB-06 방 규칙 막대(안내 메시지의 content.roomRule): 휴대폰 폭에서 「이 방의 규칙 · …」과 끄기', async ({ pageAs, as, db, cleanup }, testInfo) => {
    const page = await pageAs(AREA, PHONE)
    const id = await room(db, page.user)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    const action = '이 링크나 파일로 노트북 lm(NotebookLM)에서 슬라이드와 팟캐스트를 만든다'
    const said = '이 방에서 내가 주는 url이 있으면 그거를 받아다가 노트북엘엠으로 슬라이드를 만들고 그 팟캐스트를 하나 만들어 주면 돼'
    const [, ruleMsg] = await db.addMessages(id, [
      { role: 'user', kind: 'text', content: { text: said } },
      { role: 'agent', kind: 'text', content: { text: `알겠습니다. 이 방에 올리시는 링크와 파일은 앞으로 바로 처리할게요. ${action}`, roomRule: { said, action, runs: 2 } } },
    ])
    expect((await page.user.get(`/threads/${id}/rule`)).body.rule).toMatchObject({ id: ruleMsg.id, said, action, runs: 2 })
    // someone else neither sees nor turns it off
    const other = await as(`${AREA}-other`)
    expect((await other.get(`/threads/${id}/rule`)).body.rule).toBeNull()
    expect((await other.del(`/threads/${id}/rule`)).body.removed).toBe(0)
    await page.goto(`/projects/${id}`)
    const bar = page.getByTestId('room-rule')
    await expect(bar).toContainText('이 방의 규칙', { timeout: 20_000 })
    await expect(bar.locator('.tx')).toHaveText(`이 방의 규칙·${action}2번 실행`)
    await expect(bar).toContainText('2번 실행')
    await fitsPhone(page, bar)
    // at the top, above the conversation
    expect((await bar.boundingBox()).y).toBeLessThan((await page.locator('.bubble.user').first().boundingBox()).y)
    expect((await page.getByTestId('room-rule-off').boundingBox()).height).toBeGreaterThanOrEqual(36)
    await photo(page, testInfo, 'nb06-room-rule-390')
    await page.getByTestId('room-rule-off').click()
    await expect(bar).toHaveCount(0)
    expect((await page.user.get(`/threads/${id}/rule`)).body.rule).toBeNull()
    await page.reload()
    await expect(page.locator('.bubble.user').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('room-rule')).toHaveCount(0)
    expect(page.errors).toEqual([])
  })
})

// a short real MP3 (ffmpeg on PATH), else MPEG-1 Layer III frames of silence (decoders take them as 1 s of quiet)
function MP3(seconds = 2) {
  const out = path.join(os.tmpdir(), `rt-nb-${process.pid}-${Date.now()}.mp3`)
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '1', '-b:a', '64k', out])
    const b = fs.readFileSync(out); fs.rmSync(out, { force: true }); return b
  } catch {
    const frame = Buffer.alloc(417); frame.set([0xff, 0xfb, 0x90, 0x64])
    return Buffer.concat(Array.from({ length: 38 * seconds }, () => frame))
  }
}
