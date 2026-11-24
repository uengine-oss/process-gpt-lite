// 단계 입력 화면(lib/stepUi, 스펙 step-ui-a2ui) — 모델 · 데이터베이스 없이:
//   - Lite 단계 카탈로그: 기본 카탈로그의 부분집합, 화면(src)의 목록과 같음
//   - 받는 화면: 공식 v1.0 스키마 + 서버 검사(없는 id · 고리 · 크기 · 경로 · 예약어 · 주소 · 버튼), 정리(normalize)
//   - 낸 값: 저장한 화면에 대고 다시 봄(버튼 · 키 · 꼴 · 보기 · 검사 · 길이), 다음 단계가 읽는 글(result)
//   - 만들기: 검사에 걸리면 까닭을 붙여 한 번 더, 그래도 안 되면 null(글 한 칸으로), 비밀을 묻는 화면은 쓰지 않음
// Run: node --test test/stepUi.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.DOTENV_CONFIG_QUIET = 'true'
const here = path.dirname(fileURLToPath(import.meta.url))
const V = await import('../lib/stepUi/validate.js')
const W = await import('../lib/stepUi/values.js')
const G = await import('../lib/stepUi/generate.js')
const C = await import('../lib/stepUi/catalogInfo.js')
const FIXTURE = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'step-ui-review.json'), 'utf8'))
const SID = 'step_0123abcd'
const fresh = () => V.normalize(structuredClone(FIXTURE), { surfaceId: SID })
const cs = (m) => m.createSurface
const comp = (m, id) => cs(m).components.find((c) => c.id === id)
const bad = (m, re, opts = {}) => {
  const r = V.checkSurface(m, { surfaceId: m.createSurface?.surfaceId || SID, ...opts })
  assert.equal(r.ok, false, 'should be refused')
  assert.ok(r.errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(r.errors)}`)
  return r
}

// ---------- the catalog ----------
test('Lite 단계 카탈로그: 기본 카탈로그 v1 의 부분집합 — 그림 · 영상 · 소리 · 링크 · 모달 · 비밀번호 칸 없음, 화면 쪽 목록과 같다', async () => {
  const cat = V.CATALOG
  assert.equal(cat.catalogId, C.CATALOG_ID)
  assert.equal(cat.$id, C.CATALOG_ID)
  assert.equal(cat.protocolVersion, '1.0')
  assert.deepEqual(Object.keys(cat.components), C.COMPONENTS)
  assert.deepEqual(Object.keys(cat.functions), C.FUNCTIONS)
  for (const n of ['Image', 'Video', 'AudioPlayer', 'Modal', 'Icon', 'Tabs', 'List']) assert.ok(!(n in cat.components), n)
  for (const n of ['openUrl', 'regex']) assert.ok(!(n in cat.functions), n)
  const variant = cat.components.TextField.allOf.find((x) => x.properties?.variant).properties.variant
  assert.deepEqual(variant.enum.sort(), ['longText', 'number', 'shortText'])
  assert.match(cat.instructions, /One field per line/)
  assert.match(cat.instructions, /Never ask for passwords/)
  const client = await import('../../src/components/a2ui/catalogIds.js')
  assert.equal(client.CATALOG_ID, C.CATALOG_ID)
  assert.deepEqual(client.COMPONENTS, C.COMPONENTS)
  assert.deepEqual(client.FUNCTIONS, C.FUNCTIONS)
  // the prompt's reference is made from the catalog itself
  const brief = G.catalogBrief()
  for (const n of C.COMPONENTS) assert.match(brief, new RegExp(`- ${n}:`))
  assert.doesNotMatch(brief, /obscured|openUrl|Image/)
})

// ---------- screens ----------
test('받는 화면: 공식 스키마와 서버 검사를 통과하고, 이름 · 카탈로그 · 데이터 모델은 서버가 정리한다', () => {
  const m = V.normalize({ ...structuredClone(FIXTURE), createSurface: { ...structuredClone(FIXTURE.createSurface), surfaceId: 'whatever', catalogId: 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json',
    dataModel: { form: { decision: 'go', amount: 1200, checked: 'yes', stray: 'x' }, other: { a: 1 } } } }, { surfaceId: SID })
  assert.equal(cs(m).surfaceId, SID)
  assert.equal(cs(m).catalogId, C.CATALOG_ID)
  assert.equal(cs(m).sendDataModel, true)
  // only the bound keys, each in its input's type (a single choice as a list, a number field as text, a checkbox as a boolean)
  assert.deepEqual(cs(m).dataModel, { form: { decision: ['go'], amount: '1200', due: '', checked: false, opinion: '' } })
  const r = V.checkSurface(m, { surfaceId: SID })
  assert.deepEqual(r.errors, [])
  assert.equal(r.ok, true)
  assert.deepEqual(r.inputs.map((i) => i.key), ['decision', 'amount', 'due', 'checked', 'opinion'])
  assert.deepEqual(r.buttons.map((b) => [b.name, b.variant]), [['reject', 'default'], ['submit', 'primary']])
})

test('걸리는 화면: v0.9 바인딩 · theme · 모르는 컴포넌트 · 없는 id · 고리 · 너무 큼 · javascript: 주소', () => {
  // v0.9 binding ({"path": …}) instead of {"@path": …}
  let m = fresh(); comp(m, 'opinion').value = { path: '/form/opinion' }
  bad(m, /schema: components\/\d+ \(opinion\) TextField: \/value/)
  // theme on createSurface (gone in v1.0)
  m = fresh(); cs(m).theme = { primaryColor: '#ff0000' }
  bad(m, /additional properties \(theme\)/)
  // a component the catalog does not have (an image from elsewhere)
  m = fresh(); cs(m).components.push({ id: 'pic', component: 'Image', url: 'https://example.com/x.png' }); comp(m, 'col').children.push('pic')
  bad(m, /unknown component Image/)
  // a child that does not exist
  m = fresh(); comp(m, 'col').children.push('ghost')
  bad(m, /refers to "ghost", which does not exist/)
  // a cycle: a column inside itself through another
  m = fresh(); cs(m).components.push({ id: 'inner', component: 'Column', children: ['col'] }); comp(m, 'col').children.push('inner')
  bad(m, /two parents|cycle/)
  // over the size limit
  m = fresh(); comp(m, 'intro').text = '가'.repeat(1900)
  bad(m, /bytes; the limit is 2000/, { limits: { maxBytes: 2000 } })
  // a javascript: address anywhere in the screen
  m = fresh(); comp(m, 'intro').text = 'javascript:alert(document.cookie)'
  bad(m, /javascript: address is not allowed/)
  m = fresh(); comp(m, 'intro').text = 'ftp://files.example.com/a'
  bad(m, /ftp:\/\/ address/)
})

test('걸리는 화면: 경로는 /form/<키>만 · 예약어 · 한 키에 두 입력 · 버튼은 이벤트만 · 비밀번호 칸 · 떨어진 컴포넌트 · 템플릿', () => {
  let m = fresh(); comp(m, 'opinion').value = { '@path': '/secret/opinion' }
  bad(m, /must be \/form\/<key>/)
  m = fresh(); comp(m, 'opinion').value = { '@path': '/form/result' }
  bad(m, /the key "result" is reserved/)
  m = fresh(); comp(m, 'amount').value = { '@path': '/form/opinion' }
  bad(m, /bound by another input/)
  m = fresh(); comp(m, 'send').action = { functionCall: { '@call': 'formatString', args: { value: 'x' } } }
  bad(m, /sends an event/)
  m = fresh(); comp(m, 'send').action = { functionCall: { '@call': 'openUrl', args: { url: 'https://example.com' } } }
  bad(m, /schema/)
  m = fresh(); comp(m, 'opinion').variant = 'obscured'
  bad(m, /schema: components\/\d+ \(opinion\) TextField: \/variant must be equal to one of the allowed values/)
  m = fresh(); cs(m).components.push({ id: 'lost', component: 'Text', text: '어디에도 없음' })
  bad(m, /"lost" is not reachable from root/)
  m = fresh(); comp(m, 'col').children = { path: '/form/items', componentId: 'intro' }
  bad(m, /no templates|schema/)
  m = fresh(); comp(m, 'send').variant = 'default'
  bad(m, /exactly one Button has variant "primary"/)
  m = fresh(); comp(m, 'buttons').children = []
  bad(m, /no Button sends the form|not reachable/)
  m = fresh(); comp(m, 'intro').text = { '@call': 'formatString', args: { value: '견적 ${/task/title}' } }
  bad(m, /formatString placeholder/)
  // numeric over a number field's text: the renderer reads it as not a number — refused (the field takes numbers only)
  m = fresh(); comp(m, 'amount')['@checks'] = [{ condition: { '@call': 'numeric', args: { value: { '@path': '/form/amount' }, min: 0 } }, message: '0 이상' }]
  bad(m, /numeric is for a Slider's value only/)
  m = fresh(); comp(m, 'intro').id = 'intro-text'; comp(m, 'col').children[0] = 'intro-text'
  bad(m, /letters, digits and _/)
  m = fresh(); cs(m).components = cs(m).components.filter((c) => c.id !== 'root')
  bad(m, /no component with id "root"/)
  // not a createSurface at all
  assert.equal(V.checkSurface({ version: '1.0', deleteSurface: { surfaceId: SID } }).ok, false)
  assert.equal(V.checkSurface(null).ok, false)
})

// ---------- what a person hands in ----------
const action = (name, extra = {}) => ({ name, surfaceId: SID, sourceComponentId: name === 'reject' ? 'reject' : 'send', timestamp: new Date().toISOString(), context: {}, ...extra })
const throws400 = (fn, re) => assert.throws(fn, (e) => e.status === 400 && re.test(e.message))

test('낸 값: 화면이 묶은 키만, 입력마다 꼴 · 보기 · 길이를 다시 보고, 보내기 버튼은 화면의 검사를 다시 셈한다', () => {
  const m = fresh()
  const ok = W.readSubmit(m, { values: { decision: ['adjust'], amount: '24500000', due: '2026-12-10', checked: true, opinion: '설계비를 조정해 주세요.\n납기는 그대로.', injected: 'x', result: '가짜' }, action: action('submit') })
  assert.deepEqual(ok.values, { decision: ['adjust'], amount: '24500000', due: '2026-12-10', checked: true, opinion: '설계비를 조정해 주세요.\n납기는 그대로.' })
  assert.deepEqual(ok.button, { id: 'send', name: 'submit', label: '검토 결과 보내기', primary: true })
  // a button the screen does not have · another screen · no action
  throws400(() => W.readSubmit(m, { values: {}, action: action('approve_all') }), /없는 버튼/)
  throws400(() => W.readSubmit(m, { values: {}, action: action('submit', { surfaceId: 'step_other' }) }), /다른 화면/)
  throws400(() => W.readSubmit(m, { values: {}, action: action('submit', { sourceComponentId: 'reject' }) }), /없는 버튼/)
  throws400(() => W.readSubmit(m, { values: {} }), /버튼/)
  const base = { decision: ['go'], amount: '', due: '', checked: false, opinion: '좋아요' }
  // types and choices
  throws400(() => W.readSubmit(m, { values: { ...base, decision: ['approve'] }, action: action('submit') }), /없는 보기/)
  throws400(() => W.readSubmit(m, { values: { ...base, decision: ['go', 'adjust'] }, action: action('submit') }), /하나만/)
  throws400(() => W.readSubmit(m, { values: { ...base, decision: 'go' }, action: action('submit') }), /보기 목록/)
  throws400(() => W.readSubmit(m, { values: { ...base, checked: 'true' }, action: action('submit') }), /참 · 거짓/)
  throws400(() => W.readSubmit(m, { values: { ...base, amount: '이천만' }, action: action('submit') }), /숫자/)
  throws400(() => W.readSubmit(m, { values: { ...base, due: '12월 10일' }, action: action('submit') }), /날짜/)
  throws400(() => W.readSubmit(m, { values: { ...base, opinion: { text: 'x' } }, action: action('submit') }), /글이어야/)
  throws400(() => W.readSubmit(m, { values: { ...base, opinion: '가'.repeat(101) }, action: action('submit') }, { maxValueChars: 100 }), /100자/)
  // the screen's checks: the send button's and every input's (required decision · opinion)
  throws400(() => W.readSubmit(m, { values: { ...base, decision: [] }, action: action('submit') }), /검토 결과를 골라 주세요/)
  // 반려: only its own check (a reason) — no decision needed
  throws400(() => W.readSubmit(m, { values: { ...base, decision: [], opinion: '' }, action: action('reject') }), /반려하는 까닭/)
  const rej = W.readSubmit(m, { values: { ...base, decision: [], opinion: '단가가 맞지 않아요' }, action: action('reject') })
  assert.equal(rej.button.name, 'reject')
  // missing keys take the empty value of their input
  const empty = W.readSubmit(m, { values: { decision: ['go'], opinion: '확인' }, action: action('submit') })
  assert.deepEqual(empty.values, { decision: ['go'], amount: '', due: '', checked: false, opinion: '확인' })
})

test('검사 함수는 기본 카탈로그와 같은 뜻: required · length · numeric · email · and · or · not', () => {
  const ev = (call, form) => W.evalValue(call, { form })
  const p = (k) => ({ '@path': `/form/${k}` })
  assert.equal(ev({ '@call': 'required', args: { value: p('a') } }, { a: '' }).valid, false)
  assert.equal(ev({ '@call': 'required', args: { value: p('a') } }, { a: [] }).valid, false)
  assert.equal(ev({ '@call': 'required', args: { value: p('a') } }, { a: false }).valid, true)
  assert.equal(ev({ '@call': 'length', args: { value: p('a'), min: 2, max: 4 } }, { a: '가나다' }).valid, true)
  assert.equal(ev({ '@call': 'length', args: { value: p('a'), max: 2 } }, { a: '가나다' }).valid, false)
  // (as @a2ui/web_core: an empty text reads as 0)
  assert.equal(ev({ '@call': 'numeric', args: { value: p('a'), min: 0 } }, { a: '' }).valid, true)
  assert.equal(ev({ '@call': 'numeric', args: { value: p('a'), min: 0 } }, { a: 'x' }).valid, false)
  assert.equal(ev({ '@call': 'email', args: { value: p('a') } }, { a: 'yoon@example.com' }).valid, true)
  assert.equal(ev({ '@call': 'email', args: { value: p('a') } }, { a: '' }).valid, false)
  const req = (k) => ({ '@call': 'required', args: { value: p(k) } })
  assert.equal(ev({ '@call': 'and', args: { values: [req('a'), req('b')] } }, { a: 'x', b: '' }), false)
  assert.equal(ev({ '@call': 'or', args: { values: [req('a'), req('b')] } }, { a: 'x', b: '' }), true)
  assert.equal(ev({ '@call': 'not', args: { value: req('a') } }, { a: '' }), true)
  // a function that is not a check does not count as passing
  assert.deepEqual(W.failedChecks({ '@checks': [{ condition: { '@call': 'openUrl', args: {} }, message: 'no' }] }, { form: {} }), ['no'])
})

test('다음 단계가 읽는 글(result): 누른 버튼(둘 이상일 때) · 「라벨: 값」 · 빈 칸은 빼고 · 긴 글은 아래 줄에 — 뜻은 읽지 않는다', () => {
  const m = fresh()
  const { values, button } = W.readSubmit(m, { values: { decision: ['adjust'], amount: '24500000', due: '2026-12-10', checked: true, opinion: '설계비를 조정해 주세요.\n납기는 그대로.' }, action: action('submit') })
  assert.equal(W.resultText(m, values, button, 'ko'), [
    '결정: 검토 결과 보내기',
    '검토 결과: 금액 조정 후 진행',
    '확정 금액(원): 24500000',
    '납기일: 2026-12-10',
    '단가표와 맞춰 봤어요: 예',
    '검토 의견:\n설계비를 조정해 주세요.\n납기는 그대로.',
  ].join('\n'))
  const r = W.readSubmit(m, { values: { decision: [], opinion: 'Unit prices do not match' }, action: action('reject') })
  assert.equal(W.resultText(m, r.values, r.button, 'en'), 'Decision: 반려\n단가표와 맞춰 봤어요: No\n검토 의견: Unit prices do not match')
  // one button only: no decision line
  const one = fresh(); comp(one, 'buttons').children = ['send']
  one.createSurface.components = one.createSurface.components.filter((c) => !['reject', 'reject_label'].includes(c.id))
  assert.equal(W.resultText(one, { decision: ['go'], amount: '', due: '', checked: false, opinion: '좋아요' }, { label: '검토 결과 보내기' }), '검토 결과: 그대로 진행\n단가표와 맞춰 봤어요: 아니요\n검토 의견: 좋아요')
})

test('보낸 동작(renderer → agent)의 꼴은 공식 스키마로 본다', () => {
  assert.equal(V.checkAction({ version: '1.0', action: action('submit') }).ok, true)
  assert.equal(V.checkAction({ version: '1.0', action: { name: 'submit' } }).ok, false)
  assert.equal(V.checkAction({ version: '0.9', action: action('submit') }).ok, false)
})

// ---------- making it ----------
const INPUT = { lang: 'ko', today: '2026-11-24', step: '견적 검토', role: '영업', definition: { description: '견적 금액 · 납기를 확인한다', instruction: '', outputs: ['검토 결과'], checkpoints: ['단가표 대조'] },
  request: { subject: '교육장 인테리어 견적 요청', body: '', from: '윤태호 <yoon@example.test>', customer: '한빛상사' }, earlier: [] }
const answer = (obj) => ({ content: typeof obj === 'string' ? obj : JSON.stringify(obj) })

test('만들기: 첫 답이 맞으면 그대로(이름 · 카탈로그는 서버 것), 프롬프트는 스킬의 step-ui + 카탈로그 지침', async () => {
  const seen = []
  const r = await G.makeSurface(INPUT, { surfaceId: SID, R: {}, chatFn: async (o) => { seen.push(o); return answer(FIXTURE) } })
  assert.equal(r.tries, 1)
  assert.equal(r.msg.createSurface.surfaceId, SID)
  assert.equal(r.inputs, 5)
  assert.equal(r.buttons, 2)
  assert.match(seen[0].messages[0].content, /입력 화면을 만듭니다/)
  assert.match(seen[0].messages[0].content, /# Catalog https:\/\/process-gpt\.io\/a2ui\/catalogs\/lite-step\/v1\/catalog\.json/)
  assert.match(seen[0].messages[0].content, /- ChoicePicker: /)
  assert.equal(JSON.parse(seen[0].messages[1].content).surfaceId, SID)
  assert.equal(seen[0].json, false, 'no JSON mode by default (stepUi.jsonMode)')
})

test('만들기: 검사에 걸리면 까닭을 붙여 한 번 더 — 고쳐 오면 그것, 또 걸리면 null(글 한 칸으로)', async () => {
  const broken = structuredClone(FIXTURE)
  broken.createSurface.components.find((c) => c.id === 'col').children.push('ghost')
  const seen = []
  let n = 0
  const fixed = await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async (o) => { seen.push(structuredClone(o.messages)); return answer(n++ ? FIXTURE : broken) } })
  assert.equal(fixed.tries, 2)
  assert.ok(fixed.msg)
  assert.equal(seen[1].length, 4)
  assert.equal(seen[1][2].role, 'assistant')
  assert.match(seen[1][3].content, /refers to "ghost", which does not exist/)
  const failed = await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async () => answer(broken) })
  assert.equal(failed.msg, null)
  assert.equal(failed.tries, 2)
  assert.ok(failed.errors.some((e) => /ghost/.test(e)))
  // not JSON at all, twice: asked afresh (the broken answer is not shown back)
  const asked = []
  const prose = await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async (o) => { asked.push(o.messages); return answer('화면을 만들었어요!') } })
  assert.equal(prose.msg, null)
  assert.match(prose.errors[0], /not a JSON message/)
  assert.equal(asked[1].length, 3)
  assert.equal(asked[1][2].role, 'user')
  assert.match(asked[1][2].content, /ONE compact JSON message/)
  const temps = []
  await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async (o) => { temps.push(o.temperature); return answer('화면은 이렇게 만들면 좋겠어요.') } })
  assert.deepEqual(temps, [0.2, 0.6], '다시 물을 땐 조금 더 따뜻하게')
  // a sentence around the message, or a cut-off answer
  const wrapped = await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async () => answer(`화면이에요:\n${JSON.stringify(FIXTURE)}\n이상이에요.`) })
  assert.ok(wrapped.msg)
  // a miscounted bracket is mended at the punctuation where the parser stops (what comes out is checked as usual)
  assert.deepEqual(G.parseLoose('{"a": {"b": [1, 2}, "c": 3}'), { a: { b: [1, 2] }, c: 3 })
  assert.deepEqual(G.parseLoose('{"a": {"b": 1}}}'), { a: { b: 1 } })
  assert.throws(() => G.parseLoose('화면이에요'))
  const cut = await G.makeSurface(INPUT, { surfaceId: SID, R: { retries: 0 }, chatFn: async () => Object.defineProperty({ content: '{"version": "1.0", "createSurface": {' + ' '.repeat(50) }, 'finish', { value: 'length' }) })
  assert.match(cut.errors[0], /cut off at the token limit/)
  // the gateway timed out: not asked again
  let calls = 0
  const down = await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async () => { calls++; throw new Error('The operation was aborted due to timeout') } })
  assert.equal(down.msg, null)
  assert.equal(calls, 1)
  // retries: 0 — one try only
  const once = await G.makeSurface(INPUT, { surfaceId: SID, R: { retries: 0 }, chatFn: async () => answer(broken) })
  assert.equal(once.tries, 1)
})

test('만들기: 비밀 · 결제 정보를 묻는 화면이라고 판정 모델이 읽으면 쓰지 않는다 — 읽을 수 없으면 구조 검사만으로', async () => {
  let asked = null
  const yes = async (state, q, opts) => { asked = { state, q, opts }; return { choice: 'yes', probabilities: { no: 0.2, yes: 0.8 }, confidence: 0.8 } }
  const r = await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async () => answer(FIXTURE), odds: yes })
  assert.equal(r.msg, null)
  assert.equal(r.refused, true)
  assert.match(asked.state, /검토 의견/)
  assert.match(asked.state, /- 금액 조정 후 진행/)
  assert.deepEqual(asked.opts.map((o) => o.key), ['no', 'yes'])
  const no = await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async () => answer(FIXTURE), odds: async () => ({ probabilities: { no: 0.97, yes: 0.03 } }) })
  assert.ok(no.msg)
  const unknown = await G.makeSurface(INPUT, { surfaceId: SID, chatFn: async () => answer(FIXTURE), odds: async () => null })
  assert.ok(unknown.msg)
  const off = await G.makeSurface(INPUT, { surfaceId: SID, R: { secretCheck: false }, chatFn: async () => answer(FIXTURE), odds: yes })
  assert.ok(off.msg)
})
