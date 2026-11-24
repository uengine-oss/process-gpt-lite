# 회귀 시험 (2026-11-24, 이 브랜치 = origin/main b6c5f85 + 이 변경, 비교 = origin/main 80775dc)

## A. 기본 설정 서버(server/.env 그대로 — 지도 저장소 주소는 있으나 로컬 Ontological 은 꺼짐), PGPT_URL=http://localhost:5190 API_URL=http://127.0.0.1:8790
```
  ✓   1 [feature] › tests/feature/home-dismiss.spec.js:60:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-01 메일 카드: 휴대폰에서 ✕ 가 보이고, 밀어서 닫으면 Home 에서 사라지고 받은 편지함 › 메일에 남아 다시 연다 (3.5s)
  ✘   2 [feature] › tests/feature/home-dismiss.spec.js:94:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-02 업무 카드: ✕ 가 있고, 닫으면 다시 열어도 Home 에 없으며 루틴 「내 입력이 필요해요」에는 남는다 (7.5s)
  ✓   3 [feature] › tests/feature/home-dismiss.spec.js:119:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-03 워크아이템 알림을 닫으면 같은 업무가 「Submit」 카드로 다시 나오지 않는다 (2.6s)
  ✓   4 [feature] › tests/feature/mobile-review-1121.spec.js:38:3 › 휴대폰 검토 11-21 — 홈 알림 카드 › F-MR-01 날 JSON 이 든 알림: 카드가 화면 안에 맞고 ✕ 가 보이며, 홈이 옆으로 밀리지 않는다 (843ms)
  ✓   5 [feature] › tests/feature/mobile-review-1121.spec.js:59:3 › 휴대폰 검토 11-21 — 홈 알림 카드 › F-MR-02 ✕ 로 닫으면 아래 카드가 제자리(왼쪽 여백 그대로)에서 위로 올라온다 (1.7s)
  ✓   6 [feature] › tests/feature/mobile-review-1121.spec.js:80:3 › 휴대폰 검토 11-21 — 홈 알림 카드 › F-MR-03 손가락으로 옆으로 밀면 카드가 닫힌다(위아래는 목록 스크롤) (2.6s)
  ✓   7 [feature] › tests/feature/mobile-review-1121.spec.js:130:3 › 휴대폰 검토 11-21 — 루틴 열기 · 닫기 › F-MR-04 홈 카드로 루틴을 열면 앞 채팅이 비치지 않고 「루틴 여는 중」 → 루틴, ‹ 로 닫으면 홈 (1.1s)
  ✓   8 [feature] › tests/feature/mobile-review-1121.spec.js:153:3 › 휴대폰 검토 11-21 — 루틴 열기 · 닫기 › F-MR-05 없는 루틴은 오류와 「닫기」, 주소로 바로 열었을 때 ‹ 는 루틴 목록으로 (817ms)
  ✓   9 [feature] › tests/feature/mobile-review-1121.spec.js:165:3 › 휴대폰 검토 11-21 — 채팅 말풍선 › F-MR-08 넓은 표가 든 답도 말풍선이 휴대폰 폭을 넘지 않고, 표만 그 안에서 옆으로 스크롤된다 (944ms)
  ✓  10 [feature] › tests/feature/mobile-review-1121.spec.js:200:3 › 휴대폰 검토 11-21 — 예약 작업 › F-MR-06 「곧바로 하나 정도 한번 실행해 봐」는 새 예약이 아니라 그 작업을 지금 한 번 실행한다 (402ms)
  ✓  11 [feature] › tests/feature/mobile-review-1121.spec.js:215:3 › 휴대폰 검토 11-21 — 예약 작업 › F-MR-07 「급등락이 감지되면 내 텔레그램 봇으로 알려줘」: 그 작업에 텔레그램 전달을 켜고, 봇이 없으면 연결 카드 (409ms)
  ✘  12 [feature] › tests/feature/process-flow-plan.spec.js:31:1 › F-PO-20 고쳐 보기 · 개선안 — 고쳐 보기는 아무것도 쓰지 않고, 안은 앞 · 뒤를 지니며, 정하기는 관리자만 · 정하면 고침과 사람이 들어간다 (90ms)
  ✘  13 [feature] › tests/feature/process-flow-plan.spec.js:69:1 › F-PO-21 화면 — 지도(?view=flow)에서 고쳐 보기: 칩을 누르면 앞 · 뒤 표, 지도에 「할 일 8 → n」, 저장하면 안 카드, 합의에 올리면 「합의 중」 (872ms)
  ✘  14 [feature] › tests/feature/process-ontology.spec.js:18:1 › F-PO-01 지도 — 일 · 관계 · 프로세스과 자동 값(θ · 반감기 · 띠)이 근거와 함께 (147ms)
  ✘  15 [feature] › tests/feature/process-ontology.spec.js:34:1 › F-PO-02 배운 조건 · 드문 경로 · 은퇴 후보 (101ms)
  ✘  16 [feature] › tests/feature/process-ontology.spec.js:48:1 › F-PO-03 시점 고르기 — 9월 1일의 지도 (102ms)
  ✘  17 [feature] › tests/feature/process-ontology.spec.js:57:1 › F-PO-04 스냅샷 — 같은 키는 같은 정의를 다시 쓴다, 맨 앞은 요청 접수 (158ms)
  ✘  18 [feature] › tests/feature/process-ontology.spec.js:73:1 › F-PO-05 앞날짜 고정 — 그날 뒤 스냅샷에만 재무 검토가 반드시, 결정 원장, 관리자만 (155ms)
  ✘  19 [feature] › tests/feature/process-ontology.spec.js:101:1 › F-PO-06 검토 안건 — 은퇴 후보는 근거 숫자와 함께, 은퇴는 관리자만 (98ms)
  ✓  20 [feature] › tests/feature/process-ontology.spec.js:111:1 › F-PO-07 일 정의 — SKILL.md 형식을 읽고 쓰기가 되돌아온다 (348ms)
  ✘  21 [feature] › tests/feature/process-ontology.spec.js:132:1 › F-PO-08 화면 — 지도 · θ · 값 보기 · 검토 안건 · 스냅샷이 오류 없이 (106ms)
  ✘  22 [feature] › tests/feature/process-ontology.spec.js:152:1 › F-PO-09 사건과 소속 — 요청 메일이 첫 일을, 결과물이 다음 일을 일으키고, 한 일이 여러 프로세스에 (98ms)
  ✘  23 [feature] › tests/feature/process-ontology.spec.js:163:1 › F-PO-10 역할 — 사람 · 에이전트 · 지표, 보기는 누구나, 정의 초안은 관리자만 (103ms)
  ✘  24 [feature] › tests/feature/process-ontology.spec.js:174:1 › F-PO-11 개인 습관을 지도에 보이는 설정 — 관리자만 바꾸고, 지도에는 역할 · 일 · 사람 수만 (153ms)
  ✘  25 [feature] › tests/feature/process-ontology.spec.js:190:1 › F-PO-12 일의 방법 — 목표마다 공유한 방법, 남의 습관은 공유할 수 없고, 스킬은 관리자만 (100ms)
  ✘  26 [feature] › tests/feature/process-ontology.spec.js:202:1 › F-PO-13 승격 단계 — 관찰 · 제안 · 자동은 관리자만 바꾸고, 바꾸면 결정 원장에 (153ms)
  ✘  27 [feature] › tests/feature/process-ontology.spec.js:219:1 › F-PO-14 타이머 — 회사 타이머는 관리자만 걸고 프로세스의 시작 사건이 되며, 멈추고 지우면 예약도 따라간다 (155ms)
  ✘  28 [feature] › tests/feature/process-ontology.spec.js:241:1 › F-PO-15 화면 — 승격 단계 · 타이머 · 사건 보기 (157ms)
  ✘  29 [feature] › tests/feature/process-ontology.spec.js:264:1 › F-PO-16 병목 보기 — 일마다 할 일 = todolist 를 activity_id 로 센 수, 병목은 우리 쪽 사람 단계, 제약은 역할로, 건 제목은 관리자만 (150ms)
  ✘  30 [feature] › tests/feature/process-ontology.spec.js:291:1 › F-PO-17 화면 — 병목 보기: 패널(병목 · 회사의 제약 · 흔한 길) · 지도에 꼬리표와 범례 (101ms)
  -  31 [feature] › tests/feature/process-ontology.spec.js:337:1 › F-PO-18 화면 — 인스턴스 화면에서 내 단계 내기: 김민지가 루틴 탭(지도) › 진행 중인 루틴에서 건을 열면 그 건의 BPMN 과 자기 단계(평면도 작성)의 양식이 있고, 내면 지도 엔진이 다음 단계(제안서 작성)를 연다
  ✘  32 [feature] › tests/feature/process-ontology.spec.js:403:1 › F-PO-19 /improve 넘기기 — 목록은 지도의 병목 보기로, 지도 프로세스의 스냅샷 정의는 그 프로세스로, 지도에 없는 정의는 옛 개선 화면 그대로 (102ms)
  -  33 [feature] › tests/feature/process-ontology.spec.js:438:1 › F-PO-22 루틴 탭 — 지도가 뜨고, 진행 중인 루틴에 Lite · 클래식 둘 다, 클래식 개선 분석은 물을 때만
  ✘  34 [feature] › tests/feature/process-ontology.spec.js:494:1 › F-PO-23 화면 — 머리 단추는 보기 · 고치기 · 운영 세 칸, 항목마다 한 줄 설명, 휴대폰 폭에서도 화면 안에 (109ms)
    Error: expect(locator).toContainText(expected) failed
    Locator: locator('.rlist section').filter({ hasText: '내 입력이 필요해요' })
      - Expect "toContainText" locator('.rlist section').filter({ hasText: '내 입력이 필요해요' }) with timeout 5000ms
    > 114 |     await expect(page.locator('.rlist section').filter({ hasText: '내 입력이 필요해요' })).toContainText(`회귀 영업활동 ${RUN}`)
    Error: login pro-rt-po-user@uengine.org: 403 {"error":"이 계정은 다른 작업 공간(ax-demo)의 계정이에요. http://ax.localhost:5180 에서 로그인해 주세요."}
    Error: login pro-rt-po-admin@uengine.org: 403 {"error":"이 계정은 다른 작업 공간(ax-demo)의 계정이에요. http://ax.localhost:5180 에서 로그인해 주세요."}
  21 failed
  2 skipped
  11 passed (34.7s)
```

### A 를 origin/main(80775dc)에서 같은 설정으로 (PGPT_URL=http://localhost:5192 API_URL=http://127.0.0.1:8791)
```
  ✓   1 [feature] › tests/feature/home-dismiss.spec.js:60:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-01 메일 카드: 휴대폰에서 ✕ 가 보이고, 밀어서 닫으면 Home 에서 사라지고 받은 편지함 › 메일에 남아 다시 연다 (3.9s)
  ✘   2 [feature] › tests/feature/home-dismiss.spec.js:94:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-02 업무 카드: ✕ 가 있고, 닫으면 다시 열어도 Home 에 없으며 루틴 「내 입력이 필요해요」에는 남는다 (7.5s)
  ✓   3 [feature] › tests/feature/home-dismiss.spec.js:119:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-03 워크아이템 알림을 닫으면 같은 업무가 「Submit」 카드로 다시 나오지 않는다 (2.6s)
  ✘   4 [feature] › tests/feature/process-flow-plan.spec.js:31:1 › F-PO-20 고쳐 보기 · 개선안 — 고쳐 보기는 아무것도 쓰지 않고, 안은 앞 · 뒤를 지니며, 정하기는 관리자만 · 정하면 고침과 사람이 들어간다 (98ms)
  ✘   5 [feature] › tests/feature/process-flow-plan.spec.js:69:1 › F-PO-21 화면 — 지도(?view=flow)에서 고쳐 보기: 칩을 누르면 앞 · 뒤 표, 지도에 「할 일 8 → n」, 저장하면 안 카드, 합의에 올리면 「합의 중」 (157ms)
  ✘   6 [feature] › tests/feature/process-ontology.spec.js:18:1 › F-PO-01 지도 — 일 · 관계 · 프로세스과 자동 값(θ · 반감기 · 띠)이 근거와 함께 (101ms)
  ✘   7 [feature] › tests/feature/process-ontology.spec.js:34:1 › F-PO-02 배운 조건 · 드문 경로 · 은퇴 후보 (106ms)
  ✘   8 [feature] › tests/feature/process-ontology.spec.js:48:1 › F-PO-03 시점 고르기 — 9월 1일의 지도 (107ms)
  ✘   9 [feature] › tests/feature/process-ontology.spec.js:57:1 › F-PO-04 스냅샷 — 같은 키는 같은 정의를 다시 쓴다, 맨 앞은 요청 접수 (158ms)
  ✘  10 [feature] › tests/feature/process-ontology.spec.js:73:1 › F-PO-05 앞날짜 고정 — 그날 뒤 스냅샷에만 재무 검토가 반드시, 결정 원장, 관리자만 (153ms)
  ✘  11 [feature] › tests/feature/process-ontology.spec.js:101:1 › F-PO-06 검토 안건 — 은퇴 후보는 근거 숫자와 함께, 은퇴는 관리자만 (101ms)
  ✓  12 [feature] › tests/feature/process-ontology.spec.js:111:1 › F-PO-07 일 정의 — SKILL.md 형식을 읽고 쓰기가 되돌아온다 (361ms)
  ✘  13 [feature] › tests/feature/process-ontology.spec.js:132:1 › F-PO-08 화면 — 지도 · θ · 값 보기 · 검토 안건 · 스냅샷이 오류 없이 (101ms)
  ✘  14 [feature] › tests/feature/process-ontology.spec.js:152:1 › F-PO-09 사건과 소속 — 요청 메일이 첫 일을, 결과물이 다음 일을 일으키고, 한 일이 여러 프로세스에 (102ms)
  ✘  15 [feature] › tests/feature/process-ontology.spec.js:163:1 › F-PO-10 역할 — 사람 · 에이전트 · 지표, 보기는 누구나, 정의 초안은 관리자만 (99ms)
  ✘  16 [feature] › tests/feature/process-ontology.spec.js:174:1 › F-PO-11 개인 습관을 지도에 보이는 설정 — 관리자만 바꾸고, 지도에는 역할 · 일 · 사람 수만 (151ms)
  ✘  17 [feature] › tests/feature/process-ontology.spec.js:190:1 › F-PO-12 일의 방법 — 목표마다 공유한 방법, 남의 습관은 공유할 수 없고, 스킬은 관리자만 (101ms)
  ✘  18 [feature] › tests/feature/process-ontology.spec.js:202:1 › F-PO-13 승격 단계 — 관찰 · 제안 · 자동은 관리자만 바꾸고, 바꾸면 결정 원장에 (163ms)
  ✘  19 [feature] › tests/feature/process-ontology.spec.js:219:1 › F-PO-14 타이머 — 회사 타이머는 관리자만 걸고 프로세스의 시작 사건이 되며, 멈추고 지우면 예약도 따라간다 (150ms)
  ✘  20 [feature] › tests/feature/process-ontology.spec.js:241:1 › F-PO-15 화면 — 승격 단계 · 타이머 · 사건 보기 (153ms)
  ✘  21 [feature] › tests/feature/process-ontology.spec.js:264:1 › F-PO-16 병목 보기 — 일마다 할 일 = todolist 를 activity_id 로 센 수, 병목은 우리 쪽 사람 단계, 제약은 역할로, 건 제목은 관리자만 (153ms)
  ✘  22 [feature] › tests/feature/process-ontology.spec.js:291:1 › F-PO-17 화면 — 병목 보기: 패널(병목 · 회사의 제약 · 흔한 길) · 지도에 꼬리표와 범례 (102ms)
  -  23 [feature] › tests/feature/process-ontology.spec.js:337:1 › F-PO-18 화면 — 건 화면에서 내 단계 내기: 김민지가 루틴 탭(지도) › 진행 중인 루틴에서 건을 열면 자기 단계(평면도 작성)의 양식이 있고, 내면 지도 엔진이 다음 단계(제안서 작성)를 연다
  ✘  24 [feature] › tests/feature/process-ontology.spec.js:397:1 › F-PO-19 /improve 넘기기 — 목록은 지도의 병목 보기로, 지도 프로세스의 스냅샷 정의는 그 프로세스로, 지도에 없는 정의는 옛 개선 화면 그대로 (100ms)
  -  25 [feature] › tests/feature/process-ontology.spec.js:432:1 › F-PO-22 루틴 탭 — 지도가 뜨고, 진행 중인 루틴에 Lite · 클래식 둘 다, 클래식 개선 분석은 물을 때만
  ✘  26 [feature] › tests/feature/process-ontology.spec.js:488:1 › F-PO-23 화면 — 머리 단추는 보기 · 고치기 · 운영 세 칸, 항목마다 한 줄 설명, 휴대폰 폭에서도 화면 안에 (100ms)
    Error: expect(locator).toContainText(expected) failed
    Locator: locator('.rlist section').filter({ hasText: '내 입력이 필요해요' })
      - Expect "toContainText" locator('.rlist section').filter({ hasText: '내 입력이 필요해요' }) with timeout 5000ms
    > 114 |     await expect(page.locator('.rlist section').filter({ hasText: '내 입력이 필요해요' })).toContainText(`회귀 영업활동 ${RUN}`)
    Error: login pro-rt-po-user@uengine.org: 403 {"error":"이 계정은 다른 작업 공간(ax-demo)의 계정이에요. http://ax.localhost:5180 에서 로그인해 주세요."}
    Error: login pro-rt-po-admin@uengine.org: 403 {"error":"이 계정은 다른 작업 공간(ax-demo)의 계정이에요. http://ax.localhost:5180 에서 로그인해 주세요."}
  21 failed
  2 skipped
  3 passed (25.4s)
```

### A 의 지도 시험을 그 계정의 회사(ax-demo)로: PGPT_URL=http://ax.localhost:5190 API_URL=http://ax.localhost:8790 PGPT_TENANT=ax-demo
```
  -   1 [feature] › tests/feature/process-flow-plan.spec.js:31:1 › F-PO-20 고쳐 보기 · 개선안 — 고쳐 보기는 아무것도 쓰지 않고, 안은 앞 · 뒤를 지니며, 정하기는 관리자만 · 정하면 고침과 사람이 들어간다
  -   2 [feature] › tests/feature/process-flow-plan.spec.js:69:1 › F-PO-21 화면 — 지도(?view=flow)에서 고쳐 보기: 칩을 누르면 앞 · 뒤 표, 지도에 「할 일 8 → n」, 저장하면 안 카드, 합의에 올리면 「합의 중」
  -   3 [feature] › tests/feature/process-ontology.spec.js:18:1 › F-PO-01 지도 — 일 · 관계 · 프로세스과 자동 값(θ · 반감기 · 띠)이 근거와 함께
  -   4 [feature] › tests/feature/process-ontology.spec.js:34:1 › F-PO-02 배운 조건 · 드문 경로 · 은퇴 후보
  -   5 [feature] › tests/feature/process-ontology.spec.js:48:1 › F-PO-03 시점 고르기 — 9월 1일의 지도
  -   6 [feature] › tests/feature/process-ontology.spec.js:57:1 › F-PO-04 스냅샷 — 같은 키는 같은 정의를 다시 쓴다, 맨 앞은 요청 접수
  -   7 [feature] › tests/feature/process-ontology.spec.js:73:1 › F-PO-05 앞날짜 고정 — 그날 뒤 스냅샷에만 재무 검토가 반드시, 결정 원장, 관리자만
  -   8 [feature] › tests/feature/process-ontology.spec.js:101:1 › F-PO-06 검토 안건 — 은퇴 후보는 근거 숫자와 함께, 은퇴는 관리자만
  ✓   9 [feature] › tests/feature/process-ontology.spec.js:111:1 › F-PO-07 일 정의 — SKILL.md 형식을 읽고 쓰기가 되돌아온다 (370ms)
  -  10 [feature] › tests/feature/process-ontology.spec.js:132:1 › F-PO-08 화면 — 지도 · θ · 값 보기 · 검토 안건 · 스냅샷이 오류 없이
  -  11 [feature] › tests/feature/process-ontology.spec.js:152:1 › F-PO-09 사건과 소속 — 요청 메일이 첫 일을, 결과물이 다음 일을 일으키고, 한 일이 여러 프로세스에
  -  12 [feature] › tests/feature/process-ontology.spec.js:163:1 › F-PO-10 역할 — 사람 · 에이전트 · 지표, 보기는 누구나, 정의 초안은 관리자만
  -  13 [feature] › tests/feature/process-ontology.spec.js:174:1 › F-PO-11 개인 습관을 지도에 보이는 설정 — 관리자만 바꾸고, 지도에는 역할 · 일 · 사람 수만
  -  14 [feature] › tests/feature/process-ontology.spec.js:190:1 › F-PO-12 일의 방법 — 목표마다 공유한 방법, 남의 습관은 공유할 수 없고, 스킬은 관리자만
  -  15 [feature] › tests/feature/process-ontology.spec.js:202:1 › F-PO-13 승격 단계 — 관찰 · 제안 · 자동은 관리자만 바꾸고, 바꾸면 결정 원장에
  -  16 [feature] › tests/feature/process-ontology.spec.js:219:1 › F-PO-14 타이머 — 회사 타이머는 관리자만 걸고 프로세스의 시작 사건이 되며, 멈추고 지우면 예약도 따라간다
  -  17 [feature] › tests/feature/process-ontology.spec.js:241:1 › F-PO-15 화면 — 승격 단계 · 타이머 · 사건 보기
  -  18 [feature] › tests/feature/process-ontology.spec.js:264:1 › F-PO-16 병목 보기 — 일마다 할 일 = todolist 를 activity_id 로 센 수, 병목은 우리 쪽 사람 단계, 제약은 역할로, 건 제목은 관리자만
  -  19 [feature] › tests/feature/process-ontology.spec.js:291:1 › F-PO-17 화면 — 병목 보기: 패널(병목 · 회사의 제약 · 흔한 길) · 지도에 꼬리표와 범례
  -  20 [feature] › tests/feature/process-ontology.spec.js:337:1 › F-PO-18 화면 — 인스턴스 화면에서 내 단계 내기: 김민지가 루틴 탭(지도) › 진행 중인 루틴에서 건을 열면 그 건의 BPMN 과 자기 단계(평면도 작성)의 양식이 있고, 내면 지도 엔진이 다음 단계(제안서 작성)를 연다
  -  21 [feature] › tests/feature/process-ontology.spec.js:403:1 › F-PO-19 /improve 넘기기 — 목록은 지도의 병목 보기로, 지도 프로세스의 스냅샷 정의는 그 프로세스로, 지도에 없는 정의는 옛 개선 화면 그대로
  -  22 [feature] › tests/feature/process-ontology.spec.js:438:1 › F-PO-22 루틴 탭 — 지도가 뜨고, 진행 중인 루틴에 Lite · 클래식 둘 다, 클래식 개선 분석은 물을 때만
  -  23 [feature] › tests/feature/process-ontology.spec.js:494:1 › F-PO-23 화면 — 머리 단추는 보기 · 고치기 · 운영 세 칸, 항목마다 한 줄 설명, 휴대폰 폭에서도 화면 안에
  22 skipped
  1 passed (1.8s)
```

## B. 가짜 모델 59998 · 지도 저장소 없음(PRO_LLM_BASE_URL=http://127.0.0.1:59998/v1 PRO_ONTOLOGY_BOLT_URL= PRO_FOLDERS_ROOT=<임시>)
```
  ✓   1 [feature] › tests/feature/home-dismiss.spec.js:60:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-01 메일 카드: 휴대폰에서 ✕ 가 보이고, 밀어서 닫으면 Home 에서 사라지고 받은 편지함 › 메일에 남아 다시 연다 (3.6s)
  ✓   2 [feature] › tests/feature/home-dismiss.spec.js:94:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-02 업무 카드: ✕ 가 있고, 닫으면 다시 열어도 Home 에 없으며 루틴 「내 입력이 필요해요」에는 남는다 (3.1s)
  ✓   3 [feature] › tests/feature/home-dismiss.spec.js:119:3 › Home 은 알림 — 메일 카드 · 업무 카드도 닫는다 › F-HD-03 워크아이템 알림을 닫으면 같은 업무가 「Submit」 카드로 다시 나오지 않는다 (2.4s)
  ✓   4 [feature] › tests/feature/mail-thread-flow.spec.js:108:3 › 메일 칩 · 시트 · 인스턴스 — 채팅의 메일 줄에서 메일 원문으로, 메일에서 일로 › F-MT-01 모닝 브리프 아래 메일 칩 → 원문 시트 → 「Home 카드로」 그 카드가 보이고 빛난다 (PC) (2.6s)
  ✓   5 [feature] › tests/feature/mail-thread-flow.spec.js:135:3 › 메일 칩 · 시트 · 인스턴스 — 채팅의 메일 줄에서 메일 원문으로, 메일에서 일로 › F-MT-02 휴대폰: 채팅 탭의 메일 칩 → 시트 → 「Home 카드로」 홈 탭으로 가서 그 카드 (3.8s)
  ✓   6 [feature] › tests/feature/mail-thread-flow.spec.js:161:3 › 메일 칩 · 시트 · 인스턴스 — 채팅의 메일 줄에서 메일 원문으로, 메일에서 일로 › F-MT-03 시트가 묻는다: 「이 메일은 ‘…’의 시작으로 보여요 — 진행할까요?」 새로 시작 · 진행 중인 일에 잇기(같은 일 90%) · 이번엔 안 해요 — Home 카드도 한 줄로 (2.0s)
  ✓   7 [feature] › tests/feature/mail-thread-flow.spec.js:188:3 › 메일 칩 · 시트 · 인스턴스 — 채팅의 메일 줄에서 메일 원문으로, 메일에서 일로 › F-MT-04 잇기 → 그 인스턴스 화면, 메일이 인스턴스 대화의 사건 · Home 카드와 브리프 칩은 인스턴스로 · 거기서 답장하면 인스턴스에 남는다 (6.6s)
  ✓   8 [feature] › tests/feature/mail-thread-flow.spec.js:230:3 › 메일 칩 · 시트 · 인스턴스 — 채팅의 메일 줄에서 메일 원문으로, 메일에서 일로 › F-MT-05 휴대폰: 시트의 물음 · 잇기 뒤 Home 카드는 인스턴스를 연다 (4.5s)
  ✓   9 [feature] › tests/feature/mail-thread-flow.spec.js:262:3 › 메일 칩 · 시트 · 인스턴스 — 채팅의 메일 줄에서 메일 원문으로, 메일에서 일로 › F-MT-06 새로 시작이 실패하면 이유가 시트에 보이고 카드는 묶이지 않는다 · 이번엔 안 해요 → 더 묻지 않고, 다시 묻기로 되돌린다 (4.1s)
  ✓  10 [feature] › tests/feature/mail-thread-flow.spec.js:291:3 › 메일 칩 · 시트 · 인스턴스 — 채팅의 메일 줄에서 메일 원문으로, 메일에서 일로 › F-MT-07 새로 시작의 화면 흐름: 시작 응답의 인스턴스 화면으로 간다 (지도 엔진 없는 이 계층에서는 시작 응답만 대역) (2.1s)
  ✓  11 [feature] › tests/feature/mail-work-folder.spec.js:109:3 › 일의 작업 폴더 — 메일과 단계 결과가 한곳에 › F-MW-01 메일을 일에 이으면 작업 폴더가 생기고 첫 메일이 들어간다 — 인스턴스 화면의 「작업 폴더」 → 폴더(메일/01_….eml · .md) → 「루틴 · …」로 돌아온다 (PC) (4.4s)
  ✓  12 [feature] › tests/feature/mail-work-folder.spec.js:151:3 › 일의 작업 폴더 — 메일과 단계 결과가 한곳에 › F-MW-02 휴대폰: 인스턴스 화면의 「작업 폴더」와 폴더 화면이 옆으로 넘치지 않는다 (3.8s)
  ✓  13 [feature] › tests/feature/mail-work-folder.spec.js:177:3 › 일의 작업 폴더 — 메일과 단계 결과가 한곳에 › F-MW-03 다음 메일도 이으면 같은 폴더의 메일/02_…로 — 메일 시트의 「작업 폴더 · …」, 폴더 목록의 「작업 폴더」 표시 (5.4s)
  ✓  14 [feature] › tests/feature/mail-work-folder.spec.js:210:3 › 일의 작업 폴더 — 메일과 단계 결과가 한곳에 › F-MW-04 끝난 단계의 결과는 인스턴스 라인의 산출물/NN_<단계>/ 로 — 인스턴스 화면 「단계 결과 보기」 → 그 변형(main 은 반영 전까지 그대로) (4.8s)
  ✓  15 [feature] › tests/feature/map-case-view.spec.js:122:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-01 메일 칩으로 연 지도 건: 회사 지도가 아니라 인스턴스 화면, 진행 상황은 건의 BPMN(왼쪽에서 오른쪽) · 상태 색 · 범례 · 레인 (3.7s)
  ✓  16 [feature] › tests/feature/map-case-view.spec.js:175:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-02 목록과 다이어그램은 같은 상태 — 서버의 단계 · 흐름도의 색 · 목록, 「내 입력이 필요해요」 카드 하나, 건의 방식 · 멈추기 · 이 건 다루기 (2.4s)
  ✓  17 [feature] › tests/feature/map-case-view.spec.js:228:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-03 「회사 지도에서 이 건 보기」 → 지도의 건 패널, 거기서 흐름도 「크게 보기」(왼쪽에서 오른쪽) · 「인스턴스 열기」로 돌아옴 (6.0s)
  ✓  18 [feature] › tests/feature/map-case-view.spec.js:275:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-04 루틴 목록 · Home 카드 · 알림에서 연 지도 건도 인스턴스 화면 (5.9s)
  ✓  19 [feature] › tests/feature/map-case-view.spec.js:313:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-05 정의가 있는 인스턴스(클래식 · 스냅샷)는 그대로: 목록부터, 다이어그램은 정의의 BPMN, 병목 링크 · 회사 지도 링크 없음 (3.3s)
  ✓  20 [feature] › tests/feature/map-case-view.spec.js:366:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-06 휴대폰(390px): 흐름도는 위에서 아래로, 페이지는 옆으로 넘치지 않음 · ‹ 로 닫기 (2.4s)
  ✓  21 [feature] › tests/feature/map-case-view.spec.js:401:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-07 밤 테마: 흐름도 · 범례 · 칸이 어두운 화면의 색을 따른다 (3.8s)
  ✓  22 [feature] › tests/feature/mobile-review-1121.spec.js:38:3 › 휴대폰 검토 11-21 — 홈 알림 카드 › F-MR-01 날 JSON 이 든 알림: 카드가 화면 안에 맞고 ✕ 가 보이며, 홈이 옆으로 밀리지 않는다 (1.1s)
  ✓  23 [feature] › tests/feature/mobile-review-1121.spec.js:59:3 › 휴대폰 검토 11-21 — 홈 알림 카드 › F-MR-02 ✕ 로 닫으면 아래 카드가 제자리(왼쪽 여백 그대로)에서 위로 올라온다 (1.5s)
  ✓  24 [feature] › tests/feature/mobile-review-1121.spec.js:80:3 › 휴대폰 검토 11-21 — 홈 알림 카드 › F-MR-03 손가락으로 옆으로 밀면 카드가 닫힌다(위아래는 목록 스크롤) (2.5s)
  ✓  25 [feature] › tests/feature/mobile-review-1121.spec.js:130:3 › 휴대폰 검토 11-21 — 루틴 열기 · 닫기 › F-MR-04 홈 카드로 루틴을 열면 앞 채팅이 비치지 않고 「루틴 여는 중」 → 루틴, ‹ 로 닫으면 홈 (1.2s)
  ✓  26 [feature] › tests/feature/mobile-review-1121.spec.js:153:3 › 휴대폰 검토 11-21 — 루틴 열기 · 닫기 › F-MR-05 없는 루틴은 오류와 「닫기」, 주소로 바로 열었을 때 ‹ 는 루틴 목록으로 (859ms)
  ✓  27 [feature] › tests/feature/mobile-review-1121.spec.js:165:3 › 휴대폰 검토 11-21 — 채팅 말풍선 › F-MR-08 넓은 표가 든 답도 말풍선이 휴대폰 폭을 넘지 않고, 표만 그 안에서 옆으로 스크롤된다 (867ms)
  ✓  28 [feature] › tests/feature/mobile-review-1121.spec.js:200:3 › 휴대폰 검토 11-21 — 예약 작업 › F-MR-06 「곧바로 하나 정도 한번 실행해 봐」는 새 예약이 아니라 그 작업을 지금 한 번 실행한다 (422ms)
  ✓  29 [feature] › tests/feature/mobile-review-1121.spec.js:215:3 › 휴대폰 검토 11-21 — 예약 작업 › F-MR-07 「급등락이 감지되면 내 텔레그램 봇으로 알려줘」: 그 작업에 텔레그램 전달을 켜고, 봇이 없으면 연결 카드 (405ms)
  29 passed (1.5m)
```

## C. step-ui 설정(가짜 모델 59987 · PRO_STEP_UI=on · 지도 저장소 없음 — openspec/specs/step-ui-a2ui/e2e/README.md 의 명령)
```
  ✓   1 [feature] › tests/feature/map-case-view.spec.js:122:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-01 메일 칩으로 연 지도 건: 회사 지도가 아니라 인스턴스 화면, 진행 상황은 건의 BPMN(왼쪽에서 오른쪽) · 상태 색 · 범례 · 레인 (5.9s)
  ✓   2 [feature] › tests/feature/map-case-view.spec.js:175:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-02 목록과 다이어그램은 같은 상태 — 서버의 단계 · 흐름도의 색 · 목록, 「내 입력이 필요해요」 카드 하나, 건의 방식 · 멈추기 · 이 건 다루기 (2.7s)
  ✓   3 [feature] › tests/feature/map-case-view.spec.js:228:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-03 「회사 지도에서 이 건 보기」 → 지도의 건 패널, 거기서 흐름도 「크게 보기」(왼쪽에서 오른쪽) · 「인스턴스 열기」로 돌아옴 (6.2s)
  ✓   4 [feature] › tests/feature/map-case-view.spec.js:275:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-04 루틴 목록 · Home 카드 · 알림에서 연 지도 건도 인스턴스 화면 (5.5s)
  ✓   5 [feature] › tests/feature/map-case-view.spec.js:313:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-05 정의가 있는 인스턴스(클래식 · 스냅샷)는 그대로: 목록부터, 다이어그램은 정의의 BPMN, 병목 링크 · 회사 지도 링크 없음 (3.1s)
  ✓   6 [feature] › tests/feature/map-case-view.spec.js:366:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-06 휴대폰(390px): 흐름도는 위에서 아래로, 페이지는 옆으로 넘치지 않음 · ‹ 로 닫기 (2.6s)
  ✓   7 [feature] › tests/feature/map-case-view.spec.js:401:3 › 지도에서 바로 도는 건의 인스턴스 화면 — 건의 BPMN 으로 (spec map-case-view) › F-CV-07 밤 테마: 흐름도 · 범례 · 칸이 어두운 화면의 색을 따른다 (4.1s)
  ✓   8 [feature] › tests/feature/step-ui-a2ui.spec.js:94:3 › 단계 입력 화면 — 에이전트가 만든 A2UI 화면 (spec step-ui-a2ui) › F-SU-01 할 일 카드: 준비하고 있어요 → 단계에 맞는 화면, 필수 칸 전엔 보내기 꺼짐, 한국어로 채워 내면 읽기 전용 · 서버에 값과 결과 글 (7.0s)
  ✓   9 [feature] › tests/feature/step-ui-a2ui.spec.js:147:3 › 단계 입력 화면 — 에이전트가 만든 A2UI 화면 (spec step-ui-a2ui) › F-SU-02 빈 칸을 두고 보내기를 누르면 모든 칸의 안내가 보이고, 맡은 사람이 아니면 낼 수 없다(서버가 다시 본다) (2.1s)
  ✓  10 [feature] › tests/feature/step-ui-a2ui.spec.js:179:3 › 단계 입력 화면 — 에이전트가 만든 A2UI 화면 (spec step-ui-a2ui) › F-SU-03 화면을 못 만들면(모델이 엉뚱한 화면을 두 번) 지금의 글 한 칸으로 낸다 (1.4s)
  ✓  11 [feature] › tests/feature/step-ui-a2ui.spec.js:200:3 › 단계 입력 화면 — 에이전트가 만든 A2UI 화면 (spec step-ui-a2ui) › F-SU-04 휴대폰 390px: 화면이 카드 너비 안, 버튼 줄이 옆으로 넘치지 않는다 (1.7s)
  ✓  12 [feature] › tests/feature/step-ui-a2ui.spec.js:229:3 › 단계 입력 화면 — 에이전트가 만든 A2UI 화면 (spec step-ui-a2ui) › F-SU-05 낮 · 밤 테마: 화면의 글 · 칸 · 버튼 색이 앱의 테마를 따른다(페이지의 color-scheme 은 그대로) (2.8s)
  12 passed (45.9s)
```
