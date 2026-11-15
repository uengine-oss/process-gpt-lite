---
name: hwpx-proposal
description: 한글(hwpx) 제안서 양식을 office-mcp 로 채워요 — 앞 단계의 평면도를 그림 자리에
kind: step
runs: 서버(lib/mining/worker.js SKILLS hwpx-proposal → lib/mail.js hwpxDraft → office-mcp generate_hwpx)
---

# 한글 제안서 채우기 (hwpx-proposal)

회사의 한글 제안서 템플릿을 office-mcp 의 `generate_hwpx` 로 채워 `<고객> 제안서.hwpx` 를 만들어요.

## 하는 일
1. 앞 단계가 그린 평면도가 있으면 템플릿의 그림 자리에 넣은 템플릿을 먼저 만들어요.
2. 메일의 요구사항을 모두 반영하라고 알려 주고, 표의 행 수는 템플릿 그대로 두고 칸만 이 고객에 맞게 채워요.
3. '공간 구성' 표는 평면도의 실별 면적으로 채워요.

## 결과
- 만든 한글 파일을 이 건의 대화에 올리고, 단계 결과에 남겨요.

## 하지 않는 것
- 그림을 새로 만들지 않아요(그림 생성 · 참조 꺼짐).
