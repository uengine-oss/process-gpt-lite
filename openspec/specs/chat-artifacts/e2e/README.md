# 시험과 증거

## 순수 규칙 (데이터베이스 · 모델 없이)

```bash
cd server && node --test test/chatArtifacts.test.js
```

`src/artifactScope.js`의 규칙을 시험한다. 화면의 범위(전체 채팅 · 고른 대화 · 프로젝트 방 · 그 밖은 없음), 파일 순서(최근 순, 이름 없는 파일은 뺌), 찾기, 자리(목록 · 띠 · 더미 · 없음 — 채팅 칸 512px + 양옆 40px), 더미의 자리(입력창 옆 · 위, 「멈추기」 알약 위, 휴대폰은 48px), 접은 상태 기억을 다룬다.

| 스펙 시나리오 | 시험 |
|---|---|
| 전체 채팅의 13개 · 고른 대화와 프로젝트 방 | AS-U-01 · AS-U-02 |
| 찾기 | AS-U-03 |
| 1440px 화면 · 1600px 화면, 오른쪽에 붙은 메신저 · 열고 닫기(문서가 열리면 없음) | AS-U-04 |
| 1100px 화면 · 390px 휴대폰(더미의 자리) | AS-U-05 |
| 접고 새로 고침(기억 · 막힌 저장소) | AS-U-06 |

## 화면 시험 (Playwright, `e2e/tests/feature/chat-artifacts.spec.js`)

```bash
cd server && PRO_PORT=8885 PRO_BACKGROUND=0 PRO_ONTOLOGY_WORKER=0 PRO_LOCAL_AGENT_WORKER=0 PRO_PUBLIC_URL=http://localhost:5285 node index.js
PRO_API_TARGET=http://127.0.0.1:8885 npx vite --port 5285 --strictPort
cd e2e && PGPT_URL=http://localhost:5285 API_URL=http://127.0.0.1:8885 RT_WORKERS=1 \
  npx playwright test tests/feature/chat-artifacts.spec.js --project=feature
```

시험 계정은 `pro-rt-as-user` · `pro-rt-as-phone`(@uengine.org)이다. 시험마다 대화 맥락 시험과 같은 채팅을 지어 넣는다(`e2e/lib/chatseed.js` — 「출장 숙소」 파일 3개, 「유튜브 채널」 파일 10개). F-AS-02 는 파일 두 개를 만든 프로젝트 방을 하나 더 만들고, 시험이 끝나면 지운다. 문서를 열면 이음오피스 편집기(`/office/sheets/`)의 틀이 열리는지까지 본다. 편집기 서버가 없는 시험 스택에서는 그 틀 안에 오류 화면이 뜨지만 패널은 열린다. F-AS-05 는 이 브라우저에 「오른쪽에 붙인 메신저(400px)」를 기억시킨 뒤 메신저를 연다. F-AS-06 은 답을 쓰는 중인 상태(「멈추기」)를 화면의 저장소에 직접 만든다.

| 스펙 시나리오 | 시험 |
|---|---|
| 전체 채팅의 13개 · 1440px 화면 · 찾기 | F-AS-01 |
| 고른 대화와 프로젝트 방(루틴 · 새 프로젝트에는 없음) | F-AS-02 |
| 엑셀 · 열고 닫기 · 공유 단추 | F-AS-03 |
| 접고 새로 고침 · 띠의 표로 열기 · 펼치기 | F-AS-04 |
| 1600px 화면, 오른쪽에 붙은 메신저(더미 → Home 을 닫으면 목록, 모서리 시계) | F-AS-05 |
| 1100px 화면(입력창 위 · 「멈추기」 · 여러 줄 입력 · 격자 · 격자에서 열기) · 1280px 에서 입력창 옆 | F-AS-06 |
| 390px 휴대폰(작은 더미 · 부채꼴 · 전체 채팅 · Home 탭에는 없음) | F-AS-07 |
| 밤 테마 | F-AS-08 |

대화 맥락 시험(`e2e/tests/feature/conversations.spec.js`)의 F-CV-03 은 이제 전체 채팅에도 더미(13개)가 있는지 본다. F-CV-04 는 넓은 화면의 목록이 아니라 더미를 시험하도록 980px 화면에서 실행한다.

## 문서 옆의 왼쪽 칸 (`e2e/tests/feature/doc-layout.spec.js`, `server/test/docLayout.test.js`)

시나리오 「2000px 과 1600px 에서 프로젝트의 산출물을 연다」를 시험한다. 처음 보고된 화면은 운영 화면(약 2000px)으로, 프로젝트 목록 위에 채팅이 올라가 있었다. 고치기 전 코드로 F-DL-01 을 돌리면 2000px 에서 채팅(264–776px)과 목록(0–420px)이 겹쳐 실패한다. 순수 규칙(`src/leftColumn.js` — 나란히 · 접힘 · 채팅 위 · 없음, 경계 1972px · 1852px, 붙여 둔 메신저)은 `cd server && node --test test/docLayout.test.js` 로 시험한다(DL-U-01~05).

```bash
cd e2e && PGPT_URL=http://localhost:5283 API_URL=http://127.0.0.1:8883 RT_WORKERS=1 \
  npx playwright test tests/feature/doc-layout.spec.js --project=feature
```

시험 계정은 `pro-rt-dl-project` · `pro-rt-dl-routine` · `pro-rt-dl-chat` · `pro-rt-dl-threads`(@uengine.org)이다. 프로젝트 방 둘(하나에 「분기 매출.xlsx」 카드)과 클래식 루틴 하나(「회귀 강의 개설 · 가온아카데미」)를 지어 넣고, 시험이 끝나면 지운다. 시험마다 1280 · 1440 · 1600 · 2000px 에서 문서를 연다. 그때 문서 패널, 채팅 칸(위쪽 막대 아래부터 바닥까지), 입력창, 왼쪽 칸, 접힌 목록의 단추와 Home 단추 · 탭, 붙여 둔 메신저의 상자가 서로 겹치지 않는지 본다.

| 스펙 시나리오 · 요건 | 시험 |
|---|---|
| 프로젝트: 2000px 은 나란히, 1280 · 1440 · 1600px 은 접힘 + 「≡ 프로젝트」, 닫으면 목록 | F-DL-01 |
| 접힌 목록을 채팅 위에 펼침 · Esc · 바깥 · 단추로 접힘 · 다른 프로젝트를 고르면 접히고 문서는 그대로 · 창을 넓히면 나란히 · 데스크톱 앱에서도 Home 오른쪽 | F-DL-02 |
| 루틴 화면 | F-DL-03 |
| Home(문서를 열면 비킴, 다시 열면 나란히 또는 채팅 위, Esc · Home 단추로 닫힘) | F-DL-04 |
| 대화 목록(같은 규칙, 펼쳐서 대화를 고름, 밤 테마) | F-DL-05 |
| 붙여 둔 메신저: 오른쪽 · 왼쪽 열(2000px), 문서 패널 안(2000px), 오른쪽 1440 · 2600px | F-DL-06 |

화면: `results/f-dl-01-project-<폭>.png`, `f-dl-02a-list-over.png`(펼친 목록) · `f-dl-02b-picked.png`, `f-dl-03-routine-<폭>.png`, `f-dl-04-home-2000.png` · `f-dl-04-home-over-<폭>.png`, `f-dl-05-threads-<폭>.png`(밤 테마), `f-dl-06-messenger-<자리>-<폭>.png`. 결과 기록은 `results/doc-layout.txt`에 있다.

결정:
- 접힌 목록은 왼쪽 가장자리에 띠를 두지 않고 위쪽 막대의 Home 옆 단추로 다시 연다. 띠(64px)를 두면 1280px 에서 채팅이 352px 에서 288px 로 줄고, 오른쪽에 메신저를 붙인 1440px 창에서는 212px 까지 준다. 휴대폰 화면의 ≡(프로젝트 목록) 단추와 같은 모양이다.
- Home 은 접어 둘 단추를 따로 두지 않는다. 둥근 Home 단추가 곧 Home 을 여닫는 단추다. 자리가 없을 때 열면 채팅 위에 펼쳐지고, Esc 를 누르거나 바깥을 누르면 닫힌다.
- 문서 패널의 폭은 CSS(`--craft-side-w`: 창 · 붙여 둔 메신저의 열 · 패널 자리에 따라 바뀜)를 그대로 재서 쓴다. 숨긴 상자(`.doc-probe`)의 너비를 `ResizeObserver`로 잰다. 그래서 JS 에 같은 식을 두 벌 두지 않는다.

시험하지 않은 것:
- ArtCraft 앱을 옆에 연 경우(840px). 순수 규칙(1852px 경계)으로만 시험했다. 시험 스택에 ArtCraft 앱이 없다.
- 실제 이음오피스 편집기 서버로 문서가 그려지는 모습(패널 틀만 확인했다).

## 결과

- `results/unit.txt`: 순수 규칙 6/6
- `results/e2e.txt`: F-AS-01~08 8/8, 대화 맥락 F-CV-01~05 5/5
- 화면(`results/*.png`)
  - `f-as-01a-wide-light.png`: 밝은 테마(낮 하늘), 1440px, 전체 채팅의 목록(나온 대화가 붙음)
  - `f-as-02a-conversation.png` · `f-as-02b-project.png`: 고른 대화 · 프로젝트 방의 목록
  - `f-as-03a-document-open.png`: 문서가 열린 동안(목록 없음)
  - `f-as-04a-rail.png`: 접은 띠
  - `f-as-05a-docked-pile.png` · `f-as-05b-docked-list.png`: 오른쪽에 붙은 메신저와 더미 · 목록
  - `f-as-06a-medium-dark.png` · `f-as-06b-medium-grid.png`: 1100px, 밤 테마, 입력창 위 더미와 펼친 격자
  - `f-as-07a-phone.png` · `f-as-07b-phone-fan.png`: 390px 휴대폰의 작은 더미와 부채꼴
  - `f-as-08-wide-dark.png`: 밤 테마의 넓은 목록(행에 포인터)

결정:
- 목록 행에 「폴더에 정리」(FolderSuggest)는 넣지 않았다. 그 줄은 보이는 순간 판단 모델에게 폴더를 묻기 때문에, 파일이 많은 목록에서는 그 물음이 한꺼번에 나간다. 채팅의 파일 카드에는 그대로 있다. 행에는 「공유」만 있다.
- 문서가 열려 있으면 띠로 접지 않고 감춘다. 페이지 옆 문서 패널이 오른쪽을 차지하므로 띠를 둘 자리가 문서 패널과 겹친다.

시험하지 않은 것:
- 왼쪽에 붙인 메신저, 문서 패널에 붙인 메신저. 둘 다 페이지 폭을 줄이는 같은 길(`pageW`)을 쓰지만 화면으로는 오른쪽만 확인했다.
- 실제 이음오피스 편집기 서버로 문서가 그려지는 모습(시험 스택에는 편집기 서버가 없다).
- 영어 화면. 새 문구는 `src/i18n/ko-en.json`에 넣었다.

## 작업 폴더 · 버전, 한 턴의 많은 파일은 카드 하나 (2026-11-28)

요건 「한 턴의 결과물은 작업 폴더와 버전에」 · 「한 턴의 많은 파일은 카드 하나」 · 「목록은 작업 폴더 · 버전으로 묶고 같은 이름은 폴더로 가른다」의 시험이다.

순수 규칙과 판단(데이터베이스 · 브라우저 없이, 모델은 가짜):

```bash
cd server && node --test test/fileGroups.test.js     # FG-U-01~08 — src/fileGroups.js
cd server && node --test test/workFolder.test.js     # WF-U-01~16 — server/lib/workFolder.js
cd server && node --test test/workFolderDocs.test.js # WD-U-01 — lib/office.js documentsOfRun 의 깊이(시험 폴더의 deepagents 작업 공간)
```

실제 턴(실제 데이터베이스, 가짜 모델 · 가짜 deepagents — fetch 를 바꿔 끼움, 데이터베이스가 없으면 건너뜀):

```bash
cd server && node --test --test-concurrency=1 test/workFolder.integration.test.js   # WF-I-01~07
```

화면(자기 스택: 회사 work-folders-ui 의 BFF + Vite, 8941 · 5341 부터 빈 포트, 가짜 모델 · 가짜 deepagents 는 빈 포트):

```bash
cd e2e && ~/.claude/tools/lite/reclock.sh run work-folders -- npx playwright test --project=feature tests/feature/work-folders.spec.js --workers=1
```

시험 사람은 정하윤 · 한서윤(지어낸 이름)이다. 정하윤의 채팅에 네 턴을 데이터베이스에 바로 넣는다. 첫 턴은 녹화와 같은 모양의 21개 파일(맨 위 5개 + adr/ · curriculum/ · starter/ · starter/css/ · syllabus/, README.md 4개, curriculum.md 2개)이다. 이어서 커리큘럼/v1 의 5개, 커리큘럼/v2 의 6개, 회의메모 3개가 있다. constitution.md · adr/ADR-004.md · 커리큘럼/v2/README.md 는 올려 둔 사본의 주소가 있어 이음오피스로 열린다. 나머지는 작업실로 열린다. 첫 턴의 spec.md 는 검수에서 걸린 편집본이다. 한서윤은 실제 턴(F-WF-05 · F-WF-06)을 보낸다. F-WF-06 에서 가짜 deepagents 는 파일 하나를 이벤트 없이(스크립트가 쓴 것처럼) 하위 폴더 깊이 쓴다. 시험이 끝나면 행 · 올린 파일 · deepagents 작업 공간의 그 회사 폴더를 지운다.

| 스펙 시나리오 | 시험 |
|---|---|
| 새 일은 버전 1 · 「처음부터 다시」는 다음 버전, 앞 버전은 그대로 | WF-I-01 · WF-I-02 · F-WF-05 · WF-U-02 · WF-U-03 |
| 일부만 고치기는 그 자리에서 | WF-I-03 · WF-U-04 |
| 모델이 없거나 가벼운 한 번이면 예전처럼 | WF-I-04 · WF-U-09 |
| 공유 폴더에서 일하는 프로젝트(템플릿의 결과물 폴더) | WF-U-10 |
| 프로세스 폴더처럼 보이는 이름(PR #135 검토 1) | F-WF-06 · WF-I-06 · WF-U-13 |
| 스크립트가 하위 폴더 깊이 쓴 파일(PR #135 검토 2) · 공유 폴더 작업본은 두 단계 그대로(확인 검토 2) | F-WF-06 · WD-U-01 |
| 턴은 판단을 오래 기다리지 않는다 — 메시지가 올 때 계획을 기다리지 않고 바로 묻고(이해한 내용은 계획이 이미 있을 때만), 가벼운 계획이 오면 멈춤, 계획 블록 뒤 1.5초, 늦은 판단은 버림 · 계획 1.5초 · 모델 1 · 2.5초면 줄이 붙음(PR #135 검토 3 · 4 · 5, 확인 검토 1) | WF-I-07 · WF-I-05 · WF-U-11 · WF-U-12 · WF-I-01 · WF-I-04 |
| 템플릿 프로젝트: 모델이 보는 목록도 결과물 폴더 안(확인 검토 3) · 이름-2 … 이름-50 뒤엔 폴더 없음(확인 검토 5) · 질문은 「이 채팅 · 프로젝트의 모든 대화」(확인 검토 6) | WF-U-15 · WF-U-16 · WF-U-12 |
| 작업본 목록은 손으로 걷기(점 폴더 · node_modules 제외, 한도에서 멈춤 — PR #135 검토 6) · 이름 다듬기 · 모델에게는 JSON 이름(검토 9) | WF-U-14 · WF-U-07 · WF-U-08 |
| 21개를 만든 턴은 카드 하나 · 펼치고 접기 · 줄을 누르면 카드처럼 · 검수 표시 · 컴퓨터의 공유 단추(검토 7) | F-WF-01 · FG-U-02~05 |
| 휴대폰 390(밝은 · 어두운) | F-WF-02 |
| PC 1440 의 목록 · 옛 버전은 같은 대화 · 같은 자리의 새 버전 옆에서만 접힘(검토 8) | F-WF-03 · FG-U-08 |
| 휴대폰의 더미 격자(메시지가 바뀌어도 열린 채) | F-WF-04 |

F-WF-04 의 마지막 확인은 고치기 전의 더미로 돌리면 실패한다. 카드의 폴더 정리 제안이 저장되면 서버가 그 메시지를 다시 보내는데, 예전 더미는 그때마다 격자를 접었다.

같은 바꿈으로 기존 시험도 다시 돌렸다(모두 통과). 문서 네 개 이상이 한 턴에 이어 나오는 시험(file-download 의 docx · xlsx · pdf · dxf, 대화 맥락 시험의 영상 1 · 4 · 7 · 10.xlsx)은 이제 카드 하나 안의 줄로 보인다. 줄도 `[data-test="file-card"][data-file]` 과 `button.file` 을 가지므로 같은 선택자로 열린다.
- `e2e/tests/feature/file-download.spec.js` 11/11
- `e2e/tests/feature/context-menu-actions.spec.js` 6/6
- `e2e/tests/feature/chat-artifacts.spec.js` · `conversations.spec.js` 13/13
- (PR #135 확인 검토 뒤) `e2e/tests/feature/plan-guard.spec.js` 6/6 · `file-download.spec.js` 11/11, `server/test/planGuard.test.js` 13/13 · `turnPlan.test.js` 22/22, `turnPlan.integration.test.js` 8/8. (앞 회차에는 TP-I-01 하나가 origin/main 에서도 똑같이 실패했다 — 계획 상태 'asked' ≠ 'done', 이번 회차에서는 통과)

시험하지 않은 것:
- 실제 deepagents 에이전트가 그 한 줄대로 폴더에 쓰는지(가짜 deepagents 는 줄에 적힌 폴더에 쓴다).
- 실제 모델이 「다시 하기」 · 「일부 고치기」 · 「새 일」을 얼마나 맞게 가르는지(판단 정확도). 모델은 시험마다 가짜다.
- 공유 폴더 프로젝트의 실제 턴(작업본 목록을 디스크에서 읽는 길은 단위 시험(WF-U-12 · WF-U-14)에서만 확인했다).
- 휴대폰에서 묶은 카드 아래에 뜨는 「길게 누르면 …」 안내(시험 자료에서는 가장 새 카드가 묶지 않은 회의메모 카드다).
- 작업 폴더 안의 하위 폴더 이름. 에이전트가 하위 폴더 이름을 skills 로 지으면 `/skills/<이름>/` 경로 규칙 때문에 그 아래 파일이 카드가 되지 않는다. 줄은 첫 이름만 정한다.
- 영어 화면. 새 문구(「파일 {0}개 · 폴더 {1}개」 · 「{0}개 더 보기」 · 「모두 펼치기」 · 「모두 접기」 · 「맨 위」)는 `src/i18n/ko-en.json`에 넣었다.
