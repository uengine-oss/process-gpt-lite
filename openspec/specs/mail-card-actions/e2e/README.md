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

---

# 답장만이 아닌 할 일 줄 · 메일 멘션 (2026-11-24 「메일에 대해서 무조건 답장만 하지는 않는다 …」)

## 서버 시험

```bash
cd server && node --test test/mailFollow.test.js                                   # 모델 · DB 없이
cd server && node --test --test-concurrency=1 test/mailFollow.integration.test.js   # 실제 DB · git · Express 라우트, 가짜 모델 · deepagents · Gmail
```

- `mailFollow.test.js`(9): `chooseSome`(첫 글자 확률 문턱 · 개수 · JSON 대체 · 읽지 못함), 가짜 판정 모델로 다음 할 일 고르기(보기 = 카탈로그 − 고정 − 맞지 않는 것 + 「그 밖」, 판정이 읽은 메일 상태), 시트의 줄(고정이 먼저 · 할 일을 말함 · 결과가 남는 곳 · 지도가 읽은 프로세스 · 실행한 일), 끌기 내용(`mailItem` · `validItem` · 놓는 곳의 말 · 서버 `normItem`), 메일 멘션 권한 상태(주인 · 공유받음 · 요약 · 요청함 · 없어짐)와 메시지에 남는 모양(본문 없음), 에이전트가 읽는 메일 맥락(보낸 사람 · 받는 사람 · 받은 때 · 제목 · 첨부 · 스레드 링크 · 이어진 일 · 본문 자르기), Home 카드의 한 줄, 영어 화면의 줄(스킬의 labelEn · saysEn).
- `mailFollow.integration.test.js`(5): 할 일 줄(판정 모델이 고른 것이 카드에 남고 다시 묻지 않음 · 판정 모델이 꺼지면 고정만 · 남의 카드 403) · 「이 회사 알아보기」(에이전트 요청의 메일 맥락 · Lite 가 아는 것 · 메인 채팅의 새 대화와 `context_threads` · 카드의 자리 · 두 번 눌러도 한 번) · 인스턴스에 이어진 메일(인스턴스 대화 · 작업 폴더의 `조사/01_…md` · 다음 단계가 읽음 · 메인 채팅은 그대로) · AI 채팅에 놓은 메일(`runTurn` → 에이전트 요청에 메일 맥락, 남의 메일은 칩에 까닭) · 메신저의 메일 멘션(요약만 → 본문 보기 요청 → 주인이 공유 → 본문, 방 밖 404, 공유를 그만두면 다시 403, 방에 남는 것에 본문 없음).

## 화면 시험 (Playwright, `e2e/tests/feature/mail-follow-up.spec.js`)

```bash
# 서버: 가짜 모델(이 스펙이 59981 에 띄움) · 가짜 deepagents(59982) · 지도 엔진 없음 · 백그라운드 일 없음
cd server && PRO_PORT=8869 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59981/v1 PRO_LLM_API_KEY=test PRO_LLM_MODEL=fake-judge PRO_LLM_FAST_MODEL=fake-judge \
  PRO_ONTOLOGY_BOLT_URL= PRO_DEEPAGENTS_URL=http://127.0.0.1:59982 PRO_CONTEXT_ROUTER_URL= PRO_MEMENTO_URL=http://127.0.0.1:9 PRO_COMPLETION_URL=http://127.0.0.1:9 PRO_JUDGE_URL= \
  PRO_GOOGLE_GMAIL_URL=http://127.0.0.1:59983/gmail/v1 PRO_GOOGLE_CALENDAR_URL=http://127.0.0.1:59983/calendar/v3 \
  PRO_SCENARIOS=off PRO_FOLDERS_ROOT=/tmp/e2e-pgpt-folders node index.js
PRO_API_TARGET=http://127.0.0.1:8869 npx vite --port 5269 --strictPort
cd e2e && PGPT_URL=http://localhost:5269 API_URL=http://127.0.0.1:8869 RT_WORKERS=1 RT_FAKE_LLM_PORT=59981 RT_FAKE_AGENT_PORT=59982 RT_FAKE_GOOGLE_PORT=59983 \
  npx playwright test tests/feature/mail-follow-up.spec.js --project=feature
```

- 같은 서버에 `mail-card-calendar` · `mail-reply` · `mail-thread-flow` · `messenger-file-mention` 을 이어 돌릴 때는 같은 `RT_FAKE_LLM_PORT` · `RT_FAKE_AGENT_PORT` · `RT_FAKE_GOOGLE_PORT` 를 준다(그 묶음들이 같은 포트에 자기 가짜를 띄운다).
- 가짜 판정 모델은 「다음에 할 일은」 질문에 「회의 잡기」 0.5 · 「제안서 초안」 0.3 을 준다. 가짜 deepagents 는 「회사를 알아봐 주세요」 요청에 1.5초 뒤 「# haneul-data.example 알아보기 …」로 답한다(「하는 중…」을 보려고). 메일함은 데모 메일함이다(보내지 않음).
- 끌기는 Playwright 의 DataTransfer 끌기 이벤트로 시험한다(`dragstart` 는 끄는 것에, `dragenter` · `dragover` · `drop` 은 놓는 곳에).
- 사람 · 회사 · 메일은 지어낸 것이다(한지우 · 서민재, 하늘데이터 윤서진, `haneul-data.example`).

| 스펙 시나리오 | 시험 |
|---|---|
| 답장 시트의 줄 | F-MF-01 · 서버 「시트의 할 일 줄 …」 |
| 무엇을 할지 먼저 말한다 | F-MF-01 · F-MF-06 |
| 협업 제안 메일 | F-MF-01 · 단위 「할 일 고르기(가짜 판정 모델)」 · 서버 「시트의 할 일 줄 …」 |
| 판정 모델에 연결할 수 없다 | 서버 「… 판정 모델이 꺼지면 고정만(남기지 않음)」 · 단위 `decideFollow` null |
| 지도가 읽은 프로세스 | 단위 「시트의 줄 …」(‘견적 요청’ 시작) — 화면은 `mail-thread-flow` 의 「새로 시작」과 같은 요청 |
| 회사를 알아본다 | F-MF-02 · 서버 「「이 회사 알아보기」 …」 |
| 인스턴스에 이어진 메일 | 서버 「인스턴스에 이어진 메일 …」 |
| 두 번 누른다 | 서버 「「이 회사 알아보기」 …」(두 번째 요청) |
| 채팅에서 이어 간다 | F-MF-03 · 서버 「AI 채팅에 놓은 메일 …」 |
| Home 카드를 AI 채팅에 끈다 | F-MF-04(카드 · 시트 손잡이) |
| 다른 사람의 메일 | 서버 「AI 채팅에 놓은 메일 …」(404 · 칩에 까닭) |
| 동료는 요약만 본다 | F-MF-05 · 서버 「메신저의 메일 멘션 …」 · 단위 「메신저의 메일 멘션 권한 …」 |
| 요청과 공유 | F-MF-05 · 서버 「메신저의 메일 멘션 …」 |
| 동료에게 공유 | F-MF-07 |
| 휴대폰의 답장 시트 | F-MF-06(밝은 · 밤) |

시험하지 않은 것:
- 실제 모델 · 실제 deepagents 로 회사를 알아보는 것(웹 검색 · 브라우저가 실제로 무엇을 찾는지). 시험은 가짜 deepagents 가 받은 요청의 모양(메일 맥락 · Lite 가 아는 것 · 대화 id)과 답이 남는 자리를 확인한다.
- 에이전트가 프롬프트의 「메일을 보내거나 일정을 만들지 마세요」를 지키는지. 서버가 막는 것은 시트의 「보내기」 밖의 보내기 경로가 아니라 지시다 — 회사 메일 도구를 가진 에이전트가 이를 어기면 보낼 수 있다(2026-11-23 사고와 같은 위험, 「에이전트에게 맡기기」도 같음).
- 실제 Gmail 의 스레드 링크를 누르는 것(링크 모양만 단위 시험).
- 사람이 마우스로 하는 실제 끌기(시트가 흐려지고 아래가 놓기를 받는 것은 `.veil.passing` 으로만 확인). 휴대폰에는 끌기가 없다.
- 영어 화면의 할 일 줄(서버는 `labelEn` · `saysEn` 을 주고 화면 낱말은 사전에 넣었지만, 영어 화면 스크린숏은 찍지 않았다).

## 결과

- `results/mail-follow-unit.txt`: 새 `mailFollow` 9/9 · `mailFollow.integration` 5/5, 회귀 17개 파일 모두 통과(`fileMention.test.js` 의 「모르는 종류」 예가 `mail` 이던 것을 다른 이름으로 바꿈).
- `results/mail-follow-e2e.txt`: F-MF-01~07 8/8(두 번 되풀이 16/16). 회귀: mail-reply 7/7 · mail-thread-flow 7/7 · messenger-file-mention 12/12 · chat-thread-list 10/10 · chat-artifacts 8/8 · chat-agent-picker 7/7 · mail-card-calendar 7/8(F-MC-06 은 밤 테마 때문에 기준 커밋에서도 똑같이 실패).
- 화면: `results/f-mf-*.png`
  - `01a` 답장 시트 — 원문 아래 「이 메일로」 줄, 그 아래 답장 · `01b` 「이 회사 알아보기」가 할 일을 말함 · `01c` 답장을 보낸 뒤(줄은 그대로)
  - `02a` 「이 회사 알아보기 · 하는 중…」 · `02b` 「회사 알아본 결과 · 열기」 · `02c` Home 카드의 같은 줄 · `02d` 그 메일의 대화(요청 · 메일 칩 · 답)
  - `03a` 채팅 입력창의 메일 칩 · `03b` 에이전트의 답과 보낸 말의 메일 칩
  - `04a` Home 카드를 끄는 동안 「AI에게 이 메일로 묻기」 · `04b` 시트 손잡이를 끄는 동안 흐려진 시트
  - `05a` 메신저 위 「여기에 놓으면 메일을 멘션해요」 · `05b` 메일 칩(「본문도 공유」 꺼짐) · `05c` 동료의 요약 카드 · `05d` 공유된 뒤 본문
  - `06a` · `06b` 390px 밝은 · 밤 테마 — 한 줄의 할 일(옆으로 넘김)과 할 일의 말
  - `07a` 「동료에게 공유」 — 대화를 기다리는 메일 · `07b` 대화를 고른 뒤 메일 칩

---

# 내가 보낸 메일 (2026-11-26 「이 메일은 내가 보낸건데 왜 내가 받은걸로 뜨는건가.」)

## 서버 시험

```bash
cd server && node --test test/mailSelf.test.js                                     # DB · Google 없이, Gmail 모양의 고정물
cd server && node --test --test-concurrency=1 test/mailSelf.integration.test.js    # 실제 DB, 가짜 모델 · Gmail, 지도 · 마이닝 · 초안의 시작은 대역
cd server && MO_BFF_PORT=8965 node test/mail-own-sent.e2e.mjs                      # 실제 서버 · 실제 DB, 가짜 Google(동의 · 메일함 · 스레드 · send-as) · 가짜 메일 비서
```

- `mailSelf.test.js`(7): 보낸 사람 주소와 받는 사람 목록 읽기(표시 이름 · 인코딩된 이름 · 꺾쇠 · 대소문자, 이름 안의 쉼표, 주소가 아닌 값), 사용자가 보낸 메일 구분하기(SENT 라벨 · 회사 주소에서 고객에게 보낸 메일의 사본 · 숨은 참조 사본 · 별칭으로 보낸 메일, 표시 이름만 같고 주소가 다르면 다른 사람의 메일), 자신에게만 간 메일(자신에게 쓴 메모 · 보낸 사람을 바꾸는 전달 규칙 · 받는 사람이 없는 메일은 받은 메일로, SENT 라벨이 있으면 사용자의 메일로 판단), 별칭으로만 일치하는 메일(그룹이 「… via 다온 영업」으로 다시 쓴 고객 글의 Reply-To · X-Original-Sender, 동료가 공용 주소로 보낸 메일은 다른 사람의 메일), send-as 주소(기본 주소는 사용자 자신의 주소로, 확인된 주소 중 별칭으로 다루는 주소만 별칭으로 판단, 그룹 · 확인 대기 주소는 제외, 사람과 메일함별로 한 시간 동안 기억, 거절 · 연결 끊김 시 빈 목록, 시간 제한), 스레드(원래 보낸 사람이나 해당 메일의 Reply-To 주소로 나중에 보낸 메일이 있으면 이미 답한 메일로 판단, 참조에 넣은 경우 포함, 동료에게만 전달 · 초안 · 예약 발송 · 스팸 · 휴지통 · 상대가 그보다 나중에 보낸 메일 · 읽지 못한 스레드는 제외, 도착 시각 순서, 스레드마다 한 번 · From · To · Cc 메타데이터만 · 연결의 토큰 · 시간 제한), 답장 카드 식별.
- `mailSelf.integration.test.js`(1): 견적서를 요청한 메일 세 통 가운데 이미 답한 메일은 메일 비서에게 `answered: true`로 전달되며 답장 카드가 없다. 동료에게 전달만 한 메일과 새 메일은 답장 카드가 남는다. 프로세스 마이닝은 세 통을 모두 읽고, 회사 프로세스 지도도 카드가 없는 이미 답한 메일을 읽는다. 초안 단계에서는 이미 답한 메일만 「이미 답함」으로 전달받는다.
- `mail-own-sent.e2e.mjs`(2): Lite 주소와 다른 Google 계정을 「휴대폰에서 연결」로 연결한 뒤 메일함을 읽는다. 회사 주소에서 고객에게 보낸 메일의 사본과 별칭으로 고객에게 보낸 메일에는 카드가 없고, 메일 비서도 이를 읽지 않는다. 이 메일들은 읽은 메일로 남고 보관함에 들어간다. 이미 답한 메일은 메일 비서에게 `answered: true`로 전달되며, 「Reply」 카드는 없고 「Review」 카드는 남는다. 해당 메일에서 요청한 견적서의 초안은 회신 카드(`drafts`)가 아니라 「파트너상사 견적서 초안 검토」 카드(`kind: task`, `drafted`)에 생성된다. 자신에게 쓴 메모, 그룹이 「오하늘 via 다온 영업」으로 다시 쓴 고객 글, 동료가 별칭으로 다루지 않는 그룹 주소(help@)로 보낸 메일, 이름은 같지만 주소가 다른 메일, 고객 메일은 카드로 생성된다. 브리프의 칩은 메일 비서의 카드만 가리킨다. 다시 읽으면 새 메일은 0통이다. 데모 메일함에서 Lite 주소로 나에게만 온 연습 메일(받는 사람이 나뿐)도 메일 비서가 읽으며 카드로 생성된다.
- 가짜 메일 비서는 받은 메일마다 답장 카드를 만든다. 실제 모델도 누가 사용자인지 모르면 같은 방식으로 동작했다. 따라서 이 시험은 서버가 어떤 메일을 메일 비서에게 전달하는지 확인한다.

## 화면 시험: F-MC-09

위의 `mail-card-calendar.spec.js`와 동일한 서버와 명령으로 실행한다. 가짜 Google(59966)에 메일함 목록 · 메시지 · 스레드 · send-as를 추가하고, 가짜 모델(59967)에 메일 비서를 추가했다. 390px Home에서 사용자가 보낸 메일 두 통(회사 주소에서 고객에게 보낸 메일의 사본 · 별칭으로 고객에게 보낸 메일)과 고객 메일 한 통을 읽으면 「답장 · 오하늘님께 「견적 문의」 회신」 카드 하나만 표시된다.

| 스펙 시나리오 | 시험 |
|---|---|
| 회사 주소에서 보낸 메일의 사본 | F-MC-09 · `mail-own-sent.e2e.mjs` 첫 번째 시험 · 단위 시험 「내 메일 …」 |
| send-as 별칭으로 보낸 메일 | F-MC-09 · `mail-own-sent.e2e.mjs` 첫 번째 시험 · 단위 시험 「내 메일 …」 · 「send-as 주소 …」 |
| 자신에게만 보낸 메일 | `mail-own-sent.e2e.mjs` 두 시험 모두 · 단위 시험 「나에게만 간 메일 …」 |
| 그룹이 다시 쓴 고객 메일 | `mail-own-sent.e2e.mjs` 첫 번째 시험 · 단위 시험 「별칭으로만 맞으면 …」 · 「send-as 주소 …」 |
| 이미 답한 메일 | `mail-own-sent.e2e.mjs` 첫 번째 시험 · `mailSelf.integration.test.js` · 단위 시험 「스레드 …」 |
| 동료에게 전달만 한 메일 | `mailSelf.integration.test.js` · 단위 시험 「스레드 …」 |
| 이미 답한 메일이 문서를 요청한다 | `mailSelf.integration.test.js`(지도 · 마이닝 · 초안 단계) · `mail-own-sent.e2e.mjs` 첫 번째 시험(실제 초안 카드) |
| 이름이 같은 다른 사람 | `mail-own-sent.e2e.mjs` 첫 번째 시험 · 단위 시험 「내 메일 …」 |
| 휴대폰 Home | F-MC-09 |

시험하지 않은 항목:
- 실제 Gmail. 가짜 Gmail은 `-in:sent`를 개별 메일에 적용한다(실제 Gmail의 메일 목록도 같은 방식으로 동작한다고 가정했지만, 실제 계정에서는 확인하지 않았다). SENT 라벨이 붙은 메일이 목록에 포함되는 경우는 단위 시험에서만 확인한다.
- 실제 send-as 응답(Workspace 그룹 주소의 `treatAsAlias`, 외부 별칭의 확인 상태)과 실제 Google 그룹이 다시 쓴 메일의 머리글. 가짜 응답은 Gmail API 문서와 그룹의 DMARC 다시 쓰기 형식을 따랐다.
- 실제 문서 초안의 내용. 시험 서버에는 deepagents가 없어 초안 카드만 확인하고 파일은 만들지 않는다.
- IMAP 메일함. 스레드가 없어 사용자가 이미 답한 메일인지 알 수 없으며, 주소와 받는 사람만 비교한다. 데모 메일함에는 받는 사람이 없어 사용자가 보낸 메일로 판단하는 경우가 없다.
- 사용자가 Lite가 모르는 다른 주소에서 보낸 메일. 표시 이름이 같아도 현재와 같이 카드가 생성된다(의도한 동작이다).

## 결과

- `results/own-sent-unit.txt`: `mailSelf` 7/7 · `mailSelf.integration` 1/1, 메일 관련 서버 시험을 합쳐 18개 파일 146/146. 검토 전 코드(c151932)에서 `mailSelf.integration`은 동료에게 전달한 메일까지 이미 답한 메일로 보아 실패한다.
- `results/own-sent-e2e.txt`: `mail-own-sent.e2e.mjs` 2/2. 검토 전 코드에서는 둘 다 실패하고(자신에게 쓴 메모 · 「via」로 다시 쓴 고객 글 · 그룹 주소까지 사용자의 메일로 숨김), 고치기 전 코드(origin/main)에서는 첫 시험이 실패한다(사용자의 메일 두 통과 이미 답한 메일에도 「Reply」 카드). 둘째 시험은 origin/main에서도 통과한다(자신에게 쓴 메모를 숨기지 않는지 지키는 시험).
- `results/own-sent-playwright.txt`: F-MC-01~09 9/9와 같은 서버에서 이어 실행한 메일 시험 묶음(F-HD · F-ML · F-MT · F-MW) 30/30. 고치기 전 코드에서 F-MC-09는 actions가 3이 되어 실패한다.
- `google-connect.e2e.mjs`(가짜 Google을 함께 쓰는 시험): 10/10.
- 화면: `results/f-mc-09-phone-own-sent.png`(390px Home, 고객 메일 카드 하나)
