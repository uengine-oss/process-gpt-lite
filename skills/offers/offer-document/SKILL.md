---
name: offer-document
description: "글로 된 결과물(보고서, 안내문, 공문, 계획서, 제안서, 발표 자료 같은 문서)을 새로 쓰거나 고쳐 달라는 부탁일 때 제안한다. 문서에 대한 의견, 본인이 직접 쓰겠다는 말, 이미 보낸 문서 이야기에는 제안하지 않는다."
metadata:
  kind: offer
  version: 1.0.0
  offer: [team, meeting, minutes]
  work: CreateDocument
  badge: "문서"
  badge_en: "Document"
  title: "문서 초안 작성하기"
  title_en: "Draft the document"
  description_en: "Offer it when someone asks for a written result — a report, notice, official letter, plan, proposal or slides — to be written or revised. Not for opinions about a document, someone saying they will write it themselves, or news about one already sent."
---
# 문서 초안 작성하기

팀 대화방·회의에서 사람이 한 말을 판단 모델이 이 설명과 맞춰 보고, 맞으면 제안 카드를 띄운다. 카드의 「시작」을 누른 사람의 에이전트가 그 대화(회의라면 받아쓴 말)를 읽고 일을 한다.

- 이 파일의 `description` 은 판단 모델이 읽는 선택지다. 고칠 때는 조건으로 쓰고, 평가 세트·녹화에 나온 문장을 옮기지 않는다.
- `metadata.offer` 는 어디서 제안하는지(team: 팀 대화방, meeting: 회의 중 말, minutes: 회의록의 할 일)를 정한다.
- `metadata.work` 는 제안이 기록하는 일 종류 열쇠다(pro_room_suggestions.work).
