# 시험과 증거

## 단위 시험 (모델 · DB 없음)

```bash
cd server && node --test test/ontology-engagement.test.js test/ontology-streams.test.js test/ontology-recur-yearly.test.js
```

| 스펙 시나리오 | 시험 |
|---|---|
| 아무도 답하지 않은 기관 교육 안내 | `ontology-engagement.test.js` 「스레드 안에 회사 사람이 쓴 메일이 있으면 일…」, 「splitQuiet…」 |
| 회사가 메일을 보낸 적 있는 고객사의 새 사람 | `ontology-engagement.test.js` 「회사가 메일을 보낸 적이 있는 상대…」 |
| 이미 지도에 들어간 받기만 한 메일 | 실제 메일함 측정(`results/real-mailbox.md` — 다시 셈하기가 뺀 행 211) |
| 붙여 넣은 그림 이름만 같은 전달 메일 · 같은 자료를 전달 | `ontology-engagement.test.js` 「전달 메일은 같은 파일(이름 + 크기)일 때만…」 |
| 교육 안내가 유지보수 줄기로 제안된다 | `ontology-streams.test.js` 「같은 줄기로 제안돼도 다른 일(교육 안내)은…」 |
| 같은 제안 건의 요청 · 서류 · 일정 | 실제 메일함 측정(한 공공 사업 제안 6건이 한 덩어리, 짝 판정 0.967) |
| 판정 모델이 꺼져 있다 | `ontology-streams.test.js` 「전에 정해진 무리에 새 건이 들고, 판정을 못 하면…」, 「줄기의 첫 건은 견줄 무리가 없어…」 |
| 매달 오는 실적 요청 | `ontology-streams.test.js` 「같은 고객의 다른 회차(매달 보고)는 따로 무리」 · 실제 짝 판정(정기 방문 9월 ↔ 10월 0.007) |
| 매년 10월의 유지보수 견적 | `ontology-recur-yearly.test.js` 두 시험 |
| 잘못 섞였던 일이 빠진다 | 실제 메일함 측정(교육 안내와 견적이 섞인 프로세스 0) |

결과: `results/unit.txt`(13/13), 지도 단위 시험 전체 `results/ontology-regression.txt`(224 중 223)

실패 1건(「근거: 주인은 제목 · 원문을…」)은 공용 DB의 데모 테넌트 데이터에 따라 결과가 달라지는 시험이다. 고치기 전 코드(`origin/main`)에서도 똑같이 실패한다.

## 실제 메일함으로 재기 (모델 사용)

로컬 DB에 보관된 실제 메일함에 이 브랜치 코드를 그대로 돌린다. 모델은 회사 게이트웨이 `frentis-ai-model` 이다. 도구 스크립트는 저장소 밖(작업자 scratchpad)에 있다. 메일 제목이 출력되기 때문이다.

1. 메일 이력과 묶음을 백업하고, 그때의 프로세스 목록을 적는다.
2. `refreshMailCases()` → `linkCases()` 를 실행한다. 다시 셈하기의 앞부분과 같다.
3. 덩어리와 떼어 낸 건을 사람이 읽어 검토한다.
4. 프로세스 목록을 다시 적는다(`loadEvents` → `stateAt`, 그래프에 쓰지 않음).

숫자는 `results/real-mailbox.md` 에 있다.

## 데모 메일함 회귀

`scripts/fixtures/ax-demo-mailbox.json` 에는 정답이 표시되어 있다. 이 메일함을 새 거르기에 넣어도 정답 흐름 95개는 하나도 빠지지 않았다. 빠진 스레드는 3개로, 모두 정답 흐름에 없는 거래처 안내다. 그래프 엔진을 띄워 돌리는 지도 시험(S1 `test/ontology-map.e2e.mjs`)은 이번에 돌리지 못했다. 로컬에 Ontological 엔진이 꺼져 있었다.
