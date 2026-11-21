---
name: home-action-add
description: 나중에 할 일이나 기억해 둘 일을 홈 화면의 할 일 카드(액션 버튼)로 남겨 둔다. 사용자가 나중에 눌러 처리하는 카드이고, 정한 시각에 알리지 않는다. 알림을 받을 시각이나 주기가 정해져 있으면 schedule-create(서버가 그때 알린다). 패널·앱을 만드는 일은 panel-create, 패널 앱의 목록에 항목을 넣는 일은 panel-record.
metadata:
  kind: action
  version: 1.0.0
  handler: addAction
  args: args.schema.json
  facts: []
  available_when: always
  disclosure: inline
  agent_turn: false
  misroute_cost: medium
---
# 홈 액션 추가

## 인자
- `verb`: 카드의 동사. Remind(기억해 둘 일), Add(더할 일), Reply(답할 일), Pay(낼 돈), Review(검토할 것), Call(연락할 사람).
- `text`: 할 일 한 줄.
- `due`: 사용자가 말한 마감(말 그대로), 없으면 비운다. 카드는 그때 알리지 않는다.
