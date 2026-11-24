# 시험과 증거

## 서버 시험

```bash
cd server
# 모델 · DB 없이: 카탈로그 · 받는 화면(공식 스키마 + 서버 검사) · 낸 값 다시 보기 · result 글 · 만들기(다시 묻기 · 글 칸 · 비밀 판정)
node --test test/stepUi.test.js
# 실제 DB · 실제 라우트(routes/process.js, 로그인만 대역) · 가짜 모델 서버 — 지도 저장소(Ontological)는 쓰지 않는다
node --test --test-concurrency=1 test/stepUi.integration.test.js
```

통합 시험은 건의 행(`pro_po_cases` · `bpm_proc_inst` · `todolist` · `pro_case_steps`)을 엔진이 쓰는 형식으로 넣는다. 그다음 `mapengine.toPerson` · `GET /api/todos/:id` · `POST /api/todos/:id/submit` · `runmode.earlierOfCase`를 차례로 호출한다. 제출 후 다음 단계를 정하는 과정은 지도 저장소가 없어 멈춘다(로그에 「Ontological DB 가 설정되지 않았어요」가 남는다). 시험은 그 직전인, 다음 단계가 앞 단계의 글을 읽는 지점까지 확인한다. 시험에서 만든 사람 · 건 · 할 일 · 화면 행은 시험이 끝나면 지운다.

## 화면 시험 (Playwright, `e2e/tests/feature/step-ui-a2ui.spec.js`)

```bash
# 서버: 가짜 모델(이 스펙이 RT_FAKE_LLM_PORT 에 띄움) · 백그라운드 일 없음 · 지도 저장소 없음 · 공용 서비스는 닫힌 포트
cd server && PRO_PORT=8792 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59987/v1 PRO_LLM_MODEL=fake-ui PRO_LLM_FAST_MODEL=fake-ui PRO_LLM_KEYS= \
  PRO_ONTOLOGY_BOLT_URL= PRO_DEEPAGENTS_URL=http://127.0.0.1:9 PRO_CONTEXT_ROUTER_URL= PRO_MEMENTO_URL=http://127.0.0.1:9 PRO_COMPLETION_URL=http://127.0.0.1:9 \
  PRO_SCENARIOS=off PRO_STEP_UI=on node index.js
PRO_API_TARGET=http://127.0.0.1:8792 npx vite --port 5193 --strictPort
cd e2e && PGPT_URL=http://localhost:5193 API_URL=http://127.0.0.1:8792 RT_FAKE_LLM_PORT=59987 RT_WORKERS=1 \
  npx playwright test tests/feature/step-ui-a2ui.spec.js --project=feature
```

가짜 모델은 step-ui 프롬프트에 `server/test/fixtures/step-ui-review.json`(「견적 검토」) 화면을 돌려준다. 판정에는 「A」(비밀을 묻지 않음)를 돌려준다. 건은 시험 계정 `pro-rt-su-owner@uengine.org` 소유로 DB에 넣고, 할 일 카드는 해당 계정의 메인 채팅에 둔다. 같은 가짜 모델 포트를 쓰는 다른 묶음과 동시에 실행하지 않는다(`RT_WORKERS=1`, 묶음 안은 `serial`).

| 스펙 시나리오 | 시험 |
|---|---|
| 견적 검토 단계가 열린다 | 서버 「사람 단계가 열리면 화면을 만들어 두고 …」(모델이 받은 입력 · `form` 옆 `ui`) · F-SU-01(칸 · 보기 · 버튼 둘) |
| 먼저 열면 기다린다 | F-SU-01(「이 단계에 맞는 입력 화면을 준비하고 있어요」 → 화면) · 서버 「먼저 열면 그때 만든다」 |
| 영어를 쓰는 사람 | 서버 「… 맡은 사람의 언어(영어)로」(모델 입력 `lang: en`, 시스템 프롬프트의 English 지시) |
| 초안 단계 | 서버 「초안 단계: 초안이 오기 전엔 지금의 칸, 초안이 오면 …」 |
| 모델이 엉뚱한 화면을 만든다 | F-SU-03 · 서버 「모델이 엉뚱한 화면을 두 번 …」(물은 횟수 2 · 이유) |
| 고쳐 온 화면 | 단위 「만들기: 검사에 걸리면 까닭을 붙여 한 번 더 …」 |
| 비밀을 묻는 화면 | 서버 「비밀 · 결제 정보를 묻는 화면 …」 · 단위 「만들기: 비밀 · 결제 정보 …」(판정 모델은 대역) |
| 한국어로 채워 낸다 | F-SU-01(키를 하나씩 눌러 한국어 입력 → 읽기 전용 · 「제출됨」 · 새로 고침 후에도 유지 · DB의 값과 result) |
| 빈 칸을 두고 보낸다 | F-SU-02(처음에는 안내 없음 → 입력한 칸만 → 비활성화된 보내기를 누르면 모든 칸) |
| 휴대폰에서 낸다 | F-SU-04(390×844, 페이지 · 카드 · 칸 · 버튼 줄이 넘치지 않음) |
| 밤 테마 | F-SU-05(밤 · 낮의 글 · 칸 · 보내기 색, 페이지 color-scheme `normal`) |
| 다른 사람이 낸다 | F-SU-02(`su-mate` → 403) · 서버(서하린 → 403) |
| 화면에 없는 것을 보낸다 | F-SU-02(`approve_all` → 400) · 서버(없는 버튼 · 없는 보기 · 형식이 틀린 동작 → 400, 단계는 열린 상태 유지) · 단위 「낸 값 …」 |
| 다음 단계가 읽는다 | 서버(`earlierOfCase`의 마지막 글 = result) · 단위 「다음 단계가 읽는 글(result) …」 |
| 받는 화면의 검사(v0.9 바인딩 · theme · 모르는 부품 · 없는 id · 고리 · 너무 큼 · javascript: 주소 · 경로 · 예약어 · 버튼 · 비밀번호 칸 · numeric) | 단위 「걸리는 화면 …」 두 묶음 |

시험하지 않은 것:
- **건 화면(지도 › 건 보기, `OntoCaseRun`)의 할 일 카드.** 같은 `TodoCard`를 쓰지만, 지도 화면을 열려면 Ontological 지도 저장소가 있어야 한다. 이 시험 환경에는 저장소가 없어 채팅의 할 일 카드로 시험했다. 승인함(구매 시나리오)도 같은 카드를 쓴다.
- **엔진이 실제로 다음 단계를 정하는 과정.** 지도 저장소가 필요하다. 다음 단계가 읽는 글까지만 확인했다.
- **영어 화면의 캡처.** 모델 입력과 시스템 프롬프트만 확인했다.
- **실제 모델로 만든 화면의 이미지.** 아래 「실제 모델」에서는 서버에서 화면 메시지만 만들어 검사했다.

## 실제 모델 (회사 게이트웨이 `frentis-ai-model`, 2026-11-24)

```bash
cd server && node scripts/eval-step-ui.mjs --runs 1 [--effort low] --out ../.scratch/step-ui-eval.json
```

가상의 회사 업무 여섯 개(견적 검토 · 출장비 정산 승인 · 납품 일정 확정 · 특강 신청 확인(초안 있음) · 용역 계약서 법무 검토 · 영어 Purchase request approval)의 화면을 현재 프롬프트 · 카탈로그로 만들었다. 서버 검사 통과 여부 · 물은 횟수 · 걸린 시간을 기록했다.

| 회차 | 설정 | 통과한 화면 | 첫 답에 통과 | 걸린 시간(중간값 · 최대) | 못 만든 까닭 |
|---|---|---|---|---|---|
| 1 | 기본 추론 · JSON 모드 | 5/6 | 2/6 | 64.6초 · 73.9초 | 45초 한도 초과 1 |
| 2 | 추론 low · JSON 모드 | 6/6 | 6/6 | 10.5초 · 13.0초 | — |
| 3 | 추론 low · JSON 모드 · 두 번씩 | 10/12 | 9/12 | 13.4초 · 63.8초 | 답이 빈 줄을 이어 쓰다 토큰 한도에서 끊김 2 |
| 4 | 추론 low · JSON 모드 끔 · 두 번씩 | 11/12 | 11/12 | 9.8초 · 20.4초 | 괄호 하나 빠뜨림(두 번 같은 꼴) 1 |
| 5 | 4 + 다시 물을 때 온도 0.6 | 11/12 | 10/12 | 10.8초 · 39.0초 | 괄호 하나 빠뜨림 1 |
| **6** | **지금 설정**: 5 + 괄호 고치기 | **12/12** | **11/12** | **9.3초 · 24.8초** | — |

- 지금 설정(`rules.json` `stepUi`: 추론 `low`, JSON 모드 끔, 다시 물을 때 온도 0.6, 한 번 더, 45초)으로 12개 모두 검사를 통과했다. 한 번은 첫 답의 괄호를 고친 자리가 스키마에 걸렸고, 그 까닭을 받은 모델이 두 번째 답에서 고쳤다.
- 다시 물은 까닭 가운데 예약어(`result` 키를 쓴 것)가 두 번 있었고(4 · 5회차), 두 번째 답에서 모두 고쳤다.
- 만든 칸(지금 설정, 첫 회): 견적 검토 6칸(검토 결과 · 확정 금액(원) · 납기일 · 단가표와 대조했어요 · 할인율 20% 이하 확인 · 검토 의견), 출장비 정산 승인 5칸 + 버튼 둘(승인 · 반려), 납품 일정 확정 4칸, 특강 신청 확인 5칸(초안의 강의실 · 일시가 첫 값), 법무 검토 6칸(점검 항목 셋이 확인 칸), 영어 Purchase request approval 4칸(Decision · Approved amount (KRW) · Comment · Budget line checked). 라벨은 맡은 사람의 언어로 나왔다.
- 비밀 판정(첫 글자 확률)은 매번 읽혔고(`state: ok`), 거절한 화면은 없었다.
- 실제 모델 화면 한 장: `results/real-model-expense-approval.png`(출장비 정산 승인, `server/scripts/seed-step-ui-demo.mjs`로 넣고 같은 화면 시험 서버로 그림).
- 원자료: `.scratch/step-ui-eval-*.json`(작업 트리, 저장소 밖).

## 결과

- `results/unit.txt`: 서버 시험(`stepUi.test.js` · `stepUi.integration.test.js`)과 회귀 시험.
- `results/e2e.txt`: F-SU-01~05.
- 화면: `results/f-su-*.png`
  - `01a` 할 일 카드의 「준비하고 있어요」, `01b` 생성된 화면(보내기 비활성화), `01c` 한국어로 채운 화면, `01d` 제출 후 읽기 전용 · 「제출됨」
  - `02` 비활성화된 보내기를 누른 뒤의 안내
  - `03` 화면을 만들지 못했을 때의 글 칸
  - `04` 휴대폰 390px
  - `05-dark` · `05-light` 밤 · 낮 테마