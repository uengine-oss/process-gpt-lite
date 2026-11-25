# 시험과 증거

## 서버 시험 (데이터베이스 · 네트워크 없이)

```bash
cd server && node --test test/profilePicture.test.js     # 결과: unit.txt
```

저장 규칙(기본 사진 · 내 폴더 · 빈 값), 보여 주는 규칙, 업로드 형식(앞 바이트), 구글 사진(허용 호스트 · 읽는 곳 · 순서 · 채우기 · 되돌리기), 화면이 기본 사진을 불러오는 순서(사이트 뿌리 → Lite 의 사본), 가운데 정사각형 자르기를 본다. 화면과 서버의 기본 사진 목록이 같은지, 18장 파일이 `public/assets/images/profile/` 에 JPEG 로 있는지도 본다.

## 화면 시험 (Playwright, `e2e/tests/feature/profile-picture.spec.js`)

```bash
cd e2e && npx playwright test --project=feature tests/feature/profile-picture.spec.js     # 결과: e2e.txt, 사진: results/
```

시험이 자기 스택을 띄우고 지운다. BFF(`PRO_BACKGROUND=0`, 회사 `avatar-ui`)와 Vite 는 8990 · 5391 부터 빈 포트를 쓴다(5390 은 이 PC 의 이음오피스 호스트 자리). 로컬 Supabase(54321 · 54322)를 쓰고, 모델 · 공용 서비스는 부르지 않는다. 올리는 사진은 ffmpeg 로 만든다. 구글로 로그인한 사람(이하준)은 그 사람의 `auth.identities` 에 provider `google` 행을 넣어 흉내 낸다. 구글 사진은 시험 파일이 127.0.0.1 의 빈 포트에 띄운 가짜 그림 호스트에서 오고, 스택은 `PRO_AVATAR_HOSTS=http://127.0.0.1:<그 포트>` 로 그 호스트를 허용한다. 끝나면 올린 사진과 넣은 identity 행을 지우고, 시험 계정의 `users.profile` 을 열의 기본값으로 되돌린다.

| 스펙 시나리오 | 시험 |
|---|---|
| 새 계정 · 기본 사진 고르기 | F-AV-01 |
| 가로로 긴 사진 · 다시 올리기 | F-AV-02 |
| 지우기 | F-AV-03 |
| Process GPT 에서 바꾼 사진 · 팀원의 사진 | F-AV-04 |
| 깨진 사진 · 다른 앱이 쓴 다른 사이트 주소 | F-AV-05 |
| 다른 사이트의 주소 · 남의 사진 · 그림이 아닌 업로드 | F-AV-06 · 서버 시험 |
| 휴대폰 390px 밝은 · 밤 | F-AV-07 |
| 구글로 로그인한 사람은 구글 사진이 기본 · 고른 사진이 이긴다 · 구글 사진으로 되돌리기 · 구글 계정의 사진이 바뀜 · 구글 사진을 불러오지 못함 | F-AV-08 · 서버 시험 |
| Lite 만 설치한 회사(사이트 뿌리 → 사본) | 서버 시험(`faceSources`) — 개발 스택은 도메인 뿌리라 넘어가기를 화면에서 보지 않음 |
