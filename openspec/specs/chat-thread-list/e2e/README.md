# 시험과 증거

## 순수 규칙 (데이터베이스 · 모델 없이)

```bash
cd server && node --test test/chatThreadList.test.js
```

`src/threadList.js`의 규칙을 시험한다. 행의 순서(최근 순, 시각이 없는 행은 맨 아래), 찾기(제목 · 요지 · 요약에서 낱말마다), 한 줄 요약, 「N분 전 · N시간 전 · 날짜」, 열린 상태 기억(저장소가 막혀도 오류 없음), 「채팅」 탭의 한 번 · 두 번 누르기 구분(가짜 시계)을 다룬다. 누르기 구분에서는 마우스는 브라우저가 센 클릭 수를, 터치와 키보드는 0.4초 간격을 기준으로 삼는다. 두 번째 클릭은 다시 이동하지 않고, 뒤따르는 dblclick 과 세 번째 클릭은 무시한다. 첫 클릭이 화면을 바꿔도 두 번 누르기는 첫 클릭 전의 화면을 기준으로 한다.

| 스펙 시나리오 | 시험 |
|---|---|
| 네 대화의 순서 | CT-U-01 |
| 요약의 낱말로 | CT-U-02 |
| (행의 한 줄 · 시각) | CT-U-03 · CT-U-04 |
| 새로 고침(기억 · 막힌 저장소) | CT-U-05 |
| 기다리지 않는 첫 클릭 · 대화 안에서 한 번 · 두 번 눌러 열기 · 다른 탭에서 두 번 | CT-U-06 ~ CT-U-10 |

## 화면 시험 (Playwright, `e2e/tests/feature/chat-thread-list.spec.js`)

```bash
cd server && PRO_PORT=8885 PRO_BACKGROUND=0 PRO_ONTOLOGY_WORKER=0 PRO_LOCAL_AGENT_WORKER=0 PRO_PUBLIC_URL=http://localhost:5285 node index.js
PRO_API_TARGET=http://127.0.0.1:8885 npx vite --port 5285 --strictPort
cd e2e && PGPT_URL=http://localhost:5285 API_URL=http://127.0.0.1:8885 RT_WORKERS=1 \
  npx playwright test tests/feature/chat-thread-list.spec.js --project=feature
```

시험 계정은 `pro-rt-ct-user` · `pro-rt-ct-phone` · `pro-rt-ct-empty`(@uengine.org)이다. 시험마다 그 계정의 채팅 메시지와 `context_threads` 행을 지우고, 대화 네 개(5분 · 30분 · 2시간 · 3일 전)를 지어 넣는다. 판단 모델은 쓰지 않는다. 시험은 Playwright 자체 Chromium(`channel: 'chromium'`)으로 실행하고, 휴대폰은 390×844 터치 화면에서 실제 손가락 탭(`touchscreen.tap`)을 두 번 보낸다. F-CT-09 는 서버가 보내는 실시간 이벤트를 화면의 저장소(`onEvent('message', …)`)에 그대로 넣어 다른 기기에서 온 턴을 흉내 낸다.

| 스펙 시나리오 | 시험 |
|---|---|
| 두 번 눌러 열기 · 네 대화의 순서(행 · 시각 · 메시지 수 · 「전체 대화」) · 열리는 순간 다시 받아 옴 | F-CT-01 |
| 견적서 검토만 · 전체 대화로 · 대화 막대와 같은 대화(막대의 「전체 대화」, 주소로 연 대화) | F-CT-02 |
| 요약의 낱말로(제목 · 요청 · 답 · Esc) | F-CT-03 |
| 두 번 다시 눌러 닫기 · ✕ · Home 이 목록을 밀어냄 · 대화 막대에서 열기 | F-CT-04 |
| 대화 안에서 한 번 · 기다리지 않는 첫 클릭(0.25초 안) · 다른 탭에서 두 번(방문 기록 +1) · 다른 탭에 갔다 와도 열린 채 | F-CT-05 |
| 새로 고침(열린 채 · 닫힌 채) · 저장소를 막은 창 | F-CT-06 |
| 390px 휴대폰(시트 · 고르면 닫힘 · 두 번 탭으로 닫기 · 한 번 탭 · 홈 탭 · ✕) | F-CT-07 |
| 밤 테마의 고른 행(넓은 화면 · 기억된 휴대폰 시트) | F-CT-08 |
| 다른 기기에서 시작한 대화 | F-CT-09 |
| 대화가 없는 사용자 | F-CT-10 |

## 예약 작업과 브리프는 자기 대화에 · 후속 메시지는 방금 일하던 대화로 (2026-11-25)

```bash
cd server && node --test test/convOf.test.js test/routeContexts.test.js            # 순수 규칙(데이터베이스 · 모델 없이)
cd server && node --test test/ownConversations.integration.test.js                  # 실제 데이터베이스, 가짜 deepagents · 라우터 · 모델
# 화면: 가짜 deepagents(8986)와 가짜 모델(8987)은 시험 파일이 띄운다 — BFF 는 그 둘을 보게 띄운다
cd server && PRO_PORT=8985 PRO_BACKGROUND=0 PRO_DEEPAGENTS_URL=http://127.0.0.1:8986 PRO_LLM_BASE_URL=http://127.0.0.1:8987/v1 \
  PRO_CONTEXT_ROUTER_URL= PRO_ONTOLOGY_BOLT_URL= PRO_ONTOLOGY_WORKER=0 PRO_SCENARIOS=off PRO_CRON_MODE=server PRO_PUBLIC_URL=http://127.0.0.1:5385 node index.js
PRO_API_TARGET=http://127.0.0.1:8985 npx vite --port 5385 --strictPort --host 127.0.0.1
cd e2e && PGPT_URL=http://127.0.0.1:5385 API_URL=http://127.0.0.1:8985 RT_FAKE_AGENT_PORT=8986 RT_FAKE_LLM_PORT=8987 \
  npx playwright test tests/feature/chat-thread-list.spec.js --project=feature -g "F-CT-1[123]"
```

`src/convOf.js`(어느 메시지가 어느 대화인지 · 대화 목록의 행)는 `server/test/convOf.test.js`, 판단 모델이 받는 후보(`server/lib/routeContexts.js`)는 `server/test/routeContexts.test.js`가 본다. 통합 시험은 예약 실행이 실제로 지나는 길(`runMission` → `delegate`)과 메일함 읽기(`pollUser`)를 그대로 돌리고, 시험 계정 `pro-rt-schedconv@uengine.org`(로컬 Supabase 인증)를 쓴다. 화면 시험의 실행과 브리프는 서버를 거쳐 실시간으로 도착한다(`POST /missions/:id/run`, `POST /mail/poll`). 계정은 `pro-rt-ct-own`이다.

| 스펙 시나리오 | 시험 |
|---|---|
| 대화 A 를 보는 중 예약 실행과 브리프가 도착 | F-CT-11 · CV-U-02 · CV-U-03 · SO-I-01 · SO-I-03 |
| 같은 작업을 두 번 실행(「변동 없음」은 아무것도 남기지 않음, 직전 결과를 지시에) | SO-I-01 · SO-I-09(에이전트 기록은 몇 번마다 새로) |
| (실패 줄 · 「지금 실행」 결과도 그 작업의 대화) | SO-I-02 |
| 예전에 저장된 실행 | CV-U-04 · CV-U-05 · CV-U-07(그 실행의 줄만 — 검토 11-25 #5) |
| 휴대폰 390px | F-CT-12 |
| (메일 줄의 대화: 후속 작업 → 초안 → 브리프) | CV-U-06 |
| 문서를 열어 둔 채 이어 묻기 | SO-I-05 · SO-I-06(이름만 · 다른 기기 · 폴더 실행 방은 잇지 않음) · RC-U-03 |
| 패널을 닫고 이어 묻기 | SO-I-04 · RC-U-01 · RC-U-02 · RC-U-04 · 실제 라우터 A/B(`results/own-conversations.txt`) |
| 팀원의 브리프 id 로 보내기(대화 id 는 그 사람의 것만, 멈추기도 · id 는 짐작할 수 없게) | SO-I-07 · CV-U-01 · F-CT-11(서버가 준 id 를 다시 읽음) |
| 브리프 대화 안에서 묻기 | SO-I-08 |
| 답을 쓰는 중에 도착 | F-CT-13 |
| (팀원 멘션의 맥락은 사람이 있는 대화 — 검토 #3) | CV-U-08 |
| (맥락의 턴 짝짓기 — 검토 #7) | SO-I-11 |
| (「지금 실행」의 말 · 알림은 그 작업의 대화 — 검토 #9) | SO-I-10 · SO-I-01 |

## 결과

- `results/unit.txt`: 순수 규칙 10/10
- `results/e2e.txt`: F-CT-01~10 10/10
- 화면(`results/*.png`)
  - `f-ct-01-open-light.png`: 밝은 테마(낮 하늘 `?hour=13`), Home 자리에 열린 목록
  - `f-ct-02-filtered.png`: 「견적서 검토」를 고른 채팅과 강조된 행
  - `f-ct-03-search.png`: 「견적」으로 거른 목록
  - `f-ct-04a-home-replaces.png`: Home 단추가 목록을 밀어낸 뒤
  - `f-ct-07a-phone-sheet.png` · `f-ct-07b-phone-picked.png`: 390px 휴대폰의 시트와 고른 뒤의 채팅
  - `f-ct-08a-dark.png` · `f-ct-08b-dark-phone.png`: 밤 테마(넓은 화면 · 휴대폰)
  - `f-ct-11-a-after-arrivals.png`: 대화 A 를 보는 중 실행과 브리프가 도착한 뒤 — A 는 두 메시지 그대로, 목록에 해 · 시계 아이콘 행
  - `f-ct-11-schedule.png` · `f-ct-11-brief.png` · `f-ct-11-all.png`: 작업 대화, 브리프 대화(메일 칩), 「전체 대화」(시간 순)
  - `f-ct-12-phone-list.png` · `f-ct-12-phone-schedule.png`: 390px 휴대폰의 시트와 고른 작업 대화
- `results/own-conversations.txt`: 단위 · 통합 23/23(CV-U 8 · RC-U 4 · SO-I 11), Playwright 23/23(chat-thread-list 13 · mobile-review-1121 8 · telegram-unreachable 2), 실제 라우터 A/B — 검토 11-25 반영 뒤

시험하지 않은 것:
- iOS Safari 의 실제 두 번 탭. 브라우저가 dblclick 을 보내지 않아도 0.4초 간격으로 알아보도록 만들었고(CT-U-08), Chromium 의 터치 화면에서만 확인했다.
- 영어 화면. 새 문구는 `src/i18n/ko-en.json`에 넣었지만 영어 화면으로 실행해 보지는 않았다.
- 실제 판단 모델이 나눈 대화. 시험의 대화는 판단 모델이 남기는 모양대로 지어 넣은 행이다.
- 운영 데이터의 예전 메시지. 예전 실행 · 브리프를 구조로 옮겨 보이는 규칙은 지어 넣은 메시지로만 확인했다(CV-U-04).
- 실제 메일 초안(한글 · 도면) 흐름. 초안 대화로 놓이는 것은 코드로만 바꿨고, 시험은 브리프와 메일 칩까지다.

## 서버가 받지 못한 메시지 (`e2e/tests/feature/send-retry.spec.js` · `server/test/sendQueue.test.js`)

화면 시험은 서버 응답을 `page.route` 로 대신한다(502 HTML · 503 빈 본문 · 400 · 409 JSON · 연결 끊김 · 받은 뒤 끊긴 흐름). F-SR-08 과 서버 시험은 실제 서버 · DB(한 이름은 한 번만). 결과 사진 `results/f-sr-*`.

| 스펙 시나리오 | 시험 |
|---|---|
| 서버가 다시 켜지는 동안 보낸다 | F-SR-01(휴대폰 390) |
| 서버가 거절한다 | F-SR-02 |
| 쓰던 말이 있는 입력창 | F-SR-04 |
| 다시 보내기를 그만둔다 | F-SR-03 |
| 받은 뒤 끊긴 답 | F-SR-05 · 단위 「다시 보낼 실패 …」 |
| 새로 고침 | F-SR-06 · 단위 「이 브라우저에 남기기 …」 |
| 순서와 시간 한도 | F-SR-07(시험에선 4초) |
| 같은 이름 두 번 | F-SR-08 · 서버 「한 이름은 한 번만 …」 |
