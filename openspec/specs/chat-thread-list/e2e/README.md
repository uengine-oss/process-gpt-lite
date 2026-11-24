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

시험하지 않은 것:
- iOS Safari 의 실제 두 번 탭. 브라우저가 dblclick 을 보내지 않아도 0.4초 간격으로 알아보도록 만들었고(CT-U-08), Chromium 의 터치 화면에서만 확인했다.
- 영어 화면. 새 문구는 `src/i18n/ko-en.json`에 넣었지만 영어 화면으로 실행해 보지는 않았다.
- 실제 판단 모델이 나눈 대화. 시험의 대화는 판단 모델이 남기는 모양대로 지어 넣은 행이다.
