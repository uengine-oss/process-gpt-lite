# 시험과 증거

## 단위 시험 (DB · 모델 없음)

```bash
cd server && node --test test/map-case-view.test.js
```

- 건의 단계를 한 번 읽어(`mapengine.js` `caseRowsOf` · `madeOrder` · `runmode.js` `stepState`) 흐름도(`flowGraph` · BPMN 의 상태 표시)와 인스턴스 화면의 단계(`instanceSteps`)가 일마다 같은 상태인지 본다. 진행 막대 · 「내 입력이 필요해요」 · 대화 맥락이 이 단계에서 나온다.
- 화면이 무엇을 그릴지 정하는 순수 함수(`src/components/ontology/caseView.js`)를 본다: 지도 건은 건의 BPMN · 다이어그램부터 · 회사 지도 링크, 정의가 있는 인스턴스는 목록부터, 루틴 목록에서 여는 곳, 흐름의 방향(640px), 넓은 화면의 카드 폭, 대화 맥락.
- 고정 지도: `server/test/fixtures/map-case-view.mjs`(지어낸 회사 · 사람 — 「견적 요청 처리」: 요청 검토 → 단가 조회(에이전트) → 현장 실측 → 견적서 작성 70% / 정밀 견적 30% → 고객 회신).

## 화면 시험 (Playwright, `e2e/tests/feature/map-case-view.spec.js`)

```bash
# 서버: 백그라운드 일 없음 (server/.env 그대로, 또는 지도 저장소 없이 PRO_ONTOLOGY_BOLT_URL= — 둘 다 통과)
cd server && PRO_PORT=8790 PRO_BACKGROUND=0 node index.js
PRO_API_TARGET=http://127.0.0.1:8790 npx vite --port 5190 --strictPort
cd e2e && PGPT_URL=http://localhost:5190 API_URL=http://127.0.0.1:8790 RT_WORKERS=1 npx playwright test tests/feature/map-case-view.spec.js --project=feature
```

건은 엔진(`mapengine.js`)이 남기는 모양대로 DB 에 넣는다: 건 행(`pro_po_cases`, engine `map`) · 인스턴스 행 하나(`bpm_proc_inst`, 정의 없음) · 단계마다 할 일(`todolist`)과 단계 행(`pro_case_steps`, 1분 간격). 「견적서 작성」 할 일은 시험 계정(`pro-rt-cv-owner@uengine.org`)의 것이고, 입력 화면은 글 칸으로 정해 둔다(`pro_step_ui` fallback — 모델을 부르지 않음).

로컬에는 지도 저장소(Ontological)가 떠 있지 않아 `GET /api/ontology/cases/:id/flow` 만 시험이 대신 답한다. 대신 답하는 내용은 서버 코드를 시험 프로세스에서 그대로 돌린 응답이다: `mapengine.js` `flowFor`(건의 단계를 DB 에서 읽고 `casebpmn.js` 로 BPMN 을 만든다)에 지도만 고정 지도로 넘긴다. 인스턴스(`GET /api/instances/:id`) · 건 · 진행(`/run`) · 할 일 · 멈추기 · 이어 가기는 실제 서버가 답한다. F-CV-03 의 회사 지도는 개발 서버의 가짜 지도(`?mock=1`)이고, 건 패널의 내용은 실제 서버다.

| 스펙 시나리오 | 시험 |
|---|---|
| 메일 칩으로 연다 | F-CV-01 |
| 루틴 목록 · Home 카드 · 알림으로 연다 | F-CV-04(루틴 목록 · Home 의 업무 알림 카드 「열기」 · 브라우저 알림 · `/projects/p/…`) · F-CV-06(휴대폰 루틴 목록) |
| 채팅에서 시작한 건 | F-CV-08 |
| 넓은 화면 | F-CV-01(왼쪽에서 오른쪽 · 카드 폭 · 상태 색과 표시 · 레인 · 갈림 · 범례 · 옆 스크롤 없음) |
| 휴대폰 | F-CV-06(390×844, 위에서 아래 · 화면 폭 안 · 페이지와 대화 칸이 넘치지 않음 · ‹) |
| 밤 테마 | F-CV-07 |
| 견적서 작성이 내 차례 | F-CV-02(서버의 단계 = 흐름도 상태 · 목록 상태 = 다이어그램 색 · 입력 카드 하나) · 단위 「같은 근원 …」 |
| 멈추고 이어 간다 | F-CV-02 |
| 회사 지도의 맥락을 본다 | F-CV-03 |
| 패널에서 크게 본다 | F-CV-03 |
| 클래식 인스턴스 | F-CV-05(목록부터 · 목록에 다이어그램 없음 · 정의의 BPMN · 병목 링크 · 건의 흐름도를 묻지 않음) · 단위 「화면이 그릴 것 …」 |
| 정의가 있는 인스턴스 — 밝은 테마와 밤 테마 | F-BA-01 |
| 메시지 흐름 · 연관 · 조건 흐름 · 기본 흐름 | F-BA-02 |
| 지도에서 바로 도는 건과 크게 보기 | F-BA-03 |
| 프로세스 개선의 BPMN | F-BA-04 |

### 화살촉 시험 (`e2e/tests/feature/bpmn-arrowheads.spec.js`, 스펙 「흐름도의 흐름은 화살촉으로 끝난다」)

```bash
cd e2e && npx playwright test --project=feature tests/feature/bpmn-arrowheads.spec.js
```

스택은 시험이 따로 띄운다(`e2e/lib/localStack.js`: 테넌트 `bpmnarrow-ui` 의 BFF 와 Vite, 8910 · 5310 부터 빈 포트, 모델 · 공유 서비스 없음). 사람은 지어낸 이름(정하윤)이다. 정의는 `casebpmn.js` `createBpmnXml` 로 만들고(F-BA-01 · 04), 메시지 흐름 · 연관이 있는 정의는 손으로 쓴 XML 이다(F-BA-02). 지도 건은 F-CV 와 같은 고정 지도로 넣고 흐름도 응답만 서버 코드로 대신 답한다(F-BA-03). 개선 화면의 이력은 `lib/improve/demoProcess.js` 시뮬레이션이다(F-BA-04).

흐름마다 브라우저에서 읽는 것: 선의 `marker-end`(메시지 흐름 · 조건 흐름 · 기본 흐름은 `marker-start` 도)가 가리키는 id 가 같은 문서에 하나 있는지, 그것이 같은 `<svg>` 의 `<marker>` 인지 본다. 그 촉의 계산된 칠 · 선 색도 읽는다. 회색 촉은 밤 테마에서 밝고(휘도 0.5 넘음) 밝은 테마에서 어두워야 한다. 순서 흐름의 촉은 선과 같은 RGB 에 선보다 옅지 않아야 한다. 테마는 앱이 하듯 `<html data-theme>` 을 바꿔 다시 그리지 않고 본다. 그림은 `results/f-ba-*.png` 에 남긴다(2배 해상도).

## 결과

- `results/e2e.txt` — 화면 시험 8건 통과(2026-11-24, 기본 설정 서버). 지도 저장소 없이(`PRO_ONTOLOGY_BOLT_URL=`)와 step-ui 설정 서버에서도 8건(그때는 F-CV-08 전 7건) 통과 — `results/regression.md` B · C.
- `results/unit.txt` — 단위 시험 8건 통과.
- `results/regression.md` — 회귀: 인스턴스 · 루틴 · 메일에서 일로 · 휴대폰 홈과 루틴 · 단계 입력 화면 · 프로세스 지도. 기본 설정 서버에서 실패한 21건(F-HD-02, F-PO-01~23 중 20건)은 origin/main(80775dc)에서도 똑같이 실패한다. F-PO 는 시험 계정이 ax-demo 회사의 계정이라 로그인이 403 이고, 그 회사로 돌리면 지도 저장소가 없어 건너뛴다. F-HD-02 는 지도 저장소 주소가 있는 서버에서 「루틴」 탭이 회사 지도로 가서 루틴 목록이 없다(지도 저장소 없이 띄운 B 설정에서는 통과).
- `results/bpmn-arrowheads.txt` — 화살촉 시험 4건 통과(2026-11-25). origin/main(c1d9f7b)의 `BpmnView.vue` · `HeatBpmn.vue` 로는 4건 모두 실패한다. 촉이 bpmn-js 기본색 `rgb(34, 36, 42)` 이라 밤 테마에서 묻히고, 밝은 테마에서도 선의 색과 다르다. 그 출력도 이 파일에 있다.
- 그림 `results/f-ba-*.png`: 정의의 BPMN 밝은 · 밤(01) · 메시지 흐름 · 연관(02) · 지도 건 밝은 · 밤 · 크게 보기(03) · 개선 화면의 열지도 · 크리티컬 패스(04).
- 운영과 같은 `/lite/` 기준 경로(`VITE_BASE_PATH=/lite/` 빌드를 `vite preview` 로)에서 한 번 손으로 확인했다(시험에는 넣지 않음). 문서에 `<base>` 가 없고, 촉의 `url(#marker-…)` 은 같은 문서의 `<marker>` 하나를 가리키며 밝게 칠해진다. 기준 경로는 원인이 아니었다.
- 그림: `results/f-cv-*.png` — 메일 칩(01a) · 인스턴스 화면의 BPMN(01b) · 목록(02a) · 건의 방식과 입력 카드 · 이 건 다루기(02b) · 지도의 건 패널(03a) · 크게 보기(03b) · Home 카드(04) · 클래식 목록(05a) · 클래식 다이어그램(05b) · 휴대폰 BPMN(06a) · 휴대폰 목록(06b) · 밤(07-dark) · 낮(07-light) · 채팅의 시작 카드(08).

시험하지 않은 것:
- **실제 지도 저장소(Ontological)로 그린 흐름도.** 로컬에 저장소가 없어 흐름도 응답만 서버 코드에 고정 지도를 넘겨 만들었다. 지도에서 바로 도는 실제 건으로 내고 다음 단계가 생기는 과정은 `process-ontology.spec.js` F-PO-18(ax-demo 시드 · 지도 저장소 필요)을 이 화면에 맞게 고쳐 두었으나 이 환경에서는 건너뛰었다.
- **기다리는 단계의 「진행」 · 다른 갈래.** 같은 `OntoCaseRun` 조각(지도 패널에서 쓰던 것)을 그대로 쓰고, 이 화면에서는 멈추기 · 이어 가기만 눌러 보았다.
