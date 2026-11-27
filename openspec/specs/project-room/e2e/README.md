# 시험과 증거 — 프로젝트 안의 주제 · 프로젝트 계획

이 폴더는 스펙의 「프로젝트 안의 주제」 요건들(2026-11-25)의 증거다. 앞의 요건들(새 프로젝트 · 바로잡는 말 · 소리 파일)의 시험은 `e2e/README.md` 18절에 있다.

## 순수 규칙 (데이터베이스 · 모델 없이)

```bash
cd server && PRO_CONTEXT_ROUTER_URL= node --test test/projectTopics.test.js
```

서버(`server/lib/projectTopics.js`)에서는 다음을 시험한다. 프로젝트마다 다른 열쇠, 나누는 턴과 나누지 않는 턴, 라우터에 주는 후보(이 프로젝트의 주제와 진행 중인 요청), `/route` 본문, 이 프로젝트의 대화일 때만 받는 답, 주제의 요약과 요지를 시험한다. `server/lib/turns.js`에서는 프로젝트의 턴이 한 번에 하나씩 도는지 시험한다. 화면의 순수 규칙(`src/projectTopics.js`, `src/artifactScope.js`)에서는 메시지마다 주제(늦게 온 앞 턴의 카드 포함), 주제 목록, 주소, 막대가 보이는 때, 한 주제의 산출물을 시험한다. `test/chatArtifacts.test.js`는 산출물 캡션에 「이 주제의 산출물」이 더해진 것을 확인한다.

| 스펙 시나리오 | 시험 |
|---|---|
| 두 주제로 나뉨(후보는 이 프로젝트의 것만, 나누지 않는 턴) | PT-U-01 ~ PT-U-05 |
| 같은 주제로 이어진 요청(요약 · 요지) | PT-U-06 |
| 막대와 주제 행 · 주제가 하나(메시지 수, 늦게 온 카드, 보이는 때) | PT-U-08 ~ PT-U-10 |
| 강의 주제만 · 다른 주제와 전체(한 주제의 산출물) | PT-U-11 |
| 폴더 프로젝트의 두 주제(한 번에 한 턴) | PT-U-07 |

## 화면 시험 (Playwright, `e2e/tests/feature/project-topics.spec.js`)

```bash
cd e2e && npx playwright test --project=feature tests/feature/project-topics.spec.js
```

시험은 자기 스택(BFF `PRO_BACKGROUND=0` + Vite, 회사 `projtopics-ui`, 8940 · 5340 부터 빈 포트)을 띄운다. 가짜 서비스 셋도 이 파일이 띄운다. 맥락 라우터(:8947)는 메시지의 낱말(「강의」 · 「견적」 · 「구글 문서」)로 주제를 정하고 받은 것을 모두 남긴다. deepagents(:8948)는 받은 대화로 답하고 일부 요청에 파일 카드를 남긴다. 모델(:8949)은 채팅의 라우터에 늘 DELEGATE 로 답한다. 공용 deepagents · completion · 맥락 라우터 · 판단 서버는 부르지 않는다. 계정은 `pro-rt-projtopics-ui-a@uengine.org`(한서윤, 지어낸 사람)이다. 시험 Chromium 은 Playwright 자체 것이고, 휴대폰은 390×844 터치 화면이다. F-PS-07 은 폴더 프로젝트의 턴마다 변형을 담는 동안(저장소 동기화, 최대 45초) 다음 턴이 기다리므로 1~2분 걸린다. F-PS-08 은 가짜 라우터를 닫고 돈다.

| 스펙 시나리오 | 시험 |
|---|---|
| 두 주제로 나뉨 · 같은 주제로 이어진 요청 · 막대와 주제 행 · 주제가 하나 | F-PS-01 |
| 강의 주제만 · 다른 주제와 전체 | F-PS-02 |
| 답 위의 표시 | F-PS-03 |
| 이음오피스 수정(주제가 생기기 전의 프로젝트) | F-PS-04 |
| 390px 휴대폰(밝은 · 밤) | F-PS-05 |
| 밤 테마의 고른 주제 | F-PS-06 |
| 폴더 프로젝트의 두 주제 | F-PS-07 |
| 라우터가 닿지 않는 동안 · 처음부터 라우터 없이 | F-PS-08 |

결과는 `results/unit.txt` · `results/e2e.txt`, 화면 사진은 `results/f-ps-*.png` 이다.

## 시험하지 못한 것

- 실제 판단 모델(context-router 의 judge · logprob)이 프로젝트 메시지를 얼마나 잘 나누는지. 가짜 라우터는 낱말로만 정한다. 라우터는 바뀌지 않았고, Lite 가 주는 후보와 사용자 자리의 열쇠만 바뀌었다.
- 운영의 라우터가 프로젝트 열쇠로 `context_threads` 를 읽을 때 30일 넘게 잠든 주제를 빼는 것(`ROUTER_DORMANT_DAYS`). Lite 는 최근 40개를 직접 후보로 넘긴다.

---

# 프로젝트 계획 (2026-11-27)

스펙의 「프로젝트 계획」 네 요건과 스펙 `room-rules` 의 새 요건들(계획에 넣는 말 · 습관보다 방 판정 · 규칙을 정할 때 계획과 대화 · 규칙 막대)의 증거다. 운영에서 일어난 세 장면(11-25 세부 지시의 덮어쓰기 · 11-27 07:02 링크만 · 07:05 「앞으로 …」)을 그대로 다시 일으킨다.

```bash
cd server && node --test test/projectNote.test.js                                            # 단위(DB · 모델 없음)
cd server && node --test --test-concurrency=1 test/projectPlan.integration.test.js            # 실제 개발 DB, 가짜 판정 · 모델 · deepagents
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/project-plan.spec.js # 자기 스택 projplan-ui · 8987 · 5387
cd server && PRO_JUDGE_URL= node <scratchpad>/live-plan.mjs                                   # 실제 사내 모델 한 번(아래 결과)
```

| 스펙 시나리오 | 시험 |
|---|---|
| project-room: 방 맨 위의 칩과 시트(PC · 390 · 밤) | F-PP-01 · F-PP-04 · F-PP-05 |
| project-room: 사람이 고친 항목은 낱말 그대로 | F-PP-01 · PP-U-02 · PP-U-05 · PP-I-06 |
| project-room: 1,200자를 넘는 계획 | PP-U-03 |
| project-room: 다른 사람 | F-PP-07 · PP-I-08 |
| project-room: 「링크 슬라이드 팟캐스트」 같은 방(처음 채우기) | PP-I-05 · F-PP-06 · 실제 모델(아래) |
| project-room: 대화가 도구를 정했다 · 되돌리기 | PP-I-06 · PP-I-08 · F-PP-02 |
| project-room: 규칙 없이 링크만 · 새 하위 대화 · 스킬 없는 규칙의 실행 | PP-I-03 · PP-I-07 |
| room-rules: 11-25 의 세부 지시 · 링크만(11-27 07:02) | PP-I-01 · PP-I-02 · F-PP-02 · 실제 모델(아래) |
| room-rules: 프로젝트 방의 「앞으로 …」 · 메인 채팅의 같은 말 · 판정이 그 밖의 말 | PP-I-04 · F-PP-06 · 실제 모델(아래) |
| room-rules: 서비스 이름이 없는 문장 | PP-U-07 · PP-I-04(받아 적기가 계획과 최근 대화를 받음) |
| room-rules: 스킬 없는 규칙(막대) | F-PP-03 · PP-I-07 · F-NB-06 |
| project-room: 미션 뒤로 64개 메시지가 쌓인 방(휘발되지 않는다) | PP-I-09 · 실제 모델(66개 방, 아래) |
| project-room: 방에서 넣고, 직접 고치고, 기록에서 되돌린다(바뀐 기록) | F-PP-08 · PP-I-10 · PP-U-11 |
| project-room: 계획은 안전하게 쓰이고 고쳐진다(검토 PR #105) — 구매를 말하는 계획 · 시트를 연 뒤 방에서 넣음 · 가득 찬 목록 | PP-I-11~20 · PP-U-12~14 · F-PP-09 · F-PP-10 |

결과: `results/project-plan-unit.txt` · `results/project-plan-integration.txt` · `results/project-plan-e2e.txt` · `results/project-plan-live.txt`, 화면 사진 `results/f-pp-*.png`.

## 실제 사내 모델로 한 번 (개발 DB, 2026-11-27)

방 「링크 슬라이드 팟캐스트」를 운영과 같은 순서로 만들었다(처음의 미션 → 미디엄 링크 실패 → 세부 지시로 규칙 덮어씀 → 「왜 노트북엘엠으로…」 하위 대화 → 유튜브 링크에 요약 문서).

- 처음 채우기 — frentis(4.2초) · Sonnet 5.5(4.0초) 둘 다: 목적 「사람이 주는 링크(URL)를 받아 NotebookLM 으로 슬라이드와 팟캐스트(오디오 오버뷰)를 만들어 주는 곳」, 쓰는 도구 NotebookLM(`ref` notebooklm), 지킬 것 「미디엄 링크는 (직접 넣지 않고) 내 계정으로 접속해 인쇄한 PDF 로 만든 뒤 NotebookLM 에 넣는다」.
- 방 판정(LLM 판정, 운영과 같음, 세 번씩): 세부 지시 → plan 0.82 ×3 · 덮어써진 규칙에 링크만 → run_rule 0.95 ×3 · 「앞으로 …」 → plan 0.72 ×2(1번은 토큰 한도로 답 없음) · 녹화의 첫 문장(규칙 없음, 빈 계획 · 계획 있음) → set_rule 0.95 · 0.82 ×3 · 말투 → other 0.92~0.95 · 한 번의 일 → other 0.72~0.85. 판정 모델의 토큰 한도를 1,024 → 2,048 로 올렸다(`PRO_JUDGE_LLM_MAX_TOKENS`).
- 긴 방(미션 뒤로 64개, 마지막 40개에는 미션이 없음): 처음 채우기가 목적 「사람이 주는 URL·링크를 받아 NotebookLM으로 슬라이드와 팟캐스트를 만들어 주는 곳」, 도구 notebooklm(4.7초).
- 규칙 받아 적기: 「앞으로 여기 주는 링크는 다 그렇게 해 줘」 — 계획 + 최근 대화와 함께면 skill notebooklm ×3, 한 문장만이면 skill 없음 ×3.
- 계획에 넣기: 세부 지시 → 지킬 것 「Medium은 접근 권한 문제로 내 계정으로 인쇄 후 PDF로 만들어 NotebookLM에 넣는다.」(3.3초), 「오디오는 이제 영어로 만들어 줘」 → 지금 항목 「오디오는 한국어로」를 고쳐 씀(1.0초).

## 시험하지 못한 것

- 운영 Sonnet 앞단이 `memory` 를 얼마나 맞게 고르는지(가짜 모델로만). 다섯 턴마다 다시 쓰는 것은 그 경우의 안전망이다.
- 실제 브라우저에서 NotebookLM 까지(로그인한 사람이 있어야 한다) — 브라우저 작업은 계획이 할 일에 붙은 채 시작되는 데까지만 본다.
- 계획이 길어질 때 앞단 · 라우터의 시간(계획은 1,200자 안).

