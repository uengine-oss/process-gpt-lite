# 시험과 증거

모델은 부르지 않는다. 서버 시험은 로컬 DB와 저장소(Supabase)를 쓴다. 화면 시험은 **실제 이음오피스 호스트**에서 문서를 열고 입력해 저장까지 확인한다. 호스트는 운영 이미지 `ghcr.io/uengine-oss/process-gpt-lite-office-host:ecea940`을 로컬 컨테이너(:5391)로 띄워 썼다.

```bash
cd server && node --test test/folderEditSave.test.js
# 이음오피스 호스트(운영 이미지, amd64 를 맥에서 에뮬레이션): 문서 주소 127.0.0.1:54321 을 컨테이너 안에서 맥으로 넘긴다
docker run -d --platform linux/amd64 --name fes-office-host -p 5391:5390 \
  -e SUPABASE_JWT_SECRET -e SUPABASE_SERVICE_ROLE_KEY -e SUPABASE_ANON_KEY \
  -e SUPABASE_URL=http://127.0.0.1:54321 -e IEUM_ALLOWED_SOURCES=http://127.0.0.1:54321 \
  --entrypoint sh ghcr.io/uengine-oss/process-gpt-lite-office-host:ecea940 -c \
  "node -e \"const n=require('net');n.createServer(c=>{const s=n.connect(54321,'host.docker.internal');c.pipe(s).pipe(c)}).listen(54321,'127.0.0.1')\" & exec node dist/office-host.mjs"
cd server && PRO_PORT=8792 PRO_BACKGROUND=0 PRO_OFFICE_HOST_URL=http://127.0.0.1:5391 node index.js &
PRO_API_TARGET=http://127.0.0.1:8792 PRO_OFFICE_TARGET=http://127.0.0.1:5391 npx vite --port 5192 &
cd e2e && PGPT_URL=http://localhost:5192 API_URL=http://127.0.0.1:8792 npx playwright test --project=feature tests/feature/folder-edit-save.spec.js --workers=1
```

| 스펙 시나리오 | 시험 |
|---|---|
| 손을 멈추면 저장 | F-FE-01 · `folderEditSave.test.js` 「편집본이 폴더 main 의 파일이 된다」(첫 저장) |
| 고치고 바로 닫기(녹화의 순서) | F-FE-02 |
| 한 번 열어 고치면 이력 한 줄 | F-FE-03 · `folderEditSave.test.js`(같은 세션은 접힘, 다른 세션은 새 줄, 가지가 서 있으면 접지 않음, 내용이 같으면 커밋 없음) |
| 휴대폰 | F-FE-06 |
| 먼저 올린 사람이 있을 때 | F-FE-04 · `folderEditSave.test.js`(수정본 · 번호) |
| 보기 권한의 휴대폰 | F-FE-05 |
| 열기 카드의 문서를 고친다 | F-FE-07 · `folderEditSave.test.js` 「folder_open 의 카드는 폴더와 연 버전을 갖고 다닌다」 |
| 처음 여는 휴대폰 | F-FE-08(4G · CPU 4배 느림 · 캐시 없음) |
| 남의 폴더 객체 | `folderEditSave.test.js`(다른 폴더 · 원래 사본 · 하위 경로 · 형식 거절) |
| 고친 것을 모두 되돌리면 | `folderEditSave.test.js`(되돌리면 편집 커밋이 사라지고 스테이징이 남지 않음) |
| 연 사이에 지워진 파일 | `folderEditSave.test.js`(「보고서 (… 수정본).docx」, 원래 이름은 없음) |
| 보기 권한인 사람의 카드 | F-FE-09 · `folderEditSave.test.js` 「folder_open: 편집자에게는 고칠 수 있는 카드, 보기 권한에게는 보기 전용 카드」 |
| 고치는 중에 다른 카드를 누른다 | F-FE-10 |
| 함께 올리던 파일 | `folderEditSave.test.js`(그 편집의 커밋에는 고친 파일만, 다른 파일은 올린 사람의 커밋) |
| (편집기의 저장 단추와 편집 키) | `folderEditSave.test.js` 「편집으로 치는 키」 · 「편집기의 저장 단추」 |

**편집기에 저장시키는 방법**(운영 이미지 ecea940, 2026-11-24 측정):
- 워드: 저장 단추와 Ctrl+S가 모두 통한다.
- 엑셀: 저장 단추만 통한다. Ctrl+S와 호스트의 `office_live_save`는 「save target was not authorized」로 거절된다.
- PPT: 저장 단추만 통한다. 글 상자를 빠져나온 뒤에 눌러야 하고, Ctrl+S는 무시된다.
- 한글: 저장 단추가 없고 Ctrl+S가 통한다.

그래서 화면은 편집기의 저장 단추(`.qa-btn` 「저장」)를 누르고, 그 단추가 없으면 Ctrl+S를 보낸다.

**처음 열 때 걸리는 시간**(같은 이미지, 390px 화면, 4G 9Mbps/60ms, CPU 4배 느림):

| 열기 | 편집기 화면 | 문서 |
|---|---|---|
| 처음 | 6.1초 | 9.0초 |
| 두 번째부터 | 0.5초 | 2.3초 |

편집기 묶음은 `index-*.js` 5.4MB(br 1.75MB)이고, 1년 동안 캐시된다. 미리 받아 두어도 처음 여는 시간은 6.0초로 거의 줄지 않았다. 시간 대부분이 묶음을 실행하는 데 들기 때문이다.

`results/`:
- `server.txt`: 서버 시험 출력.
- `e2e.txt`: 화면 시험 F-FE-01~10 결과.
- 화면 사진:
  - `f-fe-01.png`: 폴더에 저장한 뒤의 머리말과 편집기.
  - `f-fe-04.png`: 수정본으로 따로 저장한 화면.
  - `f-fe-05.png`: 보기 전용, 휴대폰.
  - `f-fe-06-editing.png`: 고치는 중, 휴대폰.
  - `f-fe-07.png`: 채팅 카드에서 연 문서를 폴더에 저장한 화면.
  - `f-fe-08-opening.png`: 문서를 여는 중, 휴대폰.
