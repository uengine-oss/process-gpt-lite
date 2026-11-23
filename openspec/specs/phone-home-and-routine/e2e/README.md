# 시험과 증거

실행(개발 서버, 휴대폰 390×844):

```bash
cd server && node --test test/mobile-review-1121.test.js test/telegram.test.js
cd e2e && PGPT_URL=http://127.0.0.1:5192 API_URL=http://127.0.0.1:8792 npx playwright test --project=feature tests/feature/mobile-review-1121.spec.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| 에이전트 답 전체가 담긴 알림 | F-MR-01 · R-1121-01·02·13 |
| ✕ 로 닫기 / 손가락으로 밀기 | F-MR-02 · F-MR-03 |
| 응답이 느린 루틴 / 없는 루틴 / 홈에서 연 루틴 닫기 / 주소로 연 루틴 닫기 | F-MR-04 · F-MR-05 |
| 7열 표가 든 예약 실행 결과 | F-MR-08 |
| 방금 만든 작업을 바로 시험 / 시각이 있으면 새 예약 | F-MR-06 · R-1121-04·06·11 |
| 봇이 없을 때 알려 달라고 한다 / 남의 작업 | F-MR-07 · R-1121-05·10 |
| 연결부터 시험 메시지까지 / 잘못된 토큰 / 링크로 연 대화만 | `telegram.test.js` |
| 연결한 뒤 실행 결과 | 영상 `mobile-review-1121-ko` 녹화 단언(telegram sent) |
| 주가 조회 결과 · 「ast 모바일」 | R-1121-07·08·09·12, 녹화 |
| 괄호 뒤 조사 | R-1121-03 |
| 메일 카드를 밀어서 닫는다 / 업무 카드를 닫는다 / 워크아이템 알림을 닫는다 (11-23) | F-HD-01 · F-HD-02 · F-HD-03 · `homeCards.integration.test.js` |
| 보낸 사람이 적혀 있지 않은 알림 / 단체 방의 메시지 (11-23) | F-MS-01 · F-MS-02 · `noticeSender.integration.test.js` |

`results/`: 고치기 전(main 0d32fe9) 실패 출력, 고친 뒤 통과 출력, 단위 시험 출력.
