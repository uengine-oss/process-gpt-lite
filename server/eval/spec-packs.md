# 업무 팩 · 메일 초안 · 그림 요청 · 검토 종류 평가 — 기능 명세 (문항 작성용)

이 문서는 평가 문항을 쓰는 사람(또는 모델)이 보는 **기능 명세**다. 시스템이 읽는 스킬 설명(skills/packs/**/SKILL.md)과
코드는 보지 않고 이 문서만 보고 문항을 쓴다(docs/mobile-review-1121/skill-routing-design.md 7.1). 금지 문장
`server/eval/forbidden.txt` 와 같거나 거의 같은 문장, 그 낱말 조합을 흉내 낸 문장은 쓰지 않는다.

세 과제가 있다. 과제마다 개발 세트(dev)와 보류 세트(holdout)를 따로 쓴다. 두 세트는 문장을 나눠 쓰지 않는다.

## 과제 A — 메일이 요청한 문서 초안 (sets/packs-mail.{dev,holdout}.json)

비서는 새로 온 메일을 읽고, 메일이 **문서를 만들어 보내 달라고** 하면 보낼 초안 목록을 정한다. 이 회사는 「매장 설계
제안」 업무 팩을 켜 두었다. 팩이 하는 일은 셋이다(이 이름이 정답 라벨이다).

| 라벨 | 하는 일 |
|---|---|
| `cadcraft-floor-plan` | 작은 상업 공간(가게·카페·식당·사무실·병원·학원·스튜디오 …)의 평면도를 요구사항으로 그린다(도면 파일). 인테리어·공간 설계 제안을 요청하는 메일이면 메일이 도면을 따로 말하지 않아도 함께 만든다. |
| `store-design-proposal` | 그런 공간의 인테리어 설계 제안서(공간 구성·콘셉트·평면도가 들어감). 다른 종류의 제안서(교육·마케팅·소프트웨어 도입·행사 기획 …)는 여기가 아니다. |
| `quote-xlsx` | 메일 요청에 답하는 견적서(엑셀). 인테리어 공사든 물품·행사·용역이든, 가격을 내 달라는 견적이면 여기다. |

팩이 하지 않는 문서(일정표, 보고서, 계약서 초안, 회의록, 교육 제안서, 발표 자료 …)는 팩 라벨 없이 일반 문서로 만든다 —
정답의 `skills` 에 넣지 않는다. 문서를 요청하지 않는 메일(공지, 광고, 안부, 회의 일정만 묻는 메일, 이미 보낸 문서에
대한 감사 인사 …)은 초안이 없다.

문항 한 개:

```json
{"id":"pm-dev-001","mail":{"from":"이름 <id@회사.example>","subject":"…","text":"…"},"mode":"ko",
 "expect":{"documents":true,"skills":["cadcraft-floor-plan","store-design-proposal","quote-xlsx"]},
 "category":"positive","axis":{"style":"formal","lang":"ko","quality":"clean","indirect":false}}
```

- `expect.documents`: 문서를 만들어 보내 달라는 요청이 있으면 true.
- `expect.skills`: 팩 라벨 중 맞는 것 전부(순서 무관). 팩 문서가 아니면 [].
- `category`: `positive`(팩 라벨이 하나 이상 맞음) / `boundary`(팩과 같은 낱말 — 제안서·견적·도면·설계 — 이 나오지만 팩 라벨이 일부만 맞거나 하나도 안 맞음) / `plain`(문서 요청이지만 팩 문서가 아님) / `none`(문서 요청이 없음).
- 보낸 사람 주소는 예약 도메인(`.example`)만. 회사·가게 이름은 지어내되 실제 회사 이름은 쓰지 않는다.
- `mode`: 화면 언어. 영어 메일의 절반쯤은 `en`.
- 변형: 말투(합쇼체·해요체·짧은 메모체·장황한 설명), 간접 요청(바라는 바만 말함, "~하면 좋겠는데요"), 언어(한국어·영어·일본어·섞어 쓰기), 오타·띄어쓰기 없음, 숫자·치수 유무, 여러 요청이 섞인 메일, 첨부만 말하는 메일.
- 구성(세트마다): positive 40% · boundary 30% · plain 15% · none 15% 쯤.

## 과제 B — 열린 문서의 그림에 대한 요청 (sets/packs-picture.{dev,holdout}.json)

사용자가 채팅 옆에 한글(hwp)·워드 문서를 열어 두고, 문서 속 그림 하나를 가리킨 뒤 요청을 쓴다. 시스템은 그 요청이

- `image` — **그림 자체(픽셀)를 바꾸는 일**: 색 바꾸기·밝기·보정·배경 지우기·그림 속 물체 지우기·그림 위에 글자나 표시 넣기·얼굴 흐리게·흑백으로 … (그림 편집기에서 할 일)
- `document` — **문서 안에서 그림을 다루는 일**: 그림을 옮기기·문서에서 빼기·다른 그림으로 바꾸기·캡션 달기/고치기·쪽에서의 크기·정렬·그림 옆 문단이나 표 고치기 …

중 어느 쪽인지 정한다.

```json
{"id":"pp-dev-001","picture":"그림 2","text":"…","mode":"ko","expect":"image","category":"positive","axis":{"style":"command","lang":"ko","quality":"clean"}}
```

- `category`: `positive`(한쪽이 분명) / `boundary`(같은 낱말이 다른 쪽에 쓰임 — "지워"가 그림 속 물체를 지우는 것인지 그림을 빼는 것인지, "크기"가 쪽에서의 크기인지 …, 정답은 문장에 분명히 드러나게).
- 섞어 쓰기·오타·일본어·영어를 고르게. 정말 어느 쪽인지 사람도 가를 수 없는 문장은 쓰지 않는다.

## 과제 C — 공유받은 검토의 종류 (sets/packs-review.{dev,holdout}.json)

팀원이 다른 팀원에게 초안을 공유하며 짧은 메모를 남긴다. 공유한 파일의 형식으로 검토 이름을 정할 수 없을 때(텍스트 파일 등),
시스템은 **받는 사람의 역할**과 **공유 메모**로 검토의 종류를 고른다.

| 라벨 | 검토 |
|---|---|
| `finance` | 돈 문제 확인: 금액·단가·예산·세금·정산 |
| `design` | 도면·배치·인테리어 디자인 확인 |
| `contract` | 계약 조건·약관·조항 확인 |
| `proposal_review` | 제안서 문안·표현·오탈자 확인 |
| `none` | 위 어느 것도 아님(일반 확인, 일정 확인, 그냥 참고) |

```json
{"id":"pr-dev-001","roles":["회계팀"],"note":"…","mode":"ko","expect":"finance","category":"positive","axis":{"lang":"ko","style":"banmal"}}
```

- `roles`: 받는 사람이 회사에서 맡은 역할 이름(0~2개, 회사마다 부르는 말이 다르다: 경리·회계·Finance·FP&A·법무·리걸·Legal·디자이너·Designer·영업·PM …). 빈 배열도 섞는다(메모만으로 정함).
- 역할과 메모가 서로 다른 쪽을 가리키면 **메모가 부탁하는 검토**가 정답이다(역할은 받는 사람, 메모는 부탁한 일).
- `category`: `positive` / `boundary`(낱말이 겹치지만 다른 라벨, 또는 none).

## 공통 축(axis)

style: plain · banmal · formal · command · question · monologue · indirect / lang: ko · en · ja · zh · mix / quality: clean · typo · nospace · dictation.
