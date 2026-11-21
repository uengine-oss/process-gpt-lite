---
name: offer-process-start
description: "회사에 등록된 업무 프로세스(신청·결재·접수 같은 절차) 하나를 시작해 달라는 부탁일 때 제안한다. 프로세스를 어떻게 쓰는지 묻거나 이름만 꺼낸 말에는 제안하지 않는다."
metadata:
  kind: offer
  version: 1.0.0
  offer: [team]
  work: StartProcessInstance
  badge: "프로세스"
  badge_en: "Process"
  title: "프로세스 시작하기"
  title_en: "Start the process"
  description_en: "Offer it when someone asks for one of the company's registered business processes (a request, approval or intake procedure) to be started. Not for asking how a process works, or only mentioning one."
---
# 프로세스 시작하기

팀 대화방·회의에서 사람이 한 말을 판단 모델이 이 설명과 맞춰 보고, 맞으면 제안 카드를 띄운다. 카드의 「시작」을 누른 사람의 에이전트가 그 대화(회의라면 받아쓴 말)를 읽고 일을 한다.

- 이 파일의 `description` 은 판단 모델이 읽는 선택지다. 고칠 때는 조건으로 쓰고, 평가 세트·녹화에 나온 문장을 옮기지 않는다.
- `metadata.offer` 는 어디서 제안하는지(team: 팀 대화방, meeting: 회의 중 말, minutes: 회의록의 할 일)를 정한다.
- `metadata.work` 는 제안이 기록하는 일 종류 열쇠다(pro_room_suggestions.work).
