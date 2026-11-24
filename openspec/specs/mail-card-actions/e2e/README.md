# 시험과 증거

## 서버 시험

```bash
cd server && node --test test/mailCard.test.js                                   # 모델 · DB · Google 없이
cd server && node --test --test-concurrency=1 test/mailCard.integration.test.js   # 실제 DB, 가짜 모델 · Gmail · Google 캘린더
```

- `mailCard.test.js`(8): 카드의 일(「Reply」 · 문서 초안 카드는 묻지 않음), 가짜 판정 모델로 고르기(첫 글자 확률 · 문턱 아래 · JSON 대체 · 읽지 못함), 시간대 계산(받은 때의 날짜 · 서머타임 앞뒤), 가짜 JSON 모델로 일정 읽기(모델이 본 입력 · 정리된 값), 정리(시각 없음 → 종일 또는 묻기, 없는 날짜 · 시각 · 위험한 링크 버림, 끝 시각 → 길이, 다른 시간대 → 내 시각), 읽기 실패 → 빈 양식, 같은 일정 찾기.
- `mailCard.integration.test.js`(11): 메일 카드 경로를 실제 Express 라우트(`routes/mailReply.js`)에 대고 부른다(로그인만 헤더 대역). 모델 · Gmail · Google 캘린더는 가짜 `fetch`다. 가짜 캘린더는 넣은 일정을 기억하고 시간 창으로 찾으면 돌려준다. 시험이 만든 행은 끝나면 지운다.

## 화면 시험 (Playwright, `e2e/tests/feature/mail-card-calendar.spec.js`)

```bash
# 서버: 가짜 모델(이 스펙이 59967 에 띄움) · 가짜 Google(59966) · 지도 엔진 없음 · 백그라운드 일 없음 · 공용 서비스는 닫힌 포트
cd server && PRO_PORT=8793 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59967/v1 PRO_LLM_MODEL=fake-judge PRO_LLM_FAST_MODEL=fake-judge \
  PRO_ONTOLOGY_BOLT_URL= PRO_DEEPAGENTS_URL=http://127.0.0.1:9 PRO_CONTEXT_ROUTER_URL= PRO_MEMENTO_URL=http://127.0.0.1:9 PRO_COMPLETION_URL=http://127.0.0.1:9 \
  PRO_GOOGLE_GMAIL_URL=http://127.0.0.1:59966/gmail/v1 PRO_GOOGLE_CALENDAR_URL=http://127.0.0.1:59966/calendar/v3 \
  PRO_SCENARIOS=off PRO_FOLDERS_ROOT=/tmp/e2e-pgpt-folders node index.js
PRO_API_TARGET=http://127.0.0.1:8793 npx vite --port 5194 --strictPort
cd e2e && PGPT_URL=http://localhost:5194 API_URL=http://127.0.0.1:8793 RT_WORKERS=1 RT_FAKE_LLM_PORT=59967 RT_FAKE_GOOGLE_PORT=59966 \
  npx playwright test tests/feature/mail-card-calendar.spec.js --project=feature
```

- 가짜 판정 모델은 웨비나 카드면 일정(A), 그 밖의 카드면 그 밖의 일(C)을 94% 확신으로 고른다. 일정 읽기는 1.5초 뒤 「내일 15:00 · 1시간 · 참여 링크」를 돌려준다(「일정 정보를 읽는 중…」을 보려고). 「내일」은 시험 날 서울 날짜의 다음 날이다.
- F-MC-04 는 Gmail 메일함의 Google 연결(캘린더 권한 포함)을 서버 모듈로 보관함에 넣는다. 시험 프로세스와 서버가 같은 보관함 키 파일(`server/.vault-keyring.json`)을 쓰므로 서버 소스 옆에서만 돈다(`lib` 픽스처). 다른 작업 트리의 키로 만든 시험 계정의 데이터 키는 열 수 없어 다시 만들고, 시험 뒤에는 데이터 키를 지우지 않는다(서버가 연 키를 10분 기억한다).
- 같은 서버에 `mail-reply` · `mail-thread-flow` · `home-dismiss` · `mail-work-folder` 를 이어 돌릴 때는 `RT_FAKE_LLM_PORT=59967` 로 같은 포트를 준다. 가짜 모델이 판정 모델의 첫 글자 확률에 답하지 않으면 서버가 판정 읽기를 10분 쉬므로(`lib/decide.js`), `mail-reply` 의 가짜 모델도 이제 그 물음에 답한다.

| 스펙 시나리오 | 시험 |
|---|---|
| 예전에 만든 일정 카드 | F-MC-01 · 서버 「예전 카드: 시트를 처음 열 때 …」 |
| 판정 모델에 연결할 수 없다 | 서버 「판정 모델이 꺼져 있으면 …」 |
| 브리프의 칩을 누른다 | F-MC-02 · F-MC-08(휴대폰) |
| 시각이 없는 메일 | 단위 「일정 정리: 시각이 없으면 종일 … 아니면 묻기」 · 서버 「… 시각 · 날짜가 빠진 양식은 400」 |
| 다른 시간대의 시각 | 단위 「일정 정리: … 다른 시간대는 내 시각으로」 |
| 일정을 읽지 못한다 | 단위 「읽기에 실패하면 …」 |
| 시각을 수정해 추가한다 | F-MC-03 · 서버 「「캘린더에 추가」: 한 번 만들고 …」 |
| 같은 일정이 이미 있다 | F-MC-04 · 서버 「같은 일정이 캘린더에 이미 있으면 …」 · 단위 「같은 일정」 |
| 두 번 누른다 | F-MC-04 · 서버 「「캘린더에 추가」 …」(두 번째 누름) · 「두 번 누름이 동시에 와도 …」 |
| 데모 메일함 | F-MC-03 · F-MC-08 · 서버 「데모 메일함: …」 |
| 캘린더 권한이 없다 | 서버 「캘린더 권한이 없는 Google 연결은 …」(연결 없음 · IMAP 포함) |
| 다른 사람의 카드 | 서버 「남의 카드는 403 …」 |
| 납부 카드 | F-MC-06 · F-MC-08 · F-ML-03 · 05 |
| Reply 카드 | F-MC-05 · F-ML-01~07 |
| 한국어 화면 · 영어 화면 | F-MC-07 · F-MT-01(칩의 「답장」) |
| 웨비나 초대 메일(브리프) | 서버 「들어올 때 메일 비서가 카드의 일을 정한다」(프롬프트) · 실제 모델 확인(`results/real-model.txt`) |
| 휴대폰의 일정 카드 | F-MC-08 |

시험하지 않은 것:
- 실제 Google 캘린더에 일정을 만들기. 시험은 가짜 Google 로만 하고, 요청 모양(시작 · 끝 · 시간대 · 설명 · 장소)과 같은 일정 찾기(시간 창)를 확인한다. 실제 캘린더에는 아무것도 만들지 않았다.
- 실제 Gmail 메일함. F-MC-04 는 가짜 Gmail 이 돌려주는 원문(RFC 822)을 읽는다.
- IMAP 메일함에 Google 캘린더 연결이 따로 있는 경우. 지금 Lite 의 Google 연결은 Gmail 메일함 연결과 함께여서 이 조합은 실제로 생기지 않는다. 코드는 Google 연결에 캘린더 권한이 있으면 IMAP 이어도 Google 에 넣고, 없으면 403 을 돌려준다(서버 시험은 연결 없음만).

## 결과

- `results/unit.txt`: 서버 시험. 새 `mailCard` 8/8 · `mailCard.integration` 11/11. 회귀(mailReply · filing · mailFlow · mailWork · homeCards · mailPollRace · google · youtube · llm-logprob · lang · en-fix · ontology-mailbody) 모두 통과.
- `results/e2e.txt`: F-MC-01~08 8/8(세 번 되풀이 24/24). 같은 서버에 이어 돈 메일 묶음(F-ML · F-MT · F-HD · F-MW)까지 29/29. 다른 묶음 3개 실패는 기준 커밋에서도 똑같이 실패한다(환경).
- `results/real-model.txt`: 실제 모델(회사 게이트웨이)로 허구 메일 4통의 판정과 일정 읽기, 메일 비서의 `kind`.
- 화면: `results/f-mc-*.png`
  - `01a` 예전 카드: 판정 · 「일정 정보를 읽는 중…」(머리가 이미 「일정 추가」) · `01b` 읽은 양식(답장은 「답장도 쓰기」 아래)
  - `02a` 「오후 브리프」의 칩 「일정 추가 · …」 · `02b` 칩으로 연 같은 양식
  - `03` 시각을 16:30 · 1시간 30분으로 고쳐 넣은 뒤 「기록했어요 · …」(데모 메일함)
  - `04a` Google: 「캘린더에 추가했어요 · …」 · 「캘린더에서 보기」 · `04b` 같은 웨비나의 둘째 메일: 「이미 캘린더에 있어요」
  - `05` Reply 카드는 그대로(머리 「답장」, 초안 바로)
  - `06a` Pay 카드: 「에이전트에게 맡기기」가 큰 단추 · `06b` 「답장도 쓰기」를 누른 뒤
  - `07a` Home · 칩의 「일정 추가 · 납부 · 답장 · 검토」 · `07b` 받은 편지함 › 메일 · `07c` 영어 화면(Add to calendar · Pay · Reply · Review, 양식)
  - `08a`~`08d` 390px: 칩 · 양식 · 「기록했어요」 · 맡기기 카드
