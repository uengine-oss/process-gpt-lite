// 대화 기록(design-v0.3 §21, lib/ontology/chatlog.js): 카카오톡 내보내기(CSV · PC TXT · 모바일 TXT)를 메시지로, 대화방 이름의 직함 떼기,
// 같은 대상의 메시지를 건으로(조용한 날이 길면 다음 건). 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseChat, csvRows, baseName, casesOf, isChatExport } from '../lib/ontology/chatlog.js'

test('카카오톡 CSV: 따옴표 안 줄바꿈, 한국 시각', () => {
  const csv = '﻿Date,User,Message\n2026-11-13 17:50:00,"장진영","@김상훈 레포 권한\n부탁해요"\n2026-11-13 17:55:00,"김상훈","드렸습니다"\n'
  assert.equal(csvRows(csv).length, 3)
  const p = parseChat('a.csv', csv)
  assert.equal(p.kind, 'csv')
  assert.equal(p.messages.length, 2)
  assert.equal(p.messages[0].text, '@김상훈 레포 권한\n부탁해요')
  assert.equal(p.messages[0].at.toISOString(), '2026-11-13T08:50:00.000Z')
})

test('카카오톡 TXT: PC(날짜 줄 + [이름] [오후 시각]) · 모바일(날짜, 이름 : 메시지)', () => {
  const pc = '--------------- 2026년 11월 13일 금요일 ---------------\n[장진영] [오후 5:50] 견적 부탁해요\n[김상훈] [오후 5:51] 넵\n두 번째 줄\n[김상훈] [오후 5:55] 보냈어요\n[장진영] [오전 9:01] 확인\n[장진영] [오후 12:02] 사진\n'
  const a = parseChat('t.txt', pc)
  assert.equal(a.messages.length, 5)
  assert.equal(a.messages[1].text, '넵\n두 번째 줄')
  assert.equal(a.messages[3].at.toISOString(), '2026-11-13T00:01:00.000Z')
  assert.equal(a.messages[4].at.toISOString(), '2026-11-13T03:02:00.000Z')
  const mob = Array.from({ length: 5 }, (_, i) => `2026. 11. 13. 오후 5:5${i}, 김상훈 : 메시지 ${i}`).join('\n')
  assert.equal(parseChat('m.txt', mob).messages.length, 5)
  assert.equal(isChatExport('보고서.pdf', Buffer.from(mob)), false)
})

test('대화방 이름의 직함 · 숫자 떼기', () => {
  assert.deepEqual(['정석진 전무', '박용주이사', '장재형2', '김 대리님'].map(baseName), ['정석진', '박용주', '장재형', '김'])
})

test('같은 대상의 메시지는 한 건, 이틀 넘게 조용하면 다음 건', () => {
  const at = (d, h) => new Date(Date.UTC(2026, 10, d, h))
  const items = casesOf([
    { at: at(3, 1), subject: 'A 레포', task: '권한 요청' }, { at: at(3, 2), subject: 'A 레포', task: '권한 부여' },
    { at: at(9, 1), subject: 'A 레포', task: '권한 요청' }, { at: at(3, 3), subject: 'B 고객', task: '견적서 작성' },
  ], 2)
  const [a1, a2, a3, b] = items.sort((x, y) => x.at - y.at || x.subject.localeCompare(y.subject))
  assert.equal(a1.caseKey, a2.caseKey)
  assert.notEqual(items.find((x) => x.at.getUTCDate() === 9).caseKey, a1.caseKey)
  assert.notEqual(items.find((x) => x.subject === 'B 고객').caseKey, a1.caseKey)
  void a3; void b
})
