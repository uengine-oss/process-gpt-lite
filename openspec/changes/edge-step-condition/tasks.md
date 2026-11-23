## 1. 「앞 단계 완료」 이벤트

- [x] 1.1 structure.js: 연속한 두 단계 X → Y 에 Y 로 가는 X 결과물 이벤트가 없으면 `done:X` 이벤트와 TRIGGERS `done:X → Y` 생성(단위 테스트 test/ontology-structure.test.js)
- [x] 1.2 build.js: 다시 셀 때 사라진 `done:` 간선 gone 처리, 다시 보이면 active
- [x] 1.3 다듬기 · 말로 고치기로 이은 길: 그래프에 쓰지 않고 그 프로세스 흐름에서 `done:X → Y` 간선을 만들어 보임(edgecond.js entryEdgesOf · mapView.js eventGraph, virtual)

## 2. 간선 조건 저장

- [x] 2.1 sql/047_edge_conditions.sql: pro_edge_conditions 이력 표((tenant_id, proc_key, event, task, at desc) 인덱스)
- [x] 2.2 edgecond.js: entryEdgesOf(진입 간선) · edgeConditionsOf(procKey, { asOf }) · setEdgeCondition(조건 · 분류 · 같은 일 진입 간선에 함께) — 관리자만, 결정 원장 기록(단위 테스트 test/ontology-edgecond.test.js)
- [x] 2.3 routes/ontology.js: 프로세스의 진입 간선 목록 · 간선 설정 조회 · 저장 API
- [x] 2.4 태스크 이름 바꾸기 · 합치기 때 pro_edge_conditions 의 event · task 키를 함께 바꿈

## 3. 실행 적용

- [x] 3.1 진입 간선 정하기(첫 단계 · 앞 단계 뒤 · 중간 시작 · 옮기기 · 되감기) 순수 함수와 단위 테스트
- [x] 3.2 runmode.js gateStep · steprule.forStep: 진입 간선 조건으로 꼭 · 선택 판단(「지도에서 바로」 실행은 지금 설정, 「프로세스 정의로」 실행은 인스턴스 스냅샷 때 설정), 여럿이면 하나라도 꼭이면 꼭, pro_case_steps.matched 에 간선 · 규칙 기록
- [x] 3.3 mapengine.js: 다음 단계 후보 중 진입 간선이 꼭인 태스크 우선, pinOnStart 자동 map_pin 제거
- [x] 3.4 run.js withRequirements · unfold: 이 프로세스의 간선 조건에서 꼭이 될 수 있는 간선(앞 일 → 일)만 required 로 스냅샷에 반영(edgecond.js edgeRequiredView — 태스크를 고정하지 않음)
- [x] 3.5 passedRequired(옮기기로 지나칠 때 알림)를 간선 조건 기준으로

## 4. 조건을 정하는 곳 정리

- [x] 4.1 refine.js: 단계 가르기 저장 · 태스크 고정 제거, AI 분류 제안 결과를 진입 간선마다 class.ai 로 저장
- [x] 4.2 runmode.js responsibleOf: 진입 간선의 확정 분류로 담당 결정(여럿이면 사람이 꼭 우선)
- [x] 4.3 steprule.js: 단계 단위 설정(requirementsOf · 패널 API · requiredView) 제거, 말로 고치기 set_requirement 는 그 단계의 진입 간선 설정으로(editmap.js)
- [x] 4.4 routes/ontology.js: 단계 분류 · 단계 규칙 API 제거, 간선 설정 API로 통합
- [x] 4.5 단계 패널(ProcessMapView.vue): 단계 규칙 설정과 분류 설정 제거
- [x] 4.6 MapGraph.vue 사건 보기: 간선 클릭 → 간선 설정 패널(조건 · 분류 · AI 제안, 같은 태스크 진입 간선에 복사), 간선 색칠과 분류 표시
- [x] 4.7 OntoRefine.vue · mock-refine.js: 단계 가르기 탭 제거

## 5. 이전

- [x] 5.1 이전 스크립트: pro_step_requirements → 진입 간선 복사, decided gate → 진입 간선 required(단계 규칙과 부딪치면 단계 규칙 우선, 버린 관문 원장), 다듬기가 건 태스크 고정 해제, 관문이 아닌 분류를 진입 간선마다 복사
- [x] 5.2 로컬 그래프에 이전 실행, 결과 요약 확인

## 6. 검증(로컬 Lite 화면 8088, e2e)

- [x] 6.1 간선 조건을 정하고 다시 열어도 유지되는지
- [x] 6.2 한 프로세스의 간선 조건이 같은 간선을 쓰는 다른 프로세스의 지도 · 실행 정의를 바꾸지 않는지(결함 1 재현 조건)
- [x] 6.3 부딪치는 조건을 정할 곳이 없고 실행이 간선 조건을 따르는지(결함 2 재현 조건)
- [x] 6.4 「지도에서 바로」 실행: 중간 태스크부터 시작한 건 · 설정 변경 전에 시작한 건이 바뀐 간선 설정대로 진행되는지
- [x] 6.4.1 「프로세스 정의로」 실행: 실행 중인 건은 스냅샷 때 설정대로, 새로 시작한 건은 바뀐 설정대로 진행되는지
- [x] 6.5 단계 구성이 다른 프로세스 하나로 6.1~6.4 반복
