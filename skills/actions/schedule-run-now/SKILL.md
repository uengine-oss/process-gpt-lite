---
name: schedule-run-now
description: 이미 만들어 둔 예약 작업 하나를 새 예약을 만들지 않고 지금 바로 한 번 돌려, 결과를 이 대화에 보여 준다(시험 실행). 사실의 「내 예약 작업」에 있는 작업이어야 한다. 실행 시각·주기·지연을 새로 말하면 schedule-create, 업무 프로세스를 시작하는 일은 process-work, 예약과 상관없이 한 번 알아보는 일은 delegate.
metadata:
  kind: action
  version: 1.0.0
  handler: runScheduleNow
  args: args.schema.json
  facts: [schedules, recent_schedules]
  available_when: has_schedules
  disclosure: inline
  agent_turn: false
  misroute_cost: low
  choose_if_missing: schedule
---
# 예약 작업 지금 실행

## 언제 쓰나
- 사용자가 만들어 둔 작업을 시험 삼아, 또는 기다리지 않고 지금 돌려 보려 한다.
- 어느 작업인지: 작업 이름(줄여 말해도 됨)으로 가리키거나, 사실의 「이 대화에서 방금 만들거나 돌린 예약」을 가리킨다(「그거」, 「방금 만든 것」).

## 쓰지 않나
- 「N분 뒤에」, 「내일」, 「매일」처럼 때를 새로 말한다 → schedule-create.
- 프로세스·스크립트·파일 같은 다른 것을 실행한다 → process-work 또는 delegate.

## 인자
- `schedule`: 사실에 적힌 작업 id. 어느 작업인지 단서가 없으면 비워 둔다 — 서버가 목록을 보여 주고 고르게 한다.
