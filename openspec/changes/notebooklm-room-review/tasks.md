## 1. 방 규칙 (room-rules)

- [x] 1.1 11-04 방 규칙·NotebookLM 안내를 main으로 옮기고, 저장 위치를 방 안내 메시지(`content.roomRule`)로 바꾼다 — `server/test/room-rules.test.js`(사례 `room-rules-cases.json`, 녹화 문장 포함)
- [x] 1.2 프로젝트 방 메시지는 다른 지름길보다 먼저 방 판정(set_rule · run_rule · other, 0.7)을 받는다 — 정규식 거르개·30자 규칙 없음, 가짜 판정 서버로 `room-rules.test.js`, 실제 모델로 `room-rules.e2e.mjs`
- [x] 1.3 받아 적기 {action, skill}: 스킬은 브라우저 스킬 목록(이름·설명)에서, 이름을 댄 서비스는 할 일에 — `browser-replaces-turn.test.js`
- [x] 1.4 규칙 막대·끄기·다른 사람 — e2e `room-rules.spec.js` F-RR-01~04, `notebooklm-review-chat.spec.js` F-NB-06

- [x] 1.5 사이트 지식을 `skills/notebooklm/SKILL.md`로 옮기고 `browserSkills.js`(목록·본문 읽기), 브라우저 에이전트의 `read_skill` — `browser-long-work.test.js`, `browser-walls.e2e.mjs`

## 2. 프로젝트 방 (project-room)

- [x] 2.1 새 프로젝트를 바로 만들고 제목은 나중에 — `new-project-fast.test.js`(모델 5초 지연에 응답 26ms)
- [x] 2.2 보내자마자 내 메시지·진행 표시, 실패 시 글 돌려주기 — F-NB-05
- [x] 2.3 바로잡는 말로 시작한 사이트 작업이 앞 턴을 대신하고 이유를 남긴다, 라우터가 대화 기록으로 할 일(앞서 올린 링크)과 스킬을 정한다, 메인 채팅은 판정만 — `browser-replaces-turn.test.js`
- [x] 2.4 소리 파일 플레이어, 저장 형식 `audio/*` — F-NB-04

## 3. 브라우저 작업 (browser-handoff)

- [x] 3.1 `need`·`reason`·`siteName`, 알약·크게 표시한 첫 번째 단추, 카드가 바뀌면 화면이 따라 내려감 — `browserWalls.test.js`, F-NB-01·02
- [x] 3.2 로그인 벽·거절 화면·헛돎 — `browser-walls.e2e.mjs`(9건)
- [x] 3.3 `browser.click`과 물결, 요소 이름 알약, 새 탭 따라가기 — `browser-walls.e2e.mjs`, F-NB-03
- [x] 3.4 프로필 위치·잠금 정리·캐시 상한 — `browser-walls.e2e.mjs`
- [x] 3.5 다운로드 형식·운영 attach_file·답 유실 경쟁 — `browser-walls.e2e.mjs`, `browser-vault.test.js`
- [x] 3.6 회귀: `browser-long-work`·`browser-tasks`·`browser-vault`·`browserHonest`·`takeover.e2e`·`browser-dock.spec.js`

## 4. 휴대폰 문서 보기 (office-mobile)

- [x] 4.1 접힌 리본은 탭 줄도 숨김, 펼친 탭 이름 줄 넘김 — `office-mobile.spec.js` F-OM-01·03·04
- [x] 4.2 PPT 썸네일 접기·폭 맞춤·넘김 단추·가로 화면에서 노트 숨기기 — F-OM-01·02

## 5. 실제 흐름 확인

- [x] 5.1 합친 서버(운영처럼 context-router·판정 서버 없음, 실제 사내 모델)에서 녹화 순서: 내 메시지 16ms, 규칙 4.7~7초, 링크 → 「로그인 필요 · NotebookLM」 3~5초(모델 턴 0)
- [ ] 5.2 운영 배포 뒤: 휴대폰에서 같은 순서 → 「직접 로그인」으로 구글 로그인 → NotebookLM 슬라이드·오디오 → 파일 카드 재생 (사람의 구글 로그인 필요)
