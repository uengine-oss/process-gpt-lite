# Bolt 계획 — 팀 할 일 보드

**Bolt**는 작업 단위(Unit) 하나 이상을 한 번에 설계·구현·테스트해서 실제로 돌아가는 결과로 끝내는 한 번의 작업 묶음입니다.

근거: 작업 단위 `inception/units-generation/unit-of-work.md`, 의존 관계 `inception/units-generation/unit-of-work-dependency.md`(U2 → U1), 스토리 대응표 `inception/units-generation/unit-of-work-story-map.md`, 계약 `inception/contract-design/contract-summary.md`(C1 할 일 API, C2 화면 파일 규약), 요구사항 `inception/requirements-analysis/requirements.md`, 스토리 `inception/user-stories/stories.md`, 화면 시안 `inception/refined-mockups/mockups.md`, 구성 요소 `inception/domain-design/components.md`, 팀 작업 방식 `inception/practices-discovery/team-practices.md`, 질문 답변 `delivery-planning-questions.md`(Q1~Q3 모두 A).

## 진행 방식

- **순서**: Bolt 1 → Bolt 2. 의존 관계(U2가 U1에 의존)가 허용하는 순서가 이것 하나이며, 질문 Q1의 답과 같습니다.
- **처음부터 끝까지 이어지는 얇은 조각(walking skeleton, 실제 기능 전에 각 부분이 연결되는지 먼저 증명하는 최소 버전)**: 만들지 않습니다(팀 작업 방식). Bolt 1에 별도 뼈대 체크포인트를 두지 않습니다.
- **코드 생성 단계의 진행**: 작업 단위 하나씩 차례로(`unit-major`), 동시 진행 없이(`serial`) 진행하며, 각 단위가 끝나면 결과를 확인하는 체크포인트가 있습니다. 코드 생성 단계에 들어갈 때 "자동으로 계속 진행" 또는 "체크포인트마다 검토"를 고르시게 됩니다(팀 작업 방식).
- **브랜치**: 각 Bolt는 `main`에서 갈라진 짧은 브랜치에서 만들고, 끝나면 Bolt 이름으로 된 커밋 하나로 `main`에 squash-merge합니다(팀 작업 방식).
- **병합 전 확인**: 로컬 검증 명령(테스트 + 린트 + 커버리지)을 통과해야 합니다. 이 명령은 아래 "검증 명령"에서 정합니다.

---

## Bolt 1 — 할 일 API (`bolt-1-todo-api`)

| 항목 | 내용 |
|---|---|
| 포함 단위 | U1 `u1-todo-api` (service, `server/`) |
| 얇은 조각 표시 | 아니요 |
| 스토리 | US1.1, US3.1, US3.2, US4.1, US5.1, US5.2, US5.3, US6.1, US7.3, US8.1, US8.2 의 서버 몫(11개) |
| 맡는 곳 | AI 개발자(`team-allocation.md`) |

**완료 기준 (Definition of Done)**:
- 계약 C1의 API 4개(`GET/POST /api/v1/todos`, `PATCH/DELETE /api/v1/todos/{id}`)가 명세대로 동작하고, 오류 코드 6종이 계약 표대로 나온다.
- 칸 단위 저장: 담당자만 바꾼 요청이 제목·완료를 바꾸지 않고, 완료만 바꾼 요청이 담당자를 바꾸지 않는다는 것을 테스트로 확인한다(ADR-004).
- 저장 실패 시 500 `STORAGE_FAILED`와 이전 데이터 유지, 서버 재시작 후 데이터 유지, 데이터 파일 자동 생성이 테스트로 확인된다.
- 할 일 500건에서 목록 API 95%가 300ms 안(NFR1)인지 측정 결과가 남는다.
- `client/dist`가 없어도 서버가 정상 시작하고 API가 동작한다(C2).
- 저장소 루트의 ESLint·Prettier 설정과 루트 검증 스크립트가 만들어지고, `server/` 테스트·린트가 통과하며 라인 커버리지 80% 이상.

**확인할 가설 (이 Bolt가 증명하는 것)**: 칸 단위 `PATCH`와 SQLite 저장으로 "서로 다른 칸을 동시에 바꿔도 덮어쓰지 않는다"(가장 걱정되는 동시 사용 동작의 서버 쪽 절반, 질문 Q2)가 실제로 성립한다.

**보여 줄 결과**: 서버를 띄운 뒤 API 호출로 할 일 추가 → 담당자 지정 → 완료 표시 → 서버 재시작 후 목록이 그대로인 것, 그리고 같은 할 일에 담당자 변경과 완료 표시를 연달아 보내도 둘 다 남는 것을 테스트 결과로 보여 줍니다.

---

## Bolt 2 — 보드 화면 (`bolt-2-board-web`)

| 항목 | 내용 |
|---|---|
| 포함 단위 | U2 `u2-board-web` (ui, `client/`) |
| 얇은 조각 표시 | 아니요 |
| 스토리 | US1.1, US2.1, US3.1, US3.2, US4.1, US5.1, US5.2, US5.3, US6.1, US6.2, US6.3, US7.1, US7.2, US8.2 의 화면 몫(14개) |
| 앞선 Bolt | Bolt 1 (E2E가 실제 U1 서버를 씀) |
| 맡는 곳 | AI 개발자(`team-allocation.md`) |

**완료 기준 (Definition of Done)**:
- 화면 시안 S1~S11의 상태가 모두 구현되고, 상호작용 명세의 키보드 동작을 따른다.
- 동시 사용 규칙을 가짜 시계·가짜 API로 단위 테스트한다: 10초 갱신과 탭 숨김 시 멈춤, 늦게 온 응답 버리기, 편집 중인 칸 보호, 갱신 실패 표시와 자동 회복(질문 Q2 — 먼저, 더 꼼꼼히).
- 담당자 이름 묶기·자동 완성·필터·개수 요약 계산이 단위 테스트로 확인된다.
- 핵심 흐름 E2E(Playwright): 할 일 추가 → 담당자 지정(자동 완성) → 완료 표시 → 필터로 확인을 실제 U1 서버와 함께 통과한다. 브라우저 두 개로 한쪽 변경이 다른 쪽에 반영되는 E2E 한 건 포함.
- axe 자동 접근성 검사에서 위반 0건(접근성 점검표의 대상 화면).
- `npm run build` 결과가 `client/dist`에 생기고, U1 서버 하나로 화면과 API가 함께 열린다(C2).
- `client/` 테스트·린트 통과, 라인 커버리지 80% 이상. 저장소 루트 검증 명령이 두 단위를 모두 돌리고 통과한다.

**확인할 가설**: 10초 자동 갱신과 편집 보호만으로 팀원 두 명이 같은 보드를 동시에 써도 화면이 예측 가능하게 움직인다(실시간 연결 없이도 충분하다는 요구사항 결정의 확인).

**보여 줄 결과**: `npm start` 하나로 띄운 보드에서 할 일을 추가하고 담당자를 자동 완성으로 지정한 뒤 완료 표시, 두 번째 브라우저 창에 10초 안팎으로 반영되는 모습, 키보드만으로 같은 흐름을 수행하는 모습.

---

## 검증 명령 (각 Bolt 끝의 확인)

저장소 루트에서 실행하는 하나의 명령으로 두 단위의 린트, 단위·통합 테스트, 커버리지 80% 확인, E2E(있을 때)를 모두 돌립니다. 제안: `npm run verify`. 이 명령은 아직 없으며 Bolt 1의 코드 생성에서 만들고 Bolt 2에서 화면 쪽을 추가합니다. 사용 여부는 이 단계의 별도 질문에서 정합니다.
