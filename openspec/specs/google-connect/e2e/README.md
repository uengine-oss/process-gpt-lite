# 시험과 증거 — google-connect

실행(모델 없이, 127.0.0.1 가짜 Google — `server/test/fixtures/fake-google.mjs`, 엔드포인트는 `PRO_GOOGLE_AUTH_URL` · `_TOKEN_URL` · `_USERINFO_URL` · `_GMAIL_URL`):

```bash
cd server && node --test test/google-connect.test.js test/google.test.js
cd server && node test/google-connect.e2e.mjs            # 설치형(+ 휴대폰 390 화면)
cd server && node test/google-connect-gateway.e2e.mjs    # 운영처럼: PRO_TENANT_FROM_HEADER=1, /lite 를 떼고 X-Tenant-Id 를 붙이는 가짜 게이트웨이
cd server && node --test test/driveSearch.test.js         # Drive 찾기 · 읽기: fetch 를 가짜로 바꾸고 보낸 주소를 본다(Google · DB 없음)
```

e2e 는 끝에서 `process.exit` 를 하므로 성패는 출력의 ✔/✖ 줄로 본다.

| 스펙 시나리오 | 시험 |
|---|---|
| 관리자가 넣는다 / 관리자가 아니다 | `google-connect.e2e.mjs` 「회사 OAuth 클라이언트」, `google-connect.test.js` |
| 다른 회사 | `google-connect-gateway.e2e.mjs` 「운영처럼」, `google-connect.test.js` |
| Client ID 만 바꾼다 | `google-connect.test.js` 「회사 클라이언트」 |
| 휴대폰에서 연결 / 다른 브라우저 · 다른 상태 | `google-connect.e2e.mjs` 「휴대폰에서 연결」 |
| 다른 회사 주소 | `google-connect-gateway.e2e.mjs` 「휴대폰에서 연결」 |
| 저장된 Google 로그인으로 저절로 · 저장된 로그인이 없다 | `google-connect.e2e.mjs` 「보관함 먼저」 두 가지(대본 모델), 사진 `gc-vault-request-390.png` |
| 서버 브라우저에서 동의 | `google-connect.e2e.mjs` 「서버 브라우저에서 연결」, `google-connect-gateway.e2e.mjs` |
| Google 이 거절한다 | `google-connect.e2e.mjs` 「Google 이 서버 브라우저를 거절하면」 |
| Google 이 오류 화면으로 답한다 | `google-connect.e2e.mjs` 「Google 이 오류 화면(400)으로 답하면」, `browserWalls.test.js` 「사이트 오류 화면」, 실제 판정 모델 `results/live-wall-judge.txt` |
| 허용하지 않는다 · 바쁘다 · 시간이 지난다 | `google-connect.e2e.mjs` 「허용하지 않으면」 |
| 설치형 로그인은 그대로 | `google-connect.e2e.mjs` 「설치형 「Google로 계속하기」」 |
| 다른 곳에서 만든 링크 / 이미 로그인한 사람 | `e2e/tests/feature/auth-done.spec.js` F-AD-01~04, `server/test/urlTokens.test.js` BT-A-01 · 02 · 04, `google-connect.test.js` BT-A-03 — `results/auth-done-1127.txt` |
| 서버 브라우저로는 이 앱에 로그인하지 않는다 | `server/test/browserSignInGuard.test.js` BT-E-05 · BT-E-08 — `../../browser-handoff/e2e/results/sign-in-guard-url-mask-1127.txt` |
| 낱말이 이름과 내용에 나뉘어 있어도 찾는다 · 공유 드라이브와 공유받은 파일(찾는 범위) | `driveSearch.test.js` DS-01 |
| 모든 낱말이 든 파일이 없다 | `driveSearch.test.js` DS-02 |
| 아무것도 없다 | `driveSearch.test.js` DS-03 |
| 따옴표가 든 낱말 | `driveSearch.test.js` DS-04 |
| 공유 드라이브와 공유받은 파일(드라이브 · 소유자 · 폴더 이름) | `driveSearch.test.js` DS-05 |
| 슬라이드 파일을 읽는다 | `driveSearch.test.js` DS-06 (시험 안에서 jszip 으로 만든 .pptx) |
| 너무 크거나 글이 없다 | `driveSearch.test.js` DS-07 |
| Google 슬라이드 · 바로 가기 · 긴 글 | `driveSearch.test.js` DS-08 |

결과(`results/`): 단위 8/8, Drive 찾기 · 읽기 8/8(`drive-search.txt`, 실제 Google 에는 묻지 않음), 설치형 e2e 10/10, 게이트웨이 e2e 3/3. 시험에서는 실제 Google 에 로그인하지 않았다. 운영(11-22) 첫 시도에서 Google 이 서버 브라우저에 400 오류 화면을 냈고, 배포 뒤 다시 열자 비밀번호 화면까지 정상으로 열렸다(원인 미확인) — 결정 D-1122-02.
