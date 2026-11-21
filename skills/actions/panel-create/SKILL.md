---
name: panel-create
description: 홈 화면에 새 패널을 만든다. 값이 계속 바뀌는 실시간 위젯, 또는 사람들이 항목을 등록·관리하는 작은 데이터 앱(명단·대장·목록·관리표·기록부 — 시트에 저장되고 팀과 함께 씀). 이미 있는 패널 앱에 항목을 넣는 일은 panel-record. 문서·보고서·파일·표를 한 번 만들어 받는 일은 delegate.
metadata:
  kind: action
  version: 1.0.0
  handler: panelCreate
  args: args.schema.json
  facts: [apps]
  available_when: always
  disclosure: inline
  agent_turn: false
  misroute_cost: medium
---
# 패널 만들기

## 언제 쓰나
- 홈에 계속 놓아 두고 볼 것: 실시간 값을 보여 주는 위젯, 또는 여러 번 등록·수정·조회할 항목 목록.

## 쓰지 않나
- 한 번 받아 볼 문서나 파일(워드·한글·엑셀·PPT·PDF) → delegate.
- 사실의 「내 패널 앱」에 이미 있는 앱에 항목 넣기 → panel-record.

## 인자
- `description`: 패널이 무엇을 위한 것인지, 사용자가 말한 항목·규칙·처음 넣을 행까지 그대로.

실시간 값을 읽는 패널의 데이터 출처는 references/live-data-sources.md(패널을 만드는 쪽이 필요할 때 읽는다).
