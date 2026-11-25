// 같은 이름의 사람을 한 목록 안에서 가른다(2026-11-25 운영: 한 회사에 한 사람의 계정 둘 — Gmail 과 회사 주소 — 이 둘 다 「윤가람」이라 메신저 목록에
// 똑같은 줄이 둘). src/sameNames.js: 같은 이름이 그 목록에 둘 이상일 때만, 그 이름 가운데 혼자인 도메인은 도메인, 아니면 주소 전체. 화면 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { nameTags, tagged, domainOf } from '../../src/sameNames.js'

const P = (id, name, email) => ({ id, name, email })

test('SN-01 같은 이름 둘 — 도메인이 다르면 도메인으로: 「윤가람 · gmail.com」 · 「윤가람 · uengine.org」', () => {
  const t = nameTags([P('a', '윤가람', 'gryoon@gmail.com'), P('b', '윤가람', 'gryoon@uengine.org'), P('c', '김서연', 'sy@uengine.org')])
  assert.equal(t.get('a'), 'gmail.com')
  assert.equal(t.get('b'), 'uengine.org')
  assert.equal(t.get('c'), '')
  assert.equal(tagged('윤가람', t.get('a')), '윤가람 · gmail.com')
  assert.equal(tagged('김서연', t.get('c')), '김서연')
})

test('SN-02 이름이 혼자면 그대로 — 목록마다 따로 본다', () => {
  assert.deepEqual([...nameTags([P('a', '윤가람', 'gryoon@gmail.com'), P('c', '김서연', 'sy@uengine.org')]).values()], ['', ''])
  assert.deepEqual([...nameTags([]).entries()], [])
  assert.deepEqual([...nameTags(null).entries()], [])
})

test('SN-03 도메인도 같으면 주소 전체, 셋 가운데 도메인이 혼자인 사람만 도메인', () => {
  const t = nameTags([P('a', '김민수', 'minsu.kim@uengine.org'), P('b', '김민수', 'mskim@uengine.org'), P('c', '김민수', 'minsu@gmail.com')])
  assert.equal(t.get('a'), 'minsu.kim@uengine.org')
  assert.equal(t.get('b'), 'mskim@uengine.org')
  assert.equal(t.get('c'), 'gmail.com')
})

test('SN-04 이름은 공백 · 대소문자를 가리지 않고 같다고 보고, 주소는 소문자로', () => {
  const t = nameTags([P('a', ' Minsu  Kim', 'Minsu@Gmail.com'), P('b', 'minsu kim', 'minsu@uengine.org')])
  assert.equal(t.get('a'), 'gmail.com')
  assert.equal(t.get('b'), 'uengine.org')
})

test('SN-05 같은 사람(같은 id)이 두 번 있어도 하나, 주소가 없으면 가를 것이 없다, 이름 없는 줄은 건드리지 않는다', () => {
  const t = nameTags([P('a', '윤가람', 'gryoon@gmail.com'), P('a', '윤가람', 'gryoon@gmail.com'), P('d', '윤가람', ''), P('e', '', 'x@y.z'), null])
  assert.equal(t.get('a'), 'gmail.com')
  assert.equal(t.get('d'), '')
  assert.equal(t.get('e'), '')
  assert.equal(t.size, 3)
  assert.equal(domainOf('a@'), '')
  assert.equal(domainOf('no-at'), '')
  assert.equal(domainOf(' X@Corp.COM '), 'corp.com')
})
