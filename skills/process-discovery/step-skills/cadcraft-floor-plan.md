---
name: cadcraft-floor-plan
description: 고객 메일에서 매장 배치를 정하고 CADCraft 로 평면도(.dxf)를 그려요
kind: step
runs: 서버(lib/mining/worker.js SKILLS cadcraft-floor-plan → lib/floorPlan.js → CADCraft MCP)
---

# 평면도 그리기 (cadcraft-floor-plan)

## 하는 일
1. 고객 메일(제목 · 내용)에서 실 구성과 크기를 정해요.
2. CADCraft 로 평면도를 그리고 `<고객> 평면도.dxf` 로 저장해요.
3. 파일을 올려 이 건의 대화에 붙여요.

## 결과
- 평면도 파일과 실 목록(실 이름 · 면적 · 용도)을 단계 결과에 남겨요 — 다음 단계(제안서 · 견적서)가 이 면적을 써요.
