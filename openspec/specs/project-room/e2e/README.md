# 시험과 증거 — 프로젝트 안의 주제

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
