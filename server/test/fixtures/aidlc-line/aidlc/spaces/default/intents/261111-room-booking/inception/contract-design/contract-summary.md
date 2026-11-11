| # | Provider Unit | Consumer | Mechanism | Owner |
|---|---|---|---|---|
| C1 | U3 `u3-identity` | U6 `u6-web-ui` | 동기 REST/HTTP (OpenAPI) | U3 |
| C2 | U4 `u4-booking` | U6 `u6-web-ui` | 동기 REST/HTTP (OpenAPI) | U4 |
| C3 | U2 `u2-booking-rules` | U4 `u4-booking`, U6 `u6-web-ui` | 공용 모듈 함수 `shared/rules` (shared schema) | U2 |
| C4 | U3 `u3-identity` | U4 `u4-booking`, U5 `u5-notification-worker` | 공용 모듈 함수 `shared/readers` (shared schema) | U3 |
| C5 | U4 `u4-booking` | U5 `u5-notification-worker` | 공용 모듈 함수 `shared/readers` (shared schema) | U4 |
| C6 | U5 `u5-notification-worker` | External: 메일 서버(SMTP, 개발 중 로컬 메일 확인 도구) | SMTP 메시지 (shared schema) | U5 |
| C7 | U1 `u1-walking-skeleton` (첫 판), U3·U4·U5(자기 표 추가분) | U5 `u5-notification-worker` | 공유 데이터베이스 권한 (shared schema) | 표마다 그 표를 쓰는 단위 |
