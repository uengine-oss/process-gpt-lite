# 시험과 증거

실행 조건(개발 서버, 휴대폰 390×844, 브라우저마다 사용자 에이전트 변경). 시험 브라우저는 설치를 제안하지 않으므로, 시험에서 `beforeinstallprompt`를 직접 보내고 `prompt()` 호출 횟수를 센다. 설치한 앱으로 연 화면은 `display-mode: standalone`, iOS의 `navigator.standalone`, 데스크톱 앱의 `<html class="pgl-desktop">`을 흉내 내서 만든다. 모델은 쓰지 않는다.

```bash
cd server && node --test test/installNudge.test.js
cd server && PRO_PORT=8813 PRO_BACKGROUND=0 PRO_ONTOLOGY_WORKER=0 node index.js &
PRO_API_TARGET=http://127.0.0.1:8813 npx vite --port 5233 &
cd e2e && PGPT_URL=http://localhost:5233 API_URL=http://127.0.0.1:8813 RT_SHOT_DIR=$PWD/../openspec/specs/install-nudge/e2e/results \
  npx playwright test --project=feature tests/feature/install-nudge.spec.js
# 배포한 뒤 링크 미리보기 확인(카카오톡이 예전 미리보기를 쥐고 있으면 https://developers.kakao.com/tool/clear/og 에서 지운다)
node scripts/check-link-preview.mjs https://uengine.process-gpt.io/lite/
```

| 스펙 시나리오 | 시험 |
|---|---|
| 홈 화면에 설치한 앱으로 연다 / 데스크톱 앱 | F-IN-05(standalone · iOS 홈 화면 · Android 래퍼 · 데스크톱 앱) · `installNudge.test.js` U-IN-02 |
| Android Chrome에서 링크를 연다 | F-IN-01 · U-IN-03 |
| 설치 창에서 취소한다 | F-IN-02 |
| iPhone Safari로 연다 | F-IN-03(로그인 화면) · F-IN-03b(Home) · U-IN-01 · U-IN-03 |
| 짧은 화면 | F-IN-03(375×548로 줄여 카드와 로고까지 스크롤) |
| 카카오톡에서 링크를 누른다 (Android · iPhone) / 링크로 나갈 수 없는 앱 | F-IN-04 · U-IN-05 |
| 컴퓨터의 Chrome | F-IN-07 · U-IN-04 |
| 「나중에」 / 「다시 보지 않기」 | F-IN-06 · U-IN-04 |
| 설치 제안이 없는 Android Chrome | F-IN-07 |
| 카카오톡에 링크를 붙인다 | F-IN-08(개발 서버의 HTML · 그림 1200×630) · `scripts/check-link-preview.mjs`(배포 뒤) |
| 회사마다 다른 주소 / 게이트웨이가 호스트를 넘기지 않는다 | 웹 이미지의 nginx(`install/docker/nginx.conf`)를 `nginx:1.27-alpine`으로 띄워 `Host` · `X-Forwarded-Host` · `X-Forwarded-Proto`를 바꿔 가며 확인(`results/nginx.txt`) |
| 게이트웨이 뒤의 매니페스트 | `VITE_BASE_PATH=/lite/ npx vite build` 결과의 `manifest.webmanifest`(`results/nginx.txt` 끝) |
| (영어 화면) | F-IN-09: 카드 문구에 한글이 남지 않는다 |

`results/`: 시험 출력(`e2e.txt`, `unit.txt`, `nginx.txt`)과 화면 사진(F-IN-10, 밝은 테마는 낮 하늘, 어두운 테마는 밤하늘) — 로그인 화면(Android Chrome · iPhone Safari · 카카오톡 Android · 카카오톡 iPhone · 인스타그램 iPhone), Home(Android Chrome · iPhone Safari · Mac Chrome 1280×800), 설정 › 앱 설치 시트(iPhone · Android 메뉴 안내).
