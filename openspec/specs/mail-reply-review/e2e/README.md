# 시험과 증거

실행(개발 서버, 휴대폰 390×844). 메일 시험의 서버는 가짜 모델로 띄운다 — 시험 파일이 `RT_FAKE_LLM_PORT`(기본 59998)에 가짜 모델을 띄우므로 서버는 `PRO_LLM_BASE_URL=http://127.0.0.1:59998/v1` 로 시작한다. 메일함은 데모 메일함이다(실제 메일 없음).

```bash
cd server && node --test test/mailReply.integration.test.js test/noticeSender.integration.test.js
cd server && PRO_PORT=8795 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59998/v1 node index.js &
PRO_API_TARGET=http://127.0.0.1:8795 npx vite --port 5202 &
cd e2e && PGPT_URL=http://localhost:5202 API_URL=http://127.0.0.1:8795 npx playwright test --project=feature tests/feature/mail-reply.spec.js tests/feature/message-sender.spec.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| Reply 카드를 누른다 / 카드 지시의 주소가 틀렸다 / 다시 연다 | F-ML-01 · `mailReply.integration.test.js` 「카드를 열면 원문…」「초안은 모델이 쓰지만…」 |
| 답장이 할 일이 아닌 메일 카드 | F-ML-03 |
| 메일함에서 사라진 메일 | F-ML-05 |
| 올리지 못한 첨부 | F-ML-06 |
| (요구사항) 고친 초안의 「다시 쓰기」 | F-ML-07 |
| 고쳐서 보낸다 | F-ML-02 · `mailReply.integration.test.js` 「보내기: 같은 스레드에…」 |
| 보내기 권한이 없는 Gmail | `mailReply.integration.test.js` 「보내기 권한이 없는 Gmail 연결…」 |
| (요구사항) 같은 카드로 두 번 보낼 수 없다 · 보내다 실패하면 카드가 남는다 | `mailReply.integration.test.js` 「「보내기」가 거의 동시에 두 번 와도…」「보내다 실패하면…」 |
| 다른 메일의 파일 | `mailReply.integration.test.js` 「남의 파일 · 다른 메일의 파일 · 폴더 밖으로 나가는 경로 · 열 개가 넘는 파일은…」 |
| 이전 화면에서 Reply 카드를 실행한다 | F-ML-04 · `mailReply.integration.test.js` 「답장이 일인 메일 카드…」 |
| 여러 회사에 속한 사람 | `mailReply.integration.test.js` 「메일함 확인은 그 메일함을 연결한 회사에서…」(고치기 전 코드에서 `localhost` 로 실패) |

`results/`: 시험 출력과 휴대폰 화면 사진.
