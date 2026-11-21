---
name: folder-change
description: 공유 폴더·스킬 폴더, 또는 이 대화에 붙은 폴더 안의 파일을 고치거나 지우거나, 새 파일(첨부한 파일 포함)을 그 폴더에 넣는다. 원본을 바로 바꾸지 않고 변경안을 만들어 폴더 주인이 검토·반영한다. 사실에 「이 대화에 붙은 폴더」가 있으면, 다른 폴더를 말하지 않은 채 문서·파일의 내용을 바꾸거나 더해 달라는 요청은 그 폴더의 변경이다(folder: attached). 그 밖에는 사실의 「변경을 제안할 수 있는 폴더」를 가리킬 때 쓴다. 폴더 내용에 대한 질문, 폴더 자료를 읽고 새 문서를 따로 써 달라는 일, 폴더와 상관없는 파일 작성은 delegate. 패널 앱에 항목을 넣는 일은 panel-record.
metadata:
  kind: action
  version: 1.0.0
  handler: folderChange
  args: args.schema.json
  facts: [folders, attached_folder]
  available_when: folder_change_possible
  disclosure: inline
  agent_turn: true
  misroute_cost: medium
---
# 폴더 변경안

## 언제 쓰나
- 그 폴더 안의 파일 자체를 바꾸거나 그 폴더에 새 파일을 저장하라고 한다.

## 쓰지 않나
- 폴더 파일을 읽고 묻거나 요약해 달라고 한다 → delegate.
- 폴더 자료를 바탕으로 새 문서를 만들어 받기만 한다 → delegate.
- 폴더를 말하지 않았고 이 대화에 붙은 폴더도 없다 → delegate.

## 인자
- `folder`: 사실에 적힌 폴더 slug(스킬 폴더는 `skill:<이름>`), 또는 이 대화에 붙은 폴더면 `attached`.
