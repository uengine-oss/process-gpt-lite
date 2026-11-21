---
name: teammate-notify
description: 사실의 「팀원」 한 사람(이름·이메일·역할로 가리킴)에게 이 서비스의 홈 알림을 보내 무엇을 봐 달라거나, 처리를 부탁하거나, 일을 맡긴다. 메일·메신저처럼 연결된 바깥 서비스로 보내 달라고 하면 이 스킬이 아니라 delegate, 자기 텔레그램으로 보내는 일은 telegram-delivery. 같은 이름이 둘 이상이라 누구인지 알 수 없으면 ask.
metadata:
  kind: action
  version: 1.0.0
  handler: notifyMember
  args: args.schema.json
  facts: [team]
  available_when: has_team
  disclosure: inline
  agent_turn: false
  misroute_cost: high
  choose_if_missing: member
---
# 팀원에게 알리기

## 인자
- `member`: 사실에 적힌 팀원 이름, 이메일 또는 역할.
- `title`: 무엇을 봐 달라는지 한 줄.
- `message`: 받는 사람은 이 대화를 보지 못했다. 무엇을 왜 봐 달라는지와 필요한 사실을 그것만 읽고 알 수 있게 쓴다(「이 대화」, 「위 내용」처럼 가리키지 않는다).
