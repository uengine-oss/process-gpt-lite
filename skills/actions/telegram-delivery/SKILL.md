---
name: telegram-delivery
description: 사용자 자신의 텔레그램 봇에 관한 서버 설정을 한다. 봇 연결 안내(connect), 이미 있는 예약 작업의 결과를 텔레그램으로도 받기(alerts_on)와 그만 받기(alerts_off), 이 대화의 마지막 답을 지금 텔레그램으로 보내기(send_last_answer). 봇이 아직 연결되지 않았어도 어떤 작업의 결과를 받고 싶다는 것이면 alerts_on 이다(서버가 켜 두고 연결 카드를 함께 보여 준다). 새 예약 작업을 만드는 요청은 schedule-create. 텔레그램이 무엇인지·봇 만드는 법 같은 질문, 텔레그램 채널이나 그룹의 내용을 읽는 일은 delegate.
metadata:
  kind: action
  version: 1.0.0
  handler: telegram
  args: args.schema.json
  facts: [schedules, recent_schedules, telegram]
  available_when: always
  disclosure: inline
  agent_turn: false
  misroute_cost: high
  choose_if_missing: schedule
  choose_when: { action: [alerts_on, alerts_off] }
---
# 텔레그램 전달

## 언제 쓰나
- `connect`: 내 텔레그램 봇을 이 서비스에 연결하고 싶다. 연결 방법 카드가 채팅에 나온다.
- `alerts_on`: 사실의 「내 예약 작업」 중 하나가 알릴 일이 생기면 채팅과 함께 텔레그램으로도 받고 싶다. 봇이 아직 없으면 켜 두고 연결 카드를 보여 준다.
- `alerts_off`: 그 작업의 텔레그램 전달을 끈다.
- `send_last_answer`: 이 대화에서 방금 받은 답을 지금 텔레그램으로 보낸다.

## 쓰지 않나
- 무엇을 언제 확인할지 새로 정하는 요청 → schedule-create.
- 팀원에게 알리기 → teammate-notify.
- 텔레그램에 대한 질문, 채널 글 읽기 → delegate.

## 인자
- `action`: 위 넷 중 하나.
- `schedule`: alerts_on·alerts_off 일 때 그 작업의 id. 이름으로 가리키지 않았으면 사실의 「이 대화에서 방금 만들거나 돌린 예약」. 단서가 없으면 비워 둔다 — 서버가 고르게 한다.
