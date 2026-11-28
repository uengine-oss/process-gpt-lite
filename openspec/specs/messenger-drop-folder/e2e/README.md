# 시험과 증거

## 서버 시험 (실제 DB · 실제 git · 로컬 Storage · 판정 모델은 가짜)

```bash
cd server && node --test --test-concurrency=1 test/filing.integration.test.js
```

팀 · 폴더 경로는 실제 Express 라우트(`routes/team.js` · `routes/filing.js`)에 대고 부르고, 로그인만 대역(헤더)으로 한다. 공용 서비스에는 닿지 않는다(deepagents · 라우터 · 메멘토는 닫힌 포트). 판정 모델은 `oddsOf` · `chatJson` 대역으로 보고, 한 시험은 이 시험이 띄운 가짜 모델 서버로 첫 글자 확률 길을 그대로 탄다. 폴더는 시험의 임시 폴더(`PRO_FOLDERS_ROOT`)에 만들고, 시험이 만든 사람 · 대화 · 공유 · 폴더 · Storage 객체는 끝나면 지운다.

## 화면 시험 (Playwright, `e2e/tests/feature/messenger-drop-folder.spec.js`)

```bash
# 서버: 가짜 모델(이 스펙이 RT_FAKE_LLM_PORT 에 띄움) · 백그라운드 일 없음 · 공용 서비스는 닫힌 포트 · 폴더는 임시 폴더에
cd server && PRO_PORT=8841 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59974/v1 PRO_LLM_MODEL=fake-judge PRO_LLM_FAST_MODEL=fake-judge \
  PRO_ONTOLOGY_BOLT_URL= PRO_DEEPAGENTS_URL=http://127.0.0.1:9 PRO_CONTEXT_ROUTER_URL= PRO_MEMENTO_URL=http://127.0.0.1:9 PRO_COMPLETION_URL=http://127.0.0.1:9 \
  PRO_FOLDERS_ROOT=/tmp/e2e-pgpt-folders PRO_SCENARIOS=off node index.js
PRO_API_TARGET=http://127.0.0.1:8841 npx vite --port 5241 --strictPort
cd e2e && PGPT_URL=http://localhost:5241 API_URL=http://127.0.0.1:8841 RT_FAKE_LLM_PORT=59974 RT_WORKERS=1 \
  npx playwright test tests/feature/messenger-drop-folder.spec.js --project=feature
```

같은 가짜 모델 포트를 쓰는 `mail-reply` · `mail-thread-flow` · `mail-work-folder` 와 동시에 돌리지 않는다(`RT_WORKERS=1`). 끌어다 놓기는 Playwright 의 DataTransfer 끌기 이벤트(`dragenter` · `dragover` · `drop`)로, 붙여 넣기는 `ClipboardEvent` 로 시험한다.

| 스펙 시나리오 | 시험 |
|---|---|
| 끌어다 놓아 보낸다 | F-MD-01 · 서버 「메신저에서 컴퓨터의 파일 보내기」(받는 사람이 같은 바이트 · 메인 채팅에 없음 · `.json` 파일) |
| 휴대폰에서 고르거나 붙여 넣는다 | F-MD-04 |
| 너무 큰 파일 | F-MD-05 · 서버 「50MB 를 넘는 파일은 413」(칩의 「50MB 초과」는 화면이 올리기 전에 거름 — 시험하지 않음) |
| 메신저 위에 놓는다 | F-MD-01(대화가 열렸을 때 채팅 놓기 영역 없음) · F-MD-02 |
| 받은 견적서 | F-MD-03 · 서버 「판정 → 정리」(판정 모델이 읽은 것 · 하위 폴더) |
| 맞는 폴더가 없는 문서 | F-MD-03 · 서버 「맞는 폴더가 없으면 새 폴더 이름」 |
| 한 번만 판정한다 | F-MD-03(다시 열어도 판정 모델 호출 0) · 서버 「판정 → 정리」 · 「HTTP」 |
| 권한 대로 정리한다 | F-MD-03 · F-MD-04(다른 폴더 고르기) · 서버 「판정 → 정리」(커밋 작성자 · 메시지 · 바이트) |
| 이미 있는 내용 | 서버 「판정 → 정리」(다른 카드 · 같은 내용 → 커밋 없음 · 같은 이름의 다른 파일은 (2)) |
| 보기 권한 폴더 | F-MD-03 · 서버 「후보」 · 「HTTP」 |
| 후보 · 작업 폴더 · 메일 첨부 | 서버 「후보」 · 「메일의 첨부」(메일 원문은 대역) |
| 채팅의 파일 카드는 정리 제안을 카드의 메뉴에 둔다 — 휴대폰에서 길게 눌러 정리(밝은 · 어두운) | F-CM-02(`context-menu-actions.spec.js`) · F-MD-03(채팅 카드: 점 · 오른쪽 단추 → 「새 폴더를 만들어 정리」) |
| 채팅의 파일 카드는 정리 제안을 카드의 메뉴에 둔다 — PC 「⋯」 · 오른쪽 단추 · 키보드 · 누르면 문서 | F-CM-03(`context-menu-actions.spec.js`) |
| 화면 낭독기 · 키보드 · 그림 미리 보기(PR #126 검토) | F-CM-04(`context-menu-actions.spec.js`) |

시험하지 않은 것:
- 실제 메일함(Gmail · IMAP)의 첨부를 메일 시트에서 정리 — 데모 메일함에는 첨부가 없다. 서버 시험이 메일 원문을 대역으로 넣어 판정 · 정리 · 카드 기록을 본다.
- 워크트리 테이블(`artifact_branches`)이 있는 DB — 로컬 DB 에 없어 공유는 사본 길로 돌았다(받는 사람의 카드는 판정할 때 「메신저로 받은 파일」 대화에 생김). 운영의 브랜치 공유에서는 받는 사람의 작업 대화 카드(`copy_message_id`)를 그대로 쓴다(코드는 같은 길, 실측은 안 함).
- 회사가 켜는 자동 정리(`autoFile`) — 기본은 꺼짐.
- 영어 화면(번역 사전에 새 문구는 넣었다).

## 결과

- `results/unit.txt`: 서버 시험. 새 `filing.integration` 10/10, 회귀(worktree · 폴더 6묶음 · mailReply · mailWork · mailFlow · meetingTeamFixes · capture-fixes-2 · en-fix · ontology-streams · llm-logprob 등) 모두 통과.
- `results/e2e.txt`: F-MD-01~05 5/5(세 번 되풀이 15/15), 같은 서버의 회귀 50 통과 · 3 실패(환경: 로컬 DB 에 워크트리 테이블 없음 F-TS-08, 가짜 모델이라 번역 없음 F-IT-02 · 03) · 3 건너뜀(판단 서버 없음 F-TA).
- 화면: `results/f-md-*.png`
  - `01a` 대화 위의 「여기에 놓으면 보내요」(채팅 놓기 영역 없음) · `01b` 올린 칩과 메시지 · `01c` 보낸 메시지
  - `03a` 받은 파일의 「‘견적서 …/2026’에 정리할까요? (확신 90%)」 · `03b` 「정리했어요 · 열기」 · `03c` 열기 → 폴더에서 그 파일 · `03e` 이력의 「정리: 2026/…」 · `03d` 채팅의 「새 폴더 만들기」
  - `04a` 휴대폰 클립 메뉴 「내 컴퓨터에서」 · `04b` 고른 파일 · 붙여 넣은 파일 칩 · `04c` 받은 쪽의 파일마다 권유 · `04d` 다른 폴더 고르기로 정리
- 화면(2026-11-28 채팅 카드의 메뉴): `results/f-cm-*.png`
  - `02-cards` 카드 아래 줄 없음 · 제안 점 · 처음 한 번 안내 · `02-menu` 길게 누른 메뉴(열기 · 팀원에게 공유 · 「‘견적서’에 정리」 · 다른 폴더 고르기) · `02-new-folder` 「새 폴더를 만들어 정리: 거래처 계약서」 · `02-pick` 다른 폴더 고르기 · `02-filed` 카드 아래 「‘…’에 정리했어요 · 열기」(각 `-light` · `-dark`)
  - `03-card-hover` PC 「⋯」 · `03-card-menu` 오른쪽 단추로 연 메뉴
  - `04-phone-keyboard-card` 휴대폰에서 Tab 으로 닿은 카드의 「⋯」(👥 다음) · `04-phone-picture-menu` 그림 미리 보기를 길게 눌러 연 카드의 메뉴
  - 시험: `cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/context-menu-actions.spec.js` (자기 스택 BFF 8992 · Vite 5392, 가짜 판정 모델)
- 영상 초안(무음): `pgpt-pro/demo/product/messenger-folder-ko/out/messenger-folder-ko-ko.mp4` — 실제 판정 모델(회사 게이트웨이), `NOTES.md` 에 대역과 남긴 데이터.
