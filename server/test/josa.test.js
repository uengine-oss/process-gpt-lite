// 받침에 맞는 조사(lib/josa.js) — the local-agent messages built with people's names and step names (spec openspec/specs/local-agents)
//   cd server && node --test test/josa.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { josa, ro, iga, eunNeun, eulReul } from '../lib/josa.js'
import * as page from '../../src/josa.js'

test('이/가: 받침이 있으면 「이」, 없으면 「가」 — 사람 이름', () => {
  assert.equal(iga('윤태호'), '윤태호가')
  assert.equal(iga('서하린'), '서하린이')
  assert.equal(iga('김견적'), '김견적이')
  assert.equal(iga('이검토'), '이검토가')
  assert.equal(iga('최참관'), '최참관이')
  assert.equal(iga('실행하는 사람'), '실행하는 사람이')
  assert.equal(josa(''), '가')
})
test('은/는 · 을/를 · 으로/로: 단계 이름 · CLI 이름(괄호 · 영문 · 숫자)', () => {
  assert.equal(`「견적서 작성」${josa('「견적서 작성」', '을', '를')}`, '「견적서 작성」을')
  assert.equal(eulReul('견적 검토'), '견적 검토를')
  assert.equal(eunNeun('Claude Code'), 'Claude Code는')
  assert.equal(iga('Codex'), 'Codex가')
  assert.equal(`Claude Code${ro('Claude Code')}`, 'Claude Code로')
  assert.equal(`견적서${ro('견적서')}`, '견적서로')
  assert.equal(`서울${ro('서울')}`, '서울로')       // ㄹ 받침
  assert.equal(`부산항${ro('부산항')}`, '부산항으로')
  assert.equal(iga('3'), '3이')
  assert.equal(iga('2'), '2가')
  assert.equal(eunNeun('Excel'), 'Excel은')
})
test('화면 쪽 src/josa.js 도 같은 답', () => {
  for (const w of ['윤태호', '서하린', 'Claude Code', '「견적서 작성」', '3', 'Excel', '서울']) {
    assert.equal(page.josa(w), josa(w))
    assert.equal(page.ro(w), ro(w))
  }
})
