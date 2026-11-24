# 시험과 증거

## 서버 시험 (실제 DB · 모델과 Gmail 은 가짜 fetch · 지도의 읽기와 시작은 대역)

```bash
cd server && node --test test/mailFlow.integration.test.js
```

모델 주소를 쓰지 않는 주소(`127.0.0.1:59997`)로 바꾸고, 지도 엔진을 끈 채(`PRO_ONTOLOGY_BOLT_URL=`) 돈다. 판정 모델은 가짜 fetch 가 첫 토큰 확률을 돌려준다. 시험이 만든 행은 시험이 끝나면 지운다.

## 화면 시험 (Playwright, `e2e/tests/feature/mail-thread-flow.spec.js`)

```bash
# 서버: 가짜 모델(이 스펙이 59998 에 띄움) · 지도 엔진 없음 · 백그라운드 일 없음
cd server && PRO_PORT=8792 PRO_BACKGROUND=0 PRO_LLM_BASE_URL=http://127.0.0.1:59998/v1 PRO_ONTOLOGY_BOLT_URL= node index.js
PRO_API_TARGET=http://127.0.0.1:8792 npx vite --port 5197 --strictPort
cd e2e && PGPT_URL=http://localhost:5197 API_URL=http://127.0.0.1:8792 RT_WORKERS=1 npx playwright test tests/feature/mail-thread-flow.spec.js --project=feature
```

같은 가짜 모델 포트를 쓰는 `mail-reply.spec.js` 와 동시에 돌리지 않는다(`RT_WORKERS=1`). 메일함은 데모 메일함이다. 지도의 읽기는 카드에 남은 결과를 쓴다(들어올 때 지도가 남기는 것과 같은 모양).

| 스펙 시나리오 | 시험 |
|---|---|
| 모닝 브리프의 칩 | F-MT-01, 서버 「모닝 브리프는 그 메일들의 Home 카드 칩을 단다」 |
| 휴대폰 | F-MT-02 |
| 채팅에서 연 시트 → Home 카드로 | F-MT-01(PC) · F-MT-02(휴대폰) |
| 고객이 같은 스레드로 다시 쓴다 | 서버 「들어올 때(스레드)」(가짜 Gmail 로 두 번 수집) |
| 끝난 인스턴스 | 서버 「같은 Gmail 스레드의 앞 메일이 …」 |
| 제안 단계 프로세스와 같은 일 | F-MT-03 · F-MT-05(휴대폰), 서버 「시트: 지도가 「제안」 프로세스의 시작으로 읽고 …」 |
| 다른 일 | 서버 「시트: …」(4%) · 「판정 모델: … 문턱 아래면 권하지 않는다」 |
| 관찰 단계 | 서버 「시트: …」(paused 는 권하지 않음) |
| 진행 중인 인스턴스에 잇는다 | F-MT-04 · F-MT-05, 서버 「잇기」 |
| 새로 시작한다 | 서버 「새로 시작」(시작은 대역 — 인스턴스 · 건 행을 만든다), F-MT-07(화면 흐름: 시작 응답만 대역, 그 인스턴스로 간다) |
| 시작할 수 없다 | F-MT-06(지도 엔진 없는 서버의 실제 거절), 서버 「시작이 실패하면 …」 |
| 두 번 누른다 | 서버 「새로 시작」(409 두 번) |
| 이번엔 안 한다 | F-MT-06, 서버 「이번엔 안 해요」 |
| 자동 단계의 시작 · 제안 단계 | 서버 「들어올 때(자동)」 |
| 인스턴스 화면에서 답장한다 | F-MT-04, 서버 「답장」 |

시험하지 않은 것:
- Home에 다섯 장이 넘는 카드가 있을 때 「Home 카드로」가 목록 밖의 카드를 보여 주는 것.
- 같은 인스턴스에 대한 Home 알림이 있을 때 메일 카드를 겹쳐 보이지 않게 하는 것(화면).
- 실제 지도 엔진(Ontological)으로 지도를 읽고 시작하는 것. 로컬 엔진이 꺼져 있었다.

## 결과

- `results/unit.txt`: 서버 시험. `mailFlow` 12/12. 관련 시험 `mailReply` 10, `ontology-streams` 6, `ontology-events` 8, `homeCards` 3, `mailPollRace` 2, `instanceContext` 3은 모두 통과.
- `results/ontology-regression.txt`: `ontology-*.test.js`를 하나씩 순서대로 돌린 결과 224/224. 공용 DB 데이터에 따라 실패하던 「근거: 주인은…」도 이번에는 통과했다.
- `results/e2e.txt`: F-MT-01~07, 7/7. 같은 서버에서 `mail-reply.spec.js` 7과 `home-dismiss.spec.js` 3도 통과(회귀).
- 화면: `results/f-mt-*.png`
  - `01a`~`01c` PC: 브리프 칩 → 시트 → Home 카드가 빛남
  - `02a`~`02c` 휴대폰: 브리프 칩 → 시트 → 홈 탭의 카드
  - `03` PC: 시트의 물음
  - `04a`~`04c`: 잇기 뒤 인스턴스 대화, 거기서 보낸 답장, 「루틴 · …」이 된 브리프 칩
  - `05a`~`05c` 휴대폰: 시트의 물음 → 인스턴스 → 「루틴 · …」이 된 Home 카드
  - `06a`·`06b`: 시작 실패의 이유 → 「이번엔 안 해요」
