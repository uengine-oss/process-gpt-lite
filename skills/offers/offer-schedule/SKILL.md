---
name: offer-schedule
description: "회의나 일정을 잡아 캘린더에 넣어 달라는 부탁일 때 제안한다. 언제가 좋은지 사람끼리 의견을 묻는 말에는 제안하지 않는다."
metadata:
  kind: offer
  version: 1.0.0
  offer: [team, meeting, minutes]
  work: ScheduleRegistration
  badge: "일정"
  badge_en: "Schedule"
  title: "일정 잡기"
  title_en: "Schedule the meeting"
  description_en: "Offer it when someone asks for a meeting or event to be set up and put on the calendar. Not when people only ask each other which time suits them."
---
# 일정 잡기

팀 대화방·회의에서 사람이 한 말을 판단 모델이 이 설명과 맞춰 보고, 맞으면 제안 카드를 띄운다. 카드의 「시작」을 누른 사람의 에이전트가 그 대화(회의라면 받아쓴 말)를 읽고 일을 한다.

- 이 파일의 `description` 은 판단 모델이 읽는 선택지다. 고칠 때는 조건으로 쓰고, 평가 세트·녹화에 나온 문장을 옮기지 않는다.
- `metadata.offer` 는 어디서 제안하는지(team: 팀 대화방, meeting: 회의 중 말, minutes: 회의록의 할 일)를 정한다.
- `metadata.work` 는 제안이 기록하는 일 종류 열쇠다(pro_room_suggestions.work).
