// 보고문의 글머리 목록이 빠른 답 버튼이 되지 않게 (tutorial-findings #30). src/replies.js — 화면 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReplies } from '../../src/replies.js'

test('질문으로 끝나는 짧은 선택지는 버튼', () => {
  const r = parseReplies('흐름 초안을 만들었어요.\n이대로 진행할까요?\n- 네, 이대로 진행 (폼까지 만들어요)\n- 단계를 고칠게요')
  assert.deepEqual(r.options.map((o) => o.label), ['네, 이대로 진행', '단계를 고칠게요'])
  assert.equal(r.options[0].hint, '폼까지 만들어요')
  assert.equal(r.body, '흐름 초안을 만들었어요.\n이대로 진행할까요?')
  // the question may come after the list
  assert.equal(parseReplies('두 가지 방법이 있어요.\n- 엑셀로 받기\n- 한글로 받기\n어느 쪽으로 할까요?').options.length, 2)
  assert.equal(parseReplies('아래에서 골라 주세요:\n- A안\n- B안\n- C안').options.length, 3)
})

test('보고문의 글머리 목록은 버튼이 아님 (브라우저 작업 요약)', () => {
  const report = '결제를 마쳤어요.\n- 무선 이어폰을 장바구니에 담았습니다\n- 카드 •••• 4242를 자동으로 **선택**·입력했습니다\n- 결제 버튼을 눌렀습니다'
  assert.equal(parseReplies(report), null)
  // "선택" appearing somewhere is not a question
  assert.equal(parseReplies('어떤 항목을 선택했는지 정리했어요.\n- 대관료\n- 다과비'), null)
  // a question earlier in the text, then a report list at the end
  assert.equal(parseReplies('견적이 맞나요? 확인해 봤어요.\n\n정리\n- 홀 단가 수정\n- 비고 추가'), null)
})

test('긴 문장이나 완료형 항목, 목록 뒤에 다른 문단이 있으면 버튼이 아님', () => {
  assert.equal(parseReplies('어떻게 할까요?\n- 이번 주 금요일까지 고객에게 보낼 견적서를 먼저 만들고 그다음에 평면도를 다시 그리는 방법\n- 아니요'), null)
  assert.equal(parseReplies('진행할까요?\n- 저장했어요\n- 보냈습니다'), null)
  assert.equal(parseReplies('진행할까요?\n- 네\n- 아니요\n\n참고로 내일 다시 알려 드릴게요. 그때 확인해 주세요.'), null)
  assert.equal(parseReplies('진행할까요?\n- 네'), null, '하나뿐이면 아님')
  assert.equal(parseReplies(''), null)
})
