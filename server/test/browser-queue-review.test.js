// 독립 검토(2026-11-25)가 찾은 것의 회귀 — 브라우저 · DB · 모델 없이(브라우저 · DB 가 필요한 것은 browser-queue-answers.test.js 의 BQ-R-*i).
//   BQ-R-01 입력창의 말이 결제를 승인하지 못한다: 보기는 그 하나가 0.7 일 때만, 잠긴 기다림(승인 · 로그인 · 카드 · 코드 · 사람 확인)은 답을
//           받지 않으며, 판정 LLM 의 남는 몫 · 모르는 키가 이기지 못한다(lib/judge.js spread)
//   BQ-R-03 후보 하나 + 약한 「없음」은 확실하지 않다
//   BQ-R-04 짧아진 결과 메시지: 뒤의 턴 · 텔레그램은 전문(detail)을 읽는다, 클릭 기록(did)은 읽지 않는다
//   BQ-R-06 다시 돌리는 작업은 폴더 · 공유 · 비공개 파일과 어떻게 얻은 파일인지(origin)를 잃지 않는다
//   BQ-R-09 사람에게 묻거나 저장하는 도구(pick_file · attach_file · save_pdf)는 동작 하나의 한도로 끊기지 않는다(늦은 카드가 다른 기다림을 덮지 않음)
//   BQ-R-10 작업 공간의 파일은 링크를 따라 바깥으로 나가지 않는다
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { spread } = await import('../lib/judge.js')
const { waitPick, waitOptions } = await import('../lib/browserQueue.js')
const { filePick } = await import('../lib/browserFiles.js')
const { LONG_TOOLS, keptFiles, insideWorkspace } = await import('../lib/browser.js')
const { historyText } = await import('../lib/agent.js')

const APPROVE = { title: '가상 상품 결제', waiting: true, question: '39,000원을 결제할까요?', options: ['승인', '취소'], approval: true, locked: true }
const PICK = { title: '노트북 고르기', waiting: true, question: '어느 노트북에 만들까요?', options: ['A', 'B', 'C', 'D', 'E', 'F'] }

test('BQ-R-01 입력창의 말은 결제를 승인하지 못한다 — 잠긴 기다림은 답을 받지 않고, 보기는 그 하나가 0.7 일 때만, LLM 판정의 남는 몫 · 모르는 키는 이기지 못한다', () => {
  // the reviewer's case: a confused judge gives o0 (승인) 0.5, its own words 0.25 — before, 0.75 summed and o0 was delivered as 「승인」
  assert.equal(waitPick({ o0: 0.5, o1: 0, answer: 0.25, other: 0.25 }, APPROVE).pick, 'other', '승인 카드는 입력창의 말로 답하지 않는다')
  assert.deepEqual(waitOptions(APPROVE).map((o) => o.key), ['steer', 'replace', 'other'], '판정 보기에도 답이 없다')
  for (const locked of [{ need: 'login' }, { need: 'captcha' }, { vault: true }]) assert.equal(waitPick({ answer: 0.99 }, { ...PICK, ...locked, locked: true }).pick, 'other')
  // an ordinary card: an option only when that option alone is at the bar — else the words themselves, never an option nobody picked
  const below = waitPick({ o0: 0.5, o1: 0, answer: 0.25, other: 0.25 }, PICK)
  assert.equal(below.pick, 'answer')
  assert.equal(below.option, null, '0.5 는 보기를 고른 것이 아니다')
  assert.equal(waitPick({ o2: 0.71, answer: 0.1 }, PICK).option, 2)
  // the LLM judge (no judge server): an unsure pick no longer spreads its leftovers over the other keys …
  const opts = waitOptions(PICK)
  const unsure = spread(opts, 'other', 0.2)
  assert.equal(Object.values(unsure).reduce((a, b) => a + b, 0), 0.2)
  assert.equal(waitPick(unsure, PICK).pick, 'other', '예전엔 남는 0.8 이 보기 일곱 개로 나뉘어 「답」 0.7 이 됐다')
  // … and a key that is not an option is no pick at all (before: all equal, and option 0 won the tie)
  const unknown = spread(opts, 'yes', 0.95)
  assert.ok(Object.values(unknown).every((v) => v === 0))
  assert.deepEqual(waitPick(unknown, PICK), { pick: 'other', option: null, p: { answer: 0, steer: 0, replace: 0, other: 0 } })
})

test('BQ-R-03 후보 하나와 약한 「없음」(0.3)은 확실하지 않다 — 묻지 않고 붙이지 않는다', () => {
  const one = [{ id: 'card:1', name: '보고서.pdf', kind: 'pdf', from: 'artifact' }]
  assert.equal(filePick({ f0: 0.7, none: 0.3 }, one).pick, null)
  assert.equal(filePick({ f0: 0.9, none: 0.05 }, one).pick.name, '보고서.pdf')
  // the LLM judge's shape now: only the chosen key has mass — "none" chosen never makes f0 sure by leftovers
  assert.equal(filePick(spread([{ key: 'f0' }, { key: 'none' }], 'none', 0.4), one).pick, null)
})

test('BQ-R-04 짧아진 브라우저 결과: 뒤의 턴과 텔레그램은 전문(detail)을 읽고, 클릭 기록(did)은 읽지 않는다', () => {
  const r = { role: 'agent', kind: 'text', content: { text: '새 노트북은 만들었지만 글은 들어가지 않았어요.', detail: '새 노트북은 만들었지만 글은 들어가지 않았어요. 사이트가 가져오기를 막았어요. 원하시면 PDF 로 이어서 해 드릴게요.', did: [{ text: "'새 노트북' 누르기" }] } }
  assert.equal(historyText(r), r.content.detail)
  assert.doesNotMatch(historyText(r), /누르기/)
  assert.equal(historyText({ role: 'agent', content: { text: '그냥 답' } }), '그냥 답')
  assert.equal(historyText({ role: 'user', content: { text: '사람의 말', detail: '사람 메시지에 detail 이 있어도' } }), '사람의 말')
})

test('BQ-R-06 다시 돌리는 작업의 파일: 폴더 · 공유 · 비공개 사본과 출처 · 얻은 방법(origin) · 후보 id 를 그대로 남긴다', () => {
  const kept = keptFiles([
    { name: '표준 조사.pdf', from: 'folder', folder: { slug: 'team-docs', path: 'docs/표준 조사.pdf' }, origin: 'picked', cid: 'folder:team-docs:docs/표준 조사.pdf' },
    { name: '표.xlsx', from: 'share', share: 's1', origin: 'picked', cid: 'share:s1' },
    { name: 'page.pdf', private: { key: 'browser/t/u/x/page.pdf' }, origin: 'made', cid: 'made:browser/t/u/x/page.pdf' },
    { name: '메모.docx', url: 'https://files.example/m', origin: 'attached' },
    { name: '어디에도 없는 파일' },
  ])
  assert.deepEqual(kept, [
    { name: '표준 조사.pdf', from: 'folder', folder: { slug: 'team-docs', path: 'docs/표준 조사.pdf' }, origin: 'picked', cid: 'folder:team-docs:docs/표준 조사.pdf' },
    { name: '표.xlsx', from: 'share', share: 's1', origin: 'picked', cid: 'share:s1' },
    { name: 'page.pdf', private: { key: 'browser/t/u/x/page.pdf' }, origin: 'made', cid: 'made:browser/t/u/x/page.pdf' },
    { name: '메모.docx', url: 'https://files.example/m', origin: 'attached' },
  ])
})

test('BQ-R-09 사람에게 묻거나 저장하는 도구는 동작 하나의 한도(15초) 밖 — 스스로 걸음마다 한도를 둔다', () => {
  for (const t of ['pick_file', 'attach_file', 'save_pdf', 'approve', 'need_user']) assert.ok(LONG_TOOLS.has(t), t)
  for (const t of ['click', 'type', 'goto', 'scroll']) assert.ok(!LONG_TOOLS.has(t), t)
})

test('BQ-R-10 작업 공간의 파일: 실제 경로가 작업 공간 안의 보통 파일일 때만 — 링크를 따라 바깥으로 나가지 않는다', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bq-ws-'))
  const root = path.join(base, 'workspace'), outside = path.join(base, 'secret.txt')
  fs.mkdirSync(path.join(root, '.bpmn', 'c1'), { recursive: true })
  fs.writeFileSync(outside, 'server secret')
  fs.writeFileSync(path.join(root, '.bpmn', 'c1', 'report.pdf'), '%PDF-1.4')
  fs.symlinkSync(outside, path.join(root, '.bpmn', 'c1', 'link.pdf'))
  fs.symlinkSync(base, path.join(root, '.bpmn', 'up'))
  try {
    assert.equal(await insideWorkspace(path.join(root, '.bpmn', 'c1', 'report.pdf'), root), fs.realpathSync(path.join(root, '.bpmn', 'c1', 'report.pdf')))
    assert.equal(await insideWorkspace(path.join(root, '.bpmn', 'c1', 'link.pdf'), root), null, '바깥 파일을 가리키는 링크')
    assert.equal(await insideWorkspace(path.join(root, '.bpmn', 'up', 'secret.txt'), root), null, '바깥 폴더를 가리키는 링크를 거친 경로')
    assert.equal(await insideWorkspace(path.join(root, '.bpmn', 'c1'), root), null, '폴더는 올리지 않는다')
    assert.equal(await insideWorkspace(path.join(root, 'none.pdf'), root), null)
  } finally { fs.rmSync(base, { recursive: true, force: true }) }
})
