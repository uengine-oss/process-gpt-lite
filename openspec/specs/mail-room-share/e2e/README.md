# 시험과 증거

## 서버 시험

```bash
cd server && node --test test/mailRooms.test.js                                   # 모델 · DB 없이
cd server && node --test --test-concurrency=1 test/mailRooms.integration.test.js   # 실제 DB · 실제 Express 라우트, 가짜 모델, 데모 메일함
```

- `mailRooms.test.js`(6): 「앞으로 …」 보기(스레드 · 보낸 사람 · 회사, 메일 서비스 도메인은 회사가 아님, 먼저 보이는 것은 회사), 약속이 들어온 메일을 받는가(같은 스레드 · 주소 대소문자 · 하위 도메인, 비슷한 이름의 다른 회사는 아님), 자동으로 올릴 때의 말, 방 순서와 까닭(스레드 > 보낸 사람 > 회사 > 같이 받은 사람 > 판정, 나는 같이 받은 사람이 아님), 판정이 읽는 것(방 이름 · 사람 · 최근 메시지, 메일은 본문 앞부분만), 내 회사 도메인은 약속에도 까닭에도 아님, 약속의 말(주인에게는 주소까지 · 방에는 이름이나 도메인만, 영어 화면).
- `mailRooms.integration.test.js`(5): 고르기(판정 모델이 고른 방이 먼저 · 다시 열면 묻지 않음 · 대화가 없는 팀원 · 남의 카드 403), 보내기(동료는 요약만 · 알림 · 카드에 남음 · 팀원에게 바로 1:1 · 본문은 켠 방만 · 정할 수 없는 약속 400 · 없는 방 404), 메일이 오면(약속한 회사의 새 메일만 · 약속의 말 · Home 카드가 없는 메일은 끝난 카드로), 끄기(저절로 온 메일에서 약속 끄기 → 다음 메일은 안 감 · 본문 끄기 → 동료 카드가 요약 · 나간 방의 약속은 치움 · 없는 약속 404 · 모르는 끄기 400), 팀원이 아닌 사람 403 · 자기 자신 403 · 올리지 못한 보내기는 켠 공유를 되돌림, 본문까지 정한 약속(본문은 그 방에서만 · 첨부 멘션 없음 · 주소 없음 → 본문 끄기가 약속의 본문도 끔) · 다른 회사 공간의 약속은 쓰지도 지우지도 않음 · 팀에서 빠진 사람 때문에 못 올려도 약속은 남음. 방 이름은 Process GPT 사용자 이름이 아니라 프로필 이름으로 확인한다. 메일 비서의 새 메일 읽기는 실제 `pollUser` 를 지난다(가짜 모델이 할 일 카드를 만든다).
- 결과: `results/server-mailRooms.txt` · `results/server-mailRooms-integration.txt`.

## 화면 시험 (Playwright, `e2e/tests/feature/mail-room-share.spec.js`)

```bash
# 서버: 가짜 모델(이 스펙이 59961 에 띄움) · 지도 엔진 없음 · 백그라운드 일 없음 · 공용 서비스는 닫힌 포트
cd server && PRO_PORT=8796 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59961/v1 PRO_LLM_MODEL=fake-judge PRO_LLM_FAST_MODEL=fake-judge \
  PRO_ONTOLOGY_BOLT_URL= PRO_DEEPAGENTS_URL=http://127.0.0.1:9 PRO_CONTEXT_ROUTER_URL= PRO_MEMENTO_URL=http://127.0.0.1:9 PRO_COMPLETION_URL=http://127.0.0.1:9 PRO_JUDGE_URL= \
  PRO_SCENARIOS=off PRO_FOLDERS_ROOT=/tmp/e2e-pgpt-folders node index.js
PRO_API_TARGET=http://127.0.0.1:8796 npx vite --port 5197 --strictPort
cd e2e && PGPT_URL=http://localhost:5197 API_URL=http://127.0.0.1:8796 RT_WORKERS=1 RT_FAKE_LLM_PORT=59961 \
  npx playwright test tests/feature/mail-room-share.spec.js --project=feature
```

- 가짜 판정 모델은 「…어느 방에 올릴…」 질문에서 이름이 「에이스정밀 납품」으로 시작하는 방을 84% 확신으로 고른다. 메일 비서의 새 메일 읽기에는 시험이 정한 제목의 메일마다 할 일 카드를 만든다.
- 같은 서버에 `mail-follow-up.spec.js` 를 돌릴 때는 그 스펙의 가짜 모델 · 가짜 deepagents 포트(`PRO_LLM_BASE_URL=http://127.0.0.1:59981/v1`, `PRO_DEEPAGENTS_URL=http://127.0.0.1:59982`)로 서버를 다시 띄운다.
- 결과: `results/e2e-F-MR.txt`. 사진의 대화방 목록에서는 이 데이터베이스의 다른 팀원 줄을 가린다(F-MR-01a).

| 스펙 시나리오 | 시험 |
|---|---|
| 휴대폰에서 공유한다 | F-MR-04 |
| 판정 모델이 고른 방이 먼저 | F-MR-01 · 서버 「고르는 화면 …」 · 단위 「방 순서 …」 |
| 남의 카드 | 서버 「고르는 화면 …」(403 둘) · 「보내기 …」(팀원 아님 · 자기 자신) |
| 올리지 못한 보내기 | 서버 「보내기 …」 |
| 본문까지 정한 약속 | 서버 「본문까지 정한 약속 …」 |
| 내 회사의 메일 | 단위 「내 회사 도메인은 …」 |
| 한마디와 함께 올린다 | F-MR-01 · F-MR-02 · 서버 「보내기 …」 |
| 팀원에게 바로, 본문도 | F-MR-04 · 서버 「보내기 …」 |
| 같은 회사의 새 메일 | F-MR-03 · 서버 「메일이 오면 …」 · 단위 「들어온 메일을 약속이 받는가 …」 |
| Home 카드가 없는 메일 | 서버 「메일이 오면 …」 |
| 나간 방 | 서버 「끄기 …」 |
| 저절로 온 메일에서 약속을 끈다 | F-MR-03 · 서버 「끄기 …」 |
| 본문 공유를 끈다 | F-MR-04 · 서버 「끄기 …」 |
| 본문을 펼쳐 둔 동료 | F-MR-05 |

사진(`results/`):
- `f-mr-01a` 고르기 — 판정 모델이 고른 방이 먼저(「추천」 · 까닭) · `f-mr-01b` 한마디 · 「앞으로 오는 메일도」(회사) · 방에 보일 것 · `f-mr-01c` 공유한 대화방과 약속
- `f-mr-02` 동료의 메신저 — 메일 멘션 카드(요약)
- `f-mr-03a` 저절로 올라간 메일의 시트 — 「…이라 저절로 올라갔어요 · 그만 올리기」
- `f-mr-04a~c` 휴대폰 390 · 밤 테마 — 팀원 고르기 · 본문도 공유 · 본문 끄기
