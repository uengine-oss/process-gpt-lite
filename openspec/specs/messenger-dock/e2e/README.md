# 시험과 증거

서버 코드는 바꾸지 않았다(새 SQL 없음). 바뀐 것은 웹 화면과 데스크톱 앱이 쓰는 CSS다. 규칙은 화면 없이 단위 시험으로 보고, 동작은 Playwright로 실제 화면에서 본다. 문서 패널은 실제 이음오피스 호스트(운영 이미지 `ghcr.io/uengine-oss/process-gpt-lite-office-host:ecea940`, 로컬 컨테이너 :5392)에 띄웠다. 받은 사람 쪽 폴더 추천의 판정 모델은 가짜다.

## 단위 시험 (화면 없이)

```bash
cd server && node --test --test-concurrency=1 test/messengerDock.test.js test/openPlan.test.js
```

- `messengerDock.test.js`(6): 남긴 값 읽기 · 너비 한도, 자리 바꾸기 · 너비(페이지에 남길 폭) · 되돌리기, 1000px 아래 창은 떠 있기(고른 자리는 남음), 배치(오른쪽 · 왼쪽 · 문서 패널 안 · 밖, 넓은 열은 두 칸), 끌어 놓는 자리(세 상자가 겹치지 않음, 여러 창 너비에서 상자 가운데가 그 자리), 저장소가 없거나 막혀도 기본값.
- `openPlan.test.js`(5): 문서는 패널(PDF · 워드 · 엑셀 · PPT · 한글 · 마크다운), 볼 수 없는 형식 · 앱이 없는 설치는 이유와 링크, 주소 없는 카드(작업 공간 사본 · 작업실 · 없음), Drive 링크, 떠 있을 때만 · 열렸을 때만 메신저가 비켜 줌.

## 화면 시험 (Playwright, `e2e/tests/feature/messenger-dock.spec.js`)

```bash
# 이음오피스 호스트(운영 이미지, amd64 를 맥에서 에뮬레이션): 문서 주소 127.0.0.1:54321 을 컨테이너 안에서 맥으로 넘긴다
docker run -d --platform linux/amd64 --name msgdock-office-host -p 5392:5390 \
  -e SUPABASE_JWT_SECRET -e SUPABASE_SERVICE_ROLE_KEY -e SUPABASE_ANON_KEY \
  -e SUPABASE_URL=http://127.0.0.1:54321 -e IEUM_ALLOWED_SOURCES=http://127.0.0.1:54321 \
  --entrypoint sh ghcr.io/uengine-oss/process-gpt-lite-office-host:ecea940 -c \
  "node -e \"const n=require('net');n.createServer(c=>{const s=n.connect(54321,'host.docker.internal');c.pipe(s).pipe(c)}).listen(54321,'127.0.0.1')\" & exec node dist/office-host.mjs"
# 서버: 가짜 판정 모델(시험 파일이 RT_FAKE_LLM_PORT 에 띄움) · 백그라운드 일 없음 · 공용 서비스는 닫힌 포트 · 지도 엔진 끔
cd server && PRO_PORT=8799 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59973/v1 PRO_LLM_MODEL=fake-judge PRO_LLM_FAST_MODEL=fake-judge \
  PRO_ONTOLOGY_BOLT_URL= PRO_DEEPAGENTS_URL=http://127.0.0.1:9 PRO_CONTEXT_ROUTER_URL= PRO_MEMENTO_URL=http://127.0.0.1:9 PRO_COMPLETION_URL=http://127.0.0.1:9 \
  PRO_OFFICE_HOST_URL=http://127.0.0.1:5392 PRO_FOLDERS_ROOT=/tmp/e2e-pgpt-folders PRO_SCENARIOS=off node index.js
PRO_API_TARGET=http://127.0.0.1:8799 PRO_OFFICE_TARGET=http://127.0.0.1:5392 npx vite --port 5197 --strictPort
cd e2e && PGPT_URL=http://localhost:5197 API_URL=http://127.0.0.1:8799 RT_FAKE_LLM_PORT=59973 RT_WORKERS=1 \
  npx playwright test tests/feature/messenger-dock.spec.js --project=feature
```

- 회사 프로세스 지도는 개발 서버의 가짜 응답(`/process-map?mock=1`)으로 띄운다. 그래서 Vite 개발 서버에 대고 돌린다. 지도 엔진은 쓰지 않는다.
- 같은 가짜 모델 포트를 쓰는 `messenger-drop-folder` · `mail-reply` · `mail-thread-flow` · `mail-work-folder` 와 동시에 돌리지 않는다(이 파일은 `mode: 'serial'`).
- 머리 끌기는 Playwright 마우스(`down` · `move` · `up`)로 한다. 너비는 마우스와 ←/→로 바꾼다. 끌어다 놓아 보내기는 DataTransfer 끌기 이벤트로 시험한다.
- 이음오피스 호스트가 없으면 패널에 호스트의 오류 페이지가 보인다. 그래도 패널 · 파일 이름 · 편집기 주소(`/office/pdf/` · `/office/docs/`) 검사는 통과한다.

| 스펙 시나리오 | 시험 |
|---|---|
| 지도에서 내가 보낸 PDF를 연다 | F-MO-01(지도 · 메신저가 닫힘 · 지도 그대로) · `openPlan.test.js` |
| 받은 사람이 폴더 화면에서 연다 | F-MO-01(사본 · 워드 · 받은 편지함 「편집기에서 열기」) |
| 볼 수 없는 형식 | F-MO-07 · `openPlan.test.js` |
| 끌어서 오른쪽에 붙인다 | F-MO-02(세 자리 상자 · 오른쪽 밝아짐 · 페이지 끝 ≤ 메신저 시작) |
| 가운데에 놓는다 | F-MO-02 · `messengerDock.test.js`(zoneAt) |
| 오른쪽에 붙이고 채팅하며 문서를 본다 | F-MO-02(위쪽 막대로 채팅 · 입력 · 문서는 메신저 왼쪽 · Esc 로 안 닫힘 · 닫으면 페이지 전체) |
| 문서 패널에 넣는다 | F-MO-03(패널 안 오른쪽 · 문서는 그 왼쪽 · 페이지 전체 폭 · 닫으면 열로) · `messengerDock.test.js`(layout) |
| 다시 열어도 그대로 | F-MO-04(←/→ 3번 · 마우스로 520px · 저장 값 · 새로 고침) · `messengerDock.test.js`(load · save) |
| 창을 좁힌다 | F-MO-04(900px 떠 있기 · 위치 단추 없음 · 넓히면 왼쪽) · `messengerDock.test.js`(effective) |
| 390px | F-MO-05(남은 자리가 있어도 전체 화면 · 단추 · 손잡이 없음 · 넘치지 않음 · PDF 전체 화면) |
| 붙여 둔 메신저에 놓는다 | F-MO-06 |
| 밤 | F-MO-08 |
| macOS에서 왼쪽에 붙인다 | 데스크톱 앱 실측(아래) |
| 단체방에 초대 | F-MS-03(방에 없는 팀원만 · 찾기 · 시스템 줄 · 머리의 사람 목록 · 열어 둔 김서연의 화면에 바로 · 최도현에게 지난 메시지 · Process GPT 모양의 참여자 · 'team' 알림) · `roomInvite.integration.test.js` MS-I-03 · MS-I-04 |
| 이미 있는 사람 | `roomInvite.integration.test.js` MS-I-02(또 초대 · 둘이 동시에) · MS-I-01(권한: 방 밖 404 · 다른 회사 · 팀원 아님 · 에이전트 403 · 1:1 400) |
| 1:1 대화에서 단체방 만들기 | F-MS-04(「초대」 없음 · 두 사람은 목록에 없음 · 새 단체방 · 1:1 은 둘 그대로) |
| 초대 · 휴대폰 390px 밝은 · 밤 | F-MS-05(머리의 「+」 · 고르는 창이 화면 안 · 시스템 줄 · 넘치지 않음) |

초대(F-MS-03~05)는 자기 스택을 띄우는 `e2e/tests/feature/room-invite.spec.js`(회사 `room-invite`)에 있다.

```bash
cd server && node --test --test-concurrency=1 test/roomInvite.integration.test.js
cd e2e && RT_API_FROM=8975 RT_WEB_FROM=5375 RT_WORKERS=1 npx playwright test --project=feature tests/feature/room-invite.spec.js
```

### 데스크톱 앱 실측 (Electron 45.3.2, macOS, 같은 개발 서버)

`desktop/`를 `_electron`으로 띄우고(설정 파일의 서버 = Vite :5197, `PGL_DESKTOP_EXTERNAL=log`), 다음 결과를 얻었다.
- `html.pgl-desktop pgl-os-darwin`. 오른쪽에 붙인 열(`top` 12px)과 그 머리의 `app-region`은 `no-drag`다(창 이동 띠 높이 68px 안에 있어도 그렇다).
- 대화 머리를 끌어 왼쪽 끝에 놓으면 자리 상자 `left`가 밝아지고 왼쪽 열이 된다. 열의 `top`은 44px로, 신호등 단추(`--pgl-tb-left` 80px) 아래다.
- PDF 칩은 문서 패널에 열렸고 메신저는 그대로 왼쪽에 있었다. zip 칩은 「앱 안에서 열 수 없는 형식이에요.」를 보여 주었고, 「새 창에서 열기」는 시스템 브라우저로 갔다(Storage 주소 기록, 새 창 없음).
- 화면: `results/desktop-left-pdf.png`.
- Playwright의 마우스는 운영체제의 창 이동 판정을 거치지 않는다. 그래서 끌기는 계산된 `app-region` 값으로 확인했다. 손으로 창을 끌어 보는 확인은 하지 않았다.

시험하지 않은 것:
- 내가 보낸 공유의 받은 사람별 「고친 파일」 줄. 로컬 DB에 워크트리 테이블(`artifact_branches`)이 없어 그 줄이 생기지 않는다. 코드는 문서 칩과 같은 길(문서 패널 · 이유 표시)이다.
- 붙인 메신저가 폴더 「열기」와 「이어서 작업」 뒤에도 남는 것(코드 검토만 했다).
- 다른 화면에서 받은 편지함 › 메일 카드를 눌러 메일 시트가 열리는 것(시트를 모든 화면에 두었고, 데모 메일 카드로 시험하지는 않았다).
- Windows · Linux 데스크톱 앱에서 오른쪽 창 단추를 피하는 것(macOS에서만 실측했다).
- 영어 화면(번역 사전에 새 문구는 넣었다).

## 결과

- `results/unit.txt`: 단위 시험 11/11. 데스크톱 앱 `desktop/test` 10/10(이번에 `desktop/`는 바꾸지 않았다).
- `results/e2e.txt`: F-MO-01~08 8/8이다. 세 번 되풀이하면 23/24였다. 실패한 1번은 같은 로컬 DB를 쓰는 다른 실행의 정리가 시험 계정을 팀에서 뺀 때였다(403).
- 같은 서버에서 돌린 회귀: conversations · editors-live · folder-edit-save · folder-open · home-dismiss · mail-reply · mail-thread-flow · messenger-drop-folder · mobile-review-1121 · office-mobile · workroom은 모두 통과했다. meetings F-MT-04 · 07(실제 모델 필요)과 team-sharing F-TS-08(워크트리 테이블 없음)은 실패했고, origin/main 화면에서도 똑같이 실패한다. F-TS-06은 단독으로 돌리면 통과한다. smoke 실패 4개(설정 화면의 영어 · 보관함 키링)도 origin/main에서 똑같이 실패한다.
- 화면: `results/f-mo-*.png`
  - `01a` 지도에서 내가 보낸 PDF가 패널에 열림, `01b` 받은 사람이 폴더 화면에서 연 PDF(사본)
  - `02a` 떠 있는 메신저, `02b` 머리를 끄는 동안의 세 자리(오른쪽 밝아짐), `02c` 오른쪽 열(폴더 화면), `02d` 오른쪽 열 + 채팅 + 메신저 왼쪽에 열린 PDF
  - `03a` 문서 패널 안의 메신저와 워드 문서
  - `04` 새로 고친 뒤 그대로인 왼쪽 520px 열
  - `05a` 390px 전체 화면 시트(위치 단추 없음), `05b` 휴대폰에서 연 PDF
  - `06a` 붙여 둔 메신저 위의 「여기에 놓으면 보내요」
  - `07` 볼 수 없는 형식의 이유와 「새 창에서 열기」
  - `08a` 밤 테마에서 끄는 동안의 자리 상자, `08b` 밤 테마의 패널 안 메신저와 PDF
  - `desktop-left-pdf` 데스크톱 앱: 신호등 아래 왼쪽 열 + 문서 패널의 PDF
