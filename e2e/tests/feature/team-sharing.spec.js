// 팀 공유·받은 편지함·@팀원 제안·메신저 — 산출물은 팀원에게만, 받는 사람마다 따로 허가(pro_shares),
// 원본 저장 주소는 내려가지 않고, 받는 사람은 열 때 자기 사본 카드를 받는다. 메신저는 1:1·그룹, 안 읽은 수.
// (server/lib/team/*, routes/team.js · 설계 process-gpt/openspec/changes/pgpt-pro-team-sharing · 영상 팀 공유·메신저)
import { test, expect, api, uniq } from '../../lib/fixtures.js'
import { XLSX, MIME } from '../../lib/seed.js'

// a member: GET /api/team adds the caller to the tenant team; an outsider is taken off it again
const member = async (c) => { await c.get('/team'); return c }
async function outsider(as, db) {
  const c = await as('ts-outsider')
  await db.q('delete from pro_team_members where tenant_id=$1 and user_id=$2', [db.tenant, c.id])
  return c
}
async function fileCard(db, u, name = '공유 견적.xlsx') {
  const th = await db.mainThreadId(u.id)
  const up = await api.upload(u.token(), name, MIME.xlsx, await XLSX([['품목', '금액'], ['설계비', 500000]]))
  const [m] = await db.addMessages(th, [{ role: 'agent', kind: 'file', content: { name, url: up.url } }])
  return m
}

test.describe('팀 공유 (spec pgpt-pro-team-sharing)', () => {
  test('F-TS-01 산출물 공유 → 받은 편지함·알림, 받는 사람은 자기 사본 카드로 열고, 원본 주소는 내려가지 않는다', async ({ as, db, cleanup }) => {
    const a = await member(await as('ts-sender')), b = await member(await as('ts-mate'))
    const card = await fileCard(db, a)
    const note = uniq('검토 부탁')
    const r = await a.post('/team/share', { to: [{ type: 'user', id: b.id }], messageIds: [card.id], note })
    expect(r.status, r.text).toBe(200)
    expect(r.body.sent[0].to.id).toBe(b.id)
    cleanup(() => db.q('delete from pro_dm_threads where id=$1', [r.body.sent[0].threadId]))
    // the recipient's inbox: the share, unread, with their own share id — never the storage key
    let item
    await expect.poll(async () => { item = (await b.get('/team/inbox')).body.find((m) => m.body === note); return !!item }).toBe(true)
    expect(item).toMatchObject({ kind: 'share', unread: true, mine: false, sender: { id: a.id } })
    expect(item.artifacts[0]).toMatchObject({ name: '공유 견적.xlsx', own: false })
    const inboxText = JSON.stringify((await b.get('/team/inbox')).body)
    expect(inboxText).not.toContain(card.content.url)
    expect(inboxText).not.toContain('object_key')
    expect((await b.get('/notifications')).body.some((n) => /공유했어요/.test(n.title || ''))).toBe(true)
    // open: a copy card in the recipient's chat (same copy on the second open); the raw bytes
    const shareId = item.artifacts[0].shareId
    const o1 = await b.post(`/team/shares/${shareId}/open`)
    expect(o1.status, o1.text).toBe(200)
    expect(o1.body.message.content).toMatchObject({ name: '공유 견적.xlsx', shared: { shareId } })
    expect(o1.body.message.content.url).not.toBe(card.content.url)
    expect((await b.post(`/team/shares/${shareId}/open`)).body.message.id).toBe(o1.body.message.id)
    const raw = await b.get(`/team/shares/${shareId}/raw`, { raw: true })
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-security-policy')).toContain('sandbox')
    // the sender's own view opens their original card
    expect((await a.post(`/team/shares/${shareId}/open`)).body.message.id).toBe(card.id)
    // revoke: the share is gone for the recipient
    expect((await b.del(`/team/shares/${shareId}`)).status, '받는 사람은 취소 못 함').toBe(404)
    expect((await a.del(`/team/shares/${shareId}`)).status).toBe(200)
    expect((await b.get(`/team/shares/${shareId}/raw`, { raw: true })).status).toBe(404)
  })

  test('F-TS-02 팀원이 아니면 보내지도 받지도 못한다(403), 남의 카드는 공유할 수 없다(404), 자신에게는 400', async ({ as, db }) => {
    const a = await member(await as('ts-sender')), b = await member(await as('ts-mate'))
    const out = await outsider(as, db)
    const card = await fileCard(db, a)
    expect((await a.post('/team/share', { to: [{ type: 'user', id: out.id }], messageIds: [card.id] })).status).toBe(403)
    expect((await out.post('/team/share', { to: [{ type: 'user', id: a.id }], messageIds: [card.id] })).status).toBe(403)
    expect((await out.get('/team/inbox')).status).toBe(403)
    expect((await b.post('/team/share', { to: [{ type: 'user', id: a.id }], messageIds: [card.id] })).status, '남의 카드').toBe(404)
    expect((await a.post('/team/share', { to: [{ type: 'user', id: a.id }], messageIds: [card.id] })).status, '자기 자신').toBe(400)
    expect((await a.post('/team/share', { to: [], messageIds: [card.id] })).status).toBe(400)
    expect((await a.post('/team/share', { to: [{ type: 'role', role: `없는역할-${Date.now()}` }], messageIds: [card.id] })).status).toBe(400)
  })

  test('F-TS-03 "@" 제안: 자주 주고받은 팀원이 먼저, 팀원이 아닌 사람·나는 없다 (판단 모델이 없어도 빈도 순)', async ({ as, db, cleanup }) => {
    const a = await member(await as('ts-sender')), b = await member(await as('ts-mate'))
    const out = await outsider(as, db)
    const t = await a.post('/team/threads', { members: [b.id] })
    expect(t.status, t.text).toBe(200)
    cleanup(() => db.q('delete from pro_dm_threads where id=$1', [t.body.id]))
    expect((await a.post(`/team/threads/${t.body.id}/messages`, { text: uniq('안녕하세요') })).status).toBe(200)
    const s = await a.post('/team/suggest', { mode: 'fast' })
    expect(s.status, s.text).toBe(200)
    expect(s.body.frequent.map((p) => p.id)).toContain(b.id)
    const everyone = [...s.body.frequent, ...s.body.related, ...s.body.rest].map((p) => p.id)
    expect(everyone).not.toContain(a.id)
    expect(everyone).not.toContain(out.id)
    // related mode asks the judge; down or unset, the answer still comes (frequency order only)
    const rel = await a.post('/team/suggest', { mode: 'related', title: '견적 검토' }, { timeout: 30_000 })
    expect(rel.status).toBe(200)
    expect(rel.body.frequent.map((p) => p.id)).toContain(b.id)
  })

  test('F-TS-04 메신저: 1:1 은 하나만, 그룹, 안 읽은 수와 읽음, 남의 대화는 404, 팀에서 빠진 사람에게는 403', async ({ as, db, cleanup }) => {
    const a = await member(await as('ts-sender')), b = await member(await as('ts-mate')), c = await member(await as('ts-third'))
    const t1 = (await a.post('/team/threads', { members: [b.id] })).body.id
    expect((await b.post('/team/threads', { members: [a.id] })).body.id, '같은 1:1 대화').toBe(t1)
    const g = await a.post('/team/threads', { members: [b.id, c.id], title: uniq('회귀 그룹') })
    expect(g.status).toBe(200)
    cleanup(() => db.q('delete from pro_dm_threads where id = any($1::uuid[])', [[t1, g.body.id]]))
    expect((await a.post('/team/threads', { members: [] })).status).toBe(400)
    expect((await a.post(`/team/threads/${t1}/messages`, { text: '' })).status).toBe(400)
    const text = uniq('점심 같이')
    expect((await a.post(`/team/threads/${t1}/messages`, { text })).status).toBe(200)
    const unread = (await b.get('/team/unread')).body
    expect(unread.byThread[t1]).toBeGreaterThan(0)
    const msgs = (await b.get(`/team/threads/${t1}/messages`)).body
    expect(msgs.messages.at(-1)).toMatchObject({ body: text, mine: false, sender: { id: a.id } })
    expect((await b.post(`/team/threads/${t1}/read`)).status).toBe(200)
    expect((await b.get('/team/unread')).body.byThread[t1] || 0).toBe(0)
    expect((await c.get(`/team/threads/${t1}/messages`)).status, '1:1 밖의 팀원').toBe(404)
    expect((await a.get('/team/threads')).body.find((x) => x.id === g.body.id)?.members.length).toBe(3)
    // c leaves the team: a message to the group that includes c is refused
    await db.q('delete from pro_team_members where tenant_id=$1 and user_id=$2', [db.tenant, c.id])
    expect((await a.post(`/team/threads/${g.body.id}/messages`, { text: '공지' })).status).toBe(403)
  })

  test('F-TS-05 채팅에서 @팀원에게 요청: 받는 사람 받은 편지함에 대화 발췌와 함께, 내 대화엔 "보냈어요" 칩', async ({ as, db, cleanup }) => {
    const a = await member(await as('ts-sender')), b = await member(await as('ts-mate'))
    const th = await db.clearMain(a.id)
    await db.addMessages(th, [{ role: 'user', kind: 'text', content: { text: '카페 인테리어 견적을 만들어 줘' } }])
    const body = uniq('견적 숫자 확인 부탁해요')
    const r = await a.post('/team/mention', { to: [{ type: 'user', id: b.id }], text: body, threadId: th, conversation: { title: '카페 견적' } })
    expect(r.status, r.text).toBe(200)
    let m
    await expect.poll(async () => { m = (await b.get('/team/inbox')).body.find((x) => x.body === body); return !!m }).toBe(true)
    expect(m).toMatchObject({ kind: 'mention', context: { title: '카페 견적' } })
    cleanup(() => db.q('delete from pro_dm_threads where id=$1', [m.threadId]))
    const mine = (await a.get(`/threads/${th}/messages`)).body
    expect(mine.some((x) => x.kind === 'chip' && /보냈어요/.test(x.content.text))).toBe(true)
    expect((await a.post('/team/mention', { to: [{ type: 'user', id: b.id }], text: '' })).status).toBe(400)
    // "이어서 작업" only for a message someone else sent me
    expect((await a.post(`/team/messages/${m.id}/continue`)).status).toBe(404)
  })
})
