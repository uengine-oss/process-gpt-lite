// 팀 대화 속 에이전트 제안 — 메신저 메시지에 에이전트가 도울 일이 보이면(규칙 → 판단 모델) 그 메시지 아래 제안 카드,
// 요청받은 사람만 보고, 아니요는 나만 숨김, 대화별 끄기, 구성원 밖은 404, 시작은 요청받은 사람만. 감지에 큰 모델은 0회.
// (server/lib/team/assist.js, routes/teamAssist.js · 설계 process-gpt/openspec/changes/pgpt-pro-team-sharing)
import { test, expect } from '../../lib/fixtures.js'

const member = async (c) => { await c.get('/team'); return c }
const judgeUp = async () => fetch((process.env.PRO_JUDGE_URL || 'http://127.0.0.1:8896/judge').replace(/\/judge$/, '/health')).then((r) => r.ok).catch(() => false)
// the stack under test must have a judge of its own (the Docker bundle has none unless JUDGE_URL is set):
// its /team/assist/stats says so; an older server that does not say falls back to the local judge
const judgeOn = async (c) => { const st = (await c.get('/team/assist/stats')).body; return st?.judge === false ? false : judgeUp() }
const ASK = '다음 주 워크숍 견적서 좀 엑셀로 뽑아줄 수 있을까요? 인원 20명, 1박2일'

test.describe('팀 대화 속 에이전트 제안 (spec pgpt-pro-team-sharing · assist)', () => {
  test('F-TA-01 잡담은 제안 없음, 업무 요청은 요청받은 사람에게만 제안, 큰 모델 호출 0', async ({ as, db, cleanup }) => {
    const a = await member(await as('ta-author')), b = await member(await as('ta-mate')), c = await member(await as('ta-third'))
    test.skip(!(await judgeOn(a)), '판단 모델(judge) 서버가 없음 — 이 스택에 PRO_JUDGE_URL 이 없으면(Docker 번들 기본) 제안 없이 규칙만')
    const g = (await a.post('/team/threads', { members: [b.id, c.id] })).body
    cleanup(() => db.q('delete from chat_rooms where id=$1', [g.id]))
    for (const t of ['점심 뭐 먹지?', 'ㅋㅋ', '👍']) expect((await a.post(`/team/threads/${g.id}/messages`, { text: t })).status).toBe(200)
    await new Promise((r) => setTimeout(r, 3000))
    expect((await b.get(`/team/threads/${g.id}/suggestions`)).body.suggestions).toHaveLength(0)
    const m = (await a.post(`/team/threads/${g.id}/messages`, { text: ASK })).body
    let sg
    await expect.poll(async () => { sg = (await b.get(`/team/threads/${g.id}/suggestions`)).body.suggestions.find((s) => s.messageId === m.id); return !!sg }, { timeout: 15000 }).toBe(true)
    expect(sg).toMatchObject({ work: 'CreateSpreadsheet', state: 'open', canStart: true })
    expect(sg.title).toContain('견적서')
    // the author is not offered their own request; the third member is
    expect((await a.get(`/team/threads/${g.id}/suggestions`)).body.suggestions).toHaveLength(0)
    expect((await c.get(`/team/threads/${g.id}/suggestions`)).body.suggestions).toHaveLength(1)
    // the author is a member but was not asked: may not start it
    expect((await a.post(`/team/suggestions/${sg.id}/start`)).status).toBe(403)
    const stats = (await b.get('/team/assist/stats')).body
    expect(stats.bigModelCalls).toBe(0)
    expect(stats.judgeLatency.n).toBeGreaterThan(0)
  })

  test('F-TA-02 아니요는 나만 숨김, 대화별 끄기, 구성원 밖 404', async ({ as, db, cleanup }) => {
    const a = await member(await as('ta-author')), b = await member(await as('ta-mate')), c = await member(await as('ta-third'))
    test.skip(!(await judgeOn(a)), '판단 모델(judge) 서버가 없음 — 이 스택에 PRO_JUDGE_URL 이 없으면(Docker 번들 기본) 제안 없이 규칙만')
    const g = (await a.post('/team/threads', { members: [b.id, c.id] })).body
    cleanup(() => db.q('delete from chat_rooms where id=$1', [g.id]))
    const m = (await a.post(`/team/threads/${g.id}/messages`, { text: ASK })).body
    let sg
    await expect.poll(async () => { sg = (await b.get(`/team/threads/${g.id}/suggestions`)).body.suggestions[0]; return !!sg }, { timeout: 15000 }).toBe(true)
    expect(sg.messageId).toBe(m.id)
    expect((await b.post(`/team/suggestions/${sg.id}/dismiss`)).status).toBe(200)
    expect((await b.get(`/team/threads/${g.id}/suggestions`)).body.suggestions).toHaveLength(0)
    expect((await c.get(`/team/threads/${g.id}/suggestions`)).body.suggestions).toHaveLength(1)
    // an outsider (not in the thread) sees nothing
    const o = await member(await as('ta-outsider'))
    expect((await o.get(`/team/threads/${g.id}/suggestions`)).status).toBe(404)
    expect((await o.post(`/team/suggestions/${sg.id}/start`)).status).toBe(404)
    // switched off for the thread: no new suggestion
    expect((await b.put(`/team/threads/${g.id}/assist`, { on: false })).body.assist).toBe(false)
    const m2 = (await a.post(`/team/threads/${g.id}/messages`, { text: '회의록 정리해 줄 수 있어요?' })).body
    await new Promise((r) => setTimeout(r, 5000))
    expect((await c.get(`/team/threads/${g.id}/suggestions`)).body.suggestions.some((s) => s.messageId === m2.id)).toBe(false)
  })

  // The rules read Korean and English words only: a request in Japanese (a teammate whose main language is
  // 日本語) got no card. It is now read through its translation, the way a meeting reads a line in another
  // language — no Japanese word lists. The detection runs here in-process (lib/team/assist.js detect, as the
  // server's room feed calls it), so the test also works against a development server without the feed.
  test('F-TA-03 일본어 요청도 제안 카드 (번역으로 읽고 같은 규칙·판단 모델), 일본어 잡담은 제안 없음', async ({ as, db, lib, cleanup }) => {
    const a = await member(await as('fix-ta-ja')), b = await member(await as('fix-ta-mate'))
    test.skip(!(await judgeOn(a)), '판단 모델(judge) 서버가 없음')
    const TR = await lib('lib/translate.js')
    test.skip(!TR.enabled(), '번역 모델(PRO_TRANSLATE·OpenAI 키)이 없음 — 다른 언어 요청은 카드 없이 둠')
    // a teammate who speaks Japanese, on English screens (what the app sets when 日本語 is chosen)
    expect((await a.put('/me/main-lang', { lang: 'ja' })).status).toBe(200)
    expect((await a.put('/me/lang', { lang: 'en' })).status).toBe(200)
    const A = await lib('lib/team/assist.js'), M = await lib('lib/team/messenger.js'), { mainLangOf } = await lib('lib/mainLang.js')
    const t = (await a.post('/team/threads', { members: [b.id] })).body
    cleanup(() => db.q('delete from chat_rooms where id=$1', [t.id]))
    const say = async (text) => {
      const m = (await a.post(`/team/threads/${t.id}/messages`, { text })).body
      const [row] = await db.q('select c.uuid, c.id, c.messages, r.participants from chats c join chat_rooms r on r.id=c.id where c.uuid=$1', [m.id])
      const { humans } = M.split(row.participants)
      const pf = A.prefilter(row.messages.content, await mainLangOf(a.id))
      expect(pf).toMatchObject({ pass: false, translate: true })
      await A.detect(row, humans, humans.find((h) => h.id === a.id), { translate: true })
      return m.id
    }
    const chat = await say('お疲れさまです！今日はいい天気ですね。')
    const ask = await say('見積書を作ってもらえますか？2号店の照明の費用も入れてください。')
    let sg
    await expect.poll(async () => { sg = (await b.get(`/team/threads/${t.id}/suggestions`)).body.suggestions.find((s) => s.messageId === ask); return !!sg }, { timeout: 15000 }).toBe(true)
    expect(['CreateSpreadsheet', 'CreateDocument']).toContain(sg.work)
    expect(sg).toMatchObject({ state: 'open', canStart: true })
    // the card quotes the request as it was written; its title is in the requester's screen language (English)
    expect(sg.reason).toContain('見積書を作ってもらえますか')
    expect(sg.title).not.toMatch(/[\u3040-\u30ff가-힣]/)
    expect((await b.get(`/team/threads/${t.id}/suggestions`)).body.suggestions.some((s) => s.messageId === chat)).toBe(false)
  })
})
