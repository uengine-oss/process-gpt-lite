// 문서 옆의 왼쪽 칸(2026-11-24 운영 화면, 약 2000px 창: 「프로젝트에서 산출물을 열어보면 이렇게 목록과 대화내용이 겹쳐진다.」 — 스펙
// openspec/specs/chat-artifacts 「문서가 페이지 옆에 열려 있어도 왼쪽 칸 · 채팅 · 문서는 겹치지 않는다」). 문서 패널(OfficeSheet)이 페이지
// 옆에 열리면 채팅 칸을 창 왼쪽 끝부터 다시 놓는 규칙(left: 0)이 왼쪽 칸(프로젝트 · 루틴 목록, Home, 대화 목록)을 셈에 넣지 않아
// 채팅이 목록 위로 올라갔다. 고친 뒤: 왼쪽 칸(420px) · 채팅(512px + 양옆 40px) · 문서가 나란히 들어가면 셋을 나란히, 아니면 문서가
// 열린 동안 목록을 접고(채팅은 문서 왼쪽 전체를 씀) 위쪽 막대의 Home 옆 「≡ 프로젝트」 단추로 채팅 위에 잠깐 펼친다(고르기 · Esc ·
// 바깥 누르기로 접힘). Home 은 자리가 없으면 열 때 채팅 위에 펼쳐진다.
// 모드마다(프로젝트 · 루틴 · Home 을 연 채팅 · 대화 목록을 연 채팅) 1280 · 1440 · 1600 · 2000px 에서 문서를 열고, 붙여 둔 메신저까지
// 상자끼리 겹치지 않는지 본다. 모델 없이 고정 데이터로. 순수 규칙은 server/test/docLayout.test.js.
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { test, expect, RUN } from '../../lib/fixtures.js'
import { seedConversations } from '../../lib/chatseed.js'
import * as api from '../../lib/api.js'
import { MIME, XLSX } from '../../lib/seed.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.resolve(here, '../../../openspec/specs/chat-artifacts/e2e/results')
const H = 900
// the top bar's height (TopBar .top)
const TOP = 68
const WIDTHS = [1280, 1440, 1600, 2000]
// left column 420 + chat 512 + 2 × 40 beside a document of min(960px, 70%): only the 2000px window holds all three
const besideAt = (w) => w - Math.min(960, 0.7 * w) - 420 >= 592
// Playwright's own Chromium (never a person's Chrome)
test.use({ channel: 'chromium' })
test.describe.configure({ mode: 'serial' })

const sheet = (page) => page.locator('[data-test="office-sheet"] .sheet')
const leftCol = (page) => page.locator('.content > aside.plist, .content > aside.rlist, .content > aside.tlist, .content > aside.dock')
const fold = (page) => page.getByTestId('left-fold')
const inner = (page) => page.locator('.center .col .msgs .inner').first()
const composer = (page) => page.locator('.center .col .foot .composer').first()
const messenger = (page) => page.locator('[data-test="messenger"]')
const store = (page, fn, arg) => page.evaluate(([f, a]) => {
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app')
  // eslint-disable-next-line no-new-func
  return new Function('app', 'a', `return (${f})(app, a)`)(app, a)
}, [String(fn), arg])
// every CSS transition and animation of the page has run (the chat sliding over, the panel growing)
const calm = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))
const shot = async (page, name) => { await calm(page); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
const overlap = (a, b) => a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5
const theme = (page, t) => page.context().addInitScript((v) => { try { localStorage.setItem('pgpt-pro-theme', v) } catch { /* ignore */ } }, t)
const listOpen = (page, open) => page.context().addInitScript((v) => { try { localStorage.setItem('pgl-chat-thread-list', v) } catch { /* ignore */ } }, open ? '1' : '0')

// The boxes on screen with a document open beside the page: the document panel, the chat column (its messages' width, from under the
// top bar to the bottom — messages scroll under the bar as they always did), the composer, the left column, a docked messenger, and in
// the top bar the folded list's button beside Home and the tabs — none of them on another (the composer is in the chat column)
async function boxes(page, w) {
  await calm(page)
  const doc = await sheet(page).boundingBox()
  const m = await inner(page).boundingBox()
  const b = { doc, chat: { x: m.x, y: TOP, width: m.width, height: H - TOP }, composer: await composer(page).boundingBox() }
  if (await leftCol(page).count()) b.left = await leftCol(page).first().boundingBox()
  if (await fold(page).count()) {
    b.fold = await fold(page).boundingBox()
    b.home = await page.locator('.top .home').boundingBox()
    b.tabs = await page.locator('.top .seg').boundingBox()
  }
  if (await messenger(page).count()) b.messenger = await messenger(page).boundingBox()
  for (const [k, v] of Object.entries(b)) {
    expect(v, `${k} 상자`).toBeTruthy()
    expect(v.x, `${k}: 창 안`).toBeGreaterThanOrEqual(-0.5)
    expect(v.x + v.width, `${k}: 창 안`).toBeLessThanOrEqual(w + 0.5)
  }
  const names = Object.keys(b)
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const [p, q] = [names[i], names[j]]
      if ([p, q].includes('chat') && [p, q].includes('composer')) continue
      // the top bar's tabs sit over the page's middle when they do not fit over the chat (MainView chatCenter): above the document's top
      if ([p, q].includes('tabs') && !([p, q].includes('fold') || [p, q].includes('home'))) continue
      // the messenger in the document panel sits inside the panel, beside the document
      if ([p, q].includes('doc') && [p, q].includes('messenger') && (await messenger(page).getAttribute('data-dock')) === 'panel') continue
      expect(overlap(b[p], b[q]), `${w}px: ${p} 와 ${q} 가 겹침 ${JSON.stringify([b[p], b[q]])}`).toBe(false)
    }
  }
  // the chat stays a usable column, and the composer is in it
  expect(b.chat.width, '채팅 칸 너비').toBeGreaterThanOrEqual(270)
  expect(b.composer.x).toBeGreaterThanOrEqual(b.chat.x - 1)
  return b
}
// where the list should be at this width: beside the chat, or put away with its button in the top bar
async function expectPlace(page, w, beside = besideAt(w)) {
  if (beside) {
    await expect(leftCol(page)).toHaveCount(1)
    await expect(fold(page)).toHaveCount(0)
  } else {
    await expect(leftCol(page)).toHaveCount(0)
    await expect(fold(page)).toBeVisible()
  }
  // still so once the fades have run (a list fading out still counts for a moment)
  await calm(page)
  expect(await leftCol(page).count(), `${w}px: 왼쪽 칸`).toBe(beside ? 1 : 0)
}
async function openCard(page, name) {
  const card = page.locator('.row.k-file').filter({ hasText: name }).last().locator('button.file')
  await card.scrollIntoViewIfNeeded()
  await card.click()
  await expect(sheet(page)).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-test="office-sheet"]')).toHaveClass(/\bside\b/)
}
async function closeDoc(page) {
  await page.locator('.oef .tb.ic[title="닫기"]').click()
  await expect(page.locator('[data-test="office-sheet"]')).toHaveCount(0)
}

// a project room with a file the agent made in it (and a second, empty room to move to)
async function seedProjects(db, u, cleanup) {
  const xlsx = await api.upload(u.token(), '분기 매출.xlsx', MIME.xlsx, await XLSX([['분기', '매출'], ['1분기', 1200], ['2분기', 1500]]))
  const ids = []
  for (const title of ['이음오피스 정리', '신규 강의 개설']) {
    const [t] = await db.q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning id`, [u.id, `${title} ${RUN}`])
    cleanup(() => db.q('delete from pro_threads where id=$1', [t.id]))
    ids.push(t.id)
  }
  await db.addMessages(ids[1], [
    { role: 'user', kind: 'text', content: { text: '신규 강의 개설 요청서를 표로 정리해 줘' } },
    { role: 'agent', kind: 'text', content: { text: '강의 개설 요청 내용을 분기별 표로 정리했어요. 아래 파일을 열어 고칠 수 있어요.' } },
    { role: 'agent', kind: 'file', content: { name: '분기 매출.xlsx', url: xlsx.url } },
    { role: 'user', kind: 'text', content: { text: '2분기 숫자도 넣어 줘' } },
    { role: 'agent', kind: 'text', content: { text: '2분기 1,500을 넣었어요.' } },
  ])
  return { ids, xlsx }
}
// a small running routine of mine (a classic instance: its page has the chat column under the instance's header)
async function seedRoutine(db, u, cleanup) {
  const DEF = `rt_dl_${RUN}_${crypto.randomUUID().slice(0, 6)}`.toLowerCase()
  const inst = `${DEF}.${crypto.randomUUID()}`
  const def = { activities: [{ id: 'draft', name: '강의 계획서 작성', role: '교육담당자', type: 'userTask' }], events: [{ id: 'start', type: 'startEvent' }, { id: 'end', type: 'endEvent' }],
    gateways: [], roles: [{ name: '교육담당자' }], sequences: [{ id: 's1', source: 'start', target: 'draft' }, { id: 's2', source: 'draft', target: 'end' }] }
  cleanup(async () => {
    await db.q('delete from pro_messages where thread_id in (select id from pro_threads where kind=$1 and ref=$2)', ['process', inst]).catch(() => {})
    await db.q('delete from pro_threads where kind=$1 and ref=$2', ['process', inst]).catch(() => {})
    await db.q('delete from todolist where proc_inst_id=$1', [inst]).catch(() => {})
    await db.q('delete from bpm_proc_inst where proc_inst_id=$1', [inst]).catch(() => {})
    await db.q('delete from proc_def where id=$1', [DEF]).catch(() => {})
  })
  await db.q(`insert into proc_def (id, name, definition, type, tenant_id, isdeleted) values ($1,$2,$3,'bpmn',$4,false)`, [DEF, `회귀 강의 개설 ${RUN}`, def, db.tenant])
  await db.q(`insert into bpm_proc_inst (proc_inst_id, proc_inst_name, proc_def_id, status, current_activity_ids, participants, tenant_id, start_date)
              values ($1,$2,$3,'RUNNING',$4,$5,$6,now())`, [inst, `회귀 강의 개설 · 가온아카데미 ${RUN}`, DEF, ['draft'], [u.id], db.tenant])
  return inst
}

test('F-DL-01 프로젝트: 산출물을 열면 2000px 은 목록 · 채팅 · 문서가 나란히, 그보다 좁으면 목록을 접고 위쪽 막대에 「≡ 프로젝트」 — 어느 폭에서도 겹치지 않음', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('dl-project', { viewport: { width: 2000, height: H } })
  await theme(page, 'light')
  const { ids } = await seedProjects(db, page.user, cleanup)
  for (const w of [...WIDTHS].reverse()) {
    await page.setViewportSize({ width: w, height: H })
    await page.goto(`/projects/${ids[1]}?hour=13`)
    await expect(page.locator('.plist')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('2분기 1,500을 넣었어요.')).toBeVisible()
    await openCard(page, '분기 매출.xlsx')
    await expectPlace(page, w)
    const b = await boxes(page, w)
    // the chat sits between the list (when beside) and the document
    if (b.left) expect(b.chat.x).toBeGreaterThanOrEqual(b.left.x + b.left.width)
    expect(b.chat.x + b.chat.width).toBeLessThanOrEqual(b.doc.x)
    await shot(page, `f-dl-01-project-${w}`)
    await closeDoc(page)
    // the document closed: the list is back beside the chat
    await expect(page.locator('.plist')).toBeVisible()
    await expect(fold(page)).toHaveCount(0)
  }
  expect(page.errors).toEqual([])
})

test('F-DL-02 접힌 목록: 위쪽 막대의 「≡ 프로젝트」로 채팅 위에 펼치고(문서와 겹치지 않음) 다른 프로젝트를 고르거나 Esc · 바깥을 누르면 다시 접힘', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('dl-project', { viewport: { width: 1600, height: H } })
  const { ids } = await seedProjects(db, page.user, cleanup)
  await page.goto(`/projects/${ids[1]}`)
  await openCard(page, '분기 매출.xlsx')
  await expectPlace(page, 1600)
  await expect(fold(page)).toHaveText('프로젝트')
  await expect(fold(page)).toHaveAttribute('aria-label', '프로젝트 목록 펼치기')
  await expect(fold(page)).toHaveAttribute('aria-expanded', 'false')
  // right of Home's round button — in the desktop app too, where the bar starts right of macOS's traffic lights (styles/desktop.css)
  const right = async () => { const h = await page.locator('.top .home').boundingBox(), f = await fold(page).boundingBox(); return f.x - (h.x + h.width) }
  expect(await right()).toBe(8)
  await page.evaluate(() => { document.documentElement.classList.add('pgl-desktop'); document.documentElement.style.setProperty('--pgl-tb-left', '78px') })
  await calm(page)
  expect(await right()).toBe(8)
  await page.evaluate(() => { document.documentElement.classList.remove('pgl-desktop'); document.documentElement.style.removeProperty('--pgl-tb-left') })
  // the button: the list over the chat, from the left edge to the document's room
  await fold(page).click()
  const over = page.locator('.content > aside.plist.over')
  await expect(over).toBeVisible()
  await expect(fold(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(fold(page)).toHaveAttribute('aria-label', '프로젝트 목록 접기')
  await calm(page)
  const ob = await over.boundingBox(), db2 = await sheet(page).boundingBox(), fb = await fold(page).boundingBox()
  expect(overlap(ob, db2), '펼친 목록과 문서').toBe(false)
  expect(overlap(ob, fb), '펼친 목록과 단추').toBe(false)
  expect(await over.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
  await shot(page, 'f-dl-02a-list-over')
  // Esc folds it
  await page.keyboard.press('Escape')
  await expect(over).toHaveCount(0)
  await expect(fold(page)).toBeVisible()
  // a click outside (on the chat right of it) folds it too
  await fold(page).click()
  await expect(over).toBeVisible()
  expect(ob.x + ob.width + 40).toBeLessThan(db2.x)
  await page.mouse.click((ob.x + ob.width + db2.x) / 2, 300)
  await expect(over).toHaveCount(0)
  // the button again folds it
  await fold(page).click()
  await expect(over).toBeVisible()
  await fold(page).click()
  await expect(over).toHaveCount(0)
  // picking another project: its room, the list folded again, the document still open beside it
  await fold(page).click()
  await over.locator('.item').filter({ hasText: `이음오피스 정리 ${RUN}` }).click()
  await expect(page).toHaveURL(new RegExp(`/projects/${ids[0]}$`))
  await expect(over).toHaveCount(0)
  await expect(sheet(page)).toBeVisible()
  await expectPlace(page, 1600)
  await boxes(page, 1600)
  await shot(page, 'f-dl-02b-picked')
  // the window widened to 2000px: the list beside the chat again
  await page.setViewportSize({ width: 2000, height: H })
  await expectPlace(page, 2000)
  await boxes(page, 2000)
  expect(page.errors).toEqual([])
})

test('F-DL-03 루틴: 루틴 화면에 문서를 열어도 루틴 목록 · 채팅 · 문서가 겹치지 않음', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('dl-routine', { viewport: { width: 2000, height: H } })
  const inst = await seedRoutine(db, page.user, cleanup)
  const x = await api.upload(page.user.token(), '강의 계획서.xlsx', MIME.xlsx, await XLSX([['주차', '주제'], ['1주', '오리엔테이션'], ['2주', '실습']]))
  for (const w of [...WIDTHS].reverse()) {
    await page.setViewportSize({ width: w, height: H })
    await page.goto(`/routines/${encodeURIComponent(inst)}`)
    await expect(page.locator('.rlist')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.rlist [data-inst]').filter({ hasText: `가온아카데미 ${RUN}` })).toBeVisible({ timeout: 20_000 })
    await expect(composer(page)).toBeVisible({ timeout: 20_000 })
    // a document opened from elsewhere (the team messenger's file chip, a card): the same app.setOfficeDoc every opener calls
    await store(page, (app, a) => app.setOfficeDoc(a), { url: x.url, name: '강의 계획서.xlsx' })
    await expect(page.locator('[data-test="office-sheet"]')).toHaveClass(/\bside\b/, { timeout: 20_000 })
    await expectPlace(page, w)
    if (!besideAt(w)) await expect(fold(page)).toHaveAttribute('aria-label', '루틴 목록 펼치기')
    await boxes(page, w)
    await shot(page, `f-dl-03-routine-${w}`)
    await closeDoc(page)
    await expect(page.locator('.rlist')).toBeVisible()
  }
  expect(page.errors).toEqual([])
})

test('F-DL-04 채팅 · Home: 문서를 열면 Home 은 비켜 있고, 다시 Home 을 열면 자리가 있으면 나란히 · 없으면 채팅 위에(Esc · 바깥 · Home 단추로 닫힘)', async ({ pageAs, db }) => {
  const page = await pageAs('dl-chat', { viewport: { width: 2000, height: H } })
  await listOpen(page, false)
  await seedConversations(db, page.user, { tripFiles: 3, ytFiles: 2 })
  for (const w of [...WIDTHS].reverse()) {
    await page.setViewportSize({ width: w, height: H })
    await page.goto('/chat')
    await expect(page.locator('aside.dock')).toBeVisible({ timeout: 30_000 })
    await openCard(page, '숙소 1.xlsx')
    // the document beside the page puts Home away (as before)
    await expect(page.locator('aside.dock')).toHaveCount(0)
    await boxes(page, w)
    // Home again
    await page.locator('.top .home').click()
    await expect(page.locator('aside.dock')).toBeVisible()
    // (Home has its own round button: no list button)
    await expect(fold(page)).toHaveCount(0)
    if (besideAt(w)) {
      await expectPlace(page, w)
      await boxes(page, w)
      await shot(page, `f-dl-04-home-${w}`)
    } else {
      // no room beside: Home over the chat, clear of the document; Esc closes it (as its round button would)
      await expect(page.locator('aside.dock.over')).toBeVisible()
      await calm(page)
      expect(overlap(await page.locator('aside.dock.over').boundingBox(), await sheet(page).boundingBox())).toBe(false)
      await shot(page, `f-dl-04-home-over-${w}`)
      await page.keyboard.press('Escape')
      await expect(page.locator('aside.dock')).toHaveCount(0)
      await expect(page.locator('.top .home')).not.toHaveClass(/\bon\b/)
      await boxes(page, w)
      // the round button opens and closes it too
      await page.locator('.top .home').click()
      await expect(page.locator('aside.dock.over')).toBeVisible()
      await page.locator('.top .home').click()
      await expect(page.locator('aside.dock')).toHaveCount(0)
    }
    await closeDoc(page)
  }
  expect(page.errors).toEqual([])
})

test('F-DL-05 채팅 · 대화 목록: 문서를 열어도 대화 목록은 같은 규칙(나란히 · 접고 「≡ 대화」) — 겹치지 않음, 닫으면 목록 그대로', async ({ pageAs, db }) => {
  const page = await pageAs('dl-threads', { viewport: { width: 2000, height: H } })
  await theme(page, 'dark')
  await listOpen(page, true)
  await seedConversations(db, page.user, { tripFiles: 3, ytFiles: 2 })
  for (const w of [...WIDTHS].reverse()) {
    await page.setViewportSize({ width: w, height: H })
    await page.goto('/chat?hour=22')
    await expect(page.getByTestId('thread-list')).toBeVisible({ timeout: 30_000 })
    await openCard(page, '숙소 1.xlsx')
    await expectPlace(page, w)
    if (!besideAt(w)) await expect(fold(page)).toHaveAttribute('aria-label', '대화 목록 펼치기')
    await boxes(page, w)
    await shot(page, `f-dl-05-threads-${w}`)
    await closeDoc(page)
    await expect(page.getByTestId('thread-list')).toBeVisible()
  }
  // folded at 1280: the button lays the list over the chat; a conversation picked narrows the chat, the list folds again
  await openCard(page, '숙소 1.xlsx')
  await fold(page).click()
  await expect(page.locator('aside.tlist.over')).toBeVisible()
  await page.locator('aside.tlist.over [data-conv="rt-conv-trip"]').click()
  await expect(page).toHaveURL(/\/chat\/c\/rt-conv-trip$/)
  await expect(page.locator('aside.tlist.over')).toHaveCount(0)
  await boxes(page, 1280)
  expect(page.errors).toEqual([])
})

test('F-DL-06 붙여 둔 메신저: 오른쪽 · 왼쪽 열, 문서 패널 안 — 왼쪽 칸 · 채팅 · 문서 · 메신저가 서로 겹치지 않음', async ({ pageAs, db, cleanup }) => {
  const page = await pageAs('dl-project', { viewport: { width: 2000, height: H } })
  const { ids } = await seedProjects(db, page.user, cleanup)
  const dock = (d) => page.evaluate((v) => { try { localStorage.setItem('pgl-messenger-dock', JSON.stringify({ dock: v, width: 400 })) } catch { /* ignore */ } }, d)
  for (const [d, w] of [['right', 2000], ['left', 2000], ['panel', 2000], ['right', 1440], ['right', 2600]]) {
    await page.setViewportSize({ width: w, height: H })
    await page.goto(`/projects/${ids[1]}`)
    await dock(d)
    await page.reload()
    await expect(page.locator('.plist')).toBeVisible({ timeout: 30_000 })
    await page.locator('button.msg-btn').click()
    await expect(messenger(page)).toHaveAttribute('data-dock', d)
    await openCard(page, '분기 매출.xlsx')
    await expect(messenger(page)).toBeVisible()
    // the page is the window less the docked column (the panel dock takes its room inside the document panel)
    const pageW = d === 'panel' ? w : w - 412
    const docW = d === 'panel' ? Math.min(960 + 400, 0.72 * pageW) : Math.min(960, 0.7 * pageW)
    await expectPlace(page, w, pageW - docW - 420 >= 592)
    await boxes(page, w)
    await shot(page, `f-dl-06-messenger-${d}-${w}`)
    await closeDoc(page)
    await page.locator('[data-test="msg-close"]:visible, .thd .x[aria-label="닫기"]:visible').first().click()
    await expect(messenger(page)).toHaveCount(0)
  }
  expect(page.errors).toEqual([])
})
