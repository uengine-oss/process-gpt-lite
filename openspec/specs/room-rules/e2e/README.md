# 시험과 증거 — room-rules · browser-handoff · project-room · office-mobile

실행(개발 서버, 운영처럼 context-router · 판정 서버 없이):

```bash
cd server && node --test --test-concurrency=1 test/room-rules.test.js test/browser-replaces-turn.test.js test/new-project-fast.test.js test/browserWalls.test.js test/browser-long-work.test.js
cd server && node test/browser-walls.e2e.mjs && node test/takeover.e2e.mjs
cd e2e && PGPT_URL=http://localhost:5191 API_URL=http://127.0.0.1:8791 npx playwright test --project=feature tests/feature/notebooklm-review-chat.spec.js tests/feature/room-rules.spec.js tests/feature/browser-dock.spec.js
cd e2e && npx playwright test --project=feature tests/feature/office-mobile.spec.js   # 편집기 서버 :5390 필요
cd server && node test/room-rules.e2e.mjs && node test/browser-walls.live.mjs           # 실제 모델 확인(느림)
```

판정은 단위 · e2e 에서 가짜 판정 서버(`PRO_JUDGE_URL`)로 모델 없이 보고, 실제 사내 모델로는 `room-rules.e2e.mjs` · `browser-walls.live.mjs` 로 따로 본다.

| 스펙 시나리오 | 시험 |
|---|---|
| room-rules: 녹화의 문장 / 규칙이 아닌 말 / 판정을 받지 못한다 | `room-rules.test.js`(가짜 판정), `room-rules.e2e.mjs`(실제 모델: set_rule 0.92~0.95, other 0.95) |
| room-rules: NotebookLM 규칙 / 사이트 일이 아닌 규칙 | `browser-replaces-turn.test.js`, `room-rules.e2e.mjs`(skill notebooklm · 번역은 skill 없음) |
| room-rules: 링크만 붙인다 / 규칙이 있는 방의 다른 말 | `browser-replaces-turn.test.js`, `room-rules.e2e.mjs`(run_rule 0.95 · other 0.72~0.85) |
| room-rules: 규칙을 본다 / 끈다 / 다른 사람 | F-RR-01~04, F-NB-06 |
| room-rules: 사이트 지식은 브라우저 스킬 모듈로 | `browser-long-work.test.js`(본문은 시스템 프롬프트에 없고 read_skill 로만), `browser-walls.e2e.mjs`(스킬 · 스킬 없음) |
| browser-handoff: 녹화의 순서 — NotebookLM 로그인 | `browser-walls.live.mjs`(login_needed 0.95), F-NB-01, 합친 서버 실제 흐름(7.3초 · 모델 턴 0) |
| browser-handoff: NotebookLM 첫 화면 / 평범한 페이지 / 사이트가 거절한다 / 판정을 받지 못한다 | `browser-walls.e2e.mjs`, `browserWalls.test.js` |
| browser-handoff: 아무것도 바뀌지 않는다(헛돎 5턴) | `browser-walls.e2e.mjs` |
| browser-handoff: 누르는 자리 / 새 탭 | `browser-walls.e2e.mjs`(±3px), F-NB-03(물결 ±2px) |
| browser-handoff: 파드가 바뀐다(잠금 파일) | `browser-walls.e2e.mjs` |
| browser-handoff: 오디오를 받는다 | `browser-walls.e2e.mjs`(audio/mpeg) |
| browser-handoff: 실패한 작업 | F-NB-02 |
| project-room: 모델이 느리다 | `new-project-fast.test.js`(모델 5초 지연에 응답 26ms) |
| project-room: 보내자마자 보인다 / 방을 만들지 못했다 | F-NB-05 |
| project-room: 녹화의 순서(바로잡는 말) / 메인 채팅의 다른 요청 | `browser-replaces-turn.test.js`, `room-rules.e2e.mjs`(실제 라우터가 skill notebooklm · 앞서 올린 링크) |
| project-room: 팟캐스트 MP3 | F-NB-04(206 · 재생) |
| office-mobile: 휴대폰 세로로 연다 / 넓은 화면 / 넘겨 본다 / 가로로 돌린다 / 다른 문서 | F-OM-01~04 |

결과(`results/`): 단위 56/56, `browser-walls.e2e.mjs` 15/15. 그 밖의 실행 결과는 PR #4 본문에 있다: `takeover.e2e.mjs` 10/10, Playwright F-NB · F-RR · F-BD · F-MR 20/20, F-OM 4/4.

2026-11-27 프로젝트 계획: 스펙의 새 요건(「계획에 넣는 말은 규칙을 덮어쓰지 않는다」 · 「프로젝트 방의 상시 지시는 습관보다 방 판정이 먼저 읽는다」 · 「규칙을 정할 때 계획과 대화를 읽는다」 · 「규칙 막대는 누가 하는지 보이고 바꾼다」)의 시험과 실제 모델 결과는 `openspec/specs/project-room/e2e/README.md` 「프로젝트 계획」에 있다 — `server/test/projectNote.test.js`(PP-U) · `projectPlan.integration.test.js`(PP-I) · `e2e/tests/feature/project-plan.spec.js`(F-PP). 방 판정의 보기에 `plan` 이 더해져 `browser-replaces-turn.test.js` · `browser-queue-answers.test.js`(BQ-I-09) 의 보기 목록과 F-NB-06 의 막대 글(「· 에이전트가 처리」)을 고쳤다.
