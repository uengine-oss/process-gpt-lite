# 시험과 증거

사람 · 값은 모두 지어낸 것이다(정하윤 · 김서연 · 박도윤, 010-0000-0000 꼴). 녹화의 실제 인물 · 연락처는 어디에도 쓰지 않는다.

## 서버 시험

```bash
cd server && node --test test/askTeammate.test.js                                    # 모델 · DB 없이 (AT-U-01~10)
cd server && node --test --test-concurrency=1 test/askTeammate.integration.test.js    # 실제 개발 DB · Storage, 가짜 모델 · 가짜 deepagents (AT-I-01~12)
```

- `askTeammate.test.js`(8): 도구 인자(이유 · 항목 1~8 · 줄과 빈칸 표시 · 파일 이름만), 서명한 제안(고친 것 · 지난 것 · 다른 서버의 것 아님, deepagents 가 흘려 보내는 꼴 그대로 읽음, 도구 이름), 요청 글(스킬의 틀 · 그 동료의 언어), 메시지 안 양식(A2UI 검사 통과 · 낸 값 다시 보기 · 하나도 없으면 400 · 「잘 모르겠어요」), 빈칸 채우기(에이전트가 준 줄은 모델 없이 · 나머지는 온전한 줄이 정확히 한 번 · 바뀐 부분에 값이 든 것만 · 모델이 없으면 줄로 채운 것만), 말로 한 답(판정 답 · 모름 · 다른 말, 기준 0.7, 값은 항목의 키만), 대화방에서 보이는 모습(양식은 물어본 사람에게만), 스킬 파일(도구 설명 한 · 영).
- `askTeammate.integration.test.js`(8): 회사를 따로 만들어(개발 DB 의 기본 회사에는 같은 이름의 지난 시험 사람이 있다) 진짜 Express 라우트 · 에이전트 턴(`runTurn` → 가짜 deepagents 가 이 서버의 도구 함수로 `ask_teammate` 를 부르고 결과를 흘려 보냄) 위에서: AT-I-01 전체 흐름(카드 · 휴대폰 알림 · 물어보기 · 두 번 눌러도 한 번 · 메일 원문 없음 · 팀 알림 · 양식은 박도윤에게만 · 양식으로 답 · 두 번째 답 409 · 「답했어요」 · TXT 새 판(versions) · 메일 답장 초안 채움 · 보내지 않음), AT-I-02 대신 답하기 404 · 403 · 물어본 사람의 말은 판정에 안 감, AT-I-03 말로 한 답(인사는 아님 · 값과 덧붙인 말), AT-I-04 아니요, AT-I-05 하루 뒤(한 번만) · 고쳐서 물어보기 · 다시 묻기(앞 요청 거둠) · 직접 채우기(방의 요청 거둠 · 늦은 답 409), AT-I-06 모름(그 말 그대로), AT-I-07 다른 회사 · 자기 자신 · 팀에서 빠진 사람(카드 그대로) · 남의 카드 404, AT-I-08 docx 는 서버가 만든 턴(composed)으로 에이전트에게.
- PR #108 독립 검토 반영: AT-U-09(모델의 고침은 빈칸 하나만 — 다른 줄 · 줄 수 · 값 밖의 글), AT-U-10(값은 한 줄 · HTML 이스케이프 · CSV 따옴표와 수식 첫 글자), AT-I-08(문서는 답만으로 턴 없음 · 「문서에 채우기」를 눌러야 좁힌 턴), AT-I-09(「아니요」 뒤의 답 · 손으로 쓴 요청 · 되살린 요청 — 카드를 열지 않음), AT-I-10(겹친 두 답이 모두 · 고쳐진 메일 초안에 다시 채움 · 보내는 중인 초안은 그대로 · 답은 덧붙임), AT-I-11(이름이 여럿에 맞으면 후보 · 주소는 그 주소만), AT-I-12(제안 하나에 카드 하나 · 「보내는 중」 되돌림).
- 결과: `results/server-askTeammate.txt` · `results/server-askTeammate-integration.txt`.

## 화면 시험 (Playwright, `e2e/tests/feature/ask-teammate.spec.js`)

```bash
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/ask-teammate.spec.js
```

자기 스택(`e2e/lib/localStack.js` — 회사 `askteam-ui`, BFF 8985 · Vite 5385, `PRO_BACKGROUND=0`)을 띄우고 지운다. 가짜 모델 · 가짜 deepagents · 가짜 허브는 시험 파일이 빈 포트에 띄운다. 가짜 deepagents 는 실제 에이전트처럼 그 사람의 토큰으로 이 BFF 의 `/mcp/team` 을 부른다(`tools/call ask_teammate`). F-AT-01 의 턴은 메일 카드의 「에이전트에게 맡기기」(`POST /api/actions/:id/run`)로 시작한다.

| 스펙 시나리오 | 시험 |
|---|---|
| 다른 회사 사람을 물을 사람으로 준다 | F-AT-04 · AT-I-07 |
| 위조한 제안 | F-AT-04 · AT-U-02 |
| 묻기 카드 | F-AT-01 (`f-at-01a-offer.png`) · AT-I-01 |
| 휴대폰과 어두운 테마 | F-AT-02 (`f-at-02a-phone-edit.png`) · F-AT-03 (`f-at-03a-dark-offer.png`) |
| 아니요(직접 채울게요) | F-AT-03 (`f-at-03b-dark-declined.png`) · AT-I-04 |
| 물어보기 | F-AT-01 (`f-at-01b-teammate-form.png`) · AT-I-01 |
| 고쳐서 물어보기 | F-AT-02 (`f-at-02b-phone-request.png`) · AT-I-05 |
| 양식으로 답한다 | F-AT-01 · AT-I-01 |
| 말로 한다 | F-AT-02 (`f-at-02c-phone-answered.png`) · AT-I-03 |
| 대신 답하려는 사람 | F-AT-04 · AT-I-02 |
| 답했어요 | F-AT-01 (`f-at-01c-answered.png`) · AT-I-01 |
| 문서 초안 | F-AT-05 (`f-at-05a-doc-press.png` · `f-at-05b-doc-filled.png`) · AT-I-08 |
| 카드가 보내지 않은 요청 | AT-I-09 |
| 아니요 뒤의 답 · 되살린 요청 | AT-I-09 |
| 모델이 다른 줄까지 고친다 | AT-U-09 |
| 두 답이 거의 같이 온다 | AT-I-10 |
| 하루가 지났다 | AT-I-05 |
| 모른다고 한다 | AT-I-06 |

- 결과: `results/e2e-F-AT.txt`, 화면 사진 `results/f-at-*.png`.
- 실제 모델(판정 · 값 뽑기 · 채우기)과 실제 deepagents 가 이 도구를 고르는지는 아직 재지 않았다(운영 공통 MCP 목록에 `pgpt-team` 이 들어간 뒤).
