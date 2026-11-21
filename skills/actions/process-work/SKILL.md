---
name: process-work
description: 회사 업무 프로세스(결재·신청·접수처럼 정해진 절차)를 다룬다. 시작(start — 시작 폼을 띄움), 생김새 보기(view), 어떤 프로세스가 있는지(catalog), 진행 중인 인스턴스(instances), 내가 처리할 할 일·결재 대기(my_todos), 새 프로세스 정의 설계(create). 시작하려는 프로세스와 이름이 겹치는 프로세스(한 이름이 다른 이름에 들어 있는 경우 포함)가 사실에 둘 이상 있고 사용자가 그 차이를 말하지 않았으면 고르지 말고 ask. 프로세스를 정한 때마다 시작하는 일은 schedule-create, 병목·지연 분석은 process-improve-explain, 스킬을 만드는 일은 delegate.
metadata:
  kind: action
  version: 1.0.0
  handler: processWork
  args: args.schema.json
  facts: [processes]
  available_when: always
  disclosure: staged
  stage1_args: [intent, query]
  stage2_if: { intent: [start, view] }
  agent_turn: by_handler
  misroute_cost: high
  choose_if_missing: process
  choose_when: { intent: [start] }
---
# 업무 프로세스

## 언제 쓰나
- `start`: 사실의 「프로세스」 하나를 지금 시작한다(신청서를 낸다, 결재를 올린다).
- `view`: 그 프로세스가 어떤 단계로 되어 있는지 본다.
- `catalog`: 어떤 프로세스가 있는지 본다.
- `instances`: 진행 중인 건을 본다.
- `my_todos`: 내 차례인 할 일·결재 대기를 본다.
- `create`: 설명한 업무로 새 프로세스 정의를 설계한다.

## 쓰지 않나
- 정해진 때마다 시작 → schedule-create. 병목·리드타임 → process-improve-explain. 예약 작업 실행 → schedule-run-now.

## 인자 채우는 법
- `process`: start·view 일 때 사실의 프로세스 id. 비슷한 프로세스가 둘 이상이라 어느 것인지 모르면 비워 둔다 — 서버가 고르게 한다.
- `query`: create 일 때 새 프로세스의 요구사항 전부.
- `prefill`: start 일 때 사용자가 이미 말한 시작 폼 값. 사실에 적힌 그 프로세스의 첫 단계 입력 키를 쓴다.
