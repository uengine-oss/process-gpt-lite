// 다국어 협업 — 주 언어(화면 언어와 따로), 회의 통역(자막 원문 + 번역, 통역 스위치, 듣기 방식, 음성 통로 표),
// 회의 기록·회의록의 언어별 읽기, 메신저 자동 번역(원문 보기). 말은 "말 대신 적기"(받아쓰기 뒤와 같은 길)로 넣는다.
// 가짜 마이크로 말하고 통역 음성을 듣는 실제 브라우저 여정은 agent 단계 A-15(tests/agent/interpretation.spec.js).
// 계정: pro-intl-*@uengine.org (e2e/lib/intl.js). 번역은 빠른 모델(gpt-4.1-mini) 몇 번.
// (server/lib/{mainLang,translate}.js, lib/meetings/{pairing,interpret,voice}.js, lib/team/roomTranslate.js
//  · 설계 process-gpt/openspec/changes/pgpt-pro-meeting-interpretation)
import WebSocket from 'ws'
import { test, expect, api } from '../../lib/fixtures.js'
import { person, openaiKey, HANGUL, KANA } from '../../lib/intl.js'
import { API_URL, PGPT_URL } from '../../lib/env.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const roomRows = (db, roomId, kind) => db.q(`select uuid, messages from chats where id=$1 and messages->'pgpt'->>'kind'=$2 order by public.pro_chat_ts(messages)`, [roomId, kind])
async function room(a, others, db, cleanup, title = '회귀 다국어 방') {
  const g = (await a.post('/team/threads', { members: others.map((o) => o.id), title })).body
  cleanup(() => db.q('delete from chat_rooms where id=$1', [g.id]))
  return g
}

test.describe('다국어 협업 (spec pgpt-pro-meeting-interpretation)', () => {
  test('F-IT-01 주 언어: 화면 언어와 따로 저장, 목록 밖은 400, 회의 참여자마다 언어, 섞이면 통역이 저절로 켜짐', async ({ db, cleanup }) => {
    const ko = await person('ko'), en = await person('en'), ja = await person('ja')
    const me = (await ja.get('/me')).body
    expect(me).toMatchObject({ mainLang: 'ja', mainLangSet: 'ja', lang: 'en' })
    expect((await ja.put('/me/main-lang', { lang: 'xx' })).status).toBe(400)
    expect((await ja.get('/me')).body.mainLang).toBe('ja')
    const g = await room(ko, [en, ja], db, cleanup)
    const s = (await ko.post(`/meetings/room/${g.id}/start`, { consent: true })).body
    expect(s.me.lang).toBe('ko')
    // alone (one language): interpretation is not on by itself
    expect(s.interp).toMatchObject({ on: false, mixed: false, setting: null })
    const j = (await en.post(`/meetings/${s.id}/join`, { consent: true })).body
    expect(j.interp).toMatchObject({ mixed: true, langs: ['ko', 'en'], listen: 'interp' })
    test.skip(!j.interp.available, '통역 키가 없는 서버 — 통역은 꺼진 채 원문 자막만')
    expect(j.interp.on).toBe(true)
    expect(j.peers.map((p) => [p.name, p.lang])).toEqual(expect.arrayContaining([['한지수', 'ko'], ['Emily Carter', 'en']]))
    // the switch (anyone in the meeting) and what I hear (mine only)
    expect((await en.put(`/meetings/${s.id}/interp`, { on: false })).body.on).toBe(false)
    expect((await ko.get(`/meetings/${s.id}`)).body.interp).toMatchObject({ on: false, setting: false })
    expect((await ko.put(`/meetings/${s.id}/interp`, { on: true })).body.on).toBe(true)
    expect((await en.put(`/meetings/${s.id}/listen`, { mode: 'original' })).body.listen).toBe('original')
    expect((await en.get(`/meetings/${s.id}`)).body.interp.listen).toBe('original')
    expect((await ko.get(`/meetings/${s.id}`)).body.interp.listen).toBe('interp')
    // the voice channel: a ticket only for someone in the meeting; the socket only from the app's own pages
    expect((await ja.post(`/meetings/${s.id}/voice/ticket`)).status).toBe(403)
    const t = (await en.post(`/meetings/${s.id}/voice/ticket`)).body.ticket
    expect(t).toMatch(/^[\w-]{20,}$/)
    const wsUrl = `${API_URL.replace(/^http/, 'ws')}/api/meetings/voice`
    const opened = (ticket, origin) => new Promise((resolve) => {
      const ws = new WebSocket(`${wsUrl}?ticket=${ticket}`, { headers: origin ? { Origin: origin } : {} })
      ws.on('open', () => ws.once('message', (d) => { resolve(JSON.parse(d.toString())); ws.close() }))
      ws.on('error', () => resolve(null)); ws.on('unexpected-response', () => resolve(null))
    })
    expect(await opened(t, 'https://evil.example')).toBeNull()
    const t2 = (await en.post(`/meetings/${s.id}/voice/ticket`)).body.ticket
    expect(await opened(t2, new URL(PGPT_URL).origin)).toMatchObject({ type: 'hello', meetingId: s.id })
    expect(await opened(t2, new URL(PGPT_URL).origin)).toBeNull() // spent
    expect(await opened('made-up-ticket-made-up-ticket', new URL(PGPT_URL).origin)).toBeNull()
    // nothing in the state a browser could use to call OpenAI itself
    expect(JSON.stringify(j)).not.toMatch(/sk-|ek_|client_secret|api[_-]?key/i)
    for (const c of [ko, en]) await c.post(`/meetings/${s.id}/leave`)
  })

  test('F-IT-02 자막: 원문 + 듣는 사람 언어의 번역(line-tr), 같은 언어끼리는 번역 없음, 방 기록과 회의록은 언어별로', async ({ db, cleanup }) => {
    test.skip(!openaiKey(), 'OpenAI 키 없음')
    test.setTimeout(240_000)
    const ko = await person('ko'), en = await person('en'), ja = await person('ja'), ko2 = await person('ko2')
    const g = await room(ko, [en, ja, ko2], db, cleanup)
    const s = (await ko.post(`/meetings/room/${g.id}/start`, { consent: true })).body
    for (const c of [en, ja, ko2]) expect((await c.post(`/meetings/${s.id}/join`, { consent: true })).status).toBe(200)
    test.skip(!(await en.get(`/meetings/${s.id}`)).body.interp.available, '통역 키가 없는 서버')
    expect((await ko.post(`/meetings/${s.id}/lines`, { text: '견적서 금액을 5퍼센트 낮춰서 금요일까지 다시 보내 드릴게요.' })).status).toBe(200)
    expect((await en.post(`/meetings/${s.id}/lines`, { text: 'Great. Please send the revised quote to the owner by Friday.' })).status).toBe(200)
    let lines
    await expect.poll(async () => { lines = (await ja.get(`/meetings/${s.id}`)).body.lines; return lines.every((l) => l.tr?.ja) && lines.length === 2 }, { timeout: 30000 }).toBe(true)
    const [l1, l2] = lines
    expect(l1).toMatchObject({ speaker: '한지수', lang: 'ko' })
    expect(l1.tr.en).not.toMatch(HANGUL)
    expect(l1.tr.ja).toMatch(KANA)
    expect(l1.tr.ko).toBeUndefined() // never into the speaker's own language
    expect(l2).toMatchObject({ speaker: 'Emily Carter', lang: 'en' })
    expect(l2.tr.ko).toMatch(HANGUL)
    expect(l2.tr.en).toBeUndefined()
    // the room record: one block, each line with its language and translations; process-gpt's text keeps
    // the meeting language's translation next to the English line
    let block
    await expect.poll(async () => { block = (await roomRows(db, g.id, 'meeting-transcript'))[0]; return block?.messages.pgpt.meeting.lines.every((l) => Object.keys(l.tr || {}).length >= 2) }, { timeout: 20000 }).toBe(true)
    const bl = block.messages.pgpt.meeting.lines
    expect(bl.map((l) => l.lang)).toEqual(['ko', 'en'])
    expect(Object.keys(bl[0].tr).sort()).toEqual(['en', 'ja'])
    expect(block.messages.content).toMatch(/Emily Carter: Great\. .*\(.*[가-힣].*\)/)
    // the English reader's room view: the lines are there with their translations
    const view = (await en.get(`/team/threads/${g.id}/messages`)).body.messages.find((m) => m.kind === 'meeting-transcript')
    expect(view.meeting.lines[0].tr.en).toBeTruthy()
    expect((await ko.post(`/meetings/${s.id}/end`)).status).toBe(200)
    let minutes
    await expect.poll(async () => { minutes = (await roomRows(db, g.id, 'meeting-minutes'))[0]; return !!minutes }, { timeout: 120000 }).toBe(true)
    const mm = minutes.messages.pgpt.meeting
    expect(mm.lang).toBe('ko')
    expect(mm.summary).toMatch(HANGUL)
    expect(Object.keys(mm.tr || {}).sort()).toEqual(['en', 'ja'])
    expect(mm.tr.en.summary).not.toMatch(HANGUL)
    expect(mm.tr.ja.summary).toMatch(/[぀-ヿ一-鿿]/)
    expect(mm.tr.en.actions.length).toBe(mm.actions.length)
    const st = (await ko.get('/meetings/stats')).body
    expect(st.translation.enabled).toBe(true)
  })

  test('F-IT-03 메신저: 한국어 메시지가 영어 독자에게 영어로, 「Show original」로 원문, 번역은 (메시지, 언어)마다 한 번', async ({ db, cleanup, browser }) => {
    test.skip(!openaiKey(), 'OpenAI 키 없음')
    const ko = await person('ko'), en = await person('en')
    const g = await room(ko, [en], db, cleanup, '회귀 번역 1:1')
    const text = `내일 오전까지 수정 견적서를 고객에게 보내 주세요 (${Date.now().toString(36)})`
    const sent = (await ko.post(`/team/threads/${g.id}/messages`, { text })).body
    const mine = (await en.post(`/team/threads/${g.id}/messages`, { text: 'Sure, I will send it before noon.' })).body
    // the API: translated for the English reader, the reader's own message never
    const r = (await en.post('/team/translate', { ids: [sent.id, mine.id] })).body
    expect(r).toMatchObject({ enabled: true, to: 'en' })
    expect(r.items[sent.id].body).not.toMatch(HANGUL)
    expect(r.items[sent.id].from).toBe('ko')
    expect(r.items[mine.id]).toEqual({ same: true })
    const [{ n }] = await db.q(`select count(*)::int n from pro_translations where lang='en' and text=$1`, [r.items[sent.id].body])
    expect(n).toBe(1)
    // a Korean reader of the Korean message: nothing to translate (no model call)
    expect((await ko.post('/team/translate', { ids: [sent.id] })).body.items[sent.id]).toEqual({ same: true })
    // the page: the message reads in English, Show original brings the Korean back
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, locale: 'en-US', baseURL: PGPT_URL })
    cleanup(() => ctx.close())
    await ctx.addInitScript((s) => { if (window.top === window) { localStorage.setItem('pgpt-pro-session', s); localStorage.setItem('pgl-lang', 'en') } }, JSON.stringify(en.s))
    const page = await ctx.newPage()
    await page.goto('/chat')
    await page.locator('button.msg-btn').click()
    await page.locator('.tabs button', { hasText: /Conversation|대화/ }).click()
    await page.locator('button.th', { hasText: '한지수' }).first().click()
    const bubble = page.locator('.msg', { has: page.locator('[data-test=msg-tr]') }).last()
    await expect(bubble.locator('[data-test=msg-text]')).toHaveText(r.items[sent.id].body, { timeout: 20000 })
    await expect(bubble.locator('[data-test=msg-tr]')).toContainText('AI translation')
    await bubble.locator('[data-test=show-original]').click()
    await expect(bubble.locator('[data-test=msg-text]')).toHaveText(text)
    await expect(bubble.locator('[data-test=show-original]')).toHaveText('Show translation')
    await bubble.locator('[data-test=show-original]').click()
    await expect(bubble.locator('[data-test=msg-text]')).toHaveText(r.items[sent.id].body)
    // a live message from the Korean teammate is translated as it arrives (the open room)
    const live = `금요일 회의는 오후 3시로 옮겨요 (${Date.now().toString(36)})`
    await ko.post(`/team/threads/${g.id}/messages`, { text: live })
    const liveBubble = page.locator('.msg', { hasText: /3 ?(PM|p\.m\.)|3 o'clock|15:00/i }).last()
    await expect(liveBubble.locator('[data-test=msg-tr]')).toBeVisible({ timeout: 30000 })
    expect(page.errors || []).toEqual([])
  })
})
