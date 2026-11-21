---
name: browser-task
description: 서버의 내장 브라우저로 웹사이트에 들어가 사람 대신 화면을 조작해야 하는 일. 로그인, 계정의 잔액·내역 확인, 예약·주문·결제, 웹 양식 작성·제출, 웹 관리 콘솔 조작. 연결된 서비스(메일·캘린더·드라이브·메신저·코드 저장소·문서 도구·영상 플랫폼)의 정보를 찾거나 거기에 등록하는 일, 공개된 웹 정보를 찾아 읽는 일은 delegate — 에이전트가 연결 도구와 공개 자료로 먼저 하고, 필요하면 브라우저를 스스로 연다.
metadata:
  kind: action
  version: 1.0.0
  handler: browserTask
  args: args.schema.json
  facts: []
  available_when: always
  disclosure: inline
  agent_turn: false
  misroute_cost: high
---
# 내장 브라우저 작업

## 언제 쓰나
- 계정으로 들어가야 보이는 화면, 버튼을 눌러야 끝나는 일(제출·예약·주문)이 목표다.

## 쓰지 않나
- 어떤 사이트·어떤 일인지 알 수 없다 → ask.
- 정보를 찾아 정리만 한다 → delegate.

## 인자
- `goal`: 사이트에서 끝내야 할 일, 사용자가 준 값(날짜·수량·이름)과 함께.
- `start_url`: 사용자가 주소를 줬으면 그 주소.
