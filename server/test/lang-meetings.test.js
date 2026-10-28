// English mode in meetings (lib/meetings): a meeting's language, English cues for the rules-first detector,
// English judge labels with the same keys, English name matching, and the room record / minutes texts —
// with Korean meetings exactly as they were.
import test from 'node:test'
import assert from 'node:assert/strict'
// the modules pull in the DB client through their imports; a checkout without server/.env still runs these
process.env.SERVICE_ROLE_KEY ||= 'unit-test'
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

test('English cues: materials and requests said in English, in an English meeting only', () => {
  const lines = {
    quote: 'Shall we look at the Moonlight Coffee quote we sent last time again?',
    plan: "Sure. Let's look at the floor plan too. They asked us to move the bar counter.",
    trip: "And how far has last week's Busan travel expense settlement got?",
    redo: 'Then please redo the quote with the amount 5% lower.',
    chat: 'Sounds good to me, thanks everyone',
  }
  en(() => {
    assert.deepEqual(I.cue(lines.quote), { material: true, request: false, why: null })
    assert.equal(I.cue(lines.plan).material, true)
    assert.equal(I.cue(lines.trip).material, true)
    assert.deepEqual(I.cue(lines.redo), { material: true, request: true, why: null })
    assert.equal(I.cue(lines.chat).why, 'no-cue')
    assert.equal(I.cue('ok').why, 'short')
    // a Korean line in an English meeting still counts
    assert.equal(I.cue('견적서 금액 5% 낮춰서 다시 만들어 주세요.').request, true)
  })
  ko(() => {
    // a Korean meeting is judged by the Korean rules only, as before
    for (const t of Object.values(lines)) assert.equal(I.cue(t).why, 'no-cue', t)
    assert.deepEqual(I.cue('견적서 금액 5% 낮춰서 다시 만들어 주세요.'), { material: true, request: true, why: null })
    assert.deepEqual(I.cue('지난번 달빛커피 견적서 다시 볼까요?'), { material: true, request: false, why: null })
  })
})

test('the judge reads English questions and labels in an English meeting; the keys never change', () => {
  const opts = [
    { key: 'no', label: '의견·잡담·결정처럼 자료를 찾을 필요가 없는 말' },
    { key: 'yes', label: '이미 있는 파일·문서·진행 상황·기록을 찾아서 보자는 말' },
  ]
  const works = [{ key: 'CreateSpreadsheet', label: '견적서·예산표·정산표 같은 표나 엑셀 파일 만들기' }, { key: 'DraftReply', label: '메일·답장·공지 초안 쓰기' }]
  const cands = [{ key: 'c0', label: 'Moonlight_Coffee_quote.xlsx' }]
  en(() => {
    const o = I.judgeOptions(opts)
    assert.deepEqual(o.map((x) => x.key), ['no', 'yes'])
    for (const x of o) assert.doesNotMatch(x.label, /[가-힣]/)
    assert.deepEqual(I.judgeOptions(works).map((x) => x.key), ['CreateSpreadsheet', 'DraftReply'])
    assert.match(I.judgeOptions(works)[0].label, /spreadsheet/i)
    assert.deepEqual(I.judgeOptions(cands), cands)
    assert.equal(I.judgeQuestion('방금 한 말은 어떤 말인가요?'), 'What kind of remark was just made?')
  })
  ko(() => {
    assert.equal(I.judgeOptions(opts), opts)
    assert.equal(I.judgeOptions(works), works)
    assert.equal(I.judgeQuestion('방금 한 말은 어떤 말인가요?'), '방금 한 말은 어떤 말인가요?')
  })
})

test('material names match English speech without case; Korean scores are the same as before', () => {
  en(() => {
    const said = "Let's look at the Quote again"
    const quote = MAT.score(said, 'Moonlight_Coffee_quote.xlsx')
    const revised = MAT.score(said, 'Moonlight_Coffee_quote_revised.xlsx')
    const plan = MAT.score(said, 'Moonlight_Coffee_floor_plan.dxf')
    assert.ok(quote > 0)
    assert.ok(quote > revised, 'the name with fewer unsaid words wins')
    assert.equal(plan, 0)
    assert.ok(MAT.score('pull up the floor plan', 'Moonlight_Coffee_floor_plan.dxf') > 0)
    assert.ok(MAT.score('can we see the drawing', 'Moonlight_Coffee_floor_plan.dxf') > 0, 'a synonym')
  })
  ko(() => {
    // the values the Korean matcher gave before English mode existed
    assert.equal(MAT.score('지난번달빛커피견적서다시볼까요?', '달빛커피_견적서.xlsx'), 5)
    assert.equal(MAT.score('평면도도 같이 봐요', '달빛커피_평면도.dxf'), 2.75)
    assert.equal(MAT.score('견적서 다시', '달빛커피_견적서_수정.xlsx'), 2.5)
    assert.equal(MAT.score("Let's look at the Quote again", 'Moonlight_Coffee_quote.xlsx'), 0)
  })
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

test('a request heard in an English meeting gets an English card title', () => {
  assert.equal(S.requestTitleEn('CreateSpreadsheet', 'Then please redo the quote with the amount 5% lower.'), 'Draft the quote')
  assert.equal(S.requestTitleEn('CreateSpreadsheet', 'Can you make the revised quote?'), 'Draft the revised quote')
  assert.equal(S.requestTitleEn('CreateDocument', 'please update the floor plan notes'), 'Draft the floor plan')
  assert.equal(S.requestTitleEn('SummarizeChat', 'can you sum this up'), 'Summarize the meeting')
  assert.equal(S.requestTitleEn('DraftReply', 'could you write back to them'), 'Draft the reply')
  assert.equal(S.requestTitleEn('ScheduleRegistration', 'please book a follow-up'), 'Schedule the meeting')
})
