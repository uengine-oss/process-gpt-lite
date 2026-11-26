# 시험과 증거 — 휴대폰 알림: AI의 질문과 대화방 메시지

새 테이블은 없다. 알림은 process-gpt의 `notifications` 테이블에 `ai_ask` 행으로 쌓이고, 구독은 기존 `pro_push_subscriptions`를 쓴다. 규칙(토큰 · 묶기 · 단추)은 화면 없이 단위 시험으로 본다. 서버는 로컬 Supabase에 대고 통합 시험으로 본다(이 시험만의 회사 `push-hitl-it`, deepagents는 흉내 낸 스트림). 화면과 서비스 워커는 Playwright로 실제 Chromium에서 본다. 푸시 서비스는 시험 자신의 가짜(`server/test/fixtures/fakePush.mjs`)다. 서버가 보낸 aes128gcm 본문을 구독의 개인 키로 풀어 읽으며, 실제 기기나 실제 푸시 서비스로는 아무것도 보내지 않는다(브라우저의 `pushManager.subscribe`도 막아 둔다). 모델은 부르지 않는다.

```bash
cd server && node --test test/pushActions.test.js                                            # 단위 8 (PA-U-01~08)
cd server && node --test --test-concurrency=1 test/pushHitl.integration.test.js              # 통합 9 (PH-I-01~09, 로컬 Supabase)
# 화면: 자기 스택(회사 push-hitl-ui, BFF 8973 · Vite 5373부터 빈 포트, PRO_NOTIFY_FEED=1)을 띄우고 지운다
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/push-hitl.spec.js   # F-PH-01~06
```

서비스 워커의 처리기(`public/sw.js`의 `self.__pgl.push` · `click` · `shownInFront`)는 Playwright가 그 워커 안에서 직접 부른다. 가짜 푸시 서비스가 받은 페이로드를 그대로 넘기고, 띄운 알림은 `registration.getNotifications()`로 읽는다. 실제 Android · iOS 기기에서는 시험하지 않았다. 시험 브라우저는 푸시를 구독할 수 없으므로, F-PH-01의 「시험 알림 보내기」 결과 문구는 「기기 1대에 보냈어요. 이 브라우저는 푸시를 받지 못해 직접 띄웠어요.」이다. 구독한 휴대폰에서는 「보냈어요 · 기기 1대」가 뜬다.

| 스펙 시나리오 | 시험 |
|---|---|
| 채팅 에이전트가 정리 형식을 묻는다 | PH-I-01(답에 `ask` · `ai_ask` 행 하나 · 제목 · 본문 · Home 카드 「질문」 · 여는 곳 · 열어도 남음) · PH-I-06(메인 채팅의 질문은 그 대화 `/chat/c/<id>`를 엶) · F-PH-02(Home 카드, 사진 `f-ph-02a-home-card`) |
| 브라우저 작업이 결제 승인을 기다린다 | PH-I-06(제목 「승인이 필요해요」 · 카드 하나에 행 하나 · 답하면 Home 목록에서 빠짐). `lib/browser.js` waitForUser에서 알림을 만들고 끝내는 연결은 실제 사용자로 띄운 브라우저 작업으로는 시험하지 않았다. 기존 브라우저 시험(`browser-queue-answers` · `browser-local` · `browser-walls` 등, 통과 38 · 건너뜀 14는 Electron 없음)은 그대로 통과한다 |
| 채팅에 직접 답한다 | PH-I-05(다음 메시지가 그 대화의 질문 알림을 확인 · 그 뒤의 단추는 409) |
| 「세 줄 요약」 단추로 답한다 | PH-I-03(그 대화에 「세 줄 요약」 한 번 · 「「세 줄 요약」으로 답했어요」) · F-PH-02(실제 BFF와 서비스 워커: 알림 단추 두 개 → 「세 줄 요약」 → 가짜 deepagents가 받은 다음 메시지 · 에이전트의 이어진 답 · Home 카드 사라짐, 사진 `f-ph-02b-answered-chat`) |
| 이미 답한 질문의 알림을 다시 누른다 | F-PH-02(같은 알림의 「표로 정리」 → 답하지 않고 채팅을 엶, 사람의 메시지는 그대로 둘) · PH-I-03(같은 토큰 409) · PH-I-09(그 대화에서 다른 답을 쓰는 중이면 보내지 않고 알림 · Home 카드가 남음, 끝나면 같은 단추로 답함) |
| 결제 승인 알림 | PH-I-06(단추 「열기」 · 「취소」, 토큰은 「취소」만 · `canAnswerCard`는 승인을 거절하고 다른 카드 · 보관함 카드 · 없는 보기도 거절) · PA-U-07 |
| 같은 토큰을 두 번 쓴다 | PH-I-03 · F-PH-02 |
| 다른 사람의 토큰 | PH-I-04(403, 알림 행은 그대로) |
| 위조와 만료 | PA-U-02 · 03 · PH-I-04(보기를 「승인」으로 바꿈 · 서명 바꿈 · 다른 서버 키 · 다른 회사 401, 25시간 전 410, 없는 보기 400) |
| 김서연이 1:1 방에 세 번 보낸다 | F-PH-03(실제 메신저 → process-gpt 트리거 → 피드가 회사를 채움 → 「김서연 · 3」 · 두 줄 · 태그 · 「답장」, 알림 하나) · PH-I-02(「3분기 견적 · 4」, 내가 보낸 행 빠짐) · PH-I-08(이름 없는 단체방은 「박도윤, 김민수 · 2」) · PA-U-04 · 05 |
| 「답장」으로 그 방에 바로 쓴다 | F-PH-03(설정 화면에서 나와 그 방 · 입력창에 커서 · 「지금 볼게요」 입력, 방을 읽으면 그 방의 알림이 사라짐, 사진 `f-ph-03-reply-composer`) |
| 열어 둔 방과 멘션 | F-PH-04(열어 둔 방은 띄우지 않음 · 다른 방은 띄움 · 같은 방의 멘션은 띄움 · 메신저를 닫으면 다시 띄움) · PH-I-02(멘션은 자기 태그) · PA-U-06 |
| 휴대폰에서 알림을 켜고 시험한다 | F-PH-01(390px 밝은 · 밤, 넘침 없음, 「알림 켜기」 → 「알림이 켜져 있어요」 → 「시험 알림 보내기」 → 가짜 푸시 서비스가 받은 「시험 알림이에요」, 사진 `f-ph-01a-ask-*` · `f-ph-01b-on-*`) · F-PH-06(설정 줄 「이 기기의 알림 · 켜짐」, 밤, 사진 `f-ph-06-settings-dark`) · PH-I-07 |
| iPhone의 Safari 탭 | F-PH-05(iPhone Safari UA · 밝은 · 밤: 켜기 단추 없음 · iOS 16.4 · 「홈 화면에 추가」, ✕ 뒤 새로 고쳐도 없음, 사진 `f-ph-05-ios-*`) |
