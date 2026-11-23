// 휴대폰 화면(2026-11-23, 운영) — 팀원이 보낸 1:1 메시지 「보자기」가 Home 에 「메시지 · 보자기 · process-gpt 채팅」으로만
// 떠서 누가 보냈는지 알 수 없었다(「직원에게서 메시지를 받았을때 누구한테서 온건지가 표시가 없음」). 고친 뒤: 팀원 메시지
// 카드에는 쓴 사람이 나온다. 알림에 쓴 사람이 비어 있으면 서버가 그 방의 같은 글을 쓴 사람을 찾는다.
import crypto from 'node:crypto'
import { test, expect } from '../../lib/fixtures.js'

const PHONE = { width: 390, height: 844 }
// the screen's own entry animations are over (endless ones — a spinner — are not waited for)
const settled = (page) => page.evaluate(() => Promise.all(document.getAnimations()
  .filter((a) => a.effect?.getComputedTiming?.().iterations !== Infinity).map((a) => a.finished.catch(() => {}))))

async function messageNotice(pageAs, db, area, { from = null, roomName = '한지우', writer = '한지우' } = {}) {
  const page = await pageAs(area, { viewport: PHONE })
  const u = page.user
  const room = `rt-ms-${crypto.randomUUID().slice(0, 8)}`
  const text = `보자기 ${room.slice(-4)}`
  await db.q('insert into chats(uuid, id, messages, tenant_id) values ($1,$2,$3,$4)',
    [crypto.randomUUID(), room, { content: text, name: writer, email: 'jiwoo.han@northwind.example', role: 'user', timeStamp: new Date().toISOString() }, db.tenant])
  const id = crypto.randomUUID()
  await db.q(`insert into notifications(id,user_id,title,type,description,url,from_user_id,tenant_id) values ($1,$2,$3,'chat',$4,$5,$6,$7)`,
    [id, u.email, text, roomName, `/chats?id=${room}`, from, db.tenant])
  await page.goto('/chat')
  await page.locator('.seg button').filter({ hasText: '홈' }).click()
  const card = page.locator('[data-test="notice-card"]').filter({ hasText: text })
  await expect(card).toBeVisible()
  return { page, card, done: async () => { await db.q('delete from notifications where id=$1', [id]); await db.q('delete from chats where id=$1', [room]) } }
}

test.describe('팀원 메시지 카드에 보낸 사람', () => {
  test('F-MS-01 알림에 쓴 사람이 없어도 카드에 보낸 사람이 나오고, 1:1 방 이름은 되풀이하지 않는다', async ({ pageAs, db }) => {
    const { page, card, done } = await messageNotice(pageAs, db, 'ms-noname')
    await expect(card.locator('[data-test="notice-from"]')).toHaveText(/^한지우님 · /)
    await expect(card).not.toContainText('process-gpt 채팅')
    await expect(card.locator('.ctx')).toHaveCount(0)
    await settled(page)
    await page.screenshot({ path: test.info().outputPath('f-ms-01.png') })
    await done()
  })

  test('F-MS-02 단체 방의 메시지는 보낸 사람과 방 이름이 함께 나온다', async ({ pageAs, db }) => {
    const { page, card, done } = await messageNotice(pageAs, db, 'ms-group', { from: '한지우', roomName: '단체' })
    await expect(card.locator('[data-test="notice-from"]')).toHaveText(/^한지우님 · /)
    await expect(card.locator('.ctx')).toHaveText('단체')
    await settled(page)
    await page.screenshot({ path: test.info().outputPath('f-ms-02.png') })
    await done()
  })
})
