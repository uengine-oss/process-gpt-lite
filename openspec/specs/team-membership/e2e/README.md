# 시험과 증거

## 서버 시험 (실제 로컬 DB)

```bash
cd server && node --test --test-concurrency=1 test/invite-only.integration.test.js   # IO-I-01~09
cd server && node test/invite-only.e2e.mjs                                            # IO-G-01~10 (게이트웨이 뒤, BFF 9045 · 가짜 completion 9046)
cd server && node test/invite-only-install.e2e.mjs                                    # IO-S-01~05 (설치판, BFF 9045 · 가짜 Google)
```

결과: `unit.txt`. 개발 DB 에는 `server/sql/058_membership_status.sql`(열 하나와 `pro_join_requests`)이 먼저 있어야 한다.

- `invite-only.integration.test.js`는 회원 규칙을 실제 데이터베이스에서 확인한다. IO-I-01은 `membership_status` 열이 없는 예전 DB를 흉내 낸 임시 스키마를 쓴다. IO-I-02는 Process GPT의 가입 승인 SQL(`server/test/fixtures/pgpt-membership-approval.sql` — vue3 이주 20260908000001 · 20261119000001의 트리거 · 설정 · 신청 테이블을 글자 그대로 옮긴 것)을 한 트랜잭션에 넣고 승인 켬 · 끔 모두 돌린 뒤 되돌린다. IO-I-05 · 06은 두 연결에서 동시에 부른다(첫 사람 둘 · 서로를 내보내는 관리자 둘). IO-I-08은 승인 전 행의 `viewer`가 승인하면 `user`가 되고 `editor`는 그대로인지 본다. IO-I-09는 `authenticated` 역할과 JWT 클레임을 세운 연결로 `pro_shares`를 읽어 정책(SQL 058)을 확인한다(승인된 받는 사람 1행 · 내보낸 받는 사람 0행 · 관계없는 사람 0행). 모두 자기 회사(테넌트)에서 돌고 끝에 지운다.
- `invite-only.e2e.mjs`는 운영처럼 `PRO_TENANT_FROM_HEADER=1`인 서버를 이 프로세스 안에서 띄운다. 요청에는 게이트웨이가 하듯 `X-Tenant-Id`를 붙인다. 가짜 completion은 Process GPT의 `POST /invite-user`(services/completion `invite_user`)처럼 계정과 회사의 `users` 행(역할 `user`)을 만든다. 메일은 보내지 않는다. IO-G-06은 이 회사에만 속한 사람(시험이 다른 회사 행을 지운다)의 방(메신저 API로) · 1:1 대화 · 폴더 · 진행 중인 회의 · 루틴 · 데스크톱 · 열린 이벤트 흐름 · 폴더 git 토큰을 만든 뒤 내보내고 하나씩 확인한다. IO-G-10은 두 회사에서 승인된 사람을 한 회사에서만 내보낸다: 세션은 남고 다른 회사에서는 `GET /api/me`가 200, 이 회사는 403, 이 회사로 연 이벤트 흐름만 닫히고 루틴은 이 회사 것만 멈춘다. 개발 DB의 가입 트리거가 거의 모든 계정에 기본 회사(`process-gpt`) 행을 만들기 때문에, 다른 시험에서 내보낸 사람(IO-G-04 · IO-S-05 · F-IO-06)도 로그인이 남고 이 회사에서 403 `invite_only`를 받는다. IO-G-04는 내보낸 사람을 다시 초대해 결과가 `invited`(`mailed: true`)이고 인증 서버가 메일을 보냈는지(`auth.users` 의 보낸 시각 · `auth.one_time_tokens`) 본다. IO-G-07은 인증 서버가 코드를 보냈는지 `auth.users` 의 보낸 시각과 `auth.one_time_tokens` 로 본다.
- `invite-only-install.e2e.mjs`는 설치판(`PRO_TENANT_FROM_HEADER=0`)의 아무도 운영하지 않는 새 회사에서 돈다. 설치판의 자체 Google 로그인에는 `fixtures/fake-google.mjs`를 쓰고, 진짜 이메일 코드는 인증 서버의 `generateLink`가 주는 일회용 코드를 쓴다. completion이 없는 설치판처럼 초대는 Lite의 경로를 탄다. IO-S-01은 첫 사람 둘의 Google 로그인을 동시에 보낸다.

## 화면 시험 (Playwright, `e2e/tests/feature/invite-only.spec.js`)

```bash
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/invite-only.spec.js   # 결과: e2e.txt, 사진: results/
```

시험은 자기 스택(lib/localStack.js — 회사 `invite-ui`, 게이트웨이 뒤처럼 `PRO_TENANT_FROM_HEADER=1`, BFF 9045 · Vite 5445부터 빈 포트, 가짜 completion 9046)을 띄우고 끝에 지운다. 로컬 Supabase(54321 · 54322)를 쓰고, 모델은 부르지 않는다. Process GPT의 Google 로그인에서 돌아오는 길은 인증 서버가 만든 세션으로 `/auth/done#access_token=…`을 여는 것으로 흉내 낸다. Process GPT에 로그인해 둔 브라우저는 `access_token` · `refresh_token` 쿠키로 흉내 낸다.

| 스펙 시나리오 | 시험 |
|---|---|
| 기다리는 사람 · 다른 회사의 사람 | IO-G-01 · IO-S-05 |
| 에이전트의 길(에이전트 작업 파일 · MCP) | IO-G-09 |
| 요청한 회사가 토큰의 회사보다 앞선다(MCP 의 `X-Tenant-Id`) | IO-G-09 |
| 공유를 데이터베이스에서 바로 읽는다(`pro_shares` 정책) | IO-I-09 |
| 열이 없는 예전 데이터베이스 | IO-I-01 |
| 백그라운드 작업은 승인된 구성원에게만, 아무 행도 쓰지 않음 | IO-I-07 |
| Process GPT의 Google로 온 초대받지 않은 사람(세션 끝남 · 아직 요청 없음 · 새로 고쳐도 밖) | IO-G-02 · F-IO-01 |
| 가입 요청을 보낸다(단추를 눌러야 남음 · 행 없음 · 승인 켬/끔 같음) | IO-G-02 · IO-S-03 · IO-I-02 · F-IO-01 · F-IO-08 |
| Process GPT에 로그인해 둔 채 Lite를 연 내보낸 사람 | IO-G-02 · F-IO-02 |
| 계정이 없는 새 주소의 이메일 코드(같은 대답 · 계정 없음) | IO-G-03 · IO-S-02 · F-IO-03 |
| 게이트웨이 뒤, 계정은 있지만 구성원이 아닌 주소(코드 없음) · 설치판(인증 서버의 대답과 상관없이 같은 대답) | IO-G-07 · IO-S-03 |
| 요청의 한도(1분에 한 번 · 주소마다 하루 3개 · 회사에 지난 한 시간의 대기 요청 수, 거절하면 빠짐 · 다른 회사의 표 · 위조) | IO-G-08 |
| 설치판 자체 Google 로그인의 거절(세션 전, 열쇠는 한 번) | IO-S-02 · IO-S-05 · `google-connect.e2e.mjs` 1번 |
| Process GPT의 승인 트리거와 함께: 요청 · 승인 · 초대 행 · 거절 · 내보내기 · 주인 · 첫 관리자 · 승인 끔 | IO-I-02 |
| 아무도 운영하지 않는 회사의 첫 사람(둘이 동시에 오면 한 사람) · 그다음 사람 | IO-S-01 · IO-I-05 · IO-S-02 |
| 로컬 데모 코드(설치판은 예전처럼, 게이트웨이 뒤는 구성원만) | IO-S-04 · IO-G-03 |
| 초대한 사람이 들어온다(completion · 없으면 Lite 의 경로) | IO-G-04 · IO-S-05 · F-IO-04 |
| 가입 요청을 승인한다 · 거절한다(Process GPT 의 행 · Lite 의 요청) | IO-G-04 · F-IO-05 |
| 승인의 역할(비었거나 승인 전 `viewer` → `user`, 그 밖은 그대로) · 관리자 판단이 어디서나 같음 | IO-I-02 · IO-I-04 · IO-I-08 |
| 내보낸 사람을 다시 초대한다(`invited` · 메일 · `user`) | IO-G-04 |
| 관리자 둘이 서로를 내보낸다 · 나 자신 · 회사를 만든 사람 · 마지막 관리자 | IO-I-06 · IO-G-04 |
| 관리자가 아닌 사람과 다른 회사 | IO-G-04 · IO-G-05 |
| 이 회사에만 속한 사람을 내보낸다(세션 · 갱신 토큰 끝남, 열어 둔 화면은 로그인 화면, 다시 로그인하면 단추 없는 거절 화면) | IO-G-06 |
| 다른 회사에도 속한 사람을 내보낸다(로그인 남음 · 다른 회사는 그대로 · 이 회사는 단추 없는 거절 화면 · 흐름 · 루틴은 이 회사 것만) | IO-G-10 · IO-G-04 · IO-S-05 · F-IO-06 |
| 남은 길(데스크톱 · 방 · 대화 · 폴더 · 진행 중인 회의 · 루틴 · 이벤트 흐름 · 폴더 git 토큰) | IO-G-06 · IO-G-10 |
| 방에 남은 비구성원 | IO-G-06 |
| 휴대폰 390px 밝은 · 밤, 영어 화면 | F-IO-07 · F-IO-08 |

사진(`results/`): 거절 화면(요청 전 · 보낸 뒤 · 이메일 코드 · 내보낸 뒤 · 390 밝은 · 밤 · 영어 · 「가입 요청 보내기」 390 밝은 · 밤), 팀·역할의 초대 결과 · 가입 요청 · 내보내기 확인(1280 · 390 밝은 · 밤).
