// 방 규칙 — 규칙 표시와 끄기 (spec pgpt-pro_room-rules, 모델 없음)
// (src/components/RoomRuleBar.vue, server/lib/roomRules.js)
// 규칙을 말로 정하고 링크로 실행하는 것은 server/test/room-rules.e2e.mjs, 직접 제어는 server/test/takeover.e2e.mjs
import { test, expect } from '../../lib/fixtures.js'

const ACTION = '이 링크나 파일로 노트북 lm의 슬라이드 팟캐스트를 만들어 준다'
async function room(db, u, title = '방 규칙 방') {
  const [{ id }] = await db.q(`insert into pro_threads(user_id,kind,title) values ($1,'project',$2) returning id`, [u.id, title])
  return id
}
async function rule(db, u, thread, runs = 0) {
  await db.q(`insert into pro_room_rules(tenant_id,user_id,thread_id,said,action,runs) values ($1,$2,$3,$4,$5,$6)`, [db.tenant, u.id, thread, '앞으로 이 방에 올리는 링크는 곧바로 만들어 줘', ACTION, runs])
}

test.describe('방 규칙 (spec pgpt-pro_room-rules)', () => {
  test('F-RR-01 규칙이 있는 방은 맨 위에 할 일과 실행 횟수를 보여 준다', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('rr-show')
    const id = await room(db, page.user)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    await rule(db, page.user, id, 2)
    await page.goto(`/projects/${id}`)
    const bar = page.getByTestId('room-rule')
    await expect(bar).toContainText('이 방의 규칙')
    await expect(bar).toContainText(ACTION)
    await expect(bar).toContainText('2번 실행')
  })

  test('F-RR-02 끄면 바로 사라지고, 돌아와도 없다', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('rr-off')
    const id = await room(db, page.user)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    await rule(db, page.user, id)
    await page.goto(`/projects/${id}`)
    await page.getByTestId('room-rule-off').click()
    await expect(page.getByTestId('room-rule')).toHaveCount(0)
    await expect.poll(async () => (await db.q('select 1 from pro_room_rules where thread_id=$1', [id])).length).toBe(0)
    await page.reload()
    await expect(page.getByPlaceholder(/.+/).first()).toBeVisible()
    await expect(page.getByTestId('room-rule')).toHaveCount(0)
  })

  test('F-RR-03 규칙이 없는 방에는 아무것도 없다', async ({ pageAs, db, cleanup }) => {
    const page = await pageAs('rr-none')
    const id = await room(db, page.user)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    await page.goto(`/projects/${id}`)
    await expect(page.getByPlaceholder(/.+/).first()).toBeVisible()
    await expect(page.getByTestId('room-rule')).toHaveCount(0)
  })

  test('F-RR-04 다른 사람의 규칙은 보이지도 지워지지도 않는다', async ({ as, db, cleanup }) => {
    const owner = await as('rr-owner'), other = await as('rr-other')
    const id = await room(db, owner)
    cleanup(() => db.q('delete from pro_threads where id=$1', [id]))
    await rule(db, owner, id)
    expect((await other.get(`/threads/${id}/rule`)).body.rule).toBeNull()
    expect((await other.del(`/threads/${id}/rule`)).body.removed).toBe(0)
    expect((await owner.get(`/threads/${id}/rule`)).body.rule.action).toBe(ACTION)
  })
})
