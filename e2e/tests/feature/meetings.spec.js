// 대화방 원격 회의 — 방 구성원만 회의·신호·소리·자막·자료, 신호는 참여자끼리만, 동의 없으면 소리·글 거절,
// 말의 의도 → 자료(형식 거름 → 판단 모델, 큰 모델 0회)와 부탁 제안, 회의 기록이 대화방에 저절로(회의록 블록 하나에
// 말 차례를 모아 제자리 갱신, 끝나면 최종 회의록·할 일 제안·동의 안 한 사람), 방별 도우미 스위치.
// 말은 소리 대신 "말 대신 적기"(POST /meetings/:id/lines — 받아쓰기 뒤와 같은 길)로 넣는다. 가짜 마이크로 말하는
// 실제 브라우저 여정은 agent 단계 A-14(tests/agent/meetings.spec.js).
// (server/lib/meetings/*, routes/meetings.js · 설계 process-gpt/openspec/changes/pgpt-pro-meetings)
import { test, expect, api } from '../../lib/fixtures.js'
import { XLSX, MIME, WAV } from '../../lib/seed.js'
import { API_URL } from '../../lib/env.js'

const member = async (c) => { await c.get('/team'); return c }
const judgeUp = async () => fetch((process.env.PRO_JUDGE_URL || 'http://127.0.0.1:8896/judge').replace(/\/judge$/, '/health')).then((r) => r.ok).catch(() => false)
// the judge server, or the LLM in its place (lib/judge.js — production has no judge server)
const judgeOn = async (c) => { const st = (await c.get('/meetings/stats')).body; return st?.detection?.judge === false ? false : (await judgeUp()) || !!st?.detection?.judgeLlm }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function room(a, others, db, cleanup) {
  const g = (await a.post('/team/threads', { members: others.map((o) => o.id), title: '회귀 회의방' })).body
  cleanup(() => db.q('delete from chat_rooms where id=$1', [g.id]))
  return g
}
async function sharedQuote(db, a, g) {
  const th = await db.mainThreadId(a.id)
  const up = await api.upload(a.token(), '회귀상사_견적서.xlsx', MIME.xlsx, await XLSX([['항목', '금액'], ['설계', 500000], ['시공', 3200000]]))
  const [card] = await db.addMessages(th, [{ role: 'agent', kind: 'file', content: { name: '회귀상사_견적서.xlsx', url: up.url } }])
  const r = await a.post(`/team/threads/${g.id}/messages`, { text: '지난번 견적서예요', artifactIds: [card.id] })
  expect(r.status, r.text).toBe(200)
  return card
}
// events the server pushed to someone (long poll from now on)
async function pollFrom(c) {
  const first = await api.call(c.token(), 'GET', `/events/poll?after=999999999&token=${c.token()}`, null, { timeout: 2000 }).catch(() => null)
  return first?.body?.seq ?? 0
}
const roomRows = (db, roomId, kind) => db.q(`select uuid, messages from chats where id=$1 and messages->'pgpt'->>'kind'=$2 order by public.pro_chat_ts(messages)`, [roomId, kind])

test.describe('대화방 원격 회의 (spec pgpt-pro-meetings)', () => {
  test('F-MT-01 방 구성원만: 시작·참여·상태·신호·소리·글·방 메시지 — 밖의 사람은 404, 방에는 회의 카드', async ({ as, db, cleanup }) => {
    const a = await member(await as('mt-owner')), b = await member(await as('mt-mate')), o = await member(await as('mt-outsider'))
    const g = await room(a, [b], db, cleanup)
    const s = await a.post(`/meetings/room/${g.id}/start`, { consent: true })
    expect(s.status, s.text).toBe(200)
    expect(s.body).toMatchObject({ roomId: g.id, state: 'live', me: { id: a.id, consent: true } })
    expect(JSON.stringify(s.body)).not.toMatch(/sk-|service_role|storage\/v1\/object/)
    const id = s.body.id
    for (const [m, p, body] of [['GET', `/meetings/room/${g.id}`], ['POST', `/meetings/room/${g.id}/start`, {}], ['GET', `/meetings/${id}`], ['POST', `/meetings/${id}/join`, { consent: true }],
      ['POST', `/meetings/${id}/signal`, { to: a.id, kind: 'offer', data: {} }], ['POST', `/meetings/${id}/lines`, { text: '견적서 보여 주세요' }], ['GET', `/team/threads/${g.id}/messages`]]) {
      const r = await api.call(o.token(), m, p, body)
      expect(r.status, `${m} ${p}`).toBe(404)
    }
    const audio = await api.call(o.token(), 'POST', `/meetings/${id}/audio`, WAV(1), { headers: { 'Content-Type': 'audio/wav' } })
    expect(audio.status).toBe(404)
    expect((await b.post(`/meetings/${id}/join`, { consent: true })).status).toBe(200)
    // the meeting card in the room, updated in place to two people
    await expect.poll(async () => (await roomRows(db, g.id, 'meeting'))[0]?.messages.pgpt.meeting.count, { timeout: 8000 }).toBe(2)
    expect(await roomRows(db, g.id, 'meeting')).toHaveLength(1)
    const view = (await b.get(`/team/threads/${g.id}/messages`)).body.messages.find((x) => x.kind === 'meeting')
    expect(view.meeting).toMatchObject({ id, state: 'live', count: 2 })
    expect((await b.get(`/meetings/room/${g.id}`)).body.meeting).toMatchObject({ id, count: 2 })
    for (const c of [a, b]) await c.post(`/meetings/${id}/leave`)
  })

  test('F-MT-02 신호는 회의에 들어온 두 사람 사이에만 SSE/롱폴링으로', async ({ as, db, cleanup }) => {
    const a = await member(await as('mt-owner')), b = await member(await as('mt-mate')), c = await member(await as('mt-third'))
    const g = await room(a, [b, c], db, cleanup)
    const id = (await a.post(`/meetings/room/${g.id}/start`, { consent: false })).body.id
    expect((await b.post(`/meetings/${id}/join`, { consent: false })).status).toBe(200)
    const after = await pollFrom(b)
    const sdp = { type: 'offer', sdp: 'v=0 회귀' }
    expect((await a.post(`/meetings/${id}/signal`, { to: b.id, kind: 'offer', data: sdp })).status).toBe(200)
    const got = await api.call(b.token(), 'GET', `/events/poll?after=${after}&token=${b.token()}`)
    // pollFrom's cursor can fall back to 0 (its 2 s call outlasts no event): the buffer may still hold an
    // earlier run's signal between the same test accounts, so this meeting's is the one looked at
    const sig = got.body.events.find((e) => e.type === 'meeting' && e.data.type === 'signal' && e.data.meetingId === id)
    expect(sig.data).toMatchObject({ meetingId: id, from: a.id, kind: 'offer', data: sdp })
    // c is in the room but not in the meeting: no signal to or from c
    expect((await a.post(`/meetings/${id}/signal`, { to: c.id, kind: 'offer', data: sdp })).status).toBe(404)
    expect((await c.post(`/meetings/${id}/signal`, { to: a.id, kind: 'offer', data: sdp })).status).toBe(403)
    expect((await a.post(`/meetings/${id}/signal`, { to: b.id, kind: 'hack', data: {} })).status).toBe(400)
    for (const x of [a, b]) await x.post(`/meetings/${id}/leave`)
  })

  test('F-MT-03 동의하지 않으면 소리·글을 받지 않고, 회의록에 기록하지 않은 사람으로 남는다', async ({ as, db, cleanup }) => {
    const a = await member(await as('mt-owner')), b = await member(await as('mt-mate'))
    const g = await room(a, [b], db, cleanup)
    const id = (await a.post(`/meetings/room/${g.id}/start`, { consent: true })).body.id
    expect((await b.post(`/meetings/${id}/join`, { consent: false })).status).toBe(200)
    expect((await api.call(b.token(), 'POST', `/meetings/${id}/audio`, WAV(1), { headers: { 'Content-Type': 'audio/wav' } })).status).toBe(403)
    expect((await b.post(`/meetings/${id}/lines`, { text: '이건 기록되면 안 돼요' })).status).toBe(403)
    expect((await a.post(`/meetings/${id}/lines`, { text: '오늘 안건은 하나예요' })).status).toBe(200)
    for (const x of [b, a]) await x.post(`/meetings/${id}/leave`)
    let minutes
    await expect.poll(async () => { minutes = (await roomRows(db, g.id, 'meeting-minutes'))[0]; return !!minutes }, { timeout: 60000 }).toBe(true)
    const [{ name: nb }] = await db.q('select name from pro_profile where user_id=$1', [b.id])
    expect(minutes.messages.pgpt.meeting.declined).toEqual([nb])
    expect(minutes.messages.content).toContain('받아쓰기에 동의하지 않은 분')
    const block = (await roomRows(db, g.id, 'meeting-transcript'))[0]
    expect(block.messages.content).not.toContain('기록되면 안 돼요')
  })

  test('F-MT-04 의도 → 자료(형식 거름 → 판단 모델, 큰 모델 0회), 부탁 → 시작/아니요 제안, 볼 권한 있는 사람에게만', async ({ as, db, cleanup }) => {
    const a = await member(await as('mt-owner')), b = await member(await as('mt-mate'))
    test.skip(!(await judgeOn(a)), '판단 모델(judge) 서버가 없음 — 이 스택에 PRO_JUDGE_URL 이 없으면 자막만, 자료·제안 없음')
    const g = await room(a, [b], db, cleanup)
    await sharedQuote(db, a, g)
    const id = (await a.post(`/meetings/room/${g.id}/start`, { consent: true })).body.id
    expect((await b.post(`/meetings/${id}/join`, { consent: true })).status).toBe(200)
    const before = (await a.get('/meetings/stats')).body.detection
    expect((await a.post(`/meetings/${id}/lines`, { text: '다들 주말 잘 보냈어요?' })).status).toBe(200)
    await sleep(2500)
    expect((await b.get(`/meetings/${id}`)).body.materials).toHaveLength(0)
    expect((await b.post(`/meetings/${id}/lines`, { text: '지난번 회귀상사 견적서 다시 볼까요?' })).status).toBe(200)
    let mats
    await expect.poll(async () => { mats = (await b.get(`/meetings/${id}`)).body.materials; return mats.length }, { timeout: 20000 }).toBeGreaterThan(0)
    expect(mats[0]).toMatchObject({ kind: 'file', title: '회귀상사_견적서.xlsx', byAgent: true })
    expect(JSON.stringify(mats)).not.toMatch(/storage\/v1\/object/)
    // the same for the owner; the room card is there (everyone in the room may see the shared file)
    expect((await a.get(`/meetings/${id}`)).body.materials.map((m) => m.title)).toContain('회귀상사_견적서.xlsx')
    await expect.poll(async () => (await roomRows(db, g.id, 'meeting-material')).length, { timeout: 8000 }).toBe(1)
    // b opens it: b's own copy through b's grant
    const opened = await b.post(`/meetings/${id}/materials/${mats[0].id}/open`)
    expect(opened.status, opened.text).toBe(200)
    expect(opened.body.message.content.shared).toBeTruthy()
    // a request → a suggestion for the people in the meeting
    expect((await b.post(`/meetings/${id}/lines`, { text: '견적서 금액 5% 낮춰서 다시 만들어 주세요' })).status).toBe(200)
    let sg
    await expect.poll(async () => { sg = (await a.get(`/meetings/${id}`)).body.suggestions[0]; return !!sg }, { timeout: 20000 }).toBe(true)
    expect(sg).toMatchObject({ work: 'CreateSpreadsheet', state: 'open', canStart: true, meetingId: id })
    expect(sg.title).toMatch(/견적/)
    // the suggestion hangs under the 회의록 block in the room
    const block = (await roomRows(db, g.id, 'meeting-transcript'))[0]
    expect(sg.messageId).toBe(block.uuid)
    const after = (await a.get('/meetings/stats')).body.detection
    expect(after.bigModelCalls).toBe(0)
    expect(after.judged).toBeGreaterThan(before.judged)
    // small talk reaches the judge (no word cues) and the judge says none
    expect(after.prefiltered['judge-none'] || 0).toBeGreaterThan(before.prefiltered['judge-none'] || 0)
    for (const x of [a, b]) await x.post(`/meetings/${id}/leave`)
  })

  test('F-MT-07 공유 폴더 문서도 자료: 말로 찾고(받아쓴 영어 낱말·파일 종류), 못 찾으면 도우미가 말하고, 「자료 찾기」로 직접 찾아 띄운다', async ({ as, db, cleanup }) => {
    // 2026-11-19 운영: "폴더에 있는 내용 중에 셉 ERP 관련 PDF 좀 열어볼래?" → 반응 없이 「듣고 있어요」만
    const a = await member(await as('mt-owner')), b = await member(await as('mt-mate'))
    const g = await room(a, [b], db, cleanup)
    const f = await a.post('/folders', { name: `회귀 회의 폴더 ${Date.now().toString(36)}` })
    expect(f.status, f.text).toBe(200)
    cleanup(() => db.q('delete from pro_folders where id=$1', [f.body.id]))
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
    for (const [name, body] of [['SAP_ERP_소개서.pdf', PDF], ['SAP_ERP_소개서.pptx', Buffer.from('PK')]]) {
      const up = await api.call(a.token(), 'POST', `/folders/${f.body.slug}/files?path=${encodeURIComponent(name)}`, body, { headers: { 'Content-Type': 'application/octet-stream' } })
      expect(up.status, up.text).toBe(200)
    }
    const id = (await a.post(`/meetings/room/${g.id}/start`, { consent: true })).body.id
    expect((await b.post(`/meetings/${id}/join`, { consent: true })).status).toBe(200)

    // 자료 찾기: only what I may see — a (folder member) finds it, b (not a member) does not
    const found = (await a.get(`/meetings/${id}/materials/search?q=${encodeURIComponent('ERP PDF')}`)).body.results
    expect(found[0]).toMatchObject({ kind: 'folder', title: 'SAP_ERP_소개서.pdf', folderFile: true })
    expect((await b.get(`/meetings/${id}/materials/search?q=${encodeURIComponent('ERP PDF')}`)).body.results.filter((x) => x.folderFile)).toHaveLength(0)
    // b cannot put a's folder document on the panel by its key either
    expect((await b.post(`/meetings/${id}/materials/pick`, { key: found[0].key })).status).toBe(404)

    if (await judgeOn(a)) {
      const seq = await pollFrom(a)
      // the heard words ("셉" for SAP, "PDF") pick the PDF, opened at once for the one who asked
      expect((await a.post(`/meetings/${id}/lines`, { text: '폴더에 있는 내용 중에 셉 ERP 관련 PDF 좀 열어볼래?' })).status).toBe(200)
      let mats
      await expect.poll(async () => { mats = (await a.get(`/meetings/${id}`)).body.materials; return mats.length }, { timeout: 30000 }).toBeGreaterThan(0)
      expect(mats[0]).toMatchObject({ kind: 'folder', title: 'SAP_ERP_소개서.pdf', byAgent: true, folder: { file: true, path: 'SAP_ERP_소개서.pdf' } })
      const ev = (await api.call(a.token(), 'GET', `/events/poll?after=${seq}&token=${a.token()}`)).body.events
      expect(ev.find((e) => e.type === 'meeting' && e.data.meetingId === id && e.data.type === 'material')?.data.open).toBe(true)
      // b is not in the folder: b gets neither the card nor its name
      expect((await b.get(`/meetings/${id}`)).body.materials).toHaveLength(0)
      // nothing of that name anywhere: the helper says so (it used to stay silent)
      const seq2 = await pollFrom(a)
      expect((await a.post(`/meetings/${id}/lines`, { text: '그 달빛커피 계약서 파일 좀 열어 줄래?' })).status).toBe(200)
      let said
      await expect.poll(async () => {
        const evs = (await api.call(a.token(), 'GET', `/events/poll?after=${seq2}&token=${a.token()}`)).body.events
        said = evs.find((e) => e.type === 'meeting' && e.data.meetingId === id && e.data.type === 'agent')?.data
        return !!said
      }, { timeout: 30000 }).toBe(true)
      expect(said.text).toMatch(/죄송해요|이해하지 못했어요/)
      expect(said.for).toBe(a.id)
    }

    // 「모두에게 띄우기」 from 자료 찾기: b is not in the folder, so it is shown as a's copy and b opens its own copy
    // (2026-11-19 recording: b saw 「볼 권한이 없어요」 before)
    const picked = await a.post(`/meetings/${id}/materials/pick`, { key: found[0].key })
    expect(picked.status, picked.text).toBe(200)
    expect(picked.body.material).toMatchObject({ kind: 'folder', folder: { file: true, slug: f.body.slug } })
    const pmid = picked.body.material.id
    expect((await b.post(`/meetings/${id}/materials/${pmid}/open`)).status).toBe(404)
    expect((await a.post(`/meetings/${id}/materials/${pmid}/present`)).status).toBe(200)
    const asB = (await b.get(`/meetings/${id}`)).body
    expect(asB.presenting?.material || asB.materials.find((x) => x.id === pmid)).toMatchObject({ kind: 'file', title: 'SAP_ERP_소개서.pdf' })
    const bOpen = await b.post(`/meetings/${id}/materials/${pmid}/open`)
    expect(bOpen.status, bOpen.text).toBe(200)
    expect(bOpen.body.message.content).toMatchObject({ name: 'SAP_ERP_소개서.pdf', shared: expect.anything() })
    // a still opens a's own card (made from the folder document)
    expect((await a.post(`/meetings/${id}/materials/${pmid}/open`)).body.message.content).toMatchObject({ name: 'SAP_ERP_소개서.pdf', from: { path: 'SAP_ERP_소개서.pdf' } })
    for (const x of [a, b]) await x.post(`/meetings/${id}/leave`)
  })

  test('F-MT-08 자료 띄우기 › 내 컴퓨터에서: 올린 파일이 내 파일로 자료에 오르고, 모두에게 띄우면 상대는 자기 사본으로 연다', async ({ as, db, cleanup }) => {
    const a = await member(await as('mt-owner')), b = await member(await as('mt-mate')), o = await member(await as('mt-outsider'))
    const g = await room(a, [b], db, cleanup)
    const id = (await a.post(`/meetings/room/${g.id}/start`, { consent: true })).body.id
    expect((await b.post(`/meetings/${id}/join`, { consent: true })).status).toBe(200)
    const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')
    const up = (c, name) => api.call(c.token(), 'POST', `/meetings/${id}/materials/upload`, PDF, { headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), 'X-File-Type': 'application/pdf' } })
    // only people in the meeting
    expect((await up(o, '밖.pdf')).status).toBe(404)
    const r = await up(a, '회귀_도입_제안서.pdf')
    expect(r.status, r.text).toBe(200)
    expect(r.body.material).toMatchObject({ kind: 'file', title: '회귀_도입_제안서.pdf', byAgent: false, file: { own: true } })
    expect(JSON.stringify(r.body)).not.toMatch(/storage\/v1\/object/)
    // a's own file card (a chat attachment in a's thread)
    const [card] = await db.q(`select m.content from pro_messages m join pro_threads t on t.id=m.thread_id where t.user_id=$1 and m.kind='file' and m.content->>'meeting'=$2`, [a.id, id])
    expect(card.content).toMatchObject({ name: '회귀_도입_제안서.pdf', attached: true })
    // a's own file until a shows it: b neither sees nor opens it; after 모두에게 띄우기 b has it and opens a copy
    const mid = r.body.material.id
    expect((await b.get(`/meetings/${id}`)).body.materials.map((m) => m.id)).not.toContain(mid)
    expect((await b.post(`/meetings/${id}/materials/${mid}/open`)).status).toBe(404)
    expect((await a.post(`/meetings/${id}/materials/${mid}/present`)).status).toBe(200)
    await expect.poll(async () => (await b.get(`/meetings/${id}`)).body.materials.map((m) => m.id), { timeout: 8000 }).toContain(mid)
    const opened = await b.post(`/meetings/${id}/materials/${mid}/open`)
    expect(opened.status, opened.text).toBe(200)
    expect(opened.body.message.content.shared).toBeTruthy()
    expect(opened.body.message.content.name).toBe('회귀_도입_제안서.pdf')
    for (const x of [a, b]) await x.post(`/meetings/${id}/leave`)
  })

  test('F-MT-05 회의록 블록: 문장마다 행을 만들지 않고 한 행을 제자리 갱신, 끝나면 최종 회의록·할 일 제안', async ({ as, db, cleanup }) => {
    const a = await member(await as('mt-owner')), b = await member(await as('mt-mate'))
    const g = await room(a, [b], db, cleanup)
    const id = (await a.post(`/meetings/room/${g.id}/start`, { consent: true })).body.id
    expect((await b.post(`/meetings/${id}/join`, { consent: true })).status).toBe(200)
    const lines = [[a, '오늘은 신규 매장 일정만 정해요'], [b, '다음 주 화요일이 좋겠어요'], [a, '그럼 화요일 오전으로 하죠'], [b, '제가 고객사에 일정 메일을 보낼게요'], [a, '좋아요 부탁해요'], [b, '네 오늘 보낼게요']]
    for (const [who, t] of lines) { expect((await who.post(`/meetings/${id}/lines`, { text: t })).status).toBe(200); await sleep(150) }
    const blocks = await roomRows(db, g.id, 'meeting-transcript')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].messages.pgpt.meeting.lines).toHaveLength(6)
    expect(blocks[0].messages.content).toContain('다음 주 화요일')
    // ended by a participant (not the last to leave): minutes without anyone pressing anything else
    expect((await b.post(`/meetings/${id}/end`)).status).toBe(200)
    let minutes
    await expect.poll(async () => { minutes = (await roomRows(db, g.id, 'meeting-minutes'))[0]; return !!minutes }, { timeout: 90000 }).toBe(true)
    const mm = minutes.messages.pgpt.meeting
    expect(mm.people).toHaveLength(2)
    expect(mm.lines).toBe(6)
    expect(mm.minutes).toBeGreaterThanOrEqual(1)
    expect(minutes.messages.content).toMatch(/회의록/)
    // the meeting card says it ended
    expect((await roomRows(db, g.id, 'meeting'))[0].messages.pgpt.meeting.state).toBe('ended')
    // action items (when the summary found any) are suggestions anchored on the minutes row
    const anchored = await db.q('select audience from pro_room_suggestions where anchor_uuid=$1', [minutes.uuid])
    expect(anchored).toHaveLength(mm.actions.length)
    for (const x of anchored) expect(x.audience.every((id) => [a.id, b.id].includes(id))).toBe(true)
    // the whole record reads in process-gpt's own shape: content text + assistant rows
    for (const r of await db.q(`select messages from chats where id=$1 and messages->'pgpt'->>'kind' like 'meeting%'`, [g.id])) {
      expect(r.messages.role).toBe('assistant')
      expect(String(r.messages.content).length).toBeGreaterThan(5)
    }
  })

  test('F-MT-06 방별 도우미 끄기: 영상 회의만, 소리·글 거절, 방에는 시작·끝 카드만', async ({ as, db, cleanup }) => {
    const a = await member(await as('mt-owner')), b = await member(await as('mt-mate'))
    const g = await room(a, [b], db, cleanup)
    expect((await b.put(`/meetings/room/${g.id}/agent`, { on: false })).body.agent).toBe(false)
    const s = (await a.post(`/meetings/room/${g.id}/start`, { consent: true })).body
    expect(s.agent).toBe(false)
    expect((await a.post(`/meetings/${s.id}/lines`, { text: '견적서 보여 주세요' })).status).toBe(403)
    expect((await api.call(a.token(), 'POST', `/meetings/${s.id}/audio`, WAV(1), { headers: { 'Content-Type': 'audio/wav' } })).status).toBe(403)
    await a.post(`/meetings/${s.id}/leave`)
    await expect.poll(async () => (await roomRows(db, g.id, 'meeting-minutes')).length, { timeout: 60000 }).toBe(1)
    expect(await roomRows(db, g.id, 'meeting-transcript')).toHaveLength(0)
    expect(await roomRows(db, g.id, 'meeting-material')).toHaveLength(0)
  })
})
