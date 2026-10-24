---
name: youtube-schedule-to-calendar
description: 유튜브 채널의 새 영상에서 경제·산업 일정(실적 발표, 지표 발표, 정책 회의 등)을 찾아 사용자의 Google 캘린더에 중복 없이 등록한다. "○○ 채널 새 영상 일정 캘린더에 넣어줘", "유튜브 영상 보고 주요 일정 달력에 등록", 예약 미션에서 주기적으로 실행할 때 사용한다.
metadata:
  include_tools: youtube_channel_videos youtube_video_info youtube_transcript calendar_find_events calendar_create_event
---

# 유튜브 영상 → 일정 → 캘린더

pgpt-connectors MCP 도구만 쓴다: `youtube_channel_videos`, `youtube_video_info`, `youtube_transcript`, `calendar_find_events`, `calendar_create_event`.
도구 결과에 없는 날짜·시각·수치는 만들지 않는다.

## 입력
요청 본문에 다음이 주어진다.
- `channel`: 채널 핸들(@이름), 채널 ID, 또는 URL
- `seen`: 이미 처리한 영상 ID 목록 (없으면 빈 목록)
- `sectors`: (선택) 관심 섹터. 예: 코스피, 반도체, 환율
- `now`: 현재 시각(KST)

## 절차
1. `youtube_channel_videos(channel, limit=10)`로 최근 영상을 받는다. `seen`에 없는 영상만 새 영상이다. 새 영상이 없으면 6번으로 간다.
2. 새 영상마다 제목(필요하면 `youtube_video_info`의 설명)으로 **일정이 담겼을 가능성**을 판단한다. 실적 발표 예정, 지표·통계 발표, 금리·정책 회의, 상장·청약, 기업 행사 같은 날짜가 언급될 만한 영상만 다음 단계로 보낸다. 나머지는 확인만 하고 넘어간다.
3. 고른 영상은 `youtube_transcript(videoId)`로 받아, **앞으로 다가올** 일정만 뽑는다. 이미 지난 날짜와 막연한 표현("조만간")은 뺀다. 연도가 없으면 `now` 기준으로 가장 가까운 미래 날짜로 정한다.
4. 일정마다 같은 날짜 범위로 `calendar_find_events(timeMin, timeMax, q=핵심 키워드)`를 호출해, 같은 일정이 이미 있으면 건너뛴다.
5. 새 일정만 `calendar_create_event`로 등록한다.
   - `summary`: 이모지 + 짧은 이벤트명. 예: `🇺🇸 ⭐ 미 10월 CPI 발표`, `📊 삼성전자 3분기 실적 발표`
   - `start`: 시각을 알면 `YYYY-MM-DDTHH:mm:00+09:00`, 모르면 `YYYY-MM-DD`(종일)
   - `description`: 판단 포인트 한두 문장 + 관련 섹터 + 출처 영상 URL
6. 마지막 줄에 결과를 **정확히 이 형식 한 줄로** 출력한다(다른 설명 뒤에 붙인다).

```
MISSION_RESULT: {"changed": true|false, "seen_add": ["새로 확인한 영상 ID", ...], "created": [{"date": "...", "summary": "..."}], "summary": "한두 문장 한국어 요약"}
```

- `changed`는 캘린더에 새로 등록한 일정이 하나라도 있을 때만 true다.
- `seen_add`에는 이번에 확인한 새 영상 ID를 **모두** 넣는다(일정이 없던 영상 포함).
- `summary` 예: "새 영상 1개(「…」)를 확인했고, 미 10월 CPI 발표(11/10 22:30)를 새로 등록했습니다." / "새 영상이 없어 등록한 일정이 없습니다."

## 주의
- 같은 실행 안에서 같은 일정을 두 번 만들지 않는다.
- 트랜스크립트가 없으면(`transcript: null`) 그 영상은 확인한 것으로만 처리한다.
- 도구 오류가 나면 해당 영상만 건너뛰고, summary에 무엇이 실패했는지 적는다.
