// English mode in meetings (lib/meetings): a meeting's language, the judge's question and options in the
// meeting's language with the same keys (the options are skill descriptions — lib/offers.js), which
// material a line means picked by the judge from candidate names, the card title the judge wrote, and the
// room record / minutes texts — with Korean meetings as they were. A stand-in judge server answers.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { startJudge } from './fixtures/judgeStub.mjs'
// the modules pull in the DB client through their imports; a checkout without server/.env still runs these
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
let answer = () => 'none'
const J = await startJudge((body, n) => answer(body, n))
process.env.PRO_JUDGE_URL = J.url
after(() => J.close())
const { withLang } = await import('../lib/lang.js')
const R = await import('../lib/meetings/record.js')
const I = await import('../lib/meetings/intent.js')
const MAT = await import('../lib/meetings/materials.js')
const MIN = await import('../lib/meetings/minutes.js')
const S = await import('../lib/meetings/service.js')

const en = (fn) => withLang('en', fn)
const ko = (fn) => withLang('ko', fn)

test('a meeting is in the language it was started in (summary.lang), Korean otherwise', () => {
  assert.equal(R.meetingLang({ summary: { lang: 'en' } }), 'en')
  assert.equal(R.meetingLang({ summary: { lang: 'en', summary: 'We agreed…', decisions: [] } }), 'en')
  assert.equal(R.meetingLang({ summary: null }), 'ko')
  assert.equal(R.meetingLang({ summary: { summary: '견적서를 다시 봤어요.' } }), 'ko')
  assert.equal(R.meetingLang({}), 'ko')
  assert.equal(R.meetingLang(null), 'ko')
})

test('the judge reads its question and options in the meeting\'s language; the keys never change', () => {
  const e = en(() => I.options()), k = ko(() => I.options())
  assert.deepEqual(e.map((o) => o.key), k.map((o) => o.key))
  assert.deepEqual(e.slice(0, 3).map((o) => o.key), ['none', 'show', 'find'])
  for (const o of e) assert.doesNotMatch(o.label, /[가-힣]/, o.key)
  for (const o of k) assert.match(o.label, /[가-힣]/, o.key)
  // the kinds of work are the meeting's offer skills (no process start or definition in a meeting)
  assert.ok(e.some((o) => o.key === 'CreateSpreadsheet'))
  assert.ok(!e.some((o) => o.key === 'StartProcessInstance' || o.key === 'CreateProcessDefinition'))
  // format only before the judge
  assert.equal(I.cue('ok').why, null)
  assert.equal(I.cue('…').why, 'emoji')
})

test('a line the judge calls a request: the work and the title it wrote; a material: the candidate it picked', async () => {
  const ctx = { roomId: 'r', speaker: { id: 'u', name: 'Kim' }, prev: [], shown: new Set() }
  answer = () => 'CreateDocument'
  J.calls.length = 0
  const r = await en(() => I.detect({ speaker: 'Kim', text: 'somebody should turn this into a one-pager for the board' }, ctx))
  assert.equal(r.request.work, 'CreateDocument')
  assert.equal(r.request.title, null, 'the judge server writes no title: the offer\'s title is used')
  assert.equal(J.calls[0].question, 'Does the remark just made hold something for the AI assistant listening in to do? If so, what?')
  answer = () => 'none'
  assert.equal(await ko(() => I.detect({ speaker: '김', text: '그건 제가 금요일까지 해 올게요' }, ctx)), null)
  // a material: the judge picks among the names the speaker can see (given here as the list)
  const list = [{ kind: 'file', id: 'f1', title: 'Q3_partner_rebates.xlsx' }, { kind: 'file', id: 'f2', title: 'Q3_partner_rebates.pdf' }, { kind: 'process', id: 'p9', title: 'Vendor onboarding #12' }]
  answer = (body) => (body.question.startsWith('Which material') ? 'c1' : 'show')
  J.calls.length = 0
  const pick = await en(() => MAT.pick('pull up the rebate pdf', null, { list }))
  assert.equal(pick.pick.id, 'f2')
  assert.deepEqual(J.calls[0].options.map((o) => o.key), ['none', 'c0', 'c1', 'c2'])
  assert.match(J.calls[0].options[2].label, /^\[file\] Q3_partner_rebates\.pdf/)
  answer = () => 'none'
  assert.equal((await en(() => MAT.pick('the old contract', null, { list }))).pick, null)
})

const meeting = { id: 'm1', started_at: '2026-10-28T05:00:00Z', ended_at: '2026-10-28T05:12:00Z', started_by: 'u', agent: true }

test('room record and minutes: English in an English meeting, Korean exactly as before', () => {
  ko(() => {
    assert.equal(R.cardOf(meeting, [{ name: '장진영' }, { name: '김민지', left_at: 'x' }]).content, '📹 회의 중 · 1명 참여 (장진영) — 프로세스 GPT 라이트 메시지에서 참여할 수 있어요')
    assert.equal(R.cardOf(meeting, [{ name: '장진영' }, { name: '김민지' }], { ended: true }).content, '📹 회의가 끝났어요 · 12분 · 참여 2명 (장진영, 김민지)')
    assert.deepEqual(MIN.ruleSummary([{ speaker: '장진영' }, { speaker: '김민지' }, { speaker: '장진영' }], ['장진영', '김민지'], [], []),
      { summary: '장진영, 김민지님이 이야기를 나눴어요. 장진영 2번, 김민지 1번 말했어요.', decisions: [], actions: [] })
    assert.equal(R.kindWord('file'), '파일')
  })
  en(() => {
    const live = R.cardOf(meeting, [{ name: 'Jinyoung Jang' }, { name: 'Minji Kim', left_at: 'x' }]).content
    assert.match(live, /^📹 Meeting in progress · 1 in the meeting \(Jinyoung Jang\)/)
    const ended = R.cardOf(meeting, [{ name: 'Jinyoung Jang' }, { name: 'Minji Kim' }], { ended: true }).content
    assert.equal(ended, '📹 The meeting ended · 12 min · 2 joined (Jinyoung Jang, Minji Kim)')
    const s = MIN.ruleSummary([{ speaker: 'Jinyoung Jang' }, { speaker: 'Minji Kim' }, { speaker: 'Jinyoung Jang' }], ['Jinyoung Jang', 'Minji Kim'], [], [])
    assert.equal(s.summary, 'Jinyoung Jang, Minji Kim talked. Jinyoung Jang spoke 2 times, Minji Kim spoke 1 time.')
    assert.equal(R.kindWord('process'), 'Progress')
    for (const t of [live, ended, s.summary]) assert.doesNotMatch(t, /[가-힣]/)
  })
})

test('a request card without a title from the judge gets its offer\'s title in the meeting\'s language', async () => {
  const { offerOf } = await import('../lib/offers.js')
  assert.equal(en(() => offerOf('CreateSpreadsheet').title), 'Draft the table')
  assert.equal(ko(() => offerOf('CreateSpreadsheet').title), '표 초안 만들기')
  assert.equal(en(() => offerOf('SummarizeChat').badge), 'Summary')
  assert.equal(offerOf('NoSuchWork'), null)
})
