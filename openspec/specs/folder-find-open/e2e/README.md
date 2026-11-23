# 시험과 증거

에이전트 없이 돈다. 서버 시험은 로컬 DB와 저장소를 쓰고, 화면 시험은 보내기를 가로채고 파일 카드를 실시간 이벤트로 넣는다.

```bash
cd server && node --test test/folderFindOpen.test.js
cd server && PRO_PORT=8791 PRO_BACKGROUND=0 node index.js &
PRO_API_TARGET=http://127.0.0.1:8791 npx vite --port 5191 &
cd e2e && PGPT_URL=http://localhost:5191 API_URL=http://127.0.0.1:8791 npx playwright test --project=feature tests/feature/folder-open.spec.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| 이름과 폴더에 나뉘어 있는 낱말 | `folderFindOpen.test.js` 「붙이지 않아도 찾고, 읽고, 연다」 · 「검색 낱말」 |
| 어떤 이름에도 없는 낱말 | `folderFindOpen.test.js` 「붙이지 않아도 찾고, 읽고, 연다」(`resume-…`) |
| 워드 파일을 읽는다 | `folderFindOpen.test.js` 「문서 본문: docx · pptx · hwpx · xlsx 를 unzip 없이 읽는다」 · 「붙이지 않아도…」(folder_read) |
| 예전에 읽지 못한 문서 | `folderFindOpen.test.js` 「예전 이미지가 읽지 못한 문서는 시작할 때 카드를 다시 만든다」 |
| 열어 달라고 한 화면 | F-FO-01 · `folderFindOpen.test.js` 「folder_open 의 결과는 파일 카드가 되고 open 을 가진다」 |
| 같은 사람의 다른 기기 | F-FO-02 · F-FO-04(다른 대화의 카드) |
| 만들어 준 문서 | F-FO-03 |
| 구성원이 아닌 폴더 | `folderFindOpen.test.js` 「붙이지 않아도…」(다른 사람) |

`results/`: 서버 시험 출력(`server.txt`), 화면 시험 결과(`e2e.txt`, F-FO-01~04), F-FO-01 화면(`f-fo-01.png`, 로컬에 이음오피스 서버가 없어 편집기 안은 비어 있음 — 운영 확인은 반영 뒤).
