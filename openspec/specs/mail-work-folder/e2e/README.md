# 시험과 증거

## 서버 시험 (실제 DB · 실제 git · 로컬 Storage · 모델과 Gmail 은 가짜 fetch · 지도의 읽기 · 건 시작 · 판정은 대역)

```bash
cd server && node --test --test-concurrency=1 test/mailWork.integration.test.js
```

모델 주소를 쓰지 않는 주소(`127.0.0.1:59996`)로 바꾸고 지도 엔진을 끈 채(`PRO_ONTOLOGY_BOLT_URL=`) 돈다. 작업 폴더는 시험의 임시 폴더(`PRO_FOLDERS_ROOT`)에 만든다. 시험이 만든 행 · 폴더 · Storage 객체는 끝나면 지운다. 로컬 지도 엔진(Ontological)이 꺼져 있어서, 들어온 메일의 지도 읽기와 건 시작은 PR #22 와 같은 대역(`route` · `start` · `judge`)으로 보았다. `pollUser(userId, { deps })`가 그 대역을 `mailFlow.routeMailCards`에 넘긴다.

## 화면 시험 (Playwright, `e2e/tests/feature/mail-work-folder.spec.js`)

```bash
# 서버: 가짜 모델(이 스펙이 59998 에 띄움) · 지도 엔진 없음 · 백그라운드 일 없음 · 작업 폴더는 임시 폴더에
cd server && PRO_PORT=8793 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59998/v1 PRO_ONTOLOGY_BOLT_URL= PRO_FOLDERS_ROOT=/tmp/e2e-pgpt-folders node index.js
PRO_API_TARGET=http://127.0.0.1:8793 npx vite --port 5193 --strictPort
cd e2e && PGPT_URL=http://localhost:5193 API_URL=http://127.0.0.1:8793 PRO_FOLDERS_ROOT=/tmp/e2e-pgpt-folders RT_WORKERS=1 \
  npx playwright test tests/feature/mail-work-folder.spec.js --project=feature
```

같은 가짜 모델 포트를 쓰는 `mail-thread-flow.spec.js` · `mail-reply.spec.js`와 동시에 돌리지 않는다(`RT_WORKERS=1`). 메일함은 데모 메일함이다(실제 메일 없음). F-MW-04 는 서버 모듈(`lib/mailWork.js recordDone`)을 시험 프로세스에서 직접 부르므로 시험 쪽에도 같은 `PRO_FOLDERS_ROOT`를 준다.

| 스펙 시나리오 | 시험 |
|---|---|
| 새로 시작 | 서버 「새로 시작」(시작은 대역 — 폴더 · 주인 · 이름 · 보기 구성원 · 메일 01 · 커밋 작성자 · 칩 · 참고 연결) |
| 폴더 없던 일에 메일을 잇는다 | F-MW-01 · 서버 「잇기」 |
| 첫 메일 | F-MW-01(파일 · 미리보기), 서버 「새로 시작」(.eml 을 다시 읽음 · .md) |
| 같은 스레드의 첨부 있는 메일 | 서버 「들어올 때(Gmail · 자동)」(가짜 Gmail raw, 첨부 두 개, 원문 바이트가 같음) |
| 견적서 작성 단계가 끝난다 | F-MW-04 · 서버 「단계 결과」(Storage 파일 · 결과.md · 작성자 · 취소 · 폴더에서 한 단계는 건너뜀) |
| 첫 단계 뒤에 메일이 온다 | 서버 「단계 결과」(main 과 라인에 메일 02) |
| 회신 메일 단계 | 서버 「단계 결과」(`stepContext` · doc-draft 입력의 `work`) |
| 자동 | 서버 「들어올 때(Gmail · 자동)」(문서를 요청하지 않는 메일, Home 알림) |
| 제안 · 관찰 | 서버 「들어올 때(데모 메일함)」 |
| 고객이 다시 썼지만 스레드가 없다 | 서버 「자동이라도 진행 중인 같은 일…」 |
| 인스턴스에서 폴더로, 폴더에서 인스턴스로 | F-MW-01 · F-MW-03(메일 시트 · 폴더 목록) |
| 휴대폰 | F-MW-02 |
| 다른 파드의 에이전트가 고친 파일 | 서버 「deepagents 단계 …」(로컬 Storage 에 에이전트 쪽 변경을 직접 올림) |
| 다른 엔진의 단계가 인스턴스 라인부터 | 서버 「다른 엔진(deepagents · cli-agent)…」 |

시험하지 않은 것:
- 실제 지도 엔진으로 들어온 메일을 읽고 자동 시작 → 첫 단계(지도 단계 일꾼이 `stepContext`를 읽고 도는 것). 로컬 엔진이 꺼져 있었다. doc-draft 가 `work`를 받는 것은 서버 시험이 직접 부른다.
- 운영 deepagents 의 엔진 단계가 Storage 의 방을 받는 것 — deepagents 쪽 변경이 필요하다(설계 §4). 변형 인계 · 충돌 해결(`runAgent`, 채팅 길)의 왕복은 코드만 바꾸었고 실제 deepagents 로 돌려 보지 않았다(공용 deepagents 를 쓰지 않음).
- IMAP 메일함의 원문 · 첨부(가짜 IMAP 없음 — Gmail · 데모만).
- 영어 화면.

## 결과

- `results/unit.txt`: 서버 시험. `mailWork` 9/9, 회귀 `mailFlow` 12/12 · `mailReply` 10 · 폴더 시험 6묶음 · `roomStore` 6 등 모두 통과. 이번 일과 무관한 실패(main 에서도 같음)는 따로 적었다.
- `results/ontology-regression.txt`: `ontology-*.test.js` 28개를 하나씩 — 224/224.
- `results/e2e.txt`: F-MW-01~04 4/4, 같은 서버에서 `mail-thread-flow` 7 · `mail-reply` 7 · `home-dismiss` 3 · `folders` 10 도 통과(31/31).
- 화면: `results/f-mw-*.png`
  - `01a` PC 인스턴스 화면의 「작업 폴더」 · `01b` 작업 폴더(메일/01_….eml · .md, 「작업 폴더」 · 「루틴 · …」) · `01c` 메일 .md 미리보기
  - `02a` 휴대폰 인스턴스 화면 · `02b` 인스턴스 대화의 폴더 칩 · `02c` 휴대폰 작업 폴더
  - `03a` 메일 시트의 「작업 폴더 · …」 · `03b` 폴더 목록의 「작업 폴더」 · `03c` 메일 01 · 02
  - `04a` 「단계 결과 1개 · 단계 결과 보기」 · `04b` 인스턴스 라인 변형의 `산출물/01_견적서 작성/결과.md`
