// 회의 기록이 열린 대화에 바로 — 2026-11-24 운영(팀 메시지의 그룹 대화): 「회의가 끝나면 회의가 끝난 회의록을 부착해주는데, 이게 곧바로
// 반영안되고 나갔다 들어와야 업데이트됨」. 회의 카드 · 「회의 자료」 · 최종 회의록은 회의 도우미가 방에 쓰는 행(server/lib/meetings/record.js)이라
// 대화방 피드(chats 트리거 → LISTEN)로만 열린 화면에 닿았는데, ProcessGPT 게이트웨이 뒤(운영)에서는 피드가 기본 테넌트(localhost)의 방만 보고
// 회사(uengine …)의 방 행을 버렸다. 고친 뒤: 기록 행을 쓰는 순간 방 사람 모두에게 바로 보내고(새 팀 메시지와 같은 길), 피드는 이 서버가 맡은
// 테넌트를 모두 보며, 같은 내용은 두 번 보내지 않는다. 화면은 같은 id 로 합치고(다시 열어도 하나), 회의록이 오면 열린 대화를 한 번 맞춘다.
// 회의는 API 로 시작 · 자료 띄우기 · 끝내기(카메라 없이), 두 사람은 브라우저에 그 대화를 열어 둔 채로 본다. 받아쓴 말이 없으면 회의록은
// 규칙으로 정리된다(모델 없음). 단위 시험 server/test/meetingRecordLive.test.js.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, api, uniq } from '../../lib/fixtures.js'

const SHOTS = process.env.RT_SHOTS_DIR || ''
const shot = async (page, name) => {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
  if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }) }
}
const member = async (c) => { await c.get('/team'); return c }
// (another run's teardown on the same database takes every pro-rt-* account off the team — lib/teardown.js: they are
// put back every second while this runs; GET /api/team adds the caller)
function keepOnTeam(cleanup, ...people) {
  const t = setInterval(() => { for (const c of people) c.get('/team').catch(() => {}) }, 1000)
  cleanup(() => clearInterval(t))
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
const FILE = '가온상사_도입_제안서.pdf'

async function room(a, others, db, cleanup, title) {
  const g = (await a.post('/team/threads', { members: others.map((o) => o.id), title })).body
  cleanup(async () => {
    await db.q('delete from pro_meetings where room_id=$1', [g.id]).catch(() => {})
    await db.q('delete from notifications where url=$1', [`/chats?id=${g.id}`]).catch(() => {})
    await db.q('delete from chats where id=$1', [g.id])
    await db.q('delete from chat_rooms where id=$1', [g.id])
  })
  return g
}
async function openThread(page, title) {
  await page.goto('/chat')
  await page.locator('button.msg-btn').click()
  await page.locator('.ms').waitFor()
  await page.locator('[data-test="msg-chip-all"]').click()
  await page.locator('.ms .th').filter({ hasText: title }).first().click()
  await page.locator('.ms .cmp textarea').waitFor()
}
const card = (page, kind) => page.locator(`.ms .msgs [data-test="${kind}"]`)
// a meeting: started by a, b joins, a shows a file from their computer to everyone, a ends it
async function meeting(a, b) {
  return {
    start: async (roomId) => {
      const s = await a.post(`/meetings/room/${roomId}/start`, { consent: true })
      expect(s.status, s.text).toBe(200)
      expect((await b.post(`/meetings/${s.body.id}/join`, { consent: true })).status).toBe(200)
      return s.body.id
    },
    present: async (id) => {
      const up = await api.call(a.token(), 'POST', `/meetings/${id}/materials/upload`, PDF, { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(FILE), 'X-File-Type': 'application/pdf' } })
      expect(up.status, up.text).toBe(200)
      expect((await a.post(`/meetings/${id}/materials/${up.body.material.id}/present`)).status).toBe(200)
    },
    end: async (id) => expect((await a.post(`/meetings/${id}/end`)).status).toBe(200),
  }
}

test.describe('회의 기록이 열린 대화에 바로 (meetings · messenger)', () => {
  test('F-MM-01 대화를 열어 둔 두 사람: 회의 카드 · 회의 자료 · 끝 카드 · 회의록이 나갔다 들어오지 않아도 보이고, 다시 열어도 하나씩', async ({ as, pageAs, db, cleanup }) => {
    const a = await member(await as('mm-host')), b = await member(await as('mm-mate')), c = await member(await as('mm-third'))
    keepOnTeam(cleanup, a, b, c)
    const title = uniq('회의록 바로 보기')
    const g = await room(a, [b, c], db, cleanup, title)
    const pa = await pageAs('mm-host'), pb = await pageAs('mm-mate')
    for (const p of [pa, pb]) await openThread(p, title)
    const mt = await meeting(a, b)

    // the meeting starts: its card is in both open conversations at once
    const id = await mt.start(g.id)
    for (const p of [pa, pb]) await expect(card(p, 'meeting')).toContainText('회의 중', { timeout: 10000 })
    // a file shown to everyone: the 「회의 자료」 card
    await mt.present(id)
    for (const p of [pa, pb]) await expect(card(p, 'meeting-material')).toContainText(FILE, { timeout: 10000 })

    // the meeting ends: the card turns into 「회의가 끝났어요」 and the minutes come in, without leaving the conversation
    await mt.end(id)
    for (const p of [pa, pb]) {
      await expect(card(p, 'meeting')).toContainText('회의가 끝났어요', { timeout: 15000 })
      await expect(card(p, 'meeting-minutes')).toBeVisible({ timeout: 60000 })
      await expect(card(p, 'meeting-minutes')).toContainText('📝 회의록')
      await expect(card(p, 'meeting-minutes')).toContainText('규칙으로 정리했어요')
      await expect(card(p, 'meeting-minutes')).toContainText(FILE)
      // the thread list's line is the minutes too, and the conversation being looked at has nothing unread
      await expect(p.locator('.ms .th').filter({ hasText: title }).first()).toContainText('회의록', { timeout: 10000 })
      await expect(p.locator('.ms .th').filter({ hasText: title }).first().locator('.badge')).toHaveCount(0, { timeout: 10000 })
    }
    await card(pa, 'meeting-minutes').scrollIntoViewIfNeeded()
    await shot(pa, 'F-MM-01-host-live')
    await card(pb, 'meeting-minutes').scrollIntoViewIfNeeded()
    await shot(pb, 'F-MM-01-mate-live')
    for (const p of [pa, pb]) {
      await expect(card(p, 'meeting')).toHaveCount(1)
      await expect(card(p, 'meeting-material')).toHaveCount(1)
      await expect(card(p, 'meeting-minutes')).toHaveCount(1)
    }

    // leave the conversation (close the messenger) and come back, then reload the page: still one of each (merged by message id)
    await pb.locator('[data-test="msg-close"]').first().click()
    await pb.locator('button.msg-btn').click()
    await pb.locator('.ms .th').filter({ hasText: title }).first().click()
    await expect(card(pb, 'meeting-minutes')).toHaveCount(1)
    await expect(card(pb, 'meeting')).toHaveCount(1)
    await expect(card(pb, 'meeting-material')).toHaveCount(1)
    await pa.reload()
    await openThread(pa, title)
    await expect(card(pa, 'meeting-minutes')).toHaveCount(1)
    await expect(card(pa, 'meeting')).toHaveCount(1)
    await expect(card(pa, 'meeting-material')).toHaveCount(1)
    await shot(pa, 'F-MM-01-host-reopened')
    expect(pa.errors, pa.errors.join('\n')).toEqual([])
    expect(pb.errors, pb.errors.join('\n')).toEqual([])
  })

  test('F-MM-02 회의에 들어오지 않은 방 사람에게도: 기록 행이 실시간 메시지로, 회의록이 생겼다는 알림도', async ({ as, db, cleanup }) => {
    const a = await member(await as('mm-host')), b = await member(await as('mm-mate')), c = await member(await as('mm-third'))
    keepOnTeam(cleanup, a, b, c)
    const g = await room(a, [b, c], db, cleanup, uniq('회의록 방 사람'))
    const mt = await meeting(a, b)
    const id = await mt.start(g.id)
    await mt.present(id)
    await mt.end(id)
    let minutes
    await expect.poll(async () => { [minutes] = await db.q(`select uuid from chats where id=$1 and messages->'pgpt'->>'kind'='meeting-minutes'`, [g.id]); return !!minutes }, { timeout: 60000 }).toBe(true)
    // c's own event stream (long poll from the start of its buffer): every record row of this room, the last copy of each
    // the newest, and nothing sent twice with the same content
    const events = async () => (await api.call(c.token(), 'GET', `/events/poll?after=0&token=${c.token()}`)).body.events
    let mine = []
    await expect.poll(async () => { mine = (await events()).filter((e) => e.type === 'team' && e.data.type === 'message' && e.data.threadId === g.id); return mine.some((e) => e.data.message.kind === 'meeting-minutes') }, { timeout: 15000 }).toBe(true)
    const last = (kind) => mine.filter((e) => e.data.message.kind === kind).at(-1)?.data.message
    expect(last('meeting')?.meeting).toMatchObject({ id, state: 'ended' })
    expect(last('meeting-material')?.meeting?.material).toMatchObject({ title: FILE })
    expect(last('meeting-minutes')).toMatchObject({ id: minutes.uuid, threadId: g.id, meeting: { id, by: 'rules' } })
    const seen = mine.map((e) => JSON.stringify(e.data.message))
    expect(seen.length, '같은 내용을 두 번 보내지 않는다').toBe(new Set(seen).size)
    // the meeting's own "minutes are in" reaches the room's people, not only those who were in it
    const told = (await events()).filter((e) => e.type === 'meeting' && e.data.type === 'minutes' && e.data.roomId === g.id)
    expect(told.map((e) => e.data.messageId)).toContain(minutes.uuid)
  })
})
