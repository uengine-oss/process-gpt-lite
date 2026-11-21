---
name: panel-record
description: 사실의 「내 패널 앱」 중 하나에 항목을 더하거나(add), 있는 항목을 고치거나(update), 목록·건수를 본다(list). 기록형 앱은 바뀔 때마다 새 기록을 더한다(취소·정정도 기록). 새 패널·앱을 만드는 일은 panel-create, 앱의 데이터를 읽고 문서·보고서·계획서를 써 달라는 일은 delegate.
metadata:
  kind: action
  version: 1.0.0
  handler: panelRecord
  args: args.schema.json
  facts: [apps]
  available_when: has_apps
  disclosure: staged
  stage1_args: [app, action]
  stage2_if: { action: [add, update] }
  agent_turn: false
  misroute_cost: medium
---
# 패널 앱 항목

## 언제 쓰나
- 사용자가 사실의 「내 패널 앱」 하나를 가리키며(제목을 줄이거나 바꿔 말해도 됨) 항목을 넣거나 고치거나 본다.

## 인자 채우는 법
- `app`: 사실에 적힌 앱 id.
- `action`: add(새 항목·새 기록), update(있는 항목의 값 바꾸기), list(목록·건수·남은 값 보기).
- `values`: 필드 라벨 → 값. 사실에 적힌 그 앱의 필드 라벨을 그대로 쓴다. 숫자는 숫자로.
- `match`: update 일 때 바꿀 행을 가리키는 글(그 행의 제목 열 값 등). 기록형 앱의 취소·정정은 원래 기록을 가리키는 글.
- `event`: 기록형 앱일 때 더할 기록의 이름(사실에 적힌 기록 종류 중 하나).
