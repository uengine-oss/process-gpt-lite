# 시험과 증거

## 단위 (데이터베이스 · 모델 · Storage 없이)

```bash
cd server && node --test test/craftWork.test.js test/craftInstall.test.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| 빠진 것만 없다 | `craftInstall.test.js` 「craftStatus: 웹과 CLI 를 앱마다 본다」 |
| 도구 목록 · 만든 파일이 카드로 · 첨부한 사진을 앱으로 · 경로는 /workspace 안에서만 · 이전 턴의 파일 | `craftWork.test.js`(사람마다 대신 폴더, 다른 절대 경로 · 상위 폴더 조각 거절, 내 storage 주소만 받기, 내 대화 폴더 사본 받기 · 올리기(deepagents 키 인코딩), `documentsOfRun` · `publish` 가 그 사람의 대신 폴더를 읽음, 하루 뒤 정리) |
| 다른 사람의 대화 폴더 파일은 열지도 쓰지도 않는다 | `craftWork.test.js` 「다른 사람의 대화 폴더는 받지도 올리지도 않는다」(받지 않음 · 저장 폴더를 만들지 않음 · 올리지 않음 · 한 번만 기록), 「구성원인 공유 폴더의 실행 방은 쓸 수 있다」(그 방의 폴더를 runner 이상으로 물음, 구성원이 아니면 안 됨), 채팅 카드 시험의 「다른 사람의 턴은 찾지 못함」 |

## 설치 이미지 안에서 (설치 확인 시험은 빠지면 실패한다)

운영과 같은 서버 이미지에 craft 이미지의 파일을 운영 initContainer 와 같은 방법으로 복사한 볼륨을 붙여 돌린다.

```bash
docker run --rm --platform linux/amd64 -v <볼륨>:/data ghcr.io/uengine-oss/process-gpt-lite-craft:336423d sh /init.sh   # 매니페스트의 initContainer 스크립트
docker run --rm --platform linux/amd64 -v <볼륨>:/data -e PRO_CRAFT_WEB_ROOT=/data/craft \
  -e PRO_CADCRAFT_CLI=/data/craft-bin/cadcraft-cli … -w /app/server --entrypoint node \
  ghcr.io/uengine-oss/process-gpt-lite-server:<태그> --test test/craftInstall.test.js test/craftWork.test.js
```

2026-11-25 (서버 c1d9f7b + 이 변경, craft 336423d, amd64 에뮬레이션): 14개 통과. `PRO_CRAFT_WEB_ROOT` 를 빈 폴더로 주면 다섯 앱 시험이 「index.html 가 없음」으로 실패한다.
같은 컨테이너에서 서버의 도구 경로(`callCraft`)로 다섯 앱이 대화 폴더에 `평면도.dxf` · `배너.svg` · `썸네일.psd` · `배경음.wav` 를 만들었고, `documentsOfRun` 이 넷을 카드로 찾았다(그 대화 폴더를 쓸 수 있을 때). 데이터베이스가 없어 폴더 권한을 물을 수 없는 컨테이너에서는 네 저장이 모두 각 CLI 의 「No such file or directory」로 끝났고 대신 폴더에 아무것도 남지 않았다(물을 수 없으면 쓸 수 없는 폴더로 본다). 다른 절대 경로와 상위 폴더 조각이 든 경로는 거절됐다. 라이브 공동 편집은 가짜 페이지(웹소켓)로 `vectorcraft-cli mcp --connect` → lsof pid 확인 → 페이지 → 답까지 돌았다.
`/mcp/<앱>` 익명 `tools/list` 는 이 변경 전 이미지에서 VectorCraft · PhotoCraft · SoundCraft 가 `workspace folder not found: /workspace` 였고, 변경 뒤 다섯 앱 모두 도구 목록이 왔다.

## 하위 경로 아래 (Playwright, `e2e/tests/deploy/craft-install.spec.js`)

로그인이 필요 없다. 운영 확인:

```bash
cd e2e && PGPT_ROOT_URL=https://uengine.process-gpt.io npx playwright test --project=deploy tests/deploy/craft-install.spec.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| 운영에서 PhotoCraft 카드 열기(설정 · 페이지) | C-IN-<앱> |
| 브라우저에서 다섯 앱이 뜬다 | C-IN-<앱>-boot |

2026-11-25: 게이트웨이를 흉내 낸 nginx(`/lite/` 접두어를 떼고 넘김, `Via: 1.1 google`) → Lite 웹 이미지 c1d9f7b 의 nginx → 서버에 대고 10개 통과. 라이브 연결은 같은 길에서 표 없이 4401, 다른 Origin 은 4403 으로 닫혔다.
