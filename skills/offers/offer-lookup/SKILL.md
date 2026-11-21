---
name: offer-lookup
description: "정보를 찾아 답해 달라는 부탁일 때 제안한다: 회사의 프로세스·진행 중인 업무·조직·자료, 또는 조사가 필요한 사실. 사람에게 그 사람의 사정이나 의견을 묻는 말, 대화방 사람이 기억으로 바로 답하면 되는 짧은 질문에는 제안하지 않는다."
metadata:
  kind: offer
  version: 1.0.0
  offer: [team, meeting, minutes]
  work: CompanyQuery
  badge: "조회"
  badge_en: "Lookup"
  title: "찾아보기"
  title_en: "Look up the information"
  description_en: "Offer it when someone asks for information to be found and answered: the company's processes, work in progress, organization or materials, or facts that need research. Not when a person is asked about their own situation or opinion, or for a quick fact someone in the room can answer from memory."
---
# 찾아보기

팀 대화방·회의에서 사람이 한 말을 판단 모델이 이 설명과 맞춰 보고, 맞으면 제안 카드를 띄운다. 카드의 「시작」을 누른 사람의 에이전트가 그 대화(회의라면 받아쓴 말)를 읽고 일을 한다.

- 이 파일의 `description` 은 판단 모델이 읽는 선택지다. 고칠 때는 조건으로 쓰고, 평가 세트·녹화에 나온 문장을 옮기지 않는다.
- `metadata.offer` 는 어디서 제안하는지(team: 팀 대화방, meeting: 회의 중 말, minutes: 회의록의 할 일)를 정한다.
- `metadata.work` 는 제안이 기록하는 일 종류 열쇠다(pro_room_suggestions.work).
