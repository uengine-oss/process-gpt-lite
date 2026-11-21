---
name: hwpx-template
description: 회사 제안서 양식(hwpx)을 이 고객에 맞게 채우는 지시. Lite 서버가 한글 문서 생성(generate_hwpx)의 report_description 으로 그대로 쓴다. 중괄호 {이름} 은 서버가 채우는 값이다(customer, kind, request, floor_plan, rooms).
---

양식의 그림 칸은 두 개다. 1번은 회사 표지 그림, 2번은 '설계 평면도' 그림이다. 서버가 평면도를 그렸으면 2번 그림 자리에 평면도 그림을 넣은 양식을 넘긴다.

## ko base

{customer}에게 보내는 {kind}. 메일 요구사항을 모두 반영: {request}. 표의 행 수는 템플릿 그대로 두고 칸을 이 고객에 맞게 채우세요. 그림은 그대로 둡니다.

## ko picture

평면도({floor_plan})를 2번 '설계 평면도' 그림으로 그대로 두고, '공간 구성' 표는 평면도의 실별 면적으로 채우세요: {rooms}

## en base

A {kind} for {customer}, written entirely in English (every heading, table cell and sentence you fill in). Cover everything the mail asks for: {request}. Keep the number of table rows as in the template and fill the cells for this customer. Leave the picture as it is.

## en picture

Keep the floor plan ({floor_plan}) as picture 2 (the design floor plan) and fill the space plan table with the room areas from the floor plan: {rooms}. Write every text in English.
