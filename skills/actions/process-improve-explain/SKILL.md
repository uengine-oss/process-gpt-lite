---
name: process-improve-explain
description: 사실의 「실행 기록이 있는 프로세스」 하나가 어디서 막히는지(병목·제약), 왜 오래 걸리는지, 어떻게 줄일지를 서버가 실행 기록으로 계산한 숫자로 설명한다. 실행 기록이 없는 프로세스, 업무 개선 이론·방법론에 대한 일반 질문, 개선 내용으로 문서를 만드는 일은 delegate. 프로세스의 단계를 보는 일은 process-work.
metadata:
  kind: action
  version: 1.0.0
  handler: improveExplain
  args: args.schema.json
  facts: [improvable]
  available_when: has_improvable
  disclosure: inline
  agent_turn: false
  misroute_cost: low
---
# 프로세스 개선 설명

## 인자
- `process`: 사실의 「실행 기록이 있는 프로세스」 id.
