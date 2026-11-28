# 시험과 증거

## 서버 시험

```bash
cd server && node --test --test-concurrency=1 test/answerShareProject.integration.test.js   # 실제 DB · Express 라우트 · 저장소(로컬 Supabase), 가짜 모델
```

- AP-U-01 순수(답의 제목 · 문서 이름 · 문서 글 · 방 순서), AP-U-02 방 고르기(내 방 · 1:1 이 없는 팀원 · 남의 답 404 · 답이 아닌 메시지 400), AP-U-03 보내기(방의 `answer` 메시지 · 알림 · 답에 남은 기록 · 팀원에게 바로 · 팀원이 아닌 사람 · 나 403 · 내가 없는 방 404 · 팀에서 빠진 사람 403), AP-U-04 문서로 남기기(한 번만 · 남의 답 404).
- 결과: `results/server-answerShareProject-integration.txt`.

## 화면 시험 (Playwright, `e2e/tests/feature/answer-share-project.spec.js`)

```bash
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/answer-share-project.spec.js   # 자기 스택: BFF 8997 · Vite 5397
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/context-menu-actions.spec.js   # 답 · 파일의 문맥 메뉴(F-CM-01~03), 자기 스택: BFF 8992 · Vite 5392
```

| 스펙 시나리오 | 시험 | 사진 |
|---|---|---|
| PC의 문서 답 · 단체방에 보낸다 | F-AS-01 | `results/f-as-01-answer-more.png`(답 아래 단추 없음 · 「⋯」) · `f-as-01-menu.png` · `f-as-01-send.png` · `f-as-01-room.png` · `f-as-01-received.png` |
| 문서로 남긴다 | F-AS-02 | `results/f-as-02-saved.png` · `f-as-02-file-card.png` |
| 휴대폰에서 길게 누른다(밝은 · 어두운) | F-AS-03 | `results/f-as-03-phone-light.png` · `f-as-03-menu-light.png` · `f-as-03-rooms-light.png` · `…-dark.png` |
| 한마디 없이 팀원에게 바로 · 거절 | AP-U-03 | — |
| 휴대폰에서는 단추 대신 길게 누르고, 안내는 처음 한 번만(밝은 · 어두운) | F-CM-01 | `results/f-cm-01-hint-light.png` · `f-cm-01-answer-light.png` · `f-cm-01-menu-light.png` · `f-cm-01-project-light.png` · `…-dark.png` |
| PC에서는 「⋯」 · 오른쪽 단추 · 키보드로 연다 | F-CM-03 | `results/f-cm-03-answer-hover.png` · `f-cm-03-answer-menu.png` |

결과: `results/e2e-F-AS-F-CP.txt`.
