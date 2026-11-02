// 가드레일이 글을 읽는 순서(spec pgpt-pro_guardrail-reading): 형식 → 모델 → 모델이 답하지 못하면 낱말. 모델 자리는 바꿔 끼워 값만 본다.
// 실제 모델은 test/guard-reading.e2e.mjs, 품질은 scripts/eval-guard.mjs.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { oddsFromTop, optionPrompt, oddsOf, readingStatus } from '../lib/decide.js'
import { compileTopics, formatHit, readContext, readingsOf, factsOf, READING, OTHER_TOPIC, NAME_QUESTION } from '../lib/context/sensitive.js'
import { factsOf as mailFacts, mailExcerpt, readConfidential, CONFIDENTIAL_READING } from '../lib/scenarios/mail.js'
import { findPii } from '../lib/policy/pii.js'
import { tenantStore } from '../lib/tenantStore.js'
import { q, pool } from '../lib/supa.js'

const rules = compileTopics()
const CLEAN = 'guard-reading-rt'
const answer = (p, name = 't1') => async (state, question) => (question === NAME_QUESTION
  ? { choice: name, probabilities: {}, model: 'm' }
  : { choice: p >= 0.5 ? 'sensitive' : 'normal', probabilities: { sensitive: p, normal: 1 - p }, model: 'm' })
const counting = (fn) => { const f = async (...a) => { f.calls++; return fn(...a) }; f.calls = 0; return f }
after(async () => { await q('delete from pro_context_readings where tenant_id = $1', [CLEAN]); await pool.end() })

test('확률 읽기: 첫 토큰의 글자별 확률을 합쳐 나누고, 글자가 토큰의 절반도 못 되면 재지 못한 것으로 본다', () => {
  const opts = [{ key: 'a', label: '가' }, { key: 'b', label: '나' }]
  const r = oddsFromTop([{ token: 'A', logprob: Math.log(0.6) }, { token: ' a', logprob: Math.log(0.2) }, { token: 'B', logprob: Math.log(0.1) }, { token: '네', logprob: Math.log(0.1) }], opts)
  assert.ok(Math.abs(r.a - 0.8 / 0.9) < 1e-9 && Math.abs(r.b - 0.1 / 0.9) < 1e-9)
  assert.equal(oddsFromTop([{ token: '네', logprob: Math.log(0.9) }, { token: 'A', logprob: Math.log(0.1) }], opts), null)
  assert.equal(oddsFromTop(null, opts), null)
  assert.equal(optionPrompt('글', '질문?', opts), '글\n\n질문?\n\nA) 가\nB) 나\n\nAnswer with the single option letter only.')
})

test('형식: 주민번호·계좌·전화는 잡고, 메일 주소만으로는 잡지 않는다', () => {
  assert.equal(formatHit('김 대리 주민번호 900101-1234567'), '주민등록번호')
  assert.equal(formatHit('급여 계좌 110-123-456789 변경'), '계좌번호')
  assert.equal(formatHit('연락처 010-2345-6789'), '전화번호')
  assert.equal(formatHit('담당자 kim@globex.com 으로 회신'), null)
  assert.equal(formatHit('대표번호 02-123-4567, 2026-10-30'), null)
  assert.deepEqual(findPii('a@b.co 010-2345-6789').kinds, ['mobile', 'email'])
})

test('맥락 읽기 순서: 형식이 보이면 모델을 부르지 않는다', async () => {
  const ask = counting(answer(0.99))
  const r = await readContext({ title: '연락처 정리', summary: '담당자 010-2345-6789' }, { rules, ask })
  assert.deepEqual(r, { topic: '전화번호', source: 'format', p: null, model: null })
  assert.equal(ask.calls, 0)
})

test('맥락 읽기 순서: 낱말이 있어도 모델이 아니라고 하면 묻지 않고, 낱말이 없어도 모델이 민감하다고 하면 묻는다', async () => {
  const benign = await readContext({ title: '서버 건강 체크 대시보드' }, { rules, ask: answer(0.02) })
  assert.deepEqual(benign, { topic: null, source: 'logprob', p: 0.02, model: 'm' })
  const said = await readContext({ title: '최 대리 권고사직 면담 메모' }, { rules, ask: answer(0.98, 't0') })
  assert.deepEqual(said, { topic: rules[0][0], source: 'logprob', p: 0.98, model: 'm' })
})

test('기준값 경계와 주제 이름: 0.5 부터 민감, 이름을 못 고르면 「민감한 사항」', async () => {
  assert.equal(READING.bar, 0.5)
  assert.ok((await readContext({ title: 'x' }, { rules, ask: answer(0.5) })).topic)
  assert.equal((await readContext({ title: 'x' }, { rules, ask: answer(0.4999) })).topic, null)
  assert.equal((await readContext({ title: 'x' }, { rules, ask: answer(0.9, 'other') })).topic, OTHER_TOPIC)
  const noName = async (s, question) => (question === NAME_QUESTION ? null : { choice: 'sensitive', probabilities: { sensitive: 0.9, normal: 0.1 }, model: 'm' })
  assert.equal((await readContext({ title: 'x' }, { rules, ask: noName })).topic, OTHER_TOPIC)
})

test('모델이 답하지 못하면 낱말이 대신하고, 대신했다고 적는다', async () => {
  const none = async () => null
  assert.deepEqual(await readContext({ title: '연봉 협상 준비' }, { rules, ask: none }), { topic: '연봉', source: 'regex', p: null, model: null })
  assert.deepEqual(await readContext({ title: '경쟁사 가격 벤치마크' }, { rules, ask: none }), { topic: null, source: 'regex', p: null, model: null })
})

test('모델로 보내는 글에서는 메일 주소를 가린다', async () => {
  let seen = ''
  await readContext({ title: '문의 정리', summary: '담당 kim@globex.com 회신' }, { rules, ask: async (s) => { seen = s; return null } })
  assert.ok(!seen.includes('kim@globex.com') && seen.includes('•••'), seen)
})

test('정책에 넘기는 값: 방법·확률·모델이 남고, 주인이 무시하거나 표시한 맥락은 읽은 값을 쓰지 않는다', () => {
  const reading = { topic: '연봉', source: 'logprob', p: 0.97, model: 'm' }
  const rel = { member: true, sameTeam: true, sameDept: true }
  const f = factsOf({ title: 'x', sensitive: 'none' }, { rel, depth: 'content', ownerRule: 'allow', reading })
  assert.deepEqual([f.topic, f.topic_source, f.topic_p, f.topic_model], ['연봉', 'logprob', 0.97, 'm'])
  assert.equal(factsOf({ title: 'x', sensitive: 'none', dismissed_at: new Date() }, { rel, depth: 'content', ownerRule: 'allow', reading }).topic, null)
  assert.equal(factsOf({ title: 'x', sensitive: 'confirmed' }, { rel, depth: 'content', ownerRule: 'allow', reading }).topic, null)
})

test('읽은 값 저장: 글이 그대로면 다시 부르지 않고, 글이 바뀌면 다시 읽고, 낱말로 대신한 값은 남기지 않고, 한 번에 읽는 수를 넘기지 않는다', async () => {
  await tenantStore.run({ tenant: CLEAN }, async () => {
    const row = (id, title) => ({ id, owner: 'u1', title, purpose: '', summary: '' })
    const ask = counting(answer(0.02))
    const first = await readingsOf([row('c1', '서버 비용 조사')], rules, { ask })
    assert.deepEqual([first.get('c1').source, ask.calls], ['logprob', 1])
    const again = await readingsOf([row('c1', '서버 비용 조사')], rules, { ask })
    assert.deepEqual([again.get('c1').saved, again.get('c1').p, ask.calls], [true, 0.02, 1])
    await readingsOf([row('c1', '서버 비용 조사 2차')], rules, { ask })
    assert.equal(ask.calls, 2)
    // 모델이 답하지 못한 값은 저장하지 않는다: 돌아오면 다시 읽는다
    const none = counting(async () => null)
    assert.equal((await readingsOf([row('c2', '연봉 표')], rules, { ask: none })).get('c2').source, 'regex')
    assert.equal((await q('select count(*)::int n from pro_context_readings where tenant_id = $1 and conversation_id = $2', [CLEAN, 'c2']))[0].n, 0)
    await readingsOf([row('c2', '연봉 표')], rules, { ask: none })
    assert.equal(none.calls, 2)
    // 한 번에 읽는 수
    const many = counting(answer(0.02))
    const out = await readingsOf(['m1', 'm2', 'm3'].map((id) => row(id, `글 ${id}`)), rules, { ask: many, max: 2 })
    assert.deepEqual([many.calls, out.size], [2, 2])
  })
})

test('메일 읽기: 본문·첨부 앞부분과 뒤쪽 표시 줄을 읽고, 개인정보는 가린다', () => {
  const long = `${'가'.repeat(CONFIDENTIAL_READING.fileChars + 50)}\n이 문서는 대외비입니다\n${'나'.repeat(50)}`
  const x = mailExcerpt({ subject: '자료', body: '연락처 010-2345-6789', attachments: [{ name: '계획.md', text: long }, { name: '소개.pdf', text: null }] })
  assert.ok(x.includes('이 문서는 대외비입니다') && x.includes('(내용을 읽을 수 없는 파일)'))
  assert.ok(!x.includes('010-2345-6789') && !x.includes('나'.repeat(50)))
})

test('메일 분류: 모델이 읽은 값을 쓰고, 답하지 못하면 표시 낱말이 대신하고, 개인정보 수는 그대로 센다', async () => {
  const unmarked = { subject: '실적', body: '', attachments: [{ name: '3분기_미공개_실적.xlsx', text: null }] }
  const yes = async () => ({ choice: 'confidential', probabilities: { confidential: 0.96, general: 0.04 }, model: 'm' })
  assert.deepEqual(await readConfidential(unmarked, { ask: yes }), { confidential: true, source: 'logprob', p: 0.96, model: 'm' })
  const nda = { subject: '서명 요청', body: '', attachments: [{ name: '기밀유지계약서_양식.docx', text: null }] }
  const no = async () => ({ choice: 'general', probabilities: { confidential: 0.1, general: 0.9 }, model: 'm' })
  assert.equal((await readConfidential(nda, { ask: no })).confidential, false)
  assert.deepEqual(await readConfidential(nda, { ask: async () => null }), { confidential: true, source: 'regex', p: null, model: null })
  const f = mailFacts({ to: ['a@globex-demo.com'], subject: 'x', body: '010-2345-6789', attachments: [], reading: { confidential: true, source: 'logprob', p: 0.96 } })
  assert.deepEqual([f.classification, f.classification_source, f.classification_p, f.pii_count], ['confidential', 'logprob', 0.96, 1])
})

test('게이트웨이가 닿지 않으면: null 을 돌려주고 잠시 부르지 않으며, 상태에 남긴다(맨 마지막: 이 뒤로 이 프로세스는 모델을 부르지 않는다)', async () => {
  const was = config.llm.baseUrl
  config.llm.baseUrl = 'http://127.0.0.1:9'
  const opts = [{ key: 'a', label: '가' }, { key: 'b', label: '나' }]
  assert.equal(await oddsOf('글', '질문', opts, { timeoutMs: 1000 }), null)
  assert.equal(readingStatus().state, 'down')
  const t = Date.now()
  assert.equal(await oddsOf('글', '질문', opts), null)
  assert.ok(Date.now() - t < 50, '다시 부르지 않고 바로 돌아온다')
  config.llm.baseUrl = was
})
