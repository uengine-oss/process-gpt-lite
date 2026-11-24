---
name: daily-background
description: Home 의 날짜 · 날씨 패널이 그날 추천하는 배경 사진의 주제표 — 24절기 · 계절 · 시간대 · 날씨 · 무드마다 붙일 이름과 사진을 찾을 말. 회사마다 고쳐 쓴다.
---

# 오늘의 배경 사진

Process GPT Lite 의 배경은 기본이 움직이는 하늘입니다. Home 의 날짜 · 날씨 패널은 그날에 어울리는 사진 몇 장을 함께 추천하고,
사람이 고르면 그 사진이 그 사람의 배경이 됩니다. 이 스킬은 「그날에 어울리는」을 정하는 표입니다. 서버는 회사의 스킬 폴더
(`daily-background`)를 먼저 찾고, 없으면 Lite 와 함께 온 이 기본 판을 씁니다. 회사의 판이 빠뜨린 칸은 기본 판의 값을 씁니다.

모델은 쓰지 않습니다. 날짜와 날씨 코드를 주제로 옮기는 일은 달력 계산이기 때문입니다(`server/lib/background/calendar.js`).

## 절차

1. **그날**: 날짜(그 사람의 날짜) → 24절기(태양 황경, 한국 표준시) → 계절의 때(초겨울 = 입동 · 소설). 시각 · 해의 고도 → 시간대
   (새벽 · 아침 · 한낮 · 해 질 녘 · 밤). 날씨 코드(Open-Meteo WMO) → 맑음 · 구름 조금 · 흐림 · 안개 · 비 · 눈 · 뇌우.
2. **주제**(`rules.json`): 절기 둘(`terms.<절기>` 가운데 날짜로 고른 차례) · 시간대 하나(`parts`) · 날씨 하나(`weather`) · 계절 하나
   (`seasons`) · 오늘의 사진(`potd`, Wikimedia Commons 의 Picture of the Day) · 멋진 풍경 한 장(`landscape`, 날마다 무작위).
   무드를 고르면(`moods`: 차분 · 따뜻 · 시원 · 활기) 그 무드의 주제 둘이 앞에 오고, 나머지는 그 무드가 붙은 주제부터 놓는다.
3. **사진 찾기**: 주제마다 `q`(검색 낱말)와 `cats`(Commons 의 「Featured pictures of …」 분류)로 Wikimedia Commons 를 찾는다.
   `{word}` 는 계절 낱말(spring · summer · autumn · winter), `{season}` 은 계절의 때 이름이다. 낱말을 넣어 찾은 사진이 모자라면
   낱말 없이 분류만으로 다시 찾는다. 회사 관리자가 Unsplash · Pexels 키를 넣었으면 주제 몇 개는 `keywords` 로 그 사이트에서 찾는다.
4. **고르기**: 가로로 넓고(`commons.ratio`), 원본이 충분히 크며(`commons.minWidth`), 다시 써도 되는 라이선스(CC0 · 퍼블릭 도메인 ·
   CC BY · CC BY-SA · FAL · KOGL 제1유형)이고, 제한 표시(초상권 · 상표 등)가 없는 사진만 쓴다. 같은 날 같은 회사에는 같은 사진이
   나오도록 날짜로 정한 차례로 고른다. 모두 합쳐 `counts.min`~`counts.max` 장.

## 고칠 때

- 이름(`label` · `label_en`)은 화면의 사진 아래에 그대로 나온다. 짧게(열두 자 안팎).
- `moods` 는 그 주제가 어울리는 무드다. 무드를 고르면 이 값으로 순서를 정한다.
- 분류 이름은 Commons 에 있는 것이어야 한다(예: `fog` → `Category:Featured pictures of fog`). 없는 분류는 사진이 없을 뿐 오류는 아니다.
