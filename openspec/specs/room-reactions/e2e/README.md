# 시험과 증거 — 대화방 말풍선 반응 (· 단체방 이름, 스펙 `messenger-dock`)

새 테이블은 `pro_chat_reactions`(`server/sql/062_room_reactions.sql`)이다. 공용 개발 DB(로컬 Supabase :54322)에는 2026-11-26에 두 번 실행해 적용했다(여러 번 실행해도 된다). 운영 DB에는 같은 파일을 실행해야 한다. 규칙은 화면 없이 단위 시험으로, 서버는 로컬 Supabase에 대고 통합 시험과 HTTP E2E로, 화면은 Playwright로 실제 브라우저에서 본다. 모델은 부르지 않는다.

```bash
cd server && node --test test/roomReactions.test.js                                              # 단위 6
cd server && node --test --test-concurrency=1 test/roomRenameReactions.integration.test.js        # 통합 6 (로컬 Supabase, 062 적용)
# HTTP E2E: BFF 를 띄우고(모델 · 백그라운드 일 없음) 세 사람으로
cd server && PRO_PORT=8966 PRO_BACKGROUND=0 PRO_TENANT_HOSTS= PRO_TENANT_ID=room-react PRO_LLM_BASE_URL=http://127.0.0.1:9/v1 node index.js
cd server && API_URL=http://127.0.0.1:8966 node test/room-rename-reactions.e2e.mjs               # 5단계
# 화면: 자기 스택(회사 room-react-ui, 8966 · 5366부터 빈 포트)을 띄우고 지운다
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/room-rename-reactions.spec.js   # F-RX-01~06
```

휴대폰의 길게 누르기는 CDP 터치(`Input.dispatchTouchEvent` touchStart → 0.7초 → touchEnd)로 낸다. 메시지 메뉴(`feat/message-actions`)의 시험과 같은 방법이다. 실제 iOS · Android 기기로는 시험하지 않았다.

| 스펙 시나리오 | 시험 |
|---|---|
| 데스크톱에서 마우스를 올려 👍 | F-RX-03(단추는 포인터를 올렸을 때만 보임 · 여섯 가지 순서 · 막대가 닫힘 · 「👍 1」 내 것) · RX-U-04 |
| 오른쪽 클릭으로 하나 더 | F-RX-03(👍 눌린 상태 · 「👍 1」 「✅ 1」 순서) · RX-U-01 |
| 휴대폰에서 길게 누르기 | F-RX-04(막대 · 「복사」가 화면 안 · ❤️ 칩) |
| 내 말풍선 | F-RX-03(단추 없음 · 오른쪽 클릭에도 막대 없음 · 행 없음) · RX-U-02 · RX-I-05 · HTTP 5 |
| 칩을 다시 누르면 떨어진다 | F-RX-03(「👍 2」 → 「👍 1」, 내 것 표시가 사라짐) · RX-U-03 · RX-I-04 · HTTP 4 |
| 내 말풍선에서 누가 했는지 | F-RX-03(「좋아요」 · 「정하윤, 박도윤」, 눌러도 「👍 2」) |
| 휴대폰에서 칩을 길게 누른다 | F-RX-04(누가 했는지가 화면 안 · 수는 그대로) |
| 열어 둔 화면에 바로 | F-RX-03 · F-RX-04(상대의 데스크톱) · RX-I-04(방 사람마다 각자의 「내 것」) · HTTP 4 · RX-U-06(고쳐져 다시 온 메시지에도 반응이 남음) |
| 받은 사람의 Home | F-RX-03(김서연의 알림에 그 방이 없음) · RX-I-05(알림 행 수 그대로) · HTTP 4(알림 · 읽지 않은 수) |
| 방 밖의 팀원 | RX-I-06(화면 키 · 방 밖 0행 · 다른 회사로 요청하면 0행 · 쓰기 거절) · RX-I-05 · HTTP 5(404) |
| 밤 테마 휴대폰 | F-RX-04 b(밤) · F-RX-06(영어) |

## 결과 (2026-11-26)

- 단위 `roomReactions.test.js` 6/6 · 통합 `roomRenameReactions.integration.test.js` 6/6 · `roomInvite.integration.test.js` 4/4(같은 `messenger.js`를 고쳤으므로 함께 돌림) · HTTP `room-rename-reactions.e2e.mjs` 5/5 · Playwright F-RX-01~06 6/6.
- 서버 시험 전체(`node --test test/*.test.js`): 1588개 중 1526 통과 · 59 건너뜀 · 3 실패. 실패한 3개(`process-run-fixes.test.js`의 「에이전트 연결: 일시 실패는 …」, `review.test.js`의 `mcp/craft.js` 초기화 순서 오류, `scheduleTenant.integration.test.js`)는 origin/main(c36279c)에서도 똑같이 실패한다.
- 메신저를 쓰는 다른 화면 시험: `room-invite.spec.js` 4/4 · `chat-media-preview.spec.js` 11/11 · `profile-picture.spec.js` 13/13(다른 파일과 함께 돌렸을 때 F-AV-05 「깨진 사진은 이름 첫 글자」가 한 번 실패했으나, 혼자 다시 돌리면 이 브랜치와 origin/main 모두 13/13) · `team-sharing.spec.js` 7/8(F-TS-08은 로컬 DB에 `artifact_branches` 테이블이 없어 시험 자신의 쿼리에서 실패하며, origin/main의 같은 파일도 같은 오류로 실패한다).

## 화면 (`results/`)

| 파일 | 무엇 |
|---|---|
| `f-rx-03a-hover-bar.png` | 1280px: 김서연의 말풍선 옆 반응 단추 → 막대(여섯 가지 · 「복사」), 열린 말풍선에 테두리 |
| `f-rx-03b-chips.png` | 「👍 1」 「✅ 1」 — 내 것은 파란 테두리 |
| `f-rx-03c-teammate-who.png` | 김서연의 화면: 자기 말풍선의 「👍 2」에 포인터 → 「👍 좋아요 · 정하윤, 박도윤」 |
| `f-rx-03d-toggled-off.png` | 정하윤이 👍를 뗀 뒤 「👍 1」(박도윤 것) · 「✅ 1」(내 것) |
| `f-rx-04a1-phone-bar-light.png` · `f-rx-04b1-phone-bar-dark.png` | 390px 밝은 · 밤: 길게 누른 말풍선 아래의 막대와 「복사」 |
| `f-rx-04a2-phone-who-light.png` · `f-rx-04b2-phone-who-dark.png` | 390px: 칩을 길게 눌러 누가 했는지(「❤️ 사랑해 · 박도윤, 정하윤」) |
| `f-rx-06a-english-bar.png` · `f-rx-06b-english-who.png` | 영어 화면: Like · Got it · Love · Haha · Wow · Thanks · Copy, 「Thanks · 박도윤」, 시스템 줄 「… renamed the conversation to “Quote review”」 |

단체방 이름의 화면(`f-rx-01*` · `f-rx-02` · `f-rx-05*`)은 `openspec/specs/messenger-dock/e2e/results/`에 있다.
