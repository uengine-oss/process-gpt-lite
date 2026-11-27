// 붙여 둔 공유 폴더가 있는 채팅에서 「…넣어서 보내」처럼 낱말만 폴더 고치기와 닮은 말 — 운영(2026-11-27, 녹화)에서 메일 답장 초안을
// 붙여 넣은 말이 그 폴더의 변경안 작업(따로 도는 대화방)으로 빠져, 다음 말 「○○로 해서 보내」가 초안을 보지 못했다. 이제 판정 모델이
// 그 말이 폴더의 파일을 고치는 일인지 읽는다(스킬 folder-edit-request). 판정은 가짜로(모델 없음).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'

const TF = await import('../lib/folders/threadFolders.js')
const { pool } = await import('../lib/supa.js')
after(() => pool.end())

const FOLDER = { id: 'f1', name: '연말 행사 준비' }
const PASTE = '김서연 팀장님께 아래 내용으로 답장: 받는 사람: 김서연 <seoyeon.kim@customer.example>\n제목: Re: 납품 견적\n\n견적을 넣어서 보내 줘'
const odds = (p) => ({ odds: async (state, question, options) => {
  seen.push({ state, question, options })
  return { choice: p.other >= p.edit ? 'other' : 'edit', probabilities: p, confidence: Math.max(p.other, p.edit), model: 'fake' }
} })
const seen = []

test('메일 초안을 붙여 「넣어서 보내」 — 판정이 「그 밖의 일」이면 폴더 변경안 작업이 아니다', async () => {
  const r = await TF.readFolderEdit({ folder: FOLDER, text: PASTE, judges: odds({ other: 0.93, edit: 0.07 }) })
  assert.deepEqual([r.edit, r.p, r.by], [false, 0.93, 'logprob'])
  const asked = seen.at(-1)
  assert.match(asked.state, /연말 행사 준비/)
  assert.match(asked.state, /넣어서 보내 줘/, '판정은 그 말을 자료로 읽는다')
  assert.match(asked.question, /파일을 고치거나/, '질문은 스킬의 프롬프트')
  assert.deepEqual(asked.options.map((o) => o.key), ['other', 'edit'], '폴더 고치기가 마지막 보기(판정을 못 하는 가짜 모델은 예전 길로)')
})

test('폴더의 문서를 고치라는 말은 그대로 변경안 작업', async () => {
  const r = await TF.readFolderEdit({ folder: FOLDER, text: '연말 행사 준비 폴더의 안내문에 주차 안내 추가해 줘', judges: odds({ other: 0.12, edit: 0.88 }) })
  assert.equal(r.edit, true)
})

test('확신이 모자라면(그 밖의 일 0.6 미만) 예전처럼 변경안 작업', async () => {
  const r = await TF.readFolderEdit({ folder: FOLDER, text: PASTE, judges: odds({ other: 0.55, edit: 0.45 }) })
  assert.equal(r.edit, true)
})

test('판정을 받지 못하면 null — 부르는 쪽이 예전 길(변경안 작업)을 그대로 간다', async () => {
  const r = await TF.readFolderEdit({ folder: FOLDER, text: PASTE, judges: { odds: async () => null, json: async () => { throw new Error('down') } } })
  assert.equal(r, null)
})

test('확률을 주지 않는 모델의 JSON 답도 읽는다', async () => {
  const r = await TF.readFolderEdit({ folder: FOLDER, text: PASTE, judges: { odds: async () => null, json: async () => ({ choice: 'A', confidence: 0.8 }) } })
  assert.deepEqual([r.edit, r.by], [false, 'json'])
})

test('긴 말은 앞과 끝을 읽는다(붙여 넣은 글 아래 마지막 줄이 시키는 말) · 확률을 주지 않는 모델의 JSON 답은 오래 기다리지 않는다', async () => {
  const long = `견적서 초안입니다.\n${'납품 조건 설명 줄입니다. '.repeat(200)}\n위 내용 그대로 견적 넣어서 보내 줘`
  let jsonOpts = null
  const r = await TF.readFolderEdit({ folder: FOLDER, text: long, judges: { odds: async (state) => { seen.push({ state }); return null }, json: async (sys, user, opts) => { jsonOpts = opts; seen.push({ state: user }); return { choice: 'A', confidence: 0.9 } } } })
  assert.equal(r.edit, false)
  const state = seen.at(-1).state
  assert.match(state, /견적서 초안입니다/, '앞')
  assert.match(state, /위 내용 그대로 견적 넣어서 보내 줘/, '끝')
  assert.ok(state.length < long.length)
  assert.ok(jsonOpts.timeoutMs <= 6000, `JSON 답 대기 ${jsonOpts.timeoutMs} ms`)
  assert.equal(TF.headAndTail('짧은 말', 1500), '짧은 말')
})
