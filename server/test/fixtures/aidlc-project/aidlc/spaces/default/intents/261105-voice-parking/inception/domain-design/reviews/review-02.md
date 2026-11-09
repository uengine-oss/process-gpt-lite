## Review

**Verdict:** READY
**Reviewer:** aidlc-architecture-reviewer-agent
**Date:** 2026-11-05T09:23:05Z
**Iteration:** 1
**Verdict Dictated:** no

### Findings

| ID | Severity | Location | Finding | Required action | Status |
|---|---|---|---|---|---|
| R-01 | Major | aidlc/spaces/default/intents/261105-voice-parking/inception/domain-design/components.md > component Notification (behaviour, depends_on, entities.Subscription) | Notification의 behaviour는 "재구독 시 현재 예약 상태를 먼저 보낸다"고 하고 Subscription이 Reservation 엔티티를 참조한다. 그런데 Notification의 depends_on은 []이다. 현재 상태를 보내려면 Notification이 Reservation을 조회해야 하며, 그러면 Reservation→Notification(event)과 합쳐 순환이 생긴다. 지금의 비순환 그래프는 이 숨은 호출을 빼서 성립한다. | 재구독 시 현재 상태를 누가 공급하는지 정한다. 예: Reservation이 상태 스냅샷을 Notification에 함께 밀어 넣어 Notification이 Reservation을 호출하지 않게 하거나, 의도된 순환으로 선언하고 Rationale과 ADR에 남긴다. depends_on/dependents와 다이어그램을 이에 맞춘다. | Resolved (reviewer) |
| R-02 | Major | aidlc/spaces/default/intents/261105-voice-parking/inception/domain-design/decisions.md > ADR-003 Consequences vs ADR-002 Decision | ADR-002는 상태 확정을 Reservation 한 곳에서만 한다고 하나, ADR-003 Consequences는 "Payment가 웹훅 처리 시 Reservation의 상태를 보고 무시한다"고 적었다. components.md의 Payment 의존 설명도 "현재 예약 상태를 확인한다"고 한다. Payment가 상태를 읽고 판단한 뒤 반영하면 읽기와 확정 사이에 180초 자동 취소가 끼어드는 경합이 생기고, 단일 확정 지점 주장과 어긋난다. Payment도 자체 status를 가져 예약 상태와 이중 관리 소지가 있다. | 승인 반영을 Reservation의 단일 원자 연산(승인 시도 시 이미 취소면 거부 결과 반환)으로 정의하고, Payment는 그 결과로만 무시 여부를 기록하도록 ADR-003과 Payment 상호작용 문구를 고친다. Payment.status와 Reservation.status의 관계(파생인지 독립인지)를 한 줄로 밝힌다. | Resolved (reviewer) |
| R-03 | Minor | aidlc/spaces/default/intents/261105-voice-parking/inception/domain-design/components.md > external_dependencies (Recommendation, Reservation, Payment) | 세 컴포넌트가 같은 이름 "내장 DB 또는 인메모리 저장소"를 외부 의존성으로 적어 하나의 공유 저장소로 읽힌다. 마이크로서비스 방침(팀 규칙)과 컴포넌트별 데이터 소유 원칙에 반하는 해석이 가능하다. Notification의 Subscription은 저장 방식 언급이 없다. | 컴포넌트마다 자기 저장소임을 이름이나 purpose에 분명히 하고(예: 공유 아님), Subscription의 보관 위치(ADR-004의 서버 메모리)도 외부 의존성 또는 비고로 맞춘다. | Unresolved |
| R-04 | Minor | aidlc/spaces/default/intents/261105-voice-parking/inception/domain-design/decisions.md > ADR-001~005 | 인셉션 규칙은 주요 결정마다 보안·규정 영향을 다루라고 한다. 웹훅 비밀 값 검증과 세션 단위 익명 식별은 components.md에 있으나 ADR-002/003/004 어디에도 보안 영향 항목이 없다. ADR-004와 ADR-005는 다른 단계의 질문 번호([Q6], Q2)를 인용해 이 단계 출처 목록에서 추적되지 않는다. | ADR-002/003에 웹훅 위변조·재전송 영향을, ADR-004에 구독이 예약 ID와 세션에 묶이는 접근 통제 영향을 Consequences에 한 줄씩 추가한다. 인용한 질문의 출처 문서를 명시한다. | Unresolved |
| R-05 | Minor | aidlc/spaces/default/intents/261105-voice-parking/inception/domain-design/components.md > QueryParser/Recommendation dependents, Assumptions (sessionId) | 요청의 진입 책임이 불분명하다. Recommendation이 원문 문장을 받아 QueryParser를 호출하는 구조라 추천이 입력 형식에 묶이고, 입력 부족 안내를 누가 화면에 돌려주는지, sessionId를 누가 만들고 전달하는지 정해져 있지 않다(AC1.1.4). Reservation이 Notification에 의존하는 방향도 발행자가 구독자에 의존하는 모양이다. | Functional Design 이전에 진입점(호출 순서의 조정자)과 sessionId의 출처를 Open Questions에 명시하거나, QueryParser 결과를 Recommendation 입력으로 받는 구조가 더 나은지 한 줄로 기록한다. | Unresolved |
| R-06 | Minor | aidlc/spaces/default/intents/261105-voice-parking/inception/domain-design/components.md > Reservation entities > Reservation attributes | Reservation 엔티티가 ParkingPass를 참조한다고 선언했지만 속성 목록에 `passId`가 없다. 대기 예약 생성 시 어떤 주차권인지 담을 자리가 없다. | 속성에 `passId`를 추가하거나, 참조가 어떤 속성으로 표현되는지 적는다. | New |
| R-07 | Minor | aidlc/spaces/default/intents/261105-voice-parking/inception/domain-design/components.md > Reservation behaviour, Notification behaviour | 스냅샷을 이벤트로 밀어 넣는데 순서를 가리는 값(버전이나 순번)이 없다. 늦게 도착한 오래된 스냅샷이 `lastSnapshot`을 덮어쓸 수 있다. 예를 들어 완료 뒤에 대기 스냅샷이 오면 재구독자가 대기 상태를 받는다. | Reservation 스냅샷에 단조 증가하는 버전을 두고 Notification은 더 높은 버전만 보관한다는 규칙을 Functional Design에서 정하도록 열린 질문에 적는다. | New |

> R-01 Reviewer note: Notification의 depends_on이 `[]`이고 Reservation이 상태 스냅샷을 밀어 넣으며, Notification은 최근 스냅샷(`Subscription.lastSnapshot`)을 보관해 재구독 시 재전송한다. Notification에서 Reservation으로 가는 호출은 더 이상 없다. 그래프는 Payment→Reservation→{Recommendation→QueryParser, Notification}이며 순환이 없다.

> R-02 Reviewer note: 원자 연산 `applyPaymentResult`가 Reservation에 정의되어 있다. 결제 대기일 때만 "적용됨"이고 아니면 "거부됨(현재 상태 포함)"을 돌려준다. Payment는 상태를 먼저 읽지 않고 거부됨이면 무시 기록만 한다. `Payment.status`(PG 결과 기록)와 `Reservation.status`(기준)의 관계가 components.md와 ADR-002/003/004에서 서로 일치한다.

> R-03 Reviewer note: 사람의 선택에 따라 이번에 처리하지 않았다.

> R-04 Reviewer note: 사람의 선택에 따라 이번에 처리하지 않았다.

> R-05 Reviewer note: 사람의 선택에 따라 이번에 처리하지 않았다.

### Validation Tool Results

| Tool | Result | Interpretation |
|---|---|---|
| 수동 yaml 규칙 점검 | PASS | 컴포넌트 이름이 모두 고유하고 선언되어 있다. 자기 의존이 없고 depends_on과 dependents가 대칭이다. 엔티티마다 소유자와 identifier가 하나씩이다. 참조는 소유자 아래에 선언되어 있다. 그래프는 비순환이며 인프라는 external_dependencies에만 있다. |

### Summary

R-01과 R-02는 해소되었다. 그래프는 단방향이고 원자 연산이 확정 지점을 하나로 만들며 ADR과 components.md가 일치한다. 남은 Minor 항목(R-03~R-05와 새 두 건)은 승인을 막지 않는다.
