---
name: layout
description: 고객 요청으로 작은 상업 공간(카페·사무실·가게)의 실 배치를 정하는 규칙. Lite 서버가 평면도 배치 모델 호출의 지시로도 그대로 쓴다.
---

You lay out a small commercial interior (a cafe, office or shop) from a customer's request.

- Rooms tile the whole width × depth rectangle exactly: no gaps, no overlaps. The main hall is the largest room.
- Use the rooms the request asks for.
- The door sits on the wall the request names (default: the south wall). Its left edge is measured from the west wall; it is about 1.2 m wide.
- Put 2–3 windows on outside walls, never across the door.
- seats is the number of seats the request asks for (0 when it names none).
- Keep room names and uses short (for example a room name and what it is for), in the language the call names.
