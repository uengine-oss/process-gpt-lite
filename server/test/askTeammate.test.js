// 팀원에게 물어 채우기 (lib/askTeammate.js, 스킬 skills/ask-teammate, 스펙 openspec/specs/ask-teammate) — 데이터베이스 · 모델 없이:
//   AT-U-01 도구의 인자: 이유 · 항목(1~8, 키 f1…) · 줄과 빈칸 표시는 그 줄에 그 표시가 있을 때만 · 파일 이름은 이름만
//   AT-U-02 서명한 제안: 이 서버 · 이 회사 · 그 사람의 것만, 고치거나 지난 것은 아님, deepagents 가 흘려 보내는 여러 꼴에서 읽음
//   AT-U-03 요청 글은 스킬의 틀로(그 동료의 언어), 메일 원문은 들어가지 않음
//   AT-U-04 메시지 안 양식(A2UI v1.0, Lite 단계 카탈로그): 서버가 만들고 검사를 통과, 낸 값은 화면에 대고 다시 봄(모르는 키 버림 · 하나도 없으면 400 · 「잘 모르겠어요」)
//   AT-U-05 빈칸 채우기: 에이전트가 준 줄은 모델 없이, 나머지는 모델의 「찾을 글 → 바꿀 글」을 정확히 한 번 나오는 곳만 · 값이 든 것만
//   AT-U-06 말로 한 답 읽기: 판정(답 · 모름 · 다른 말, 기준 0.7) → 답이면 모델이 값을 뽑음(항목의 키만) — 정규식으로 읽지 않음
//   AT-U-07 대화방에서 보이는 모습: 물어본 그 사람에게만 양식, 답한 값은 둘 다
//   AT-U-08 스킬 파일: 도구 설명(한 · 영) · 프롬프트, 도구는 메일을 보내지 말라고 함
// 지어낸 사람만 쓴다(정하윤 · 김서연 · 박도윤, 010-0000-0000 꼴).
// Run: node --test test/askTeammate.test.js
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DOTENV_CONFIG_QUIET = 'true'
process.env.SERVICE_ROLE_KEY ||= 'test-service-key'
const AT = await import('../lib/askTeammate.js')
const { askView } = await import('../lib/team/askView.js')
const { readSkillDir, bundledDir } = await import('../lib/skillPack.js')
const { checkSurface } = await import('../lib/stepUi/validate.js')
const { readSubmit } = await import('../lib/stepUi/values.js')
const { config } = await import('../config.js')

const base = readSkillDir(bundledDir('ask-teammate'))
const skill = { ...base, rules: { ...base.rules, readAnswer: { minConfidence: 0.7, timeoutMs: 1000, textChars: 2000 }, fill: { timeoutMs: 1000, textChars: 20000 } } }
const R = { ...skill.rules }
const DRAFT = [
  '참석자 정보 회신',
  '',
  '[정하윤]',
  '1) 이름 : 정하윤',
  '2) 연락처 : 010-0000-0001',
  '',
  '[박도윤]',
  '1) 이름 : 박도윤',
  '2) 연락처 : [확인 필요]',
  '3) 생년월일 : [확인 필요]',
  '4) 차량정보 : [확인 필요 / 차량 없으면 "없음"]',
].join('\n')

test('AT-U-01 도구의 인자: 이유 · 항목(키 f1…) · 줄과 빈칸 표시는 그 줄에 있을 때만 · 파일은 이름만', () => {
  const r = AT.shapeOffer({ reason: '  교육 출강 참석자 정보를   회신해야 해요 ', file: '/workspace/x/답장초안.txt', fields: [
    { label: '박도윤 연락처', line: '2) 연락처 : [확인 필요]\n다음 줄', blank: '[확인 필요]' },
    { label: '박도윤 생년월일', line: '3) 생년월일 : 비어 있음', blank: '[확인 필요]' },
    '차량정보', { label: '차량정보' }, { label: '' }, null,
  ] }, R)
  assert.equal(r.reason, '교육 출강 참석자 정보를 회신해야 해요')
  assert.equal(r.file, '답장초안.txt')
  assert.deepEqual(r.fields.map((f) => f.key), ['f1', 'f2', 'f3'])
  assert.deepEqual(r.fields[0], { key: 'f1', label: '박도윤 연락처', line: '2) 연락처 : [확인 필요]', blank: '[확인 필요]' })
  // a line without its marker is not kept (the fill would not know what to replace)
  assert.deepEqual(r.fields[1], { key: 'f2', label: '박도윤 생년월일' })
  assert.equal(r.fields[2].label, '차량정보')
  // at most maxFields
  const many = AT.shapeOffer({ reason: '이유', fields: Array.from({ length: 20 }, (_, i) => `항목${i}`) }, R)
  assert.equal(many.fields.length, R.maxFields)
  assert.throws(() => AT.shapeOffer({ reason: '', fields: ['a'] }, R), /reason/)
  assert.throws(() => AT.shapeOffer({ reason: '이유', fields: [] }, R), /fields/)
})

test('AT-U-02 서명한 제안: 이 회사 · 이 사람의 것만, 고친 것 · 지난 것은 아님, 흘려 보내는 꼴 그대로 읽음', () => {
  const claims = { u: 'u-1', m: { id: 'm-1', name: '박도윤' }, r: '이유', f: [{ key: 'f1', label: '연락처' }], file: 'a.txt' }
  const t = AT.signOffer(claims)
  const c = AT.verifyOffer(t)
  assert.equal(c.u, 'u-1')
  assert.equal(c.m.name, '박도윤')
  assert.equal(c.t, String(config.tenantId))
  // altered
  const [h, body, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), u: 'someone-else' })).toString('base64url')
  assert.equal(AT.verifyOffer(`${h}.${forged}.${sig}`), null)
  // expired
  assert.equal(AT.verifyOffer(AT.signOffer(claims, { now: Date.now() - 2 * 3600_000 })), null)
  // another key (another server)
  assert.equal(AT.verifyOffer(AT.signOffer(claims, { key: Buffer.from('another') })), null)
  // the shapes deepagents streams a tool result in — JSON, the MCP content list, Python's str() of it
  const out = JSON.stringify({ ok: true, ask_teammate: { offer: t, member: '박도윤' }, note: '…' })
  assert.equal(AT.offerFromOutput(out, 'u-1')?.m.id, 'm-1')
  assert.equal(AT.offerFromOutput([{ type: 'text', text: out }], 'u-1')?.m.id, 'm-1')
  assert.equal(AT.offerFromOutput(`content='${out}' name='ask_teammate' tool_call_id='x'`, 'u-1')?.m.id, 'm-1')
  // someone else's turn never takes it
  assert.equal(AT.offerFromOutput(out, 'u-2'), null)
  assert.equal(AT.offerFromOutput('{"ask_teammate":{"offer":"at1.bad.sig"}}', 'u-1'), null)
  for (const n of ['ask_teammate', 'pgpt-team__ask_teammate', 'pgpt-team.ask_teammate']) assert.ok(AT.isAskTool(n), n)
  for (const n of ['folder_open', 'not_ask_teammate_x', 'mask_teammate']) assert.ok(!AT.isAskTool(n), n)
})

test('AT-U-03 요청 글: 스킬의 틀로, 그 동료의 언어 — 이유와 항목만', () => {
  const fields = [{ key: 'f1', label: '연락처' }, { key: 'f2', label: '생년월일', hint: 'YYYY-MM-DD' }]
  const ko = AT.requestText(R, 'ko', { owner: '정하윤', reason: '교육 출강 참석자 정보를 회신해야 해요.', fields })
  assert.match(ko, /^정하윤님 대신 AI가 여쭤봐요\./)
  assert.match(ko, /교육 출강 참석자 정보를 회신해야 해요\./)
  assert.match(ko, /- 연락처\n- 생년월일 \(YYYY-MM-DD\)$/)
  const en = AT.requestText(R, 'en', { owner: 'Hayun Jung', reason: 'A reply needs the attendees.', fields })
  assert.match(en, /^Asking for Hayun Jung \(AI\)\./)
  // a $ in a name is not a replacement pattern
  assert.match(AT.requestText(R, 'ko', { owner: '$&', reason: 'r', fields }), /^\$&님/)
})

test('AT-U-04 메시지 안 양식: 서버가 만들고 검사를 통과, 낸 값은 화면에 대고 다시 본다', () => {
  const fields = [{ key: 'f1', label: '박도윤 연락처' }, { key: 'f2', label: '박도윤 생년월일', hint: 'YYYY-MM-DD' }]
  const words = { ...R.form.ko }
  const s = AT.buildSurface({ id: '0b6f1c1e-1111-4222-8333-944455556666', reason: '교육 출강 참석자 정보를 회신해야 해요.', fields, words })
  assert.ok(s, 'a surface')
  assert.equal(s.createSurface.surfaceId, 'ask_0b6f1c1e111142228333944455556666')
  const r = checkSurface(s, { surfaceId: s.createSurface.surfaceId })
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.inputs.map((i) => i.key), ['f1', 'f2', 'note'])
  assert.deepEqual(r.buttons.map((b) => b.name), ['unknown', 'answer'])
  const act = (name) => ({ name, surfaceId: s.createSurface.surfaceId })
  const ok = readSubmit(s, { values: { f1: '010-0000-0000', stray: 'x' }, action: act('answer') })
  assert.equal(ok.button.name, 'answer')
  assert.deepEqual(ok.values, { f1: '010-0000-0000', f2: '', note: '' })
  assert.deepEqual(AT.cleanValues(fields, ok.values), { f1: '010-0000-0000' })
  // nothing filled: the screen's own check refuses it
  assert.throws(() => readSubmit(s, { values: {}, action: act('answer') }), (e) => e.status === 400 && /하나 이상/.test(e.message))
  // 「잘 모르겠어요」 goes without the items
  assert.equal(readSubmit(s, { values: { note: '김서연 팀장님께 물어보세요' }, action: act('unknown') }).button.name, 'unknown')
  // a button that is not on the screen
  assert.throws(() => readSubmit(s, { values: {}, action: act('approve') }), (e) => e.status === 400)
  // one item: its own required check
  const one = AT.buildSurface({ id: 'x1', reason: 'r', fields: [fields[0]], words })
  assert.ok(checkSurface(one, { surfaceId: one.createSurface.surfaceId }).ok)
})

test('AT-U-05 빈칸 채우기: 에이전트가 준 줄은 모델 없이, 나머지는 정확히 한 번 나오는 곳만', async () => {
  const fields = [
    { key: 'f1', label: '박도윤 연락처', line: '2) 연락처 : [확인 필요]', blank: '[확인 필요]' },
    { key: 'f2', label: '박도윤 생년월일', line: '3) 생년월일 : [확인 필요]', blank: '[확인 필요]' },
    { key: 'f3', label: '박도윤 차량정보' },
    { key: 'f4', label: '정하윤 차량정보' },
  ]
  const values = { f1: '010-0000-0000', f2: '1990-01-01', f3: '없음', f4: '12가3456' }
  const calls = []
  const chatFn = async (system, user) => {
    calls.push({ system, user: JSON.parse(user) })
    return { edits: [
      // part of a line (not whole lines): not taken, even with the value in it
      { find: '[확인 필요', replace: '없음' },
      // not in the text once: not taken
      { find: '[확인 필요]', replace: '없음' },
      // the right one
      { find: '4) 차량정보 : [확인 필요 / 차량 없으면 "없음"]', replace: '4) 차량정보 : 없음' },
      // no blank for 정하윤's car in the draft: an edit that rewrites something else without the value is not taken
      { find: '[정하윤]', replace: '[정하윤 — 확인됨]' },
    ] }
  }
  const r = await AT.fillText(DRAFT, fields, values, { skill, chatFn })
  assert.equal(r.count, 3)
  assert.match(r.text, /2\) 연락처 : 010-0000-0000\n3\) 생년월일 : 1990-01-01\n4\) 차량정보 : 없음$/)
  assert.match(r.text, /2\) 연락처 : 010-0000-0001/, '다른 사람의 줄은 그대로')
  assert.match(r.text, /\[정하윤\]\n/)
  assert.deepEqual(r.missing, ['정하윤 차량정보'])
  // the model saw only what was left, as data
  assert.equal(calls.length, 1)
  assert.equal(calls[0].system, skill.prompts.fill)
  assert.deepEqual(calls[0].user.items.map((x) => x.label), ['박도윤 차량정보', '정하윤 차량정보'])
  // a line that is in the draft twice is left to the model (which must take the heading with it)
  const twice = `${DRAFT}\n\n[김서연]\n2) 연락처 : [확인 필요]`
  const r2 = await AT.fillText(twice, [fields[0]], { f1: '010-0000-0000' }, { skill, chatFn: async () => ({ edits: [{ find: '[박도윤]\n1) 이름 : 박도윤\n2) 연락처 : [확인 필요]', replace: '[박도윤]\n1) 이름 : 박도윤\n2) 연락처 : 010-0000-0000' }] }) })
  assert.equal(r2.count, 1)
  assert.match(r2.text, /\[김서연\]\n2\) 연락처 : \[확인 필요\]$/)
  // two blanks on one line: two edits written against the draft as it was (the second goes onto the first), or one edit filling both
  const LINE = '- 박도윤 / [연락처] / 생년월일 [생년월일]'
  const two = [{ key: 'f1', label: '박도윤 연락처' }, { key: 'f2', label: '박도윤 생년월일' }]
  const vals = { f1: '010-0000-0000', f2: '1990-01-01' }
  const r4 = await AT.fillText(`안녕하세요.\n${LINE}\n감사합니다.`, two, vals, { skill, chatFn: async () => ({ edits: [
    { find: LINE, replace: '- 박도윤 / 010-0000-0000 / 생년월일 [생년월일]' }, { find: LINE, replace: '- 박도윤 / [연락처] / 생년월일 1990-01-01' }] }) })
  assert.deepEqual([r4.count, r4.missing], [2, []])
  assert.match(r4.text, /^- 박도윤 \/ 010-0000-0000 \/ 생년월일 1990-01-01$/m)
  const r5 = await AT.fillText(`안녕하세요.\n${LINE}\n감사합니다.`, two, vals, { skill, chatFn: async () => ({ edits: [{ find: LINE, replace: '- 박도윤 / 010-0000-0000 / 생년월일 1990-01-01' }] }) })
  assert.deepEqual([r5.count, r5.missing], [2, []])
  // the model does not answer: what the lines gave stays, the rest is missing
  const r3 = await AT.fillText(DRAFT, fields, values, { skill, chatFn: async () => { throw new Error('down') } })
  assert.equal(r3.count, 2)
  assert.deepEqual(r3.missing, ['박도윤 차량정보', '정하윤 차량정보'])
})

test('AT-U-06 말로 한 답: 판정(답 · 모름 · 다른 말) → 답이면 모델이 값을 뽑는다', async () => {
  const ask = { reason: '교육 출강 참석자 정보를 회신해야 해요.', memberName: '박도윤', fields: [{ key: 'f1', label: '연락처' }, { key: 'f2', label: '생년월일' }] }
  const seen = []
  const odds = (pick, p) => async (state, question, options) => { seen.push({ state, question, options: options.map((o) => o.key) }); return { choice: pick, probabilities: { [pick]: p }, confidence: p, strategy: 'logprob' } }
  const extract = async (system, user) => { assert.equal(system, skill.prompts.extract); const u = JSON.parse(user); return { values: { f1: '010-0000-0000', zz: 'x', f2: '' }, note: u.message.includes('차') ? '차는 없어요' : '' } }
  const a = await AT.readReply(ask, '연락처 010-0000-0000 이고 차는 없어요', { skill, judges: { odds: odds('answer', 0.92) }, chatFn: extract })
  assert.equal(a.kind, 'answer')
  assert.deepEqual(a.values, { f1: '010-0000-0000' })
  assert.equal(a.note, '차는 없어요')
  assert.deepEqual(seen[0].options, ['answer', 'unknown', 'other'])
  assert.equal(seen[0].question, skill.prompts['read-answer'])
  assert.match(seen[0].state, /«연락처 010-0000-0000 이고 차는 없어요»/)
  const u = await AT.readReply(ask, '저도 몰라요, 김서연 팀장님께 물어보세요', { skill, judges: { odds: odds('unknown', 0.88) }, chatFn: extract })
  assert.deepEqual([u.kind, u.note], ['unknown', '저도 몰라요, 김서연 팀장님께 물어보세요'])
  assert.equal((await AT.readReply(ask, '네 확인했어요', { skill, judges: { odds: odds('other', 0.95) }, chatFn: extract })).kind, 'other')
  // not sure enough: nothing is taken as an answer
  assert.equal((await AT.readReply(ask, '010?', { skill, judges: { odds: odds('answer', 0.55) }, chatFn: extract })).kind, 'other')
  // judged an answer but no value came out: not an answer
  assert.equal((await AT.readReply(ask, '음', { skill, judges: { odds: odds('answer', 0.9) }, chatFn: async () => ({ values: {} }) })).kind, 'other')
  // no reading at all (the model down): nothing is taken
  assert.equal((await AT.readReply(ask, '010-0000-0000', { skill, judges: { odds: async () => null, json: async () => { throw new Error('down') } }, chatFn: extract })).kind, 'other')
})

test('AT-U-07 대화방에서 보이는 모습: 양식은 물어본 그 사람에게만, 열려 있을 때만 · 답은 둘 다', () => {
  const ask = { card: 'c', owner: 'owner', ownerName: '정하윤', member: 'member', memberName: '박도윤', fields: [{ key: 'f1', label: '연락처', line: 'x', blank: 'y' }], surface: { createSurface: {} }, state: 'asked' }
  const them = askView('member', ask)
  assert.ok(them.forMe && them.surface)
  assert.deepEqual(them.fields, [{ key: 'f1', label: '연락처' }])
  const mine = askView('owner', ask)
  assert.ok(mine.mine && !mine.forMe && !mine.surface)
  assert.ok(!askView('member', { ...ask, state: 'answered', values: { f1: '010-0000-0000' } }).surface)
  assert.deepEqual(askView('owner', { ...ask, state: 'answered', values: { f1: '010-0000-0000' } }).values, { f1: '010-0000-0000' })
  assert.ok(!askView('member', { ...ask, state: 'cancelled' }).surface)
  assert.ok(askView('member', { ...ask, state: 'late' }).surface, '늦어도 답할 수 있다')
})

test('AT-U-08 스킬 파일: 도구 설명(한 · 영) · 프롬프트 · 규칙, 도구는 아무것도 보내지 않고 메일을 보내지 말라고 한다', async () => {
  for (const k of ['tool', 'tool-en', 'read-answer', 'answer-json', 'extract', 'fill']) assert.ok(skill.prompts[k]?.length > 40, k)
  assert.match(skill.prompts.tool, /보내지 않습니다/)
  assert.match(skill.prompts.tool, /메일은 절대 보내지 마세요/)
  assert.match(skill.prompts['tool-en'], /Never send any mail/)
  assert.equal(R.remindAfterHours, 24)
  const { tools } = await import('../mcp/team.js')
  const [t] = await tools('ko')
  assert.equal(t.name, 'ask_teammate')
  assert.deepEqual(t.inputSchema.required, ['member', 'reason', 'fields'])
  assert.equal((await tools('en'))[0].description, skill.prompts['tool-en'])
})
