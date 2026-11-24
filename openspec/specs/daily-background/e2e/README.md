# 시험과 증거

## 서버 시험

```bash
cd server && node --test --test-concurrency=1 test/background.test.js              # 데이터베이스 · 인터넷 없이
cd server && node --test --test-concurrency=1 test/background.integration.test.js  # 실제 DB(sql/054 를 먼저) · 로컬 가짜 사진 사이트
```

`background.test.js`는 Commons에서 기록해 둔 응답(`server/test/fixtures/background/commons-*.json`)을 읽는다. 기록할 때 사람 이름 · 사용자 페이지 · 메일 주소는 가상의 정보로 바꿨다. Unsplash · Pexels 응답(`unsplash-search.json` · `pexels-search.json`)은 키 없이 각 API 문서의 형식에 맞춰 만든 것이다. 인터넷에는 접속하지 않는다(가짜 `getJson`).
`background.integration.test.js`는 127.0.0.1의 임시 포트에 가짜 Commons · Unsplash를 띄운다. 서버는 `PRO_BG_COMMONS_API` · `PRO_BG_UNSPLASH_API`로 해당 사이트에 요청한다. 시험마다 새 회사(`rt-bg-…`)와 일회용 보관함 키링을 쓴다.

| 스펙 시나리오 | 시험 |
|---|---|
| 소설 무렵 · 자정이 지난 다음 날(절기 계산) | 「24절기: 2026-11-22 소설 …」(한국천문연구원의 2026 · 2027 절기 날짜 12개), 「계절의 때 …」 |
| 초겨울 아침의 안개(주제 순서) · 따뜻한 무드 | 「그날의 주제: 소설 · 초겨울 아침 · 안개 → …」 |
| 사진 사이트가 멈춘 날 · 이번 주의 사진 | 「사이트가 실패하면: …」 |
| 다시 써도 되는 사진만 · 출처 | 「Commons 검색 답 읽기 …」, 「오늘의 사진(POTD) …」, 「라이선스: …」, 「Unsplash · Pexels 답 읽기 …」 |
| 해당 사이트의 CDN에서(고정 호스트만) | 「그림 주소는 그 사이트의 CDN 만 …」 |
| 오늘만 고른 다음 날 · 계속 두기(규칙) | 「선택의 규칙: …」 |
| 다른 호스트의 그림(서버의 재확인) | 「화면이 보낸 사진은 다시 본다 …」 |
| 같은 날 다시 요청하기(회사 + 날짜마다 한 번) | integration 「사이트의 답은 회사 + 날짜마다 한 번 …」 |
| 끄기 | integration 「회사 스위치: …」 |
| 고르고 새로 고침 · 오늘만 · 계속 두기 · 하늘 칸(저장 · 읽기) | integration 「한 사람의 선택: …」 |
| Unsplash 키를 넣은 회사 | integration 「회사의 Unsplash 키: …」 |

## 화면 시험 (Playwright, `e2e/tests/feature/daily-background.spec.js`)

```bash
# 서버: 가짜 Commons 에 묻게(시험에서만 — 게이트웨이 뒤에서는 무시), 백그라운드 일 없음
cd server && PRO_PORT=8887 PRO_BACKGROUND=0 PRO_ONTOLOGY_WORKER=0 PRO_PUBLIC_URL=http://localhost:5287 \
  PRO_BG_COMMONS_API=http://127.0.0.1:59971/w/api.php node index.js
PRO_API_TARGET=http://127.0.0.1:8887 npx vite --port 5287 --strictPort --host 127.0.0.1
cd e2e && PGPT_URL=http://localhost:5287 API_URL=http://127.0.0.1:8887 RT_WORKERS=1 \
  npx playwright test tests/feature/daily-background.spec.js --project=feature
```

가짜 Commons(`127.0.0.1:59971`, `RT_BG_SITE_PORT`)는 시험 파일에서 띄운다. 가상의 사진 열 장과 파노라마 한 장(그날의 사진)은 SVG 풍경이다. 모든 검색에 같은 열 장을 반환하되, 검색어에 따라 순서를 달리한다. 시험은 Playwright 자체 Chromium(`channel: 'chromium'`)으로 실행한다. F-BG-05는 시험 계정 하나에 잠시 관리자 권한을 부여해 회사 스위치를 껐다 켠다. 시험이 끝나면 `pro_background_settings`의 행을 지우고 관리자 표시를 원래대로 되돌린다. 시험 계정의 `pro_profile.background`는 시험마다 비운다.

| 스펙 시나리오 | 시험 |
|---|---|
| 소설 무렵(날짜 · 절기) · 초겨울 아침의 안개(하늘이 첫 칸, 6~10장, 주제 이름, 330px 썸네일 · referrer 없음) | F-BG-01 |
| 고르고 새로 고침 · 다른 기기 · 고른 사진의 출처(패널 · 구석) · srcset(960 · 1280 · 1920) | F-BG-02 |
| 오늘만 고른 다음 날(가짜 시계, 다음 날 9시) · 계속 두기 · 자정이 지난 다음 날(절기) | F-BG-03 |
| 하늘 칸 · 따뜻한 무드 | F-BG-04 |
| 끄기 · 관리자가 아닌 사람(403) · 키는 「저장됨」만 | F-BG-05 |
| 390px 휴대폰 · 데이터 절약 중인 휴대폰 | F-BG-06 |
| 낮 테마의 밝은 사진 · 밤 테마의 밤하늘 사진(가림막) | F-BG-07 |
| 지워진 사진(하늘 · 안내 한 줄 · 다시 누르면 사진) · 움직임 줄이기 | F-BG-08 |
| 데스크톱 앱의 창 끌기(`html.pgl-desktop`: 끌기 띠는 `drag`, 사진은 누름을 받지 않음, 구석 출처 링크는 `no-drag`) | F-BG-09 |
| 다른 호스트의 그림 · 로그인 없음(401) · 이상한 날짜 | F-BG-10 |

## 실제 Wikimedia Commons로 한 번 (2026-11-24, 키 없음)

서버 코드(`candidatesFor`)를 실제 Commons에 연결해 실행한 뒤 사진을 모아 보고 화면에서 골라 봤다(공용 인터넷을 사용하므로 시험 스위트에는 넣지 않음).
그날 낮 · 밤의 후보는 7~9장이었고, 한 번에 1.4~2.1초가 걸렸다(주제마다 한 번씩 동시에 요청한다. 같은 날 다시 요청하면 메모리에서 응답한다).

잘 맞은 질의(「Featured pictures of …」 분류 + 낱말):
- `incategory:"Featured_pictures_of_snow"` — 눈 덮인 숲길 · 능선 · 설원(첫눈 무렵에 잘 맞음)
- `winter incategory:"Featured_pictures_of_fog"` — 「A foggy winter morning」 등 겨울 아침 안개(초겨울 아침)
- `autumn incategory:"Featured_pictures_of_landscapes|…forests|…mountains"` — 단풍 골짜기 · 숲길(늦가을)
- `frost incategory:"…landscapes|…trees|…plants|…fog"` — 서리 내린 들 · 상고대(소설 · 상강)
- `incategory:"Featured_pictures_of_the_Milky_Way"` — 은하수 밤하늘(밤 · 동지)
- `night incategory:"…cityscapes|…skylines"` — 도시 야경(활기 무드)
- `incategory:"Featured_pictures_of_sunsets"` · `…of_sunrises` + 계절 낱말 — 해 질 녘 · 해돋이
- 그날의 사진(`Template:Potd/2026-11-24`): 모로코 타자의 파노라마(30349×8999, CC BY-SA 4.0). POTD 비율(1.25~3.6) 조건으로만 포함되며, 창이 커서 3840px까지 쓴다.

고친 것:
- `Featured pictures of astronomy`에는 별 크기 비교 그림(사진이 아닌 도해)이 섞여 있어 뺐다. 밤하늘은 은하수 분류만 쓴다.
- `Featured pictures of flowers`에는 나비 같은 근접 사진이 섞여 있어, 「꽃 핀 정원」은 정원 · 공원 분류에서만 찾는다.
- CirrusSearch의 `gsrsort=random`은 같은 순서로 결과를 반환했다. 「멋진 풍경 한 장」은 날짜로 정한 쪽(`gsroffset`)에서 고른다.
- 낱말로 찾은 사진이 세 장보다 적으면(예: `spring` + 해돋이) 같은 낱말을 넓은 풍경 분류(landscapes · forests · mountains · lakes)에서 찾는다. 그래도 모자라면 주제 분류만으로 찾는다.
- 작가 칸에 적힌 웹 주소(「작가 이름 ( www.example.org/~name )」 같은 꼴)는 이름에서 제거했다. 작가 칸에 안내 표 전체가 들어 있는 경우(그날의 사진)에는 표 안의 사용자 링크 이름만 쓴다.
- 썸네일은 `thumb.wikimedia.org`에서 온다. Wikimedia는 표준 너비(330 · 500 · 960 · 1280 · 1920 · 3840)만 제공하고, 그 밖의 너비(400 · 1000 · 2560)는 400으로 거절한다.

## 결과

- `results/unit.txt`: 서버 시험(`background` 14/14, integration 4/4)과 서버 전체 회귀 시험
- `results/e2e.txt`: F-BG-01~10 10/10
- 화면: `results/f-bg-*.png`(가짜 Commons의 SVG 풍경)
  - `01` 밤 테마, 하늘이 첫 칸이고 아직 고르지 않음
  - `02a` 고른 뒤: 배경 · 패널의 출처 · 구석의 출처
  - `03a` 「계속 두기」, `03b` 다음 날(가짜 시계)에도 같은 사진
  - `04` 낮 테마 · 「따뜻」 무드(「노을빛」 · 「햇살 드는 숲」이 앞)
  - `05a` 시스템 설정의 「인터넷 배경 사진」 끔, `05b` 끈 뒤 Home(띠 없음 · 하늘 · 날짜와 절기는 그대로)
  - `06` 휴대폰 390px(띠를 옆으로 넘긴 뒤, 패널 안 출처)
  - `07a` 낮 테마의 밝은 사진, `07b` 밤 테마의 밝은 사진, `07c` 밤 테마의 밤하늘, `07d` 낮 테마의 가을 골짜기(가림막과 가독성)
  - `08` 사진을 불러오지 못해 표시된 하늘 · 패널의 안내 한 줄

시험하지 않은 것:
- 실제 Unsplash · Pexels 키로 받은 사진. 키 없이 각 API 문서의 응답 형식으로만 시험했다. Unsplash의 download 알림은 가짜 사이트로 확인했다.
- 실제 데스크톱 앱(Electron) 창에서 끌어 보기. 브라우저에서 `html.pgl-desktop`을 붙이고, 끌기 띠의 `app-region`과 사진이 누름을 받지 않는지만 확인했다.
- 운영 게이트웨이(ProcessGPT) 앞의 CSP. 이 저장소의 index.html · nginx에는 img-src 제한이 없다. 운영에서는 링크 미리보기 카드가 이미 다른 사이트의 그림을 그대로 읽고 있다.
- 영어 화면. 주제 이름은 서버가 영어로 제공하고(`label_en`), 새 화면 문구는 `src/i18n/ko-en.json`에 넣었다. 영어 화면으로 실행해 보지는 않았다.
