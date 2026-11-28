// 운영 화면(2026-11-24): 메신저를 왼쪽에 붙여 두고 폴더 탭에서 「이력서」 폴더를 연 채로 — 「폴더내의 파일을 드래그앤드롭하면 멘션이 이루어져서 대화방에
// 공유됨 (파일첨부가 아닌 링크로 멘션됨). 그리고 "@"하여 AI 를 지칭하여 … "… 이력서 첨부해" 같은 명령을 보내면 이러한 멘션이나 관련 자료를 첨부할 수
// 있음. 이는 회의실내에서도 AI 에게 도움을 요청하는 액션들과 동일함.」 · 「마찬가지 프로젝트나 채팅에서의 산출물을 끌어다 놓기도 가능함.」 ·
// 「대화창에 받은 파일에서 드래그하여 폴더에 넣기, AI 창에 넣기도 가능하지 (모두 멘션)」.
// 끌기는 Playwright 의 DataTransfer 끌기 이벤트(`dragstart` 를 끄는 줄에, `dragenter` · `dragover` · `drop` 을 놓는 곳에)로 시험한다 — 화면의
// dragstart 가 앱의 끌기 내용(application/x-pgl-file)을 싣는다. 사람 이름 · 파일은 지어낸 것이다.
// 서버는 가짜 모델(PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59961>/v1)과 가짜 deepagents(PRO_DEEPAGENTS_URL=
// http://127.0.0.1:<RT_FAKE_AGENT_PORT, 기본 59962>)로 띄운다 — 둘 다 이 파일이 띄운다. 같은 포트를 쓰는 다른 시험과 동시에 돌리지 않는다.
// 스펙 openspec/specs/messenger-file-mention, 서버 시험 server/test/fileMention.test.js · fileMention.integration.test.js
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, api, uniq } from '../../lib/fixtures.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WIDE = { width: 1440, height: 900 }
const HUGE = { width: 1920, height: 1080 }
const PHONE = { width: 390, height: 844 }
const LLM_PORT = Number(process.env.RT_FAKE_LLM_PORT || 59961)
const AGENT_PORT = Number(process.env.RT_FAKE_AGENT_PORT || 59962)
const SHOTS = path.resolve(here, '../../../openspec/specs/messenger-file-mention/e2e/results')
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}
test.describe.configure({ mode: 'serial' })

// ---- the fake model: first-token odds for the option holding the word wanted for that question; JSON otherwise ----
const fake = { want: { '무엇을 해 달라는': '이미 있는 파일', '가리키는 자료': '차은솔' }, prompts: [] }
// ---- the fake deepagents: every /chat/stream body is kept, the answer is one line ----
const agent = { bodies: [] }
let llm, deep
test.beforeAll(async () => {
  llm = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let b = {}
      try { b = JSON.parse(body) } catch { /* not json */ }
      const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      fake.prompts.push(text)
      res.writeHead(200, { 'content-type': 'application/json' })
      if (b.logprobs) {
        const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
        const word = Object.entries(fake.want).find(([qn]) => text.includes(qn))?.[1]
        const hit = options.find((o) => word && o.label.includes(word)) || options.at(-1) || { letter: 'A' }
        const other = options.find((o) => o.letter !== hit.letter)?.letter || 'B'
        return res.end(JSON.stringify({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, logprob: Math.log(0.9), top_logprobs: [{ token: hit.letter, logprob: Math.log(0.9) }, { token: other, logprob: Math.log(0.1) }] }] } }] }))
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ answer: '네, 말씀해 주세요.', name: '받은 문서', why: '모을 곳' }) }, finish_reason: 'stop' }] }))
    })
  })
  deep = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      if (!req.url.endsWith('/chat/stream')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{}') }
      try { agent.bodies.push(JSON.parse(body)) } catch { /* not json */ }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`event: metadata\ndata: ${JSON.stringify({ conversation_id: `fm${Date.now()}` })}\n\n`)
      res.write(`data: ${JSON.stringify({ type: 'token', content: '가리키신 파일을 읽었어요. 경력 7년의 백엔드 개발자예요.' })}\n\n`)
      res.end()
    })
  })
  await new Promise((ok, no) => llm.once('error', no).listen(LLM_PORT, '127.0.0.1', ok))
  await new Promise((ok, no) => deep.once('error', no).listen(AGENT_PORT, '127.0.0.1', ok))
})
test.afterAll(async () => { await new Promise((ok) => llm?.close(ok)); await new Promise((ok) => deep?.close(ok)) })

const member = async (c) => { await c.get('/team'); return c }
const DOCX = fs.readFileSync(path.resolve(here, '../../fixtures/Moonlight Coffee Store 2 proposal.docx'))
const put = async (c, slug, p, buf) => {
  const u = await api.call(c.token(), 'POST', `/folders/${slug}/files?path=${encodeURIComponent(p)}`, buf, { headers: { 'Content-Type': 'application/octet-stream' } })
  expect(u.status, u.text).toBe(200)
}
// 윤태호(fm-owner) owns 「이력서」 · 서하린(fm-mate) reads it · 한도윤(fm-out) is not in it — all three in one conversation
async function cast(as, db, cleanup, { members = true } = {}) {
  const a = await member(await as('fm-owner')), b = await member(await as('fm-mate')), c = await member(await as('fm-out'))
  const name = `이력서 ${uniq('cv').slice(-5)}`
  const f = await a.post('/folders', { name, description: '지원자 이력서 · 포트폴리오' })
  expect(f.status, f.text).toBe(200)
  cleanup(() => db.q('delete from pro_folders where id=$1', [f.body.id]))
  await put(a, f.body.slug, '차은솔_이력서.docx', DOCX)
  await put(a, f.body.slug, '민도현_포트폴리오.pptx', Buffer.from('PK 민도현 포트폴리오'))
  await put(a, f.body.slug, '면접_질문.md', Buffer.from('# 면접 질문\n1. 결제 장애를 겪은 경험\n2. 협업 방식\n'))
  await put(a, f.body.slug, '지원자_목록.json', Buffer.from(JSON.stringify([{ 이름: '차은솔', 지원: '백엔드' }, { 이름: '민도현', 지원: '디자인' }], null, 1)))
  if (members) expect((await a.post(`/folders/${f.body.slug}/members`, { type: 'user', id: b.id, role: 'viewer' })).status).toBe(200)
  const title = `채용 회의 ${uniq('t').slice(-4)}`
  const t = await a.post('/team/threads', { members: [b.id, c.id], title })
  expect(t.status, t.text).toBe(200)
  cleanup(() => db.q('delete from chat_rooms where id=$1', [t.body.id]))
  return { a, b, c, folder: { ...f.body, name }, room: t.body.id, title }
}
// the messenger docked at the left edge (the user's screen), on this device
const dockLeft = (page) => page.addInitScript(() => { try { localStorage.setItem('pgl-messenger-dock', JSON.stringify({ dock: 'left', width: 420 })) } catch { /* none */ } })
async function openThread(page, title, { phone = false } = {}) {
  if (!(await page.locator('.ms').count())) {
    if (phone) { await page.locator('.seg button').filter({ hasText: '홈' }).click(); await page.locator('button.msgs').click() } else await page.locator('button.msg-btn').click()
    await page.locator('.ms').waitFor()
  }
  await page.locator('[data-test="msg-chip-all"]').click()
  await page.locator('.ms .th').filter({ hasText: title }).first().click()
  await page.locator('.ms .cmp textarea').waitFor()
}
const settled = (loc) => loc.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))).catch(() => {})
const calm = (page) => page.evaluate(() => Promise.all(document.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => {}))))
// a drag of the app: dragstart on the source (the page puts its payload on the DataTransfer), then over and onto the target
async function drag(page, source, target, { shotName, drop = true } = {}) {
  const dt = await page.evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer: dt })
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  // (the zones fade in)
  if (shotName) { await page.waitForTimeout(450); await shot(page, shotName) }
  if (drop) await target.dispatchEvent('drop', { dataTransfer: dt })
  await source.dispatchEvent('dragend', { dataTransfer: dt }).catch(() => {})
  return dt
}
// files from the computer (PR #31's drop): DataTransfer with File objects
async function dragFiles(page, target, files) {
  const dt = await page.evaluateHandle((fs) => {
    const d = new DataTransfer()
    for (const f of fs) d.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }))
    return d
  }, files.map((f) => ({ name: f.name, type: f.type || 'text/markdown', bytes: [...f.buf] })))
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  return { drop: () => target.dispatchEvent('drop', { dataTransfer: dt }) }
}
const row = (page, p) => page.locator(`[data-test="folder-file"][data-file="${p}"]`)
const conv = (page) => page.locator('.ms .pane .msgs')
const lastMsg = async (c, room) => (await c.get(`/team/threads/${room}/messages`)).body.messages.at(-1)
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

test.describe('파일 멘션 · 메신저의 @AI (spec messenger-file-mention)', () => {
  test('F-FM-01 폴더 옆에 붙인 메신저: 파일 줄을 대화에 끌어 놓으면 「여기에 놓으면 링크로 멘션해요」 → 링크 칩 → 보내면 받는 사람의 멘션 카드 → 열기', async ({ pageAs, as, db, cleanup }) => {
    const { a, b, folder, room, title } = await cast(as, db, cleanup)
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await dockLeft(page)
    await page.goto(`/folders/${folder.slug}`)
    await row(page, '차은솔_이력서.docx').waitFor()
    await openThread(page, title)
    await expect(page.locator('[data-test="messenger"]')).toHaveAttribute('data-dock', 'left')
    await calm(page)
    await shot(page, 'f-fm-01a-docked-beside-folder')
    // drag the row over the conversation: the zone says it will be a link
    await drag(page, row(page, '차은솔_이력서.docx'), conv(page), { shotName: 'f-fm-01b-drag-over', drop: false })
    await expect(page.locator('[data-test="msg-dropzone"]')).toContainText('여기에 놓으면 링크로 멘션해요')
    // (the folder's own upload zone does not light for its own row)
    await expect(page.locator('[data-test="folder-dropzone"]')).toHaveCount(0)
    await drag(page, row(page, '차은솔_이력서.docx'), conv(page))
    await expect(page.locator('[data-test="msg-dropzone"]')).toHaveCount(0)
    const chip = page.locator('[data-test="msg-ref-chip"][data-file="차은솔_이력서.docx"]')
    await expect(chip).toHaveAttribute('data-state', 'ready', { timeout: 15000 })
    await expect(chip).toContainText('링크')
    await expect(chip).toContainText(folder.name)
    // ⌘-click two more rows and drag one of them: both come
    await row(page, '민도현_포트폴리오.pptx').locator('button.fn').click({ modifiers: ['Meta'] })
    await row(page, '지원자_목록.json').locator('button.fn').click({ modifiers: ['Meta'] })
    await drag(page, row(page, '지원자_목록.json'), conv(page))
    await expect(page.locator('[data-test="msg-ref-chip"][data-state="ready"]')).toHaveCount(3, { timeout: 15000 })
    await page.locator('.ms .cmp textarea').fill('지원자 자료예요. 내일 면접 전에 봐 주세요')
    await settled(page.locator('.ms'))
    await shot(page, 'f-fm-01c-link-chips')
    await page.locator('[data-test="msg-send"]').click()
    await expect(page.locator('.ms .msg.mine [data-test="file-ref"]')).toHaveCount(3)
    await expect(page.locator('[data-test="msg-ref-chip"]')).toHaveCount(0)
    // the message carries references, not copies
    const sent = await lastMsg(a, room)
    expect(sent.kind).toBe('fileref')
    expect(sent.refs.map((r) => r.name).sort()).toEqual(['차은솔_이력서.docx', '민도현_포트폴리오.pptx', '지원자_목록.json'].sort())
    expect(sent.artifacts).toEqual([])
    expect(sent.refs[0].commit).toMatch(/^[0-9a-f]{40}$/)
    await shot(page, 'f-fm-01d-sent')
    // 서하린 (reads the folder): the mention cards, opened in the office panel
    const pb = await pageAs('fm-mate', { viewport: WIDE })
    await dockLeft(pb)
    await pb.goto('/chat')
    await pb.locator('.composer textarea').first().waitFor()
    await openThread(pb, title)
    const card = pb.locator('.ms .msg [data-test="file-ref"][data-file="차은솔_이력서.docx"]').last()
    await expect(card).toHaveAttribute('data-state', 'open')
    await expect(card).toContainText(folder.name)
    await shot(pb, 'f-fm-01e-recipient-card')
    await card.locator('[data-test="file-ref-open"]').click()
    await expect(pb.locator('[data-test="office-sheet"] .oef .name')).toHaveText('차은솔_이력서.docx')
    await expect(pb.locator('[data-test="office-sheet"] iframe')).toHaveAttribute('src', /\/office\/docs\/\?src=.*pgpt-pro%2Ffolders%2F/)
    // the docked messenger stays beside the document
    await expect(pb.locator('[data-test="messenger"]')).toBeVisible()
    await calm(pb)
    await shot(pb, 'f-fm-01f-recipient-opened')
    // a file with no editor in the app opens in its folder at that file
    await pb.locator('.ms .msg [data-test="file-ref"][data-file="지원자_목록.json"] [data-test="file-ref-open"]').last().click()
    await expect(pb).toHaveURL(new RegExp(`/folders/${folder.slug}\\?file=`))
    const preview = pb.locator('.veil .sheet').filter({ hasText: '지원자_목록.json' })
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('민도현')
    await calm(pb)
    await shot(pb, 'f-fm-01g-recipient-folder-file')
    expect(page.errors).toEqual([])
    expect(pb.errors).toEqual([])
    expect((await b.get(`/team/threads/${room}/messages`)).body.messages.at(-1).refs[0].state.card).toBe('open')
  })

  test('F-FM-02 컴퓨터의 파일은 그대로 올라간다(PR #31) — 앱의 파일과 끌기 종류로 가린다', async ({ pageAs, as, db, cleanup }) => {
    const { folder, title } = await cast(as, db, cleanup)
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await dockLeft(page)
    await page.goto(`/folders/${folder.slug}`)
    await row(page, '차은솔_이력서.docx').waitFor()
    await openThread(page, title)
    const name = `면접_일정-${uniq('d').slice(-4)}.md`
    const d = await dragFiles(page, conv(page), [{ name, buf: Buffer.from('# 면접 일정\n- 화 14:00\n') }])
    await expect(page.locator('[data-test="msg-dropzone"]')).toContainText('여기에 놓으면 보내요')
    await d.drop()
    await expect(page.locator('[data-test="msg-upload-chip"]').filter({ hasText: name })).toHaveAttribute('data-state', 'ready')
    await expect(page.locator('[data-test="msg-ref-chip"]')).toHaveCount(0)
    await page.locator('[data-test="msg-send"]').click()
    await expect(page.locator('.ms .msg.mine [data-test="msg-file"]').filter({ hasText: name })).toBeVisible()
    expect(page.errors).toEqual([])
  })

  test('F-FM-03 @ 를 치면 「AI」와 대화의 사람들 → AI 칩 → 「이력서 첨부해」 → 「AI가 찾는 중…」 → AI 가 파일 멘션을 올린다', async ({ pageAs, as, db, cleanup }) => {
    const { a, c, title, room, folder } = await cast(as, db, cleanup)
    fake.prompts = []
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await dockLeft(page)
    await page.goto(`/folders/${folder.slug}`)
    await row(page, '차은솔_이력서.docx').waitFor()
    await openThread(page, title)
    const box = page.locator('.ms .cmp textarea')
    await box.click()
    await box.pressSequentially('@')
    const list = page.locator('[data-test="msg-at-list"]')
    await expect(list).toBeVisible()
    await expect(list.locator('[data-test="msg-at-ai"]')).toContainText('AI')
    await expect(list.locator('[data-test="msg-at-person"]')).toHaveCount(2)
    await settled(page.locator('.ms'))
    await shot(page, 'f-fm-03a-at-list')
    await box.press('Enter')
    await expect(page.locator('[data-test="msg-ai-chip"]')).toBeVisible()
    await box.pressSequentially('차은솔 이력서 첨부해')
    await shot(page, 'f-fm-03b-ai-chip')
    await box.press('Enter')
    // my message reads 「@AI …」, then the AI answers in the room with the file as a link
    await expect(page.locator('.ms .msg.mine [data-test="msg-text"]').last()).toHaveText('@AI 차은솔 이력서 첨부해')
    const ai = page.locator('.ms .msg.agent').filter({ hasText: '✦ AI' }).last()
    await expect(ai.locator('[data-test="file-ref"][data-file="차은솔_이력서.docx"]')).toBeVisible({ timeout: 20000 })
    await expect(ai).toContainText('링크로 멘션했어요')
    // 한도윤 is not in the folder: the AI says so
    await expect(ai).toContainText('폴더 권한이 없어')
    await expect(page.locator('[data-test="ai-status"]')).toHaveCount(0)
    await settled(page.locator('.ms'))
    await shot(page, 'f-fm-03c-ai-attached')
    const m = await lastMsg(a, room)
    expect(m.sender).toMatchObject({ name: 'AI', ai: true })
    expect(m.refs.map((r) => r.name)).toEqual(['차은솔_이력서.docx'])
    // the judge was asked what the request wants, then which file — nothing of a folder the asker cannot read
    expect(fake.prompts.some((p) => p.includes('무엇을 해 달라는'))).toBe(true)
    expect(fake.prompts.some((p) => p.includes('가리키는 자료는'))).toBe(true)
    // 한도윤's view of the same answer: 「폴더 권한이 없어요 · 권한 요청」
    const mc = await lastMsg(c, room)
    expect(mc.refs[0].state.card).toMatch(/noaccess|requested/)
    expect(page.errors).toEqual([])
  })

  test('F-FM-04 권한 없는 사람: 「폴더 권한이 없어요 · 권한 요청」 → 「권한을 요청했어요」(폴더 주인에게 알림) · 바뀐 파일은 「최신 열기」', async ({ pageAs, as, db, cleanup }) => {
    const { a, b, c, folder, room, title } = await cast(as, db, cleanup)
    cleanup(() => db.q(`delete from notifications where type='folder_access' and url like $1`, [`/folders/${folder.slug}?%`]))
    const ref = (await a.post('/files/resolve', { items: [{ src: 'folder', slug: folder.slug, path: '차은솔_이력서.docx' }] })).body.items[0].ref
    expect((await a.post(`/team/threads/${room}/messages`, { text: '이력서 링크예요', refs: [ref] })).status).toBe(200)
    // 한도윤
    const pc = await pageAs('fm-out', { viewport: WIDE })
    await dockLeft(pc)
    await pc.goto('/chat')
    await pc.locator('.composer textarea').first().waitFor()
    await openThread(pc, title)
    const card = pc.locator('.ms .msg [data-test="file-ref"]').last()
    await expect(card).toHaveAttribute('data-state', 'noaccess')
    await expect(card.locator('[data-test="file-ref-noaccess"]')).toContainText('폴더 권한이 없어요')
    await expect(card.locator('[data-test="file-ref-open"]')).toBeDisabled()
    await settled(pc.locator('.ms'))
    await shot(pc, 'f-fm-04a-noaccess')
    await card.locator('[data-test="file-ref-request"]').click()
    await expect(card).toHaveAttribute('data-state', 'requested')
    await expect(card).toContainText('권한을 요청했어요')
    await shot(pc, 'f-fm-04b-requested')
    // the owner got the notice that opens the folder's 공유 with 한도윤 picked
    const [n] = await db.q(`select * from notifications where user_id=$1 and type='folder_access' and url=$2`, [a.id, `/folders/${folder.slug}?share=${c.id}`])
    expect(n?.title).toContain(folder.name)
    const pa = await pageAs('fm-owner', { viewport: WIDE })
    await pa.goto(`/folders/${folder.slug}?share=${c.id}`)
    await expect(pa.locator('.sel.grow')).toHaveValue(c.id)
    await shot(pa, 'f-fm-04c-owner-share-sheet')
    // (PR #45 review) the request leaves the address once the sheet is open, and the sheet closes for good — the folder loading again
    // (a drop on it reloads it) does not bring it back
    await expect(pa).not.toHaveURL(/share=/)
    await pa.locator('.veil .hd button[title="닫기"]').click()
    await expect(pa.locator('.sel.grow')).toHaveCount(0)
    const mid = (await a.get(`/team/threads/${room}/messages`)).body.messages.find((m) => m.refs?.length).id
    const dt = await pa.evaluateHandle((it) => { const d = new DataTransfer(); d.setData('application/x-pgl-file', JSON.stringify({ v: 1, items: [it] })); return d },
      { src: 'ref', messageId: mid, index: 0, name: '차은솔_이력서.docx' })
    for (const t of ['dragenter', 'dragover', 'drop']) await pa.locator('[data-test="folder-detail"] .files').dispatchEvent(t, { dataTransfer: dt })
    await expect(pa.locator('.toast').first()).toContainText('이미 이 폴더의 파일이에요')
    await pa.waitForTimeout(600)
    await expect(pa.locator('.sel.grow')).toHaveCount(0)
    // the file changes after the mention: 서하린 sees 「최신 열기」
    await put(a, folder.slug, '차은솔_이력서.docx', Buffer.concat([DOCX, Buffer.from(' ')]))
    const pb = await pageAs('fm-mate', { viewport: WIDE })
    await dockLeft(pb)
    await pb.goto('/chat')
    await pb.locator('.composer textarea').first().waitFor()
    await openThread(pb, title)
    const cb = pb.locator('.ms .msg [data-test="file-ref"]').last()
    await expect(cb).toHaveAttribute('data-state', 'changed')
    await expect(cb.locator('[data-test="file-ref-latest"]')).toHaveText('최신 열기')
    await shot(pb, 'f-fm-04d-changed')
    expect((await b.post('/team/refs/open', { messageId: (await lastMsg(b, room)).id, index: 0 })).body.ref).toBe(ref.commit)
    expect((await b.post('/team/refs/open', { messageId: (await lastMsg(b, room)).id, index: 0, latest: true })).body.ref).toBe('main')
    expect(pc.errors).toEqual([])
  })

  test('F-FM-05 채팅의 파일 카드 · 산출물 더미(펼친 부채) · 오른쪽 목록을 대화에 끌어 놓으면 공유 칩 → 받는 사람이 그 파일을 연다', async ({ pageAs, as, db, cleanup }) => {
    const { a, b, title, room } = await cast(as, db, cleanup)
    // three artifacts of mine in the main chat (stored files: shared as copies — the share path that exists)
    const main = await db.clearMain(a.id)
    const cards = []
    for (const n of ['그린리프_견적서.md', '교육장_배치도.md', '클라우드_강의준비안.md']) {
      const up = await api.call(a.token(), 'POST', '/team/uploads', Buffer.from(`# ${n}\n내용\n`), { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(n), 'X-File-Type': 'text/markdown' } })
      const [c0] = await db.q('select content from pro_messages where id=$1', [up.body.id])
      cards.push((await db.addMessages(main, [{ role: 'agent', kind: 'file', content: { name: n, url: c0.content.url } }]))[0])
    }
    // (1) the chat's file card — a 1440px page with the messenger docked: the files are a pile
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await dockLeft(page)
    await page.goto('/chat')
    await page.locator('.composer textarea').first().waitFor()
    await openThread(page, title)
    const fileCard = page.locator('[data-test="file-card"][data-file="그린리프_견적서.md"]').first()
    await fileCard.scrollIntoViewIfNeeded()
    await drag(page, fileCard, conv(page), { shotName: 'f-fm-05a-card-over', drop: false })
    await expect(page.locator('[data-test="msg-dropzone"]')).toContainText('여기에 놓으면 공유해요')
    await drag(page, fileCard, conv(page))
    await expect(page.locator('[data-test="msg-share-chip"][data-file="그린리프_견적서.md"]')).toContainText('공유')
    // (2) the pile, fanned out
    await page.locator('[data-test="pile"]').click({ force: true })
    const fanItem = page.locator('[data-test="pile-item"][data-file="교육장_배치도.md"]')
    await expect(fanItem).toBeVisible()
    // (the fan's tiles bob for ever — no waiting for their animations to end)
    await page.waitForTimeout(600)
    await drag(page, fanItem, conv(page), { shotName: 'f-fm-05b-fan-over' })
    await expect(page.locator('[data-test="msg-share-chip"][data-file="교육장_배치도.md"]')).toBeVisible()
    await page.locator('.ms .cmp textarea').fill('견적서랑 배치도예요')
    await shot(page, 'f-fm-05c-share-chips')
    await page.locator('[data-test="msg-send"]').click()
    await expect(page.locator('.ms .msg.mine [data-test="msg-file"]')).toHaveCount(2)
    const sent = await lastMsg(a, room)
    expect(sent.kind).toBe('share')
    expect(sent.artifacts.map((x) => x.name)).toEqual(['그린리프_견적서.md', '교육장_배치도.md'])
    // (3) the right-hand list — a wider window
    const wide = await pageAs('fm-owner', { viewport: HUGE })
    await dockLeft(wide)
    await wide.goto('/chat')
    await wide.locator('.composer textarea').first().waitFor()
    await openThread(wide, title)
    const listRow = wide.locator('[data-testid="artifact-drag"][data-file="클라우드_강의준비안.md"]')
    await expect(listRow).toBeVisible()
    await drag(wide, listRow, wide.locator('.ms .pane .msgs'), { shotName: 'f-fm-05d-list-over' })
    await expect(wide.locator('[data-test="msg-share-chip"][data-file="클라우드_강의준비안.md"]')).toBeVisible()
    await wide.locator('[data-test="msg-send"]').click()
    await expect.poll(async () => (await lastMsg(a, room)).artifacts?.[0]?.name).toBe('클라우드_강의준비안.md')
    // 서하린 opens the shared file (her copy)
    const got = (await b.get(`/team/threads/${room}/messages`)).body.messages.filter((m) => m.kind === 'share')
    const opened = await b.post(`/team/shares/${got.at(-1).artifacts[0].shareId}/open`)
    expect(opened.status, opened.text).toBe(200)
    expect(opened.body.message.content.name).toBe('클라우드_강의준비안.md')
    expect(page.errors).toEqual([])
    expect(wide.errors).toEqual([])
  })

  test('F-FM-06 받은 파일(메신저)을 폴더에 끌어 놓으면 「‘<폴더>’에 넣었어요 · 열기」 — 내 이름의 커밋 · 보기 권한 폴더는 넣지 않음', async ({ pageAs, as, db, cleanup }) => {
    const { a, b, folder, title, room } = await cast(as, db, cleanup)
    // 서하린 sends a file in the conversation; 윤태호 drags it from the messenger into 「이력서」
    const up = await api.call(b.token(), 'POST', '/team/uploads', Buffer.from('# 추천서\n차은솔 님을 추천합니다.\n'), { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('차은솔_추천서.md'), 'X-File-Type': 'text/markdown' } })
    expect((await b.post(`/team/threads/${room}/messages`, { text: '추천서 받았어요', artifactIds: [up.body.id] })).status).toBe(200)
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await dockLeft(page)
    await page.goto(`/folders/${folder.slug}`)
    await row(page, '차은솔_이력서.docx').waitFor()
    await openThread(page, title)
    const chip = page.locator('.ms .msg [data-test="msg-file"][data-file="차은솔_추천서.md"]').last()
    await drag(page, chip, page.locator('[data-test="folder-detail"] .files'), { shotName: 'f-fm-06a-folder-over', drop: false })
    await expect(page.locator('[data-test="folder-dropzone"]')).toContainText('이 폴더에 넣기')
    await drag(page, chip, page.locator('[data-test="folder-detail"] .files'))
    await expect(page.locator('[data-test="folder-filed"]')).toContainText(`‘${folder.name}’에 넣었어요`)
    await expect(row(page, '차은솔_추천서.md')).toBeVisible()
    await shot(page, 'f-fm-06b-filed')
    await page.locator('[data-test="folder-filed-open"]').click()
    await expect(page.locator('body')).toContainText('차은솔 님을 추천합니다')
    const hist = (await a.get(`/folders/${folder.slug}`)).body.history
    expect(hist[0]).toMatchObject({ name: '회귀-fm-owner' })
    expect(hist[0].msg).toContain('정리: 차은솔_추천서.md')
    // 서하린 only reads 「이력서」: the zone says why, nothing goes in
    const pb = await pageAs('fm-mate', { viewport: WIDE })
    await dockLeft(pb)
    await pb.goto(`/folders/${folder.slug}`)
    await row(pb, '차은솔_이력서.docx').waitFor()
    await openThread(pb, title)
    const mine = pb.locator('.ms .msg [data-test="msg-file"][data-file="차은솔_추천서.md"]').last()
    await drag(pb, mine, pb.locator('[data-test="folder-detail"] .files'), { drop: false })
    await expect(pb.locator('[data-test="folder-dropzone"]')).toContainText('편집 권한이 있어야')
    await shot(pb, 'f-fm-06c-viewer-refused')
    const no = await b.post(`/folders/${folder.slug}/drop`, { items: [{ src: 'card', id: up.body.id }] })
    expect(no.status).toBe(403)
    expect(no.body.error).toContain('편집 권한이 필요해요')
    expect(page.errors).toEqual([])
  })

  test('F-FM-07 받은 멘션(폴더 파일)을 AI 채팅에 끌어 놓으면 칩 → 보낸 말에 칩 → 에이전트가 그 파일을 읽을 곳을 받는다 · 못 읽는 사람의 칩은 까닭', async ({ pageAs, as, db, cleanup }) => {
    const { a, c, folder, title, room } = await cast(as, db, cleanup)
    const ref = (await a.post('/files/resolve', { items: [{ src: 'folder', slug: folder.slug, path: '면접_질문.md' }] })).body.items[0].ref
    expect((await a.post(`/team/threads/${room}/messages`, { text: '면접 질문 초안', refs: [ref] })).status).toBe(200)
    await db.clearMain(a.id)
    agent.bodies = []
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await dockLeft(page)
    await page.goto('/chat')
    const composer = page.locator('[data-test="chat-composer"]').last()
    await composer.locator('textarea').waitFor()
    await openThread(page, title)
    const card = page.locator('.ms .msg [data-test="file-ref"][data-file="면접_질문.md"]').last()
    await drag(page, card, composer.locator('textarea'), { shotName: 'f-fm-07a-chat-over', drop: false })
    await expect(composer.locator('[data-test="chat-dropzone"]')).toContainText('AI에게 이 파일로 묻기')
    await drag(page, card, composer.locator('textarea'))
    const chip = composer.locator('[data-test="chat-ref-chip"][data-file="면접_질문.md"]')
    await expect(chip).toHaveAttribute('data-state', 'ready')
    await composer.locator('textarea').fill('이 질문에 하나 더 보태 줘')
    await shot(page, 'f-fm-07b-chat-chip')
    await composer.locator('textarea').press('Enter')
    // the sent message keeps the chip; the agent got where to read the file (the folder tools, with my access)
    await expect(page.locator('[data-test="sent-ref"][data-file="면접_질문.md"]')).toBeVisible()
    await expect.poll(() => agent.bodies.length, { timeout: 30000 }).toBeGreaterThan(0)
    const said = agent.bodies.at(-1).message
    expect(said).toContain('이 질문에 하나 더 보태 줘')
    expect(said).toContain(`folder_read 도구(folder: '${folder.slug}', path: '면접_질문.md')`)
    await expect(page.locator('.bubble.agent').last()).toContainText('가리키신 파일을 읽었어요')
    await calm(page)
    await page.waitForTimeout(600)
    await shot(page, 'f-fm-07c-agent-answered')
    // 한도윤 cannot read 「이력서」: the chip says why, and nothing of it reaches the agent
    const r = await c.post('/files/resolve', { items: [{ src: 'ref', messageId: (await lastMsg(c, room)).id, index: 0, name: '면접_질문.md' }] })
    expect(r.body.items[0]).toMatchObject({ ok: false, status: 403 })
    expect(r.body.items[0].error).toContain('폴더 권한이 없어요')
    expect(page.errors).toEqual([])
  })

  test('F-FM-08 채팅의 파일 카드를 프로젝트의 폴더 막대에 끌어 놓으면 그 폴더에 들어간다', async ({ pageAs, as, db, cleanup }) => {
    const { a, folder } = await cast(as, db, cleanup, { members: false })
    // a project working in 「이력서」, with a file card of mine in its conversation
    const t = await a.post('/threads', { text: '채용 준비', folder: folder.id })
    expect(t.status, t.text).toBe(200)
    cleanup(() => db.q('delete from pro_threads where id=$1', [t.body.id]))
    const up = await api.call(a.token(), 'POST', '/team/uploads', Buffer.from('# 채용 공고\n백엔드 개발자\n'), { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent('채용공고_초안.md'), 'X-File-Type': 'text/markdown' } })
    const [c0] = await db.q('select content from pro_messages where id=$1', [up.body.id])
    await db.addMessages(t.body.id, [{ role: 'agent', kind: 'file', content: { name: '채용공고_초안.md', url: c0.content.url } }])
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await page.goto(`/projects/${t.body.id}`)
    const bar = page.locator('[data-testid="project-folder-bar"]')
    await expect(bar).toBeVisible()
    const fileCard = page.locator('[data-test="file-card"][data-file="채용공고_초안.md"]').first()
    await drag(page, fileCard, bar, { shotName: 'f-fm-08a-bar-over', drop: false })
    await expect(page.locator('[data-test="project-folder-drop"]')).toHaveText('이 폴더에 넣기')
    await drag(page, fileCard, bar)
    await expect(page.locator('[data-testid="chat-notice"]')).toContainText(`‘${folder.name}’에 넣었어요 · 채용공고_초안.md`)
    await shot(page, 'f-fm-08b-bar-filed')
    expect((await a.get(`/folders/${folder.slug}/tree`)).body.map((x) => x.path)).toContain('채용공고_초안.md')
    expect(page.errors).toEqual([])
  })

  test('F-FM-11 확인 중인 칩은 기다렸다가 그 말과 함께 · 다른 보내기 길은 입력창의 칩을 가져가지 않음 · 빈 요청은 400 (PR #45 리뷰)', async ({ pageAs, as, db, cleanup }) => {
    const { a, folder } = await cast(as, db, cleanup, { members: false })
    await db.clearMain(a.id)
    agent.bodies = []
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await page.goto('/chat')
    const comp = page.locator('[data-test="chat-composer"]').last()
    await comp.locator('textarea').waitFor()
    // the server answers the check slowly: the chip says 「확인하는 중…」 for a while
    await page.route('**/api/files/resolve', async (route) => { await new Promise((ok) => setTimeout(ok, 1500)); await route.continue() })
    const drop = async (path) => {
      const dt = await page.evaluateHandle((it) => { const d = new DataTransfer(); d.setData('application/x-pgl-file', JSON.stringify({ v: 1, items: [it] })); return d },
        { src: 'folder', slug: folder.slug, folder: folder.name, path, name: path })
      for (const t of ['dragenter', 'dragover', 'drop']) await comp.locator('textarea').dispatchEvent(t, { dataTransfer: dt })
    }
    await drop('면접_질문.md')
    await expect(comp.locator('[data-test="chat-ref-chip"]')).toHaveAttribute('data-state', 'wait')
    // Enter at once: the message waits for the file, then goes with it (before: the file was dropped silently)
    await comp.locator('textarea').fill('이 질문 정리해 줘')
    await comp.locator('textarea').press('Enter')
    await expect.poll(() => agent.bodies.length, { timeout: 30000 }).toBeGreaterThan(0)
    expect(agent.bodies.at(-1).message).toContain(`folder_read 도구(folder: '${folder.slug}', path: '면접_질문.md')`)
    await expect(page.locator('[data-test="sent-ref"][data-file="면접_질문.md"]')).toBeVisible()
    await expect(comp.locator('[data-test="chat-ref-chip"]')).toHaveCount(0)
    // a chip in the composer stays there when something else sends (a reply button, 「다시 시도해 줘」, an open document's request …)
    await page.unroute('**/api/files/resolve')
    await drop('지원자_목록.json')
    await expect(comp.locator('[data-test="chat-ref-chip"]')).toHaveAttribute('data-state', 'ready')
    const n = agent.bodies.length
    await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app').send('다른 길로 보낸 말'))
    await expect.poll(() => agent.bodies.length, { timeout: 30000 }).toBeGreaterThan(n)
    expect(agent.bodies.at(-1).message).toContain('다른 길로 보낸 말')
    expect(agent.bodies.at(-1).message).not.toContain('지원자_목록.json')
    await expect(comp.locator('[data-test="chat-ref-chip"][data-file="지원자_목록.json"]')).toBeVisible()
    // nothing to send: refused, and nothing goes to the agent
    const main = await db.mainThreadId(a.id)
    const empty = await api.call(a.token(), 'POST', `/threads/${main}/messages`, { text: '  ' })
    expect(empty.status).toBe(400)
    // only dragged files, none usable (another person's card): no empty turn either
    const m = agent.bodies.length
    const r = await api.call(a.token(), 'POST', `/threads/${main}/messages`, { text: '', refs: [{ src: 'card', id: '00000000-0000-4000-8000-000000000000' }] }, { raw: true })
    expect(await r.text()).toContain('event: error')
    await page.waitForTimeout(800)
    expect(agent.bodies.length).toBe(m)
    expect(page.errors).toEqual([])
  })

  test('F-FM-12 멘션한 변형의 파일은 「변형 「<이름>」 · 반영 전」으로 열린다 (PR #45 리뷰: 「변형 반영 전 변형」)', async ({ pageAs, as, db, cleanup }) => {
    const { a, folder } = await cast(as, db, cleanup, { members: false })
    const v = await a.post(`/folders/${folder.slug}/variations`, { title: '강의 준비' })
    expect(v.status, v.text).toBe(200)
    const page = await pageAs('fm-owner', { viewport: WIDE })
    await page.goto(`/folders/${folder.slug}?file=${encodeURIComponent('지원자_목록.json')}&ref=${v.body.id}`)
    const preview = page.locator('.veil .sheet').filter({ hasText: '지원자_목록.json' })
    await expect(preview).toContainText('「강의 준비」 · 반영 전')
    await expect(preview).not.toContainText('변형 반영 전 변형')
    await calm(page)
    await shot(page, 'f-fm-12-variation-file')
    expect(page.errors).toEqual([])
  })

  test('F-FM-10 휴대폰(390px) 채팅 입력창: 놓은 파일 칩 · 에이전트 고르기 줄 · 보내기와 마이크가 겹치지 않는다 — 밝은 · 밤 테마', async ({ pageAs, as, db, cleanup }) => {
    const { folder } = await cast(as, db, cleanup, { members: false })
    for (const theme of ['light', 'dark']) {
      const page = await pageAs('fm-owner', { viewport: PHONE, touch: true })
      await page.addInitScript((th) => { try { localStorage.setItem('pgpt-pro-theme', th) } catch { /* none */ } }, theme)
      await page.goto('/chat')
      await page.locator('.seg button').filter({ hasText: '채팅' }).first().click().catch(() => {})
      const comp = page.locator('[data-test="chat-composer"]').last()
      await comp.locator('textarea').waitFor()
      // (a phone has no drag: the drop is the same DataTransfer event a desk's drag ends with)
      const dt = await page.evaluateHandle((it) => { const d = new DataTransfer(); d.setData('application/x-pgl-file', JSON.stringify({ v: 1, items: [it] })); return d },
        { src: 'folder', slug: folder.slug, folder: folder.name, path: '차은솔_이력서.docx', name: '차은솔_이력서.docx' })
      for (const t of ['dragenter', 'dragover', 'drop']) await comp.locator('textarea').dispatchEvent(t, { dataTransfer: dt })
      await expect(comp.locator('[data-test="chat-ref-chip"]')).toHaveAttribute('data-state', 'ready', { timeout: 15000 })
      await comp.locator('textarea').fill('이 이력서 요약해 줘')
      await page.waitForTimeout(500)
      const r = await page.evaluate(() => {
        const b = (sel) => { const e = document.querySelector(sel); if (!e) return null; const x = e.getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom } }
        return { chip: b('[data-test="chat-ref-chip"]'), row: b('.composer .agentrow'), box: b('.composer .box'), send: b('.composer .send'), mic: b('[data-testid="composer-mic"]'), sw: document.documentElement.scrollWidth, vw: innerWidth }
      })
      expect(r.sw).toBeLessThanOrEqual(r.vw)
      for (const k of ['chip', 'row', 'box']) expect(r[k].r, k).toBeLessThanOrEqual(PHONE.width)
      expect(r.chip.b).toBeLessThanOrEqual(r.row ? r.row.t : r.box.t)
      if (r.row) expect(r.row.b).toBeLessThanOrEqual(r.box.t)
      expect(r.send.r).toBeLessThanOrEqual(r.mic.l)
      await shot(page, `f-fm-10-phone-composer-${theme}`)
      expect(page.errors).toEqual([])
    }
  })

  test('F-FM-09 휴대폰(390px): @ 목록의 「AI」 · AI 칩 · 멘션 카드가 화면 안에 들어오고 열린다', async ({ pageAs, as, db, cleanup }) => {
    const { a, folder, title, room } = await cast(as, db, cleanup)
    const ref = (await a.post('/files/resolve', { items: [{ src: 'folder', slug: folder.slug, path: '차은솔_이력서.docx' }] })).body.items[0].ref
    expect((await a.post(`/team/threads/${room}/messages`, { text: '지원자 이력서 링크예요 — 면접 전에 꼭 봐 주세요', refs: [ref] })).status).toBe(200)
    const page = await pageAs('fm-mate', { viewport: PHONE, touch: true })
    await page.goto('/chat')
    await page.locator('.composer textarea').first().waitFor()
    await openThread(page, title, { phone: true })
    const card = page.locator('.ms .msg [data-test="file-ref"]').last()
    await expect(card).toHaveAttribute('data-state', 'open')
    const bb = await card.boundingBox()
    expect(bb.x).toBeGreaterThanOrEqual(0)
    expect(bb.x + bb.width).toBeLessThanOrEqual(PHONE.width)
    expect(await noOverflow(page)).toBe(true)
    await shot(page, 'f-fm-09a-phone-card')
    const box = page.locator('.ms .cmp textarea')
    await box.click()
    await box.pressSequentially('@')
    await expect(page.locator('[data-test="msg-at-ai"]')).toBeVisible()
    const lb = await page.locator('[data-test="msg-at-list"]').boundingBox()
    expect(lb.x + lb.width).toBeLessThanOrEqual(PHONE.width)
    await settled(page.locator('.ms'))
    await shot(page, 'f-fm-09b-phone-at')
    await page.locator('[data-test="msg-at-ai"]').click()
    await expect(page.locator('[data-test="msg-ai-chip"]')).toBeVisible()
    expect(await noOverflow(page)).toBe(true)
    await shot(page, 'f-fm-09c-phone-ai-chip')
    await card.locator('[data-test="file-ref-open"]').click()
    await expect(page.locator('[data-test="office-sheet"] .oef .name')).toHaveText('차은솔_이력서.docx')
    expect(page.errors).toEqual([])
  })
})
