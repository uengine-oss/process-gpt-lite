# 시험과 증거

규칙(그림 · 소리 · 영상인지, 파일을 어떻게 여는지, 서명 주소)은 화면 없이 단위 시험으로 본다. 동작은 Playwright로 실제 화면에서 본다. 서버는 공유 파일 주소(`/api/team/shares/:id/raw`)가 저장소에서 구간 요청(Range)으로 흘려 보내도록 바뀌었고, 로그인 헤더 대신 15분짜리 서명(`u` · `exp` · `inline` · `sig`)도 받는다. 서명이 맞아도 접근 범위(받은 사람 · 보낸 사람, 팀원)는 그대로 다시 본다. 새 SQL은 없다.

## 단위 시험 (화면 없이)

```bash
cd server && node --test test/openPlan.test.js test/mediaLink.test.js test/tiff.test.js
```

- `mediaLink.test.js`(5): 서명한 주소는 그 사람 · 그 공유 · inline 그대로일 때만 맞음(15~20분, 5분 단위라 한동안 같은 주소), 바꾼 서명 · 만료 · 공유 · 사람 · inline · 회사 · 키는 bad, 만료는 서명이 맞을 때만 expired, 너무 먼 만료 · 모양이 틀린 값은 bad, 키는 비밀에서 끌어냄(비밀 자체가 아님) · 주소에 토큰 없음.
- `tiff.test.js`(9): TIFF 가 그림인지(형식 먼저 · 이름 · 주소, 메일 첨부 · 폴더 · 바이트 알아보기), `src/tiffCore.js` 와 `server/lib/tiffCore.js` 가 같은 파일, 디렉터리 걷기(2쪽 G4 · G3 · LZW 컬러의 쪽 수 · 크기 · 204 × 98 dpi 를 두 배 높이로, 깨진 · 5만 × 5만 · 고리 · 값 40억 개 · 쪽 수 상한 · BigTIFF · TIFF 아님은 해독 전에 까닭 코드로 거절), 쪽 해독(검은 점 비율 · 썸네일 240 × 318 · 컬러 픽셀), 서버 변환(PNG 2장 · 회색조 · RGB · Deflate · 앞 쪽만 · 픽셀 상한 · 끝나지 않는 LZW 는 1.5초에 작업자를 멈추고 서버는 계속 답함), PNG 쓰기, 에이전트에게 넘기는 말(이 업로드의 쪽 그림만 — 남의 · 다른 업로드의 · 공개 주소 · 폴더를 벗어나는 경로는 버림), 작업 공간의 같은 폴더 · 0600.
- `openPlan.test.js`(8): 문서는 문서 패널, 볼 수 없는 형식과 편집기가 없는 설치의 PSD · 도면은 이유와 링크, 그림 · 소리 · 영상인지(형식 먼저 · 확장자 · 주소 · TIFF/PSD 아님), 그림 · 소리 · 영상은 보기 화면(편집기는 이름만 · 그 설치에 있을 때만), 「… 로 편집」일 때만 편집기, 주소 없는 카드, Drive 링크, 보기 화면은 메신저를 닫지 않음.

## 화면 시험 (Playwright, `e2e/tests/feature/chat-media-preview.spec.js`)

```bash
cd e2e && npx playwright test --project=feature tests/feature/chat-media-preview.spec.js
```

- 시험 파일이 자기 스택(회사 `chatmedia-ui` 의 BFF + Vite, 8900 · 5300 부터 빈 포트)을 띄우고 끝나면 지운다. 모델 · deepagents · completion · 맥락 라우터는 부르지 않는다.
- 만료된 주소 · 다른 사람으로 맞게 서명한 주소는 시험 프로세스가 서버와 같은 키로 만든다(서버 설정을 읽음 — 키는 어디에도 찍지 않는다).
- PhotoCraft 는 시험용 껍데기다. 시험 파일이 임시 폴더에 `photocraft/index.html`(캔버스 하나, 놓인 파일 이름을 `body[data-dropped]`에 적음)을 만들고 `PRO_CRAFT_WEB_ROOT`로 준다. 그래서 이 설치에는 PhotoCraft 만 있고 SoundCraft · FilmCraft 는 없다. 「PhotoCraft 가 없는 설치」는 `/api/config` 의 `craft` 를 모두 `web: false` 로 바꿔 본다.
- 그림 · m4a · mp4 는 ffmpeg 로 만든 진짜 파일이다. `download.m4a` 는 형식 없이 올려서(운영과 같다) 이름으로 판단되는지 본다. Chrome 채널(AAC · H.264 재생)로 돈다.
- 사람은 지어낸 이름이다(윤태호 · 한지민 · 서민재).

| 스펙 시나리오 | 시험 |
|---|---|
| 이름 없이 받은 소리 | `openPlan.test.js` · F-NB-07 |
| 형식 없이 저장된 m4a | F-MP-01(AUD · 재생 길이) · F-MP-06(`audio/mp4`) |
| 메신저에서 받은 그림 | F-MP-01(미리보기 · 불러와짐 · 240px · 비율 · 테두리) · F-MP-02(보기 화면 · 편집기 아님 · Esc · 바깥 · 메신저 그대로) |
| AI 채팅의 그림 카드 | F-MP-05 |
| 메신저에서 받은 m4a | F-MP-01(재생 막대 · 길이 · 206) · F-MP-02(보기 화면) |
| 메신저에서 받은 mp4 | F-MP-01(playsinline · 길이) · F-MP-02 |
| PhotoCraft 가 있는 설치 | F-MP-03(「PhotoCraft 로 편집」 → 문서 패널의 PhotoCraft 에 그림이 들어감) · `openPlan.test.js` |
| PhotoCraft 가 없는 설치 | F-MP-04 · `openPlan.test.js` |
| AI 채팅의 카드에서 편집하기 | F-MP-05 |
| 압축 파일 | F-MP-04(차분한 안내 · 경고 표시 없음 · 경고 색 아님) · F-MO-07 |
| 대화방 밖의 사람 | F-MP-06(404 · 401) |
| 보낸 사람과 받은 사람 | F-MP-06(둘 다 200 · inline · 같은 바이트 · CSP sandbox · nosniff, zip 은 내려받기, 메시지에 저장소 열쇠 없음) |
| 주소에는 로그인 정보가 들어가지 않는다 | F-MP-01 · 02 · 07(화면의 모든 주소에 `token=` · `eyJ…` 없음, 「새 창에서 열기」도 서명 주소) · F-MP-06(서명 주소 200 · 206, `…/link`, 바꾼 주소 403, 만료 401, 다른 사람으로 맞게 서명 404, 다른 회사 403) · `mediaLink.test.js` |
| 거둔 공유 | F-MP-08(팀에서 빠지면 403 · 돌아오면 200, 거두면 두 사람의 주소 모두 404, 화면은 「미리 볼 수 없어요」) |
| 휴대폰 밤 테마 | F-MP-07(밝은 · 밤, 390px) |
| 메일 시트의 팩스 첨부 | F-MA-09(`mail-attachments.spec.js`) · `mailAttachments.integration`(팩스) |
| 메신저와 AI 채팅의 팩스 | F-MP-09(메신저: 첫 쪽 · 「2쪽」 · 보기 화면 1 / 2 → 2쪽 · 캔버스 픽셀 · 확대 · ← · 해독기는 TIFF 가 나올 때만) · F-MP-10(AI 채팅 카드 · 편집 단추 없음) |
| 공유 폴더의 팩스 | `tiff.test.js`(폴더의 IMG · 그림 미리보기) — 화면은 같은 부품(`FileView` → `TiffView`), 따로 화면 시험 없음 |
| 열 수 없는 TIFF | F-MP-09(손상된 · 5만 × 5만: 미리보기와 보기 화면의 「이 TIFF 는 열 수 없어요 · 내려받기」, 「너무 큰 TIFF 예요」) · `tiff.test.js` |
| 에이전트가 팩스를 읽는다 | F-MA-09 · F-MP-10(채팅 첨부의 쪽 PNG: 비공개 서명 주소 · 작업 공간의 같은 폴더 · 손상된 것은 `pagesError`) · `tiff.test.js` · `mailAttachments.integration`(팩스) |
| 휴대폰에서 팩스 보기 | F-MP-11 · F-MA-10(밝은 · 밤, 390px) |

## 결과

- `results/unit.txt`, `results/e2e.txt` — 마지막 실행 출력.
- 화면 사진(`results/`): `mp01-messenger-media` 메신저의 미리보기 · 재생 막대 · 영상, `mp02-viewer` 보기 화면(「PhotoCraft 로 편집」), `mp03-photocraft-on-edit` 편집을 눌러 연 PhotoCraft(시험용 껍데기에 그림이 들어감), `mp04-no-photocraft-viewer` PhotoCraft 가 없는 설치의 보기 화면, `mp04-zip-calm` zip 의 차분한 안내, `mp05-chat-cards` · `mp05-chat-viewer` · `mp05-chat-photocraft` AI 채팅, `mp07-phone-{light,dark}-{thread,viewer}` 휴대폰 390px, `mp08-revoked-fallback` 거둔 공유의 「미리 볼 수 없어요」. TIFF · 팩스: `mp09-1-messenger-fax`(첫 쪽 미리보기 · 「2쪽」 · 손상된 두 파일의 안내), `mp09-2-viewer-page1` · `mp09-3-viewer-page2` · `mp09-4-viewer-zoomed` · `mp09-5-viewer-damaged`, `mp10-1-chat-fax-card` · `mp10-2-chat-fax-viewer-page2`, `mp11-phone-{light,dark}-{thread,viewer,viewer-page2}`. TIFF 시험 파일은 `e2e/fixtures/tiff`(만든 방법 `server/fixtures/tiff/make.py`).

## 확인하지 못한 것

- 운영 저장소(Supabase)의 실제 주소와 큰 영상의 넘겨 보기 — 로컬 저장소에서만 206 을 확인했다.
- iPhone Safari 의 재생 — Chrome 으로만 돌렸다(구간 요청 206 · 형식은 Safari 가 요구하는 대로 보낸다).
- TIFF: 운영에서 받은 KT 팩스 파일 그 자체로는 돌려 보지 않았다(시험 파일은 같은 형식 — 1728 폭 · 204 × 98 dpi · G4 · 2쪽 — 으로 만든 것). Safari · iPhone 에서의 TIFF 보기, 공유 폴더 미리보기의 화면 시험, 그림을 읽는 진짜 모델이 쪽 그림을 읽는 것도 아직이다(가짜 에이전트가 PNG 를 열어 크기만 확인).
- 진짜 PhotoCraft · VectorCraft 를 보기 화면에서 여는 것은 F-ED-04 · F-CV-04 가 본다(ArtCraft 웹 빌드가 있는 설치에서).
