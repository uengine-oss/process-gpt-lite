# 시험과 증거

## 서버 시험

```bash
cd server && node --test --test-concurrency=1 test/answerShareProject.integration.test.js   # 실제 DB · Express 라우트 · git 템플릿 폴더 · 저장소, 가짜 모델
```

- AP-U-01 순수(카드의 모양 · 추천 · 판정이 읽는 템플릿 · 계획), AP-U-05 「프로젝트로 시작」 카드(판정이 고른 템플릿만 · 까닭 · 실행 권한이 없는 템플릿은 보기에도 없음 · 출처 메일 · 아직 만들지 않음), AP-U-06 「만들기」(템플릿 작업 공간 · 계획 · 첫 문서 · 「프로젝트로 옮겼어요」 · 원래 대화 그대로 · 두 번째 409), AP-U-07 빈 프로젝트 · 「아니요」 · 권한 없는 템플릿 403 · 남의 카드 404, AP-U-08 템플릿이 없으면 판정 없이 추천 없음.
- 결과: `results/server-answerShareProject-integration.txt`.

## 화면 시험 (Playwright, `e2e/tests/feature/answer-share-project.spec.js`)

가짜 모델은 라우터 요청에서 「프로젝트를 하나 만들자」에만 `start_project` 를 부르고, 템플릿 판정에서는 「교육 과정 만들기 템플릿」을 88% 로 고른다.

| 스펙 시나리오 | 시험 | 사진 |
|---|---|---|
| 녹화의 말 · 만들기 · 교육 과정 템플릿 추천 | F-CP-01 | `results/f-cp-01-offer.png` · `f-cp-01-made.png` · `f-cp-01-projects-tab.png` · `f-cp-01-project.png` |
| 단추로 · 템플릿으로 | F-CP-02 | `results/f-cp-02-pick-template.png` · `f-cp-02-workspace.png` |
| 390px(밝은 · 어두운) · 「아니요」 | F-CP-03 | `results/f-cp-03-phone-light.png` · `f-cp-03-phone-dark.png` |
| 두 번 누르기 · 권한이 없는 템플릿 · 볼 수 없는 템플릿 | AP-U-05 ~ 07 | — |

결과: `results/e2e-F-AS-F-CP.txt`.
