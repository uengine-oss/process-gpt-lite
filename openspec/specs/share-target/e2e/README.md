# 시험과 증거

모델은 쓰지 않는다. 화면 시험은 자체 스택(회사 `share-target-ui`, `lib/localStack.js` — BFF 8974 · Vite 5374부터 빈 포트)을 띄우고, Chromium 에서 실제 서비스 워커(`public/sw.js`)를 돌린다(`serviceWorkers: 'allow'`). Android 가 하는 일, 즉 매니페스트의 `share_target` 주소로 multipart `POST` 를 보내는 내비게이션은 페이지에 만든 폼을 제출해 흉내 내고(F-ST-01 · 02 · 04 · 05 · 09 · 10), 한 번은 `fetch` 로 보내 303 을 따라가며(F-ST-03), 다른 출처의 사이트에서도 보낸다(F-ST-08 — 검토자의 프로브와 같은 폼). 「넣기」 전에는 메신저 · 채팅의 올리기 요청(`/api/team/uploads` · `/api/attachments`)이 하나도 없는지 페이지의 요청을 지켜보고, 「다른 곳에」가 올리기를 멈추는지는 그 요청을 붙잡아 둔 채 취소되는지 본다. 휴대폰은 390×844(배율 2, 터치)이고, Android Chrome 사용자 에이전트를 쓴다. 지어낸 사람은 정하윤 · 김서연 · 박도윤, 단체방은 「시니어그룹」, 폴더는 「영업 자료」이다.

```bash
cd server && node --test test/shareTarget.test.js                                            # U-ST-01~14 → results/unit.txt
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/share-target.spec.js # F-ST-01~15 → results/e2e.txt, 화면 사진
# 웹 이미지 nginx 의 되돌려 보내기(150MB 본문도)와 /lite/ 빌드의 매니페스트 → results/nginx.txt
VITE_BASE_PATH=/lite/ npx vite build --outDir <임시 폴더>
docker run --rm -p 18974:80 -v <임시 폴더>:/usr/share/nginx/html:ro -v $PWD/install/docker/nginx.conf:/etc/nginx/templates/default.conf.template:ro \
  -e LITE_RESOLVER=127.0.0.11 -e LITE_SERVER=127.0.0.1:9 -e LITE_OFFICE_HOST=127.0.0.1:9 -e LITE_KONG=127.0.0.1:9 -e LITE_PUBLIC_ORIGIN=https://uengine.process-gpt.io nginx:1.27-alpine
curl -si -X POST -F title=견적서 http://127.0.0.1:18974/share-target    # 303, Location: chat?share=failed
```

| 스펙 시나리오 | 시험 |
|---|---|
| 게이트웨이 뒤의 수신 주소 | U-ST-08 · `results/nginx.txt`(`/lite/` 빌드의 매니페스트) |
| 홈 화면에 추가한 휴대폰 | — (배포 뒤 실제 휴대폰에서 확인: 아래 「휴대폰에서 확인」) |
| 파일 두 개와 글 | U-ST-09(서비스 워커를 샌드박스에서 실행: POST → 캐시(그냥 바이트) → 303) · F-ST-01(주소에서 `?share=` 사라짐, 꺼낸 뒤 공유 저장소 0개) |
| 서비스 워커가 아직 없다 | `results/nginx.txt`(150MB 본문도 303) · F-ST-06(`?share=failed` 알림) · U-ST-11 |
| 합계 200MB가 넘는다 | U-ST-12(길이를 알리는 본문 · 알리지 않는 본문) · U-ST-14(한도 안의 길이 모르는 본문도 모아 두지 않고 한 번만 흘려 읽음) · F-ST-04(41MB × 5) · F-ST-06(`failed:big`) |
| 다른 사이트가 같은 폼을 보낸다 | F-ST-08 · U-ST-02 · U-ST-09 · `results/probe.txt`(검토자의 프로브를 바뀐 서비스 워커에 돌린 결과: 다른 사이트의 POST 도 받지만 그냥 바이트로 둔다 — 넣고 올리는 것은 앱의 「넣기」 뒤에만) |
| 창이 뜬 직후 누른다 | F-ST-15(뜨자마자 누른 「넣기」는 무시 · 올리기 0건, Tab · Shift+Tab 은 창 안에서만, 0.5초 뒤에는 넣음) |
| 단체방을 열어 둔 채 PDF를 공유한다 (휴대폰) | F-ST-01(밝은 · 밤, 「넣기」 전 올리기 0건, 김서연이 같은 바이트를 받음) · U-ST-04 · 06 |
| 떠난 지 30분이 넘은 곳 | F-ST-09 · U-ST-06 · 07 |
| 넣은 뒤 다른 곳으로 옮긴다 | F-ST-05(메신저 · 채팅 첨부 둘 다 붙잡힌 올리기가 취소됨) |
| 같은 휴대폰에 다른 사람이 로그인한다 / 로그아웃 | F-ST-10 · F-ST-11(게이트웨이 세션 넘겨받기) · U-ST-05 |
| 로그인하지 않은 채 공유한다 | F-ST-13(같은 브라우저의 다른 창에서 로그인한 김서연에게는 묻지 않음, 공유한 창에서 로그인하면 고르기) |
| 공유가 들어올 때 다른 사람의 세션으로 바뀐다 | F-ST-14(묻지 않고, 저장소의 파일도 지움) |
| 쓰던 말이 있는 대화방 | F-ST-03(공유로 창이 다시 열려도 쓰던 말 뒤에, 보내면 지움) · F-ST-10 |
| 보내는 사이 다른 방으로 옮긴다 | F-ST-12(1280px — 보내는 요청을 붙잡아 둔 채 1:1 로 옮김: 1:1 의 쓰던 말 그대로, 단체방은 빈 입력칸 · 저장한 말 없음) |
| 폴더를 열어 두었다 | F-ST-05 · U-ST-06 |
| 열린 곳이 없다 | F-ST-02(밝은 · 밤) · U-ST-07 |
| 기사 링크를 공유한다 | F-ST-03 · U-ST-01 |
| 50MB가 넘는 영상과 메모 / 50MB가 넘는 영상만 | F-ST-04 · U-ST-03 · U-ST-10 |
| Android 설정의 앱 설치 / iPhone | F-ST-06(밝은 · 밤) · `install-nudge.spec.js` F-IN-01~09 |
| (정적 라우팅 · 알림 처리기) | U-ST-13 · `results/probe.txt`(올리기 진행 이벤트 수가 서비스 워커가 있을 때와 없을 때 같음) |
| (영어 화면) | F-ST-07: 묻는 창 · 고르기 · 넣은 뒤의 막대 · 50MB 알림 · 설치 안내에 한글이 남지 않는다 |

`results/`: 시험 출력(`unit.txt`, `e2e.txt`, `nginx.txt`, `probe.txt`)과 화면 사진. `f-st-01a-ask-{light,dark}` 는 묻는 창(「넣기」 전), `f-st-01-room-{light,dark}` 는 「넣기」 뒤 단체방 입력창의 칩과 「… 입력창에 넣었어요」, `f-st-02-chooser-{light,dark}` 는 「어디에 넣을까요?」, `f-st-02-chat-light` 는 채팅 입력창의 첨부와 글, `f-st-03a-ask-text-light` · `f-st-03-text-room-light` 는 글 · 주소(쓰던 말 뒤에), `f-st-04a-ask-oversize-light` · `f-st-04-oversize(-only)-light` 는 50MB 넘는 파일, `f-st-05-folder-{ask,done}-light` 는 폴더에 「넣기」 전후, `f-st-06-install-hint-{light,dark}` 는 설정 › 앱 설치의 안내 한 줄, `f-st-07a-ask-en` · `f-st-07-chooser-en` 은 영어 화면, `f-st-08-cross-site-ask-light` 는 다른 사이트가 보낸 폼의 묻는 창, `f-st-09-idle-chooser-light` 는 30분 넘게 비운 곳이 맨 위에 있는 고르기이다.

## 휴대폰에서 확인 (배포 뒤)
1. Android Chrome 에서 `https://<회사>.process-gpt.io/lite` 를 연다. 이미 홈 화면에 Process GPT 가 있으면 길게 눌러 지운 뒤(또는 「앱 정보 › 제거」) 다시 연다.
2. 메뉴(⋮) › 「앱 설치」 또는 「홈 화면에 추가」로 설치하고, 홈 화면의 아이콘으로 한 번 연다(로그인).
3. Lite 에서 단체방을 하나 열어 둔 채 다른 앱(파일 · 갤러리 · PDF 보기)에서 「공유」를 누르면 목록에 「Process GPT」가 보인다. 누르면 「공유한 파일 1개를 ‘<방>’에 넣을까요?」가 뜨고, 「넣기」를 누르면 그 방 입력창에 파일이 칩으로 들어간다.
4. 지우지 않고 그대로 둔 설치본은 Chrome 이 앱을 새로 받을 때(앱을 연 뒤 하루 안팎) 공유 목록에 나타난다.
