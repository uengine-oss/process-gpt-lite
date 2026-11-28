// 운영 화면(2026-11-24): 메시지 › 대화(「윤태호, 서하린」)에 컴퓨터의 파일을 끌어다 놓아도 첨부되지 않았다(「끌어다놓기 첨부가 안되네」).
// 고친 뒤: 열린 대화에 놓거나 붙여 넣거나 「내 컴퓨터에서」로 고르면 바로 올라가고(진행 칩), 보내면 받는 사람이 그 파일을 받는다.
// 메신저 위로 끈 파일을 아래 채팅 입력창이 가져가지 않는다(채팅 화면 전체 놓기는 그대로).
// 그리고 대화로 들어온 문서(채팅 첨부 · 에이전트가 만든 파일 · 팀원이 보낸 파일 · 메일 첨부)에 판정 모델이 고른 폴더를
// 「‘견적서’에 정리할까요? (확신 N%)」로 권하고, 누르면 그 폴더 main 에 내 이름으로 들어간다. 맞는 폴더가 없으면 「새 폴더 만들기」.
// (2026-11-28 부터 채팅의 파일 카드는 줄 대신 카드의 메뉴 — 카드에 점, 메뉴에 「새 폴더를 만들어 정리: …」. 메신저 · 메일 시트는 그대로 줄)
// 이 묶음의 서버는 가짜 모델로 띄운다: PRO_LLM_BASE_URL=http://127.0.0.1:<RT_FAKE_LLM_PORT, 기본 59998>/v1 (이 파일이 그 포트에
// 가짜 모델을 띄움 — 보기 글자의 확률을 돌려줌). 같은 포트를 쓰는 mail-reply · mail-thread-flow 와 동시에 돌리지 않는다.
// 스펙 openspec/specs/messenger-drop-folder, 서버 시험 server/test/filing.integration.test.js
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, api, uniq } from '../../lib/fixtures.js'

const PHONE = { width: 390, height: 844 }
const PORT = Number(process.env.RT_FAKE_LLM_PORT || 59998)
const SHOTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../openspec/specs/messenger-drop-folder/e2e/results')
const shot = async (page, name) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) })
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
}

// the fake judge: the option whose label holds one of the words in `want` (the folder, then the sub-folder), else the last option
// (「새 폴더가 필요하다」 · 「폴더 맨 위」), at 0.9; any other call (a new folder's name) gets `name`
// (judged: the judge's first-token calls — the folder index also asks the model for document cards, in the background)
const fake = { want: [], name: '거래처 계약서', calls: 0, judged: 0 }
let server
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      fake.calls++
      let b = {}
      try { b = JSON.parse(body) } catch { /* not json */ }
      const text = (b.messages || []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n')
      res.writeHead(200, { 'content-type': 'application/json' })
      if (b.logprobs) {
        fake.judged++
        const options = [...text.matchAll(/^([A-Z])\) (.+)$/gm)].map((m) => ({ letter: m[1], label: m[2] }))
        const hit = options.find((o) => fake.want.some((w) => o.label.includes(w))) || options.at(-1) || { letter: 'A' }
        const other = options.find((o) => o.letter !== hit.letter)?.letter || 'B'
        return res.end(JSON.stringify({ choices: [{ message: { content: hit.letter }, logprobs: { content: [{ token: hit.letter, logprob: Math.log(0.9), top_logprobs: [{ token: hit.letter, logprob: Math.log(0.9) }, { token: other, logprob: Math.log(0.1) }] }] } }] }))
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ name: fake.name, why: '계약서를 모을 곳' }) }, finish_reason: 'stop' }] }))
    })
  })
  await new Promise((ok, no) => server.once('error', no).listen(PORT, '127.0.0.1', ok))
})
test.afterAll(async () => { await new Promise((ok) => server?.close(ok)) })

const member = async (c) => { await c.get('/team'); return c }
const QUOTE = Buffer.from('# 견적서 — 한빛상사 2층 교육장 인테리어\n\n| 품목 | 금액 |\n|---|---|\n| 설계비 | 3,000,000 |\n| 시공비 | 23,070,000 |\n\n합계 26,070,000원 · 유효기간 견적일로부터 30일\n')
const CONTRACT = Buffer.from('# 용역 계약서\n\n그린리프공방(갑)과 한울디자인(을)은 매장 리뉴얼 디자인 용역에 관하여 다음과 같이 계약한다.\n\n계약 금액 12,000,000원\n')
const sendFile = (c, name, buf, type = 'text/markdown') => api.call(c.token(), 'POST', '/team/uploads', buf, { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-File-Type': type } })
// a folder of mine with files in it (POST /folders, /folders/:slug/files)
async function folder(c, db, cleanup, name, files = {}, description = '') {
  const r = await c.post('/folders', { name, description })
  expect(r.status, r.text).toBe(200)
  cleanup(() => db.q('delete from pro_folders where id=$1', [r.body.id]))
  for (const [p, text] of Object.entries(files)) {
    const u = await api.call(c.token(), 'POST', `/folders/${r.body.slug}/files?path=${encodeURIComponent(p)}`, Buffer.from(text), { headers: { 'Content-Type': 'application/octet-stream' } })
    expect(u.status, u.text).toBe(200)
  }
  return r.body
}
// a drag of files from the computer: DataTransfer events on `target` (Playwright's drag simulation)
async function dragFiles(page, target, files) {
  const dt = await page.evaluateHandle((fs) => {
    const d = new DataTransfer()
    for (const f of fs) d.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }))
    return d
  }, files.map((f) => ({ name: f.name, type: f.type || 'text/markdown', bytes: [...f.buf] })))
  await target.dispatchEvent('dragenter', { dataTransfer: dt })
  await target.dispatchEvent('dragover', { dataTransfer: dt })
  return { drop: () => target.dispatchEvent('drop', { dataTransfer: dt }), leave: () => target.dispatchEvent('dragleave', { dataTransfer: dt }) }
}
const settled = (loc) => loc.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))).catch(() => {})
async function openThread(page, title, { phone = false } = {}) {
  if (phone) {
    await page.locator('.seg button').filter({ hasText: '홈' }).click()
    await page.locator('button.msgs').click()
  } else await page.locator('button.msg-btn').click()
  await page.locator('.ms').waitFor()
  await page.locator('[data-test="msg-chip-all"]').click()
  await page.locator('.ms .th').filter({ hasText: title }).first().click()
  await page.locator('.ms .cmp textarea').waitFor()
}

test.describe('메신저에서 컴퓨터의 파일 보내기 · 들어온 문서를 폴더에 정리 (spec messenger-drop-folder)', () => {
  test('F-MD-01 열린 대화에 파일을 끌어다 놓으면 「여기에 놓으면 보내요」 → 올리는 칩 → 보내면 받는 사람이 그 파일을 받는다', async ({ pageAs, as, db, cleanup }) => {
    const page = await pageAs('md-sender')
    const a = await member(page.user)
    const b = await member(await as('md-mate'))
    const t = await a.post('/team/threads', { members: [b.id] })
    expect(t.status, t.text).toBe(200)
    cleanup(() => db.q('delete from chat_rooms where id=$1', [t.body.id]))
    await page.goto('/chat')
    await page.locator('.composer textarea').first().waitFor()
    await openThread(page, '회귀-md-mate')
    const pane = page.locator('.ms .pane')
    const name = `견적서_한빛상사-${uniq('d')}.md`
    const drag = await dragFiles(page, pane.locator('.msgs'), [{ name, buf: QUOTE }])
    await expect(page.locator('[data-test="msg-dropzone"]')).toContainText('여기에 놓으면 보내요')
    // the chat's page-wide drop zone under the sheet does not show
    await expect(page.locator('.dropzone')).toHaveCount(0)
    await settled(page.locator('.ms'))
    await shot(page, 'f-md-01a-dropzone')
    await drag.drop()
    await expect(page.locator('[data-test="msg-dropzone"]')).toHaveCount(0)
    const chip = page.locator('[data-test="msg-upload-chip"]').filter({ hasText: name })
    await expect(chip).toHaveAttribute('data-state', 'ready')
    // nothing went into the chat composer under the sheet
    await expect(page.locator('.composer .atts .att')).toHaveCount(0)
    await page.locator('.ms .cmp textarea').fill('견적서 보내드려요')
    await settled(page.locator('.ms'))
    await shot(page, 'f-md-01b-chip')
    await page.locator('[data-test="msg-send"]').click()
    await expect(page.locator('.ms .msg.mine').filter({ hasText: name })).toBeVisible()
    await expect(chip).toHaveCount(0)
    await shot(page, 'f-md-01c-sent')
    // the recipient: the message with the file, and the same bytes
    let last
    await expect.poll(async () => { last = (await b.get(`/team/threads/${t.body.id}/messages`)).body.messages.at(-1); return last?.artifacts?.[0]?.name }).toBe(name)
    expect(last).toMatchObject({ body: '견적서 보내드려요', mine: false, kind: 'share', sender: { id: a.id } })
    const raw = await b.get(`/team/shares/${last.artifacts[0].shareId}/raw`, { raw: true })
    expect(raw.status).toBe(200)
    expect(Buffer.from(await raw.arrayBuffer())).toEqual(QUOTE)
    // the sender's main chat got nothing (the card is in the messenger files conversation)
    const main = await db.mainThreadId(a.id)
    expect((await db.q(`select count(*)::int n from pro_messages where thread_id=$1 and content->>'name'=$2`, [main, name]))[0].n).toBe(0)
    expect(page.errors).toEqual([])
  })

  test('F-MD-02 채팅 입력창은 메신저 위의 놓기를 가져가지 않는다 — 대화가 열려 있지 않으면 아무것도 안 하고, 메신저를 닫으면 채팅 전체 놓기는 그대로', async ({ pageAs, db }) => {
    const page = await pageAs('md-sender')
    await member(page.user)
    await db.clearMain(page.user.id)
    await page.goto('/chat')
    await page.locator('.composer textarea').first().waitFor()
    await page.locator('button.msg-btn').click()
    await page.locator('.ms').waitFor()
    // the list alone (no conversation open — any chip): nothing to send to — nothing is taken, the chat's zone does not show either
    const name = `메모-${uniq('m')}.md`
    const drag = await dragFiles(page, page.locator('.ms .side'), [{ name, buf: Buffer.from('메모') }])
    await expect(page.locator('.dropzone')).toHaveCount(0)
    await expect(page.locator('[data-test="msg-dropzone"]')).toHaveCount(0)
    await drag.drop()
    await expect(page.locator('.composer .atts .att')).toHaveCount(0)
    await expect(page.locator('[data-test="msg-upload-chip"]')).toHaveCount(0)
    // closed: the chat takes a drop anywhere on the page, as before
    await page.keyboard.press('Escape')
    await expect(page.locator('.ms')).toHaveCount(0)
    const drag2 = await dragFiles(page, page.locator('.composer textarea').first(), [{ name, buf: Buffer.from('메모') }])
    await expect(page.locator('.dropzone')).toContainText('여기에 놓으면 첨부돼요')
    await drag2.drop()
    await expect(page.locator('.composer .atts .att').filter({ hasText: name })).toBeVisible()
    await expect(page.locator('.composer .atts .att').filter({ hasText: name })).not.toHaveClass(/uploading/)
    expect(page.errors).toEqual([])
  })

  test('F-MD-03 받은 파일에 「‘견적서’에 정리할까요? (확신 N%)」 → 정리 → 폴더에 그 파일과 이력 · 채팅의 다른 문서는 「새 폴더 만들기」', async ({ pageAs, as, db, cleanup }) => {
    const a = await member(await as('md-sender'))
    const page = await pageAs('md-mate')
    const b = await member(page.user)
    await db.clearMain(b.id)
    const tag = uniq('f')
    const quotes = await folder(b, db, cleanup, `견적서 ${tag}`, { '2025/견적서_소망상사.md': '소망상사 견적 합계 1,200,000원', '2026/견적서_대한상사.md': '대한상사 교육장 견적 합계 8,000,000원' }, '고객에게 보낸 견적서')
    await folder(b, db, cleanup, `회의록 ${tag}`, { '주간회의_1117.md': '주간 회의록' }, '팀 회의록')
    // a sends a quote file in our conversation (the way the messenger does: upload, then the message)
    const t = await a.post('/team/threads', { members: [b.id] })
    cleanup(() => db.q('delete from chat_rooms where id=$1', [t.body.id]))
    const name = `견적서_한빛상사-${tag}.md`
    const up = await sendFile(a, name, QUOTE)
    expect(up.status, up.text).toBe(200)
    expect((await a.post(`/team/threads/${t.body.id}/messages`, { text: '견적서 보내드려요', artifactIds: [up.body.id] })).status).toBe(200)
    fake.want = [quotes.name, '2026']
    await page.goto('/chat')
    await page.locator('.composer textarea').first().waitFor()
    await openThread(page, '회귀-md-sender')
    const msg = page.locator('.ms .msg').filter({ hasText: name })
    const sug = msg.locator(`[data-test="folder-suggest"][data-file="${name}"]`)
    await expect(sug.locator('[data-test="filing-say"]')).toHaveText(`‘${quotes.name}/2026’에 정리할까요? (확신 90%)`)
    await settled(page.locator('.ms'))
    await shot(page, 'f-md-03a-suggest')
    await sug.locator('[data-test="filing-go"]').click()
    await expect(sug.locator('[data-test="filing-done"]')).toHaveText(`‘${quotes.name}’에 정리했어요`)
    await shot(page, 'f-md-03b-filed')
    // the folder has it, with b as its author
    const tree = (await b.get(`/folders/${quotes.slug}/tree`)).body
    expect(tree.map((f) => f.path)).toContain(`2026/${name}`)
    const detail = (await b.get(`/folders/${quotes.slug}`)).body
    expect(detail.history[0]).toMatchObject({ name: '회귀-md-mate', msg: `정리: 2026/${name}` })
    // 열기: the folder with the file open
    await sug.locator('[data-test="filing-open"]').click()
    await expect(page).toHaveURL(new RegExp(`/folders/${quotes.slug}\\?file=`))
    await expect(page.locator('.ms')).toHaveCount(0)
    const preview = page.locator('.folders .sheet')
    await expect(preview).toContainText(name)
    await settled(page.locator('.folders'))
    await shot(page, 'f-md-03c-folder')
    // the folder's 이력: the filing, by b
    await preview.evaluate(() => document.querySelector('.folders .sheet')?.closest('.veil')?.click())
    await page.locator('.folders .seg button').filter({ hasText: '이력' }).click()
    await expect(page.locator('.folders .hist .hr').first()).toContainText(`정리: 2026/${name}`)
    await expect(page.locator('.folders .hist .hr').first()).toContainText('회귀-md-mate')
    await shot(page, 'f-md-03e-history')
    // a second document in the AI chat that fits no folder: 「새 폴더 만들기」
    const main = await db.mainThreadId(b.id)
    const doc = await api.upload(b.token(), `용역계약서_그린리프-${tag}.md`, 'text/markdown', CONTRACT)
    await db.addMessages(main, [{ role: 'user', kind: 'text', content: { text: '그린리프공방 계약서 초안 정리해 줘' } }, { role: 'agent', kind: 'file', content: { name: doc.name, url: doc.url } }])
    fake.want = []
    fake.name = `거래처 계약서 ${tag}`
    await page.goto('/chat')
    const card = page.locator('.row.k-file').filter({ hasText: doc.name })
    // (2026-11-28 「… 폴더 정리 등 모든 것들 콘텍스트 메뉴로」) a chat card has no line under it: a dot while the suggestion waits, the
    // suggestion in the card's menu — right-clicked here (F-CM-02 · F-CM-03 hold it on a phone, its ⋯, the keyboard)
    await expect(card.locator('[data-test="filing-dot"]')).toBeVisible()
    await expect(card.locator('[data-test="folder-suggest"], [data-test="filing-say"]')).toHaveCount(0)
    await card.locator('button.file').click({ button: 'right' })
    const menu = page.locator('[data-test="file-menu"]')
    await expect(menu.locator('[data-test="file-menu-new-label"]')).toHaveText(`새 폴더를 만들어 정리: 거래처 계약서 ${tag}`)
    await settled(menu)
    await shot(page, 'f-md-03d-new-folder')
    await menu.locator('[data-test="file-menu-new"]').click()
    await expect(menu).toHaveCount(0)
    await expect(card.locator('[data-test="filing-done"]')).toHaveText(`‘거래처 계약서 ${tag}’에 정리했어요`)
    const [made] = await db.q(`select f.id, f.slug, m.role from pro_folders f join pro_folder_members m on m.folder_id=f.id and m.principal_id=$2 where f.tenant_id=$1 and f.name=$3`, [db.tenant, b.id, `거래처 계약서 ${tag}`])
    cleanup(() => db.q('delete from pro_folders where id=$1', [made.id]))
    expect(made.role).toBe('owner')
    expect((await b.get(`/folders/${made.slug}/tree`)).body.map((f) => f.path)).toContain(doc.name)
    // the verdict was made once per card: reloading asks nothing of the model
    const judged = fake.judged
    await page.reload()
    await expect(card.locator('[data-test="filing-done"]')).toBeVisible()
    await page.waitForTimeout(1500)
    expect(fake.judged, '판정 모델을 다시 부르지 않는다').toBe(judged)
    // someone else's card or a folder I only view: refused
    const [cardRow] = await db.q(`select id from pro_messages where thread_id=$1 and kind='file' order by created_at desc limit 1`, [main])
    expect((await a.post('/filing/suggest', { messageId: cardRow.id })).status).toBe(404)
    const theirs = await folder(a, db, cleanup, `윤태호 폴더 ${tag}`)
    await a.post(`/folders/${theirs.slug}/members`, { type: 'user', id: b.id, role: 'viewer' })
    expect((await b.post('/filing/file', { messageId: cardRow.id, slug: theirs.slug })).status).toBe(403)
    expect((await b.get(`/filing/folders?messageId=${cardRow.id}`)).body.map((f) => f.slug)).not.toContain(theirs.slug)
    expect(page.errors).toEqual([])
  })

  test('F-MD-04 휴대폰 폭: 「내 컴퓨터에서」 · 붙여 넣기로 보내고, 받은 쪽은 폴더 추천을 누른다 — 옆으로 넘치지 않는다', async ({ pageAs, db, cleanup }) => {
    const pa = await pageAs('md-phone-a', { viewport: PHONE, touch: true })
    const pb = await pageAs('md-phone-b', { viewport: PHONE, touch: true })
    const a = await member(pa.user), b = await member(pb.user)
    const t = await a.post('/team/threads', { members: [b.id] })
    cleanup(() => db.q('delete from chat_rooms where id=$1', [t.body.id]))
    const tag = uniq('p')
    const quotes = await folder(b, db, cleanup, `견적서 ${tag}`, { '견적서_대한상사.md': '대한상사 견적' }, '고객에게 보낸 견적서')
    await pa.goto('/chat')
    await openThread(pa, '회귀-md-phone-b', { phone: true })
    await pa.locator('[data-test="msg-clip"]').click()
    await expect(pa.locator('[data-test="msg-from-computer"]')).toContainText('내 컴퓨터에서')
    await shot(pa, 'f-md-04a-phone-menu')
    const name = `견적서_모바일-${tag}.md`
    await pa.locator('[data-test="msg-file-input"]').setInputFiles({ name, mimeType: 'text/markdown', buffer: QUOTE })
    await expect(pa.locator('[data-test="msg-upload-chip"]').filter({ hasText: name })).toHaveAttribute('data-state', 'ready')
    // pasting a file into the message box adds it too
    const pasted = `메모-${tag}.txt`
    await pa.locator('.ms .cmp textarea').evaluate((el, n) => {
      const d = new DataTransfer()
      d.items.add(new File(['붙여 넣은 메모'], n, { type: 'text/plain' }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }))
    }, pasted)
    await expect(pa.locator('[data-test="msg-upload-chip"]').filter({ hasText: pasted })).toHaveAttribute('data-state', 'ready')
    await shot(pa, 'f-md-04b-phone-chips')
    expect(await pa.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await pa.locator('[data-test="msg-send"]').click()
    await expect(pa.locator('.ms .msg.mine').filter({ hasText: name })).toBeVisible()
    // the recipient, on a phone
    fake.want = [quotes.name]
    await pb.goto('/chat')
    await openThread(pb, '회귀-md-phone-a', { phone: true })
    const sug = pb.locator(`.ms .msg [data-test="folder-suggest"][data-file="${name}"]`)
    await expect(pb.locator(`.ms .msg [data-test="folder-suggest"][data-file="${pasted}"]`), '보낸 파일마다 하나씩').toHaveCount(1)
    await expect(sug.locator('[data-test="filing-say"]')).toHaveText(`‘${quotes.name}’에 정리할까요? (확신 90%)`)
    expect(await pb.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await settled(pb.locator('.ms'))
    await shot(pb, 'f-md-04c-phone-suggest')
    // 다른 폴더 고르기 lists the folders I edit, and filing from there works too
    await sug.locator('[data-test="filing-other"]').click()
    await expect(sug.locator('[data-test="filing-pick"]')).toContainText(quotes.name)
    await sug.locator('[data-test="filing-pick"] .row').filter({ hasText: quotes.name }).click()
    await expect(sug.locator('[data-test="filing-done"]')).toHaveText(`‘${quotes.name}’에 정리했어요`)
    await shot(pb, 'f-md-04d-phone-filed')
    expect((await b.get(`/folders/${quotes.slug}/tree`)).body.map((f) => f.path)).toContain(name)
    expect(pa.errors).toEqual([])
    expect(pb.errors).toEqual([])
  })

  test('F-MD-05 서버: 파일 한 개 50MB · 빈 파일 400, 남의 카드는 보낼 수 없다(404)', async ({ as }) => {
    const a = await member(await as('md-sender')), b = await member(await as('md-mate'))
    expect((await sendFile(a, 'empty.md', Buffer.alloc(0))).status).toBe(400)
    const up = await sendFile(a, `x-${uniq('e')}.md`, Buffer.from('x'))
    expect(up.status).toBe(200)
    const t = await a.post('/team/threads', { members: [b.id] })
    expect((await b.post(`/team/threads/${t.body.id}/messages`, { text: '남의 카드', artifactIds: [up.body.id] })).status).toBe(404)
    const big = await api.call(a.token(), 'POST', '/team/uploads', Buffer.alloc(50 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'big.bin' } })
    expect(big.status).toBe(413)
  })
})
