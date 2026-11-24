# 시험과 증거

## 서버 시험

```bash
cd server
node --test test/fileMention.test.js                                   # 모델 · DB 없이
node --test --test-concurrency=1 test/fileMention.integration.test.js  # 로컬 Supabase · 실제 git · 가짜 모델
```

- `fileMention.test.js`(10): 끌기 내용 읽기(`src/fileDrag.js` — 우리 것만, 폴더 밖 경로 · 아이디가 아닌 값은 버림, 10개까지), 끌기 종류와 놓는 자리의 말, 카드가 말하는 종류(폴더에서 연 카드 · 프로젝트 폴더의 파일은 링크), 다른 창의 폴더 링크, 서버의 항목 확인, 멘션 카드의 상태(권한 없음 · 요청함 · 열림 · 바뀜 · 지워짐), @AI 가 받은 부탁(가짜 판정 모델 — 자료 · 맡기기 · 답, 확신이 낮으면 답, 판정이 없으면 null), 어느 파일인지(후보의 이름 · 있는 곳 · 키워드, 「없음」 · 낮은 확신이면 못 찾음, 둘을 부탁하면 둘, 후보가 없으면 판정 모델을 부르지 않음), 회의와 같은 일 종류 질문, 「@AI 」 말머리.
- `fileMention.integration.test.js`(7, 내 PC 에이전트로 보낼 때의 사본 주소 포함): 팀 · 폴더 경로는 실제 Express 라우트(`routes/team.js` · `routes/filing.js`)에 대고 로그인만 대역(헤더). 판정 모델은 시험이 띄운 가짜 모델 서버(첫 글자 확률 길 그대로). 링크/공유 판단과 거절의 까닭, 멘션 보내기 → 받는 사람마다 상태 → 권한 요청(알림 · 한 번만) → 구성원이 되면 열림 → 바뀌면 최신 열기(편집자는 그 자리에서 고침), @AI 가 올린 멘션과 못 읽는 사람 알림(못 읽는 폴더의 파일은 판정 모델이 읽은 글에도 없음), 폴더에 넣기(출처를 커밋 메시지에 · 같은 내용 · 보기 권한 403), AI 채팅 문맥(folder_read · 사본 주소 · 거절), 프로젝트 변형의 파일(구성원만 · 반영 뒤 main · 제 폴더엔 409), 받은 파일의 사본(메인 채팅에 안 생김).

## 화면 시험 (Playwright, `e2e/tests/feature/messenger-file-mention.spec.js`, F-FM-01~10)

```bash
# 서버: 가짜 모델(:59961)과 가짜 deepagents(:59962)는 시험 파일이 띄운다 · 백그라운드 일 없음 · 판정 서버 대신 모델 · 폴더는 임시 폴더에
cd server && PRO_PORT=8879 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59961/v1 PRO_LLM_MODEL=fake-judge PRO_LLM_FAST_MODEL=fake-judge PRO_JUDGE_URL= \
  PRO_ONTOLOGY_BOLT_URL= PRO_DEEPAGENTS_URL=http://127.0.0.1:59962 PRO_CONTEXT_ROUTER_URL= PRO_MEMENTO_URL=http://127.0.0.1:9 PRO_COMPLETION_URL=http://127.0.0.1:9 \
  PRO_FOLDERS_ROOT=/tmp/e2e-fm-folders PRO_SCENARIOS=off node index.js
PRO_API_TARGET=http://127.0.0.1:8879 npx vite --port 5279 --strictPort
cd e2e && PGPT_URL=http://localhost:5279 API_URL=http://127.0.0.1:8879 RT_FAKE_LLM_PORT=59961 RT_FAKE_AGENT_PORT=59962 RT_WORKERS=1 \
  npx playwright test tests/feature/messenger-file-mention.spec.js --project=feature
```

같은 가짜 모델 포트를 쓰는 다른 시험(`messenger-drop-folder` · `messenger-dock` · `mail-*`)과 동시에 돌리지 않는다(`RT_WORKERS=1`, 파일 안은 `serial`). 끌기는 Playwright 의 DataTransfer 끌기 이벤트로 시험한다: 끄는 것에 `dragstart`(화면이 `application/x-pgl-file` 을 싣는다), 놓는 곳에 `dragenter` · `dragover` · `drop`. 사람 · 파일 이름은 지어낸 것이다.

| 스펙 시나리오 | 시험 |
|---|---|
| 폴더 파일 여럿을 끈다 | F-FM-01(⌘ 로 고른 두 줄) · 단위 「끌기 내용」 |
| 폴더 옆에 붙인 메신저로 이력서를 멘션한다 | F-FM-01 · 서버 「멘션 보내기」 |
| 채팅의 산출물을 끌어 놓는다 | F-FM-05(파일 카드 · 펼친 더미 · 오른쪽 목록) |
| 컴퓨터의 파일은 그대로 올라간다 | F-FM-02 |
| 폴더 권한이 없는 사람 | F-FM-04 · 서버 「멘션 보내기」(알림 한 번 · 구성원이 되면 열림) |
| 멘션한 뒤 바뀐 파일 | F-FM-04 · 서버 「멘션 보내기」(멘션한 때의 판 · 최신 · 편집자) |
| @ 목록 | F-FM-03 · F-FM-09 |
| 이력서를 붙여 달라고 한다 | F-FM-03 · 서버 「@AI」(못 읽는 폴더의 파일은 후보에도 없음) |
| 맞는 자료가 없다 | 서버 「@AI」 · 단위 「어느 파일인지」 |
| 받은 멘션을 AI 채팅에 놓는다 | F-FM-07(가짜 deepagents 가 받은 본문) · 서버 「AI 채팅에 놓은 파일」 |
| 읽을 수 없는 파일을 놓는다 | F-FM-07 · 서버 「AI 채팅에 놓은 파일」 |
| 받은 파일을 폴더에 넣는다 | F-FM-06 · 서버 「폴더에 놓기」 |
| 채팅의 파일 카드를 프로젝트의 폴더에 넣는다 | F-FM-08 |
| 휴대폰에서 멘션을 연다 | F-FM-09 · F-FM-10(휴대폰 채팅 입력창: 놓은 파일 칩 · 에이전트 고르기 줄 · 보내기/마이크가 겹치지 않음, 밝은 · 밤) |
| 폴더 화면에서 AI 의 답을 받는다 | F-FM-03(폴더 화면 · 새로 고침 없이) |
| 프로젝트 변형의 파일(요건 「메신저 대화에 놓으면…」) | 서버 「프로젝트가 폴더에서 만든 파일」 |

시험하지 않은 것:
- 실제 판정 모델로 「… 이력서 첨부해」를 고르는 정확도 — 가짜 모델이 질문마다 정한 보기를 고른다. 판정 모델이 읽는 질문 · 보기 · 상태는 시험이 확인한다.
- 이음오피스 호스트에서 연 문서의 화면 — 이 스택에는 호스트가 없어 문서 패널과 편집기 주소(`/office/docs/?src=…pgpt-pro/folders/…`)까지 본다.
- 회의 자료 카드에서 끌기(회의는 WebRTC 가 필요), 프로젝트 변형 파일을 화면에서 끌기(서버 시험만), 다른 앱 창에서 끈 폴더 링크(단위 시험만).
- 워크트리 테이블이 있는 DB(운영)의 받은 파일 — 로컬 DB 에는 없어 공유는 사본 길로 돌았다.
- 영어 화면 — 새 문구는 `src/i18n/ko-en.json` 에 넣었다.

## 결과

- `results/unit.txt` · `results/e2e.txt`: 아래 실행 기록.
- 화면: `results/f-fm-*.png`
  - `01a` 폴더 옆에 붙인 메신저 · `01b` 파일 줄을 대화 위로 — 「여기에 놓으면 링크로 멘션해요」 · `01c` 링크 칩 셋 · `01d` 보낸 멘션 · `01e` 받은 사람의 카드 · `01f` 문서 패널에 열림 · `01g` 편집기 없는 형식은 폴더의 그 파일
  - `03a` 「@」 목록의 AI · `03b` AI 칩 · `03c` AI 가 올린 멘션과 권한 알림
  - `04a` 「폴더 권한이 없어요 · 권한 요청」 · `04b` 「권한을 요청했어요」 · `04c` 주인의 공유 창(요청한 사람이 골라짐) · `04d` 「최신 열기」
  - `05a` 채팅 카드를 대화 위로 — 「여기에 놓으면 공유해요」 · `05b` 펼친 더미에서 · `05c` 공유 칩 · `05d` 오른쪽 목록에서
  - `06a` 받은 파일을 폴더 위로 — 「이 폴더에 넣기」 · `06b` 「‘이력서’에 넣었어요 · 열기」 · `06c` 보기 권한 — 「편집 권한이 있어야 …」
  - `07a` 받은 멘션을 채팅 입력창 위로 — 「AI에게 이 파일로 묻기」 · `07b` 입력창의 칩 · `07c` 보낸 말의 칩과 에이전트의 답
  - `08a` 프로젝트의 폴더 막대 위로 · `08b` 넣었어요
  - `09a` 휴대폰의 멘션 카드 · `09b` 「@」 목록 · `09c` AI 칩
  - `10` 휴대폰 채팅 입력창(밝은 · 밤): 놓은 파일 칩, 그 아래 「기본」 에이전트 줄, 보내기 · 마이크(마이크가 늘 끝)
