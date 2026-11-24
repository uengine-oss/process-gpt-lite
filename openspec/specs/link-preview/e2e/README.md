# 시험과 증거

## 서버 시험 (로컬 가짜 사이트 · 이름 풀이는 대역 · 공용 인터넷에 나가지 않음)

```bash
cd server && node --test --test-concurrency=1 test/linkPreview.test.js              # 데이터베이스 없이
cd server && node --test --test-concurrency=1 test/linkPreview.integration.test.js  # 회사 스위치 — 실제 DB(sql/051 을 먼저)
```

`linkPreview.test.js`는 127.0.0.1 의 임시 포트에 가짜 사이트를 띄운다. 그 한 `host:port`만 허락(`allowHosts`)하고, 다른 이름은 이름 풀이 대역(`lookup`)으로 푼다. 실제 DNS를 부르면 시험이 실패하도록 해 두었다.

| 스펙 시나리오 | 시험 |
|---|---|
| 사설 IP로 풀리는 이름 | 「이름이 사설 IP 로 풀리면 거절 — 공개 IP 와 섞여 있어도 …」 |
| 사내로 넘겨주는 페이지 · 넘겨주기 네 번 | 「넘겨주기: 사설 주소로 가면 거절, 매번 다시 검사 …, 3번까지」 |
| 큰 페이지 | 「본문은 512KB 까지만 읽는다 …」(4MB 를 보내려던 사이트가 2MB 전에 끊김, gzip 폭탄 30MB) |
| 서명 링크 | 「서명 · 토큰이 붙은 링크는 열지 않는다 — 요청 자체가 없다」 |
| HTML이 아닌 링크 | 「HTML 이 아니면 읽지 않는다 · 404 · 5초 …」 |
| 같은 링크 · 한도 | 「캐시: …」, 「한 사람 한도: …」 |
| 관리자가 끈다 | `linkPreview.integration.test.js` (그리고 F-LP-04) |
| 허락한 한 곳만 | 「시험용 허락(PRO_LINK_PREVIEW_ALLOW_HOSTS)은 게이트웨이 뒤(운영)에서는 무시」, F-LP-04 |
| 동영상 링크(YouTube 썸네일) | 「동영상: og:type video.* 는 kind video, YouTube 주소는 페이지를 못 읽어도 썸네일 카드」 |

## 화면 시험 (Playwright, `e2e/tests/feature/link-preview.spec.js`)

```bash
# 서버: 가짜 사이트 한 곳만 허락 · 백그라운드 일 없음 (회귀를 같은 서버에서 돌리려고 가짜 모델 · 지도 엔진 끔 · 임시 폴더도)
cd server && PRO_PORT=8771 PRO_BACKGROUND=0 PRO_LINK_PREVIEW_ALLOW_HOSTS=127.0.0.1:59981 \
  PRO_LLM_BASE_URL=http://127.0.0.1:59998/v1 PRO_ONTOLOGY_BOLT_URL= PRO_FOLDERS_ROOT=/tmp/e2e-lp-folders node index.js
PRO_API_TARGET=http://127.0.0.1:8771 npx vite --port 5171 --strictPort
cd e2e && PGPT_URL=http://localhost:5171 API_URL=http://127.0.0.1:8771 PRO_FOLDERS_ROOT=/tmp/e2e-lp-folders RT_WORKERS=1 \
  npx playwright test tests/feature/link-preview.spec.js --project=feature
```

가짜 사이트(`127.0.0.1:59981`)는 시험 파일이 띄운다. 페이지 다섯 개(기사 · 작은 그림 · 그림 없음 · 동영상 · 네 번째)와 2.5초 늦게 답하는 페이지, 그림(SVG)이 있다. F-LP-04 는 시험 계정 하나를 잠깐 관리자로 만든다. 회사 스위치를 껐다 켜고, 끝나면 `pro_link_preview_settings`의 행을 지우고 관리자 표시를 되돌린다.

| 스펙 시나리오 | 시험 |
|---|---|
| 채팅의 내 말 · 에이전트 답의 동영상 링크 · 코드 안의 링크 · 링크 없는 메시지 · 늦게 오는 페이지 · 열지 않는 링크 | F-LP-01 (밤 · 낮 테마, 새 탭의 `window.opener` 가 null) |
| 팀 메신저 | F-LP-02 |
| 휴대폰 · 링크 네 개 | F-LP-03 (채팅 탭 · 팀 메시지) |
| 관리자가 끈다 · 관리자가 아니다 · 서명 · 사설 주소 | F-LP-04 |
| 링크 네 개 · 코드 안의 링크 · 주소 뒤에 붙여 쓴 한국어 · 이 앱 · 파일 (화면의 규칙, 브라우저 없이) | F-LP-05 |

시험하지 않은 것:
- 실제 공개 사이트(YouTube, 뉴스, 블로그)의 카드. 시험은 공용 인터넷에 나가지 않는다. YouTube 썸네일 주소와 페이지를 읽지 못할 때의 카드는 서버 시험에서 이름 풀이 실패로 확인했다.
- https 페이지. 가짜 사이트는 http 다. https 는 같은 고정 IP 연결에 SNI · 인증서 확인(`servername`)만 더한다.
- 영어 화면. 카드의 글은 페이지의 글이라 번역하지 않고(`data-no-i18n`), 설정의 새 문구 네 개는 `src/i18n/ko-en.json`에 넣었다.

## 결과

- `results/unit.txt`: 서버 시험(`linkPreview` 19/19, 스위치 2/2)과 서버 전체 회귀(986 중 960 통과 · 13 건너뜀 · 13 실패 — 실패는 모두 main 에서도 같음)
- `results/e2e.txt`: F-LP-01~05 5/5, 같은 서버에서 돌린 화면 회귀 69 중 66 통과(실패 3건은 환경 — 파일에 이유)
- 화면: `results/f-lp-*.png`
  - `01a` 밤 테마, 내 말의 기사 카드(넓은 그림이 위) · `01b` 낮 테마 · `01c` 에이전트 답의 동영상 카드(재생 표시), 코드 안 · 서명 링크는 카드 없음
  - `02` 팀 메신저(동료 카드는 왼쪽, 내 카드는 오른쪽)
  - `03a` 휴대폰 채팅 탭(세 개까지: 위 그림 · 왼쪽 그림 · 그림 없음) · `03b` 휴대폰 팀 메시지
  - `04a` 시스템 설정의 「링크 미리보기」 끔 · `04b` 다시 켬
