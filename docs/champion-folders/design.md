# 챔피언 폴더 — 설계 (Process GPT Lite, 2026-11-26)

대상 저장소: `process-gpt-lite` (origin/main `97d77b1`, SQL 은 055 까지). 구현 · 커밋 없음, 설계만.
바탕 조사: 조사 메모(저장소에 두지 않음) (이 문서가 기대는 것은 저장소에서 다시 확인함 — 끝의 「확인한 것」).

---

## 0. 한눈에

**챔피언 폴더** = 에이전트를 잘 쓰는 사람이 자기 PC 에서 쓰던 폴더(스킬 · 명령 · 지침 · 스펙이 든 「일하는 맥락 덩어리」)를 데스크톱 앱에서 골라 Lite 의 **관리형 공유 폴더**로 올리고 맞춰 두는 것. 그 뒤는 이미 있는 것들이 받는다.

```
챔피언 PC                         Lite 서버 (테넌트)                       동료 PC
┌───────────────┐  올리기(자동)   ┌──────────────────────────┐  일 가지 push   ┌──────────────────┐
│ 고른 폴더      │ ─────────────▶ │ 관리형 폴더 (git, main)   │ ◀───────────── │ 앱 데이터 아래    │
│ (.git 안 만듦) │ ◀───────────── │  ├ 변형 var/u/<사람>/…    │ ─────────────▶ │ 변형 작업 트리    │
│ 그림자 저장소  │  받기(눌러서)  │  ├ 에이전트 자산(스킬 표) │  clone/fetch   │ 자기 CLI(Claude · │
│ (앱 데이터)    │                │  ├ 일괄 반영 → main       │                │ Codex) 세션       │
└───────────────┘                │  └ 넘기기 요청 · 수락     │                └──────────────────┘
                                  └──────────────────────────┘
```

| 요청의 말 | 이 설계에서 | 새로/재사용 |
|---|---|---|
| 「폴더를 선택을 하면 … 우리 폴더 서버에 있는 폴더로 동기화」 | 데스크톱의 폴더 고르기 + 그림자 저장소 + 동기화 토큰 → 관리형 폴더 main | 데스크톱 새로, 서버는 `gitHttp` · `bringIn` 재사용 |
| 「.claude … 각 플랫폼별 스킬이 포함된 폴더가 … 같이 동반」 | 폴더 안의 것은 그대로 실려 가고, 서버가 찾아 「에이전트 자산」으로 보여 줌. 전역 스킬은 골라서 붙임 | 발견은 새로, 붙이기 · 전사 공유는 `folders/skills.js` |
| 「공개할 수 있는 기능」 | 구성원(지금 있음) · 회사 전체(새로) · 스킬만 | `roleOf` 한 곳 확장 |
| 「포워드 … 그 사람의 CLI 클라이언트에서 할 일감으로 등록 … accept」 | `handover.js` + 요청 상태(REQUESTED → ACCEPTED/REJECTED) + 로컬 일 종류 `handover` | 인계 · 로컬 일 큐 재사용, 수락만 새로 |
| 「워크트리를 각자가 만들어서 기존에 있던 어떤 스펙대로」 | 사람 × 일 = 변형 하나 = 그 PC 의 작업 트리 하나. 스펙은 폴더에 든 것을 CLI 가 읽고, 넘길 때 「따를 스펙」을 가리킴 | 변형 · 일괄 반영 재사용 |

**연결형(`POST /api/folders/link`)은 쓰지 않는다.** 챔피언의 폴더는 챔피언 PC 에 있고, 서버에는 관리형 폴더가 새로 생긴다(그래야 git HTTP · 변형 · 반영 · 색인이 모두 붙는다).

---

## 1. 사용자 이야기

### 1.1 챔피언 — 올리기
1. 박챔피언이 데스크톱 앱 「폴더」에서 **「내 PC 폴더 올리기」**를 누른다 → 운영체제의 폴더 고르기 창.
2. 앱이 폴더를 훑어 **미리 보기**를 보여 준다: 올릴 것(파일 수 · 크기 · 위 단계 나무), 뺀 것과 까닭(「`.gitignore` 가 뺌」 「비밀로 보임」 「개인 설정」 「큰 파일」 「안에 다른 git 저장소」), **확인이 필요한 파일**(열쇠처럼 생긴 글이 든 파일), **찾은 에이전트 자산**(「Claude Code 스킬 6 · 명령 4 · CLAUDE.md」 「Codex AGENTS.md」 「Cursor 규칙 2」 「OpenSpec 스펙 12」).
3. 이름과 공개 범위(기본 「나만」)를 정하고 「올리기」 → 시스템 창이 한 번 더 묻는다(「파일 214개(3.1 MB)를 uengine.process-gpt.io 의 폴더 '영업 제안 키트'로 올립니다」) → 올라감.
4. 폴더 화면에 「에이전트 자산」 탭이 생긴다. 그 뒤로 챔피언이 **하던 대로 자기 터미널에서** 일하면 바뀐 것이 저절로 올라간다(1단계부터).

### 1.2 챔피언 — 공개
- **고른 동료에게**: 지금의 공유 시트(`ShareSheet.vue`, viewer · runner · editor) 그대로.
- **회사 전체에**: 「회사에 공개」 — 모두가 보고(viewer), 챔피언이 허락하면 「써 보기」(runner: 자기 변형을 만들어 일해 봄). 폴더 목록에 「회사에 공개된 폴더」 칸.
- **스킬만**: 폴더는 닫아 둔 채 고른 스킬을 「회사 스킬로 올리기」 → 지금의 스킬 공유 흐름(비공개 초안 → 작성자가 「전사에 공유」).
- **전역 스킬도**: `~/.claude/skills` 등 PC 전체에 깔아 둔 스킬을 골라 이 폴더에 **붙인다**(폴더에 파일을 더하지 않음, §4.3).

### 1.3 동료 — 받아 쓰기
- 김동료가 공개된 폴더를 열어 자산을 읽고, **「내 PC 에서 써 보기」** → 서버가 김동료의 변형(`var/u/<김동료8>/…`)을 만들고 데스크톱 앱이 그 변형의 작업 트리를 준비 → 김동료의 Claude Code 나 Codex 가 그 안에서 폴더의 `CLAUDE.md` · `AGENTS.md` · 스킬 · 명령을 **스스로** 읽는다.
- 데스크톱 앱이 없으면: 웹에서 읽기 · 스킬을 회사 스킬로 받아 서버 에이전트로 쓰기.

### 1.4 넘기기(포워드) — 수락 — 이어서
1. 박챔피언이 자기 폴더에서 견적 정리를 하다가 「넘기기」: 받는 사람(김동료), **지금까지 한 일 · 다음에 할 일**, **따를 스펙**(폴더에서 찾은 스펙 · 변경 중 고르기, 또는 경로), 붙일 맥락(이 일의 대화 · CLI 기록)을 고른다.
2. 앱이 먼저 폴더를 올리고(최신 상태), 서버가 김동료의 변형과 **요청(REQUESTED)** 을 만든다.
3. 김동료에게: Home 카드 「박챔피언 님이 일을 넘겼어요」 + 데스크톱 알림 · 트레이 숫자 + 「받은 일」.
4. 김동료가 **「수락하고 시작」**(자기 PC 의 Claude Code/Codex 가 자기 작업 트리에서 첫 프롬프트로 시작) · **「수락만」**(작업 트리만 준비, 나중에 시작하거나 자기 터미널에서) · **「거절」**(까닭 적기 → 박챔피언에게 되돌아감).
5. 김동료의 실행은 지금의 로컬 실행과 같다: 「대화/터미널」 보기, 다른 사람은 보기 · 제안, 입력은 김동료만. 끝나면 결과가 변형에 올라가고 박챔피언에게 「반영할 변형이 있어요」.
6. 박챔피언(편집자 이상)이 지금의 **일괄 반영**으로 main 에 넣는다 → 박챔피언 PC 에 「받을 변경 7개 — 받기」.
7. 김동료가 다시 이민수에게 넘길 수도 있다(이어받기 · 갈래 만들기 — 지금의 인계와 같음).

---

## 2. 내 폴더 동기화 (가장 큰 새 조각)

### 2.1 결정 요약

| 항목 | 결정 | 까닭 |
|---|---|---|
| 저장소 | **그림자 저장소 하나로 통일**: `GIT_DIR=<앱 데이터>/local-agents/sync/<서버10>/<폴더id>.git`, `GIT_WORK_TREE=<고른 폴더>`. 고른 폴더가 이미 git 이어도 같다 — 그 사람의 `.git` · 원격 · 가지 · 설정은 **읽지도 쓰지도 않는다** | 사람 폴더에 아무것도 만들지 않음. 그 사람 저장소의 **지난 이력**(지운 비밀이 남아 있을 수 있음)이 올라가지 않음. 길이 하나라 시험이 하나 |
| 방향 | **올리기는 자동, 받기는 눌러서**(폴더마다 「자동으로 받기」 스위치, 기본 끔) | 「동기화」의 기대를 채우되 남이 바꾼 것이 내 폴더에 말없이 들어오지 않게 |
| main 의 주인 | 원본 PC(들)와 웹 편집이 main 을 만든다. 동료의 에이전트 작업은 **변형 → 일괄 반영**으로만 main 에 | push 가드 · 반영 화면 · 충돌 화면을 그대로 씀 |
| 올리는 가지 | 기기마다 고정 가지 하나 `pgpt-agent/sync-<기기8>/main` (늘 앞으로만) | 지금 `refusals` 의 접두사 규칙 그대로(지우기 · 태그 · main 직접 push 거절), 가지가 쌓이지 않음 |
| 충돌 | 사람 폴더에 충돌 표시를 **남기지 않는다**. 병합 계산은 앱 데이터의 임시 작업 트리에서, 겹친 파일은 파일마다 고르기 | 비파괴 |
| 지우기 | 받기로 지워질 파일은 지우지 않고 앱의 휴지통 폴더로 옮김(30일) | 비파괴 |
| 경로 | 서버 · 페이지는 PC 의 경로를 **정하지도 알지도 못한다**(이름표 = 폴더 이름만) | 지금 스펙의 「이 컴퓨터의 경로가 들어가지 않는다」와 같은 줄 |

(조사 문서는 「이미 git 인 폴더에는 원격만 더하기」를 권했으나, 지난 이력의 비밀 · 사람의 `.git/config` 를 건드리는 점 때문에 그림자 저장소 하나로 좁혔다. 「내 git 이력을 그대로 쓰기」는 §9 Q3.)

### 2.2 올리기 한 바퀴 (데스크톱 `desktop/src/runner/sync.js` 새로, `git.js` 의 인증 · 환경 재사용)

1. **훑기**: 그림자 저장소에서 `git add -A --dry-run` 에 해당하는 목록(폴더 자신의 `.gitignore` 를 git 이 따름) + 앱의 제외(§2.4) + 비밀 검사(§7.1).
2. **스냅숏 커밋**: 그림자 색인에 `add -A` → 커밋(작성자 = 그 사람, 메시지 「동기화 · <기기 이름>」). 사람 폴더의 파일은 읽기만 한다.
3. **서버와 맞추기**: 링크로 동기화 토큰을 받아 `fetch origin main`.
   - 서버 main 이 내 지난 올리기 그대로면 → 그대로 push.
   - 서버 main 이 앞서 있으면 → **임시 작업 트리**(앱 데이터)에서 `내 스냅숏 + origin/main` 병합을 계산.
     겹침 없음 → 병합 커밋을 올림(내 폴더의 파일은 아직 안 바뀜 — 「받을 변경 N개」로 남음).
     겹침 있음 → 올리기를 멈추고 「서로 바뀐 파일 N개」(§2.5). 겹치지 않은 내 변경은 다음 바퀴에 올라간다.
4. **push** `pgpt-agent/sync-<기기8>/main` → 링크로 `sync:pushed {folderId, head, report}`.
5. **서버**: 폴더 직렬 잠금 안에서 `commitMainNow`(웹에서 고친 것 먼저 커밋) → 그 머리를 main 으로 **앞감기, 아니면 병합, 겹치면 main 은 그대로** — 지금 `localAgents/chat.js` 의 `bringIn`(내 PC 폴더 main 쪽)을 `folders/line.js` 로 꺼내 함께 쓴다 → 색인 다시 → 다른 원본 PC 에 `sync:changed`.

언제: 파일이 바뀌고 조용해진 뒤(기본 60초, 폴더 지켜보기 + 5분마다 확인), 앱이 켜질 때, 넘기기 직전(반드시), 「지금 올리기」.

### 2.3 받기

- 서버가 `sync:changed` 를 보내거나 앱이 켜질 때 fetch → 「받을 변경 N개」(파일 목록 · 누가 · 어느 변형의 반영인지).
- 「받기」: 임시 작업 트리에서 병합을 계산 → **바뀔 파일만** 사람 폴더에 쓴다. 쓰기 직전에 폴더를 다시 스냅숏해 그 사이 사람이 고친 파일은 건너뛴다(겹침으로). 지워질 파일은 휴지통으로. 받은 뒤 「되돌리기」(직전 스냅숏으로 그 파일들만).
- 첫 받기와 「자동으로 받기」를 켤 때는 **시스템 창**으로 확인(페이지의 단추만으로는 사람 폴더에 쓰지 못한다).
- `reset --hard` · `clean` · `checkout .` 은 사람 폴더에 대해 코드에 존재하지 않는다(동기화 모듈은 `git.js` 의 `branch()` 를 부르지 않음 — 단위 시험으로 고정).

### 2.4 무엇이 올라가고 무엇이 빠지나

올라감(기본): 폴더의 파일 전부 — **`.claude/skills` · `.claude/commands` · `.claude/agents` · `.claude/settings.json` · `CLAUDE.md` · `AGENTS.md` · `.codex/skills` · `.codex/prompts` · `.agents/skills` · `.cursor/rules` · `GEMINI.md` · `.github/copilot-instructions.md` · `openspec/` 등을 포함**. (지금 일 폴더의 제외 목록 — `skills.js:18` 의 `.claude/` · `CLAUDE.md` · `AGENTS.md` — 은 「회사 스킬을 일 폴더에 놓을 때」의 것이라 그림자 저장소에는 쓰지 않는다.)

빠짐(그림자 저장소의 `info/exclude` 에 — 사람 폴더에는 파일을 쓰지 않음):

| 갈래 | 기본 제외 | 미리 보기의 말 |
|---|---|---|
| 폴더가 이미 뺀 것 | 폴더의 `.gitignore` | 「이 폴더가 빼 둔 것」 |
| 비밀 | `.env` · `.env.*`(`.env.example` 은 올림) · `*.pem` · `*.key` · `*.p12` · `*.pfx` · `id_rsa*` · `id_ed25519*` · `.npmrc` · `.netrc` · `.pypirc` · `*.keystore` · `credentials.json` · `service-account*.json` · `.aws/` · `.ssh/` | 「비밀로 보여 뺐어요」 |
| 개인 설정 · 기록 | `.claude/settings.local.json` · `.claude/.credentials.json` · `.claude/projects/` · `.claude/todos/` · `.claude/worktrees/` · `.codex/auth.json` · `.codex/sessions/` · `.codex/history.jsonl` · `.cursor/mcp.json` · `.vscode/` · `.idea/` | 「내 PC 에만 두는 설정」 |
| 다시 만들 수 있는 것 | `node_modules/` · `.venv/` · `venv/` · `__pycache__/` · `.next/` · `target/` · `.gradle/` · `.DS_Store` · `Thumbs.db` | 「다시 만들 수 있는 것」 |
| 큰 파일 | 파일 하나 50 MB 넘음(폴더 설정으로 조정, 한 번의 push 는 서버 상한 200 MB) | 「큰 파일 — 올리지 않음」 |
| 구조 | 안에 든 다른 git 저장소(하위 폴더의 `.git`) · 폴더 밖을 가리키는 심볼릭 링크 | 「따로 관리되는 폴더」 「폴더 밖을 가리킴」 |
| 확인 필요 | `.mcp.json` · 내용 검사에 걸린 파일(§7.1) | 「확인이 필요해요」 — 빼기 / 그래도 올리기 |

- 이 목록은 파일 이름 · 형식의 **구조** 검사다(사람 말의 뜻을 읽는 것이 아님). 미리 보기에서 사람이 폴더 · 파일 단위로 더 빼거나 넣을 수 있고, 그 선택은 그 PC 의 등록부에만 남는다.
- 빈 폴더는 git 이 싣지 않는다(미리 보기에 알림). LFS 는 쓰지 않는다.

### 2.5 충돌 · 오프라인 · 그 밖

| 상황 | 동작 |
|---|---|
| 같은 파일을 양쪽이 고침 | 파일마다 「내 것 유지」 「서버 것 받기」 「둘 다 두기」(서버 것을 `이름 (서버).확장자` 로). 글 파일은 양쪽 차이를 보여 줌. 고르기 전까지 그 파일만 멈추고 나머지는 흐름 |
| 오프라인 | 스냅숏 커밋은 계속 쌓이고, 연결되면 한 번에 올림. 받기는 연결 뒤 |
| 서버가 거절(비밀 · 권한 · 크기) | 그 올리기 전체가 들어가지 않음(`sync:refused {why, paths}`) → 폴더 상태 「멈춤」과 까닭. 서버는 그 가지를 직전 머리로 되돌려 둔다 |
| 권한이 내려감(편집자 → 보기) | 올리기 멈춤(「이제 올릴 수 없어요」), 받기는 계속 |
| 폴더를 옮김 · 지움 | 「폴더를 찾을 수 없어요 — 다시 고르기 / 연결 끊기」. 서버 폴더는 그대로 |
| 연결 끊기 | 그림자 저장소만 지움. 사람 폴더 · 서버 폴더는 그대로 |
| 다른 사람이 같은 앱에 로그인 | 앞 사람의 연결은 멈춤(다른 사람의 이름으로 올라가지 않음). 로그아웃 = 멈춤 |
| 둘째 PC | 「이 PC 에도 두기」: 빈 폴더를 골라 받음(같은 구조, 기기마다 자기 가지) |
| 이미 있는 Lite 폴더에 합류 | 서버 폴더가 비어 있지 않으면 내 폴더의 내용은 main 이 아니라 **변형(`imported`)** 으로 올라가 일괄 반영으로 합친다(변형 종류 `imported` 는 이미 있음) |

### 2.6 스펙 변경 (명시)

**`openspec/specs/local-agents/spec.md` — MODIFIED** 「데스크톱의 실행은 정해진 CLI · 자기 폴더 · 그 사람의 일로만」(:282)

- 지금: 「일은 앱의 데이터 폴더 아래 인스턴스 폴더에서만 하고, 그 밖을 가리키는 산출 폴더는 거절한다.」
- 바꿈: 「서버가 보낸 일(단계 · 채팅 · 넘겨받은 일)은 앱의 데이터 폴더 아래 작업 폴더(인스턴스 폴더 · 대화 폴더 · **변형의 작업 트리**)에서만 하고, 그 밖을 가리키는 산출 폴더는 거절한다. **사람이 고른 폴더에서는 서버가 보낸 일을 돌리지 않는다.** 변형의 작업 트리는 일과 일 사이에 남으며, 앱은 그 안의 저장하지 않은 것을 버리지 않는다(되돌리기 · 치우기 없이, 있는 그대로 커밋해 올린다).」
- 시나리오 추가: 「넘겨받은 일은 그 변형의 작업 트리에서」 「작업 트리에 손으로 고친 것이 있으면 버리지 않고 함께 올린다」.

**새 스펙 `openspec/specs/champion-folders/spec.md` — ADDED** (요구사항 제목만)

1. 사람은 이 컴퓨터의 폴더를 시스템 창에서 골라 공유 폴더로 올린다(서버 · 페이지는 경로를 정하거나 알 수 없다).
2. 올리기 전에 무엇이 올라가는지 보여 주고 동의를 받는다.
3. 비밀 · 개인 설정 · 큰 파일은 올라가지 않는다.
4. 고른 폴더에는 동기화만 닿는다 — 읽기, 그리고 사람이 받겠다고 한 변경의 쓰기(되돌리기 · 치우기 · 지우기 없음, 사람의 git 에 손대지 않음).
5. 받기는 사람이 누르거나 켜 둔 때만, 겹친 파일은 사람이 고른다.
6. 폴더 안의 에이전트 자산을 찾아 보여 준다.
7. 폴더를 회사에 공개할 수 있다.
8. 일을 넘기면 받는 사람이 수락 · 거절한다.
9. 수락한 일은 받는 사람의 변형 · 작업 트리에서 이어진다.
10. 다른 사람이 만든 폴더의 실행 설정은 그 컴퓨터의 사람이 확인한 뒤에만 돈다.

**`openspec/specs/folder-git-remote/spec.md` — MODIFIED** 「에이전트가 올릴 수 있는 것은 자기 가지뿐이다」: 데스크톱의 동기화 토큰(기기 · 폴더, 일 없음)도 자기 기기의 동기화 가지만, 요청마다 그 사람의 폴더 역할을 본다.

---

## 3. 넘기기 · 수락

### 3.1 재사용과 새 것

| 조각 | 재사용 | 더하는 것 |
|---|---|---|
| 기록 | `folders/handover.js` `handover()` — 받는 사람의 대화방 · 브리핑 · ad-hoc `todolist` · `handover_events` · 알림을 한 트랜잭션에 | `request: true`(요청으로 만들기), 변형 없이 main 에서 바로 넘기기(`base: 'main'` → 받는 사람 변형을 새로), `spec` · `context` |
| 상태의 말 | 본판 `delegation_status`(`REQUESTED` · `ACCEPTED` · `REJECTED` · `COMPLETED`)와 `delegation_history`(task_id = 인계가 만든 todolist 행, `responded_at`) | Lite 의 `pro_forwards` 가 같은 말로 상태를 지니고(+`CANCELLED`), `delegation_history` 에 같은 행을 남김(본판 화면 · 마이닝이 그대로 읽음) |
| 변형 | 이어받기는 지금 있는 `locked`(「넘기는 중」)로 요청 동안 잠그고 **수락 때** 보유자를 바꿈. 갈래 · main 에서 넘기기는 받는 사람 변형을 요청 때 만들고(`ready`) 거절되면 버림 | — |
| 로컬 일 | `pro_local_jobs` 큐 · 배정 · 링크 · 터미널 중계 · 대화 기록 · 제안 · 끝내기 — `setKindHooks('handover', …)` + `relay.registerKind('handover', …)` + 데스크톱 `runner.valid()` 에 종류 하나 | 일은 **수락할 때** 만든다(`todo_id` = 인계의 todolist id, `offline: 'wait'`) |
| 알림 | `notifications` type `handover`, Home 카드, 트레이 숫자(`setBadge`) | 카드의 「수락 · 거절」 단추, 「받은 일」 화면 |
| 서버 에이전트로 받기 | `handover.js` `runReceiver`(변형 위의 deepagents 실행) | 사람이 「서버 에이전트에게 맡기기」를 고른 때에도 |

### 3.2 무엇이 실려 가나

| 실리는 것 | 어디서 | 받는 쪽에서 |
|---|---|---|
| 지금까지 한 일 · 다음에 할 일 | 넘기는 사람이 적음(지금 시트 그대로) | 브리핑 메시지 · 첫 프롬프트 |
| 변형(가지 · 커밋) | 넘기기 직전의 동기화 머리 | 작업 트리의 시작점 |
| 따를 스펙 | 폴더에서 찾은 스펙 · 진행 중 변경 가운데 고르기(§4.1) 또는 경로 | 첫 프롬프트가 그 경로를 가리킴(「이 스펙을 읽고 그대로」) — 스펙을 읽고 따르는 것은 CLI 몫 |
| 대화 | 그 일이 Lite 대화에서 나왔으면 그 대화방(`origin_room_id` 묶음 — 지금 그대로) | 받는 사람 대화방의 맥락 |
| CLI 기록 | 그 일이 Lite 가 돌린 로컬 실행이면 그 실행의 `transcript`(서버에 이미 같은 권한으로 있음). 자기 터미널에서 하던 세션은 4단계에서 「붙이기」(§8 P4) | **요약(recap)** 으로 첫 프롬프트에 — 지금 채팅의 `recapOf` 길(`chat.js:175`)을 함께 씀 |
| 폴더의 스킬 · 지침 | 작업 트리에 이미 있음 + 폴더에 붙인 스킬(§4.3) | CLI 가 스스로 읽음 |

**세션은 옮기지 않는다.** 받는 사람 PC 에서는 새 세션 + 요약으로 시작한다(`--resume` 은 같은 PC · 같은 계정의 것 — 보낸 사람의 세션 파일은 그 사람 PC 에 남는다). 첫 프롬프트 글은 프롬프트 파일 `skills/process-discovery/prompts/local-forward.md` 로(코드에 박지 않음).

### 3.3 수락하는 곳과 갈래

| 받는 사람의 상황 | 보이는 것 | 고를 수 있는 것 |
|---|---|---|
| 데스크톱 앱 켜짐 | Home 카드 + 시스템 알림 + 「받은 일」 | 「수락하고 시작」(에이전트 고르기: Claude Code · Codex — 깔린 것만) · 「수락만」 · 「거절」 |
| 웹 · 휴대폰, 데스크톱 앱은 꺼짐 | Home 카드 | 「수락」 → 「PC 앱이 켜지면 시작」으로 기다림(지금의 `wait`) · 「서버 에이전트에게 맡기기」 · 「거절」 |
| 데스크톱 앱 없음 | Home 카드 | 「수락」 → 「서버 에이전트에게 맡기기」 또는 웹의 변형 화면에서 직접(지금의 작업실) · 데스크톱 앱 받기 안내 · 「거절」 |
| 「이 컴퓨터에서 단계 실행」을 꺼 둠 | 위와 같음 | 그 PC 로는 가지 않음(지금 스위치 그대로). 「실행 전에 묻기」가 켜져 있고 다른 기기에서 수락했으면 그 PC 가 시스템 창으로 한 번 더 묻는다 |
| 답이 없음 | — | 7일 뒤 요청이 닫히고(`CANCELLED`) 보낸 사람에게 알림. 보낸 사람은 그 전에도 「거두기」 |

거절 · 거두기: 이어받기였으면 잠금을 풀고 보유자 그대로, 갈래였으면 그 변형을 버림. 받는 사람에게 권한을 함께 주었던 것(`grant`)은 거절이면 되돌린다.

끝: 실행이 끝나면(「끝내기」 또는 기다림 끝) 일 가지 push → 서버 `bringIn` 으로 그 변형에 → 변형 `ready` → todolist `DONE`(산출에 변형) · `handover_events.returned_at` · 상태 `COMPLETED` → 보낸 사람에게 「반영할 변형이 있어요」 → 일괄 반영.

---

## 4. 스킬 · 에이전트 자산

### 4.1 서버가 찾고 보여 주기 (`server/lib/folders/kit.js` 새로)

main 이 움직여 색인이 돌 때(`indexer.reindex` 뒤) main 의 **경로 구조**만 보고 찾는다(내용의 뜻을 읽지 않음, 이름 · 설명은 `SKILL.md` 머리말을 YAML 로 읽음).

| 플랫폼 | 찾는 자리 | 종류 |
|---|---|---|
| Claude Code | `.claude/skills/<이름>/SKILL.md` · `.claude/commands/**/*.md` · `.claude/agents/*.md` · `CLAUDE.md`(하위 폴더 포함) · `.claude/settings.json` · `.mcp.json` | 스킬 · 명령 · 하위 에이전트 · 지침 · 실행 설정 |
| Codex | `AGENTS.md` · `.codex/skills/<이름>/SKILL.md` · `.codex/prompts/*.md` · `.agents/skills/<이름>/SKILL.md` | 지침 · 스킬 · 프롬프트 |
| Cursor | `.cursor/rules/*.mdc` · `.cursorrules` | 규칙 |
| Gemini CLI | `GEMINI.md` · `.gemini/commands/` | 지침 · 명령 |
| GitHub Copilot | `.github/copilot-instructions.md` · `.github/instructions/*.instructions.md` · `.github/prompts/*.prompt.md` | 지침 · 프롬프트 |
| 스펙 | `openspec/specs/*/spec.md` · `openspec/changes/*/` · `specs/*/spec.md`(Spec Kit) · `.kiro/specs/*` · `aidlc-docs/` | 스펙 · 진행 중 변경 |

- 폴더 화면 **「에이전트 자산」 탭**: 플랫폼별 묶음, 항목마다 이름 · 설명 · 파일 열기, 묶음 머리에 「이 폴더에서 일하면 Claude Code 가 저절로 읽어요」 같은 한 줄. 폴더 목록 카드에 「스킬 6 · 명령 4 · 스펙 12」.
- **실행 설정**(훅 · MCP 서버 · 권한 허용 목록이 든 파일)은 따로 표시한다(§7.4).
- 자리 목록은 코드가 아니라 데이터 파일 하나(`server/lib/folders/kit-places.json`)로 두어 플랫폼이 늘면 그 파일만 고친다. 데스크톱의 미리 보기도 같은 파일을 쓴다.

### 4.2 동료의 CLI 가 집어 드는 길

- **폴더 안의 것**: 변형의 작업 트리가 곧 그 폴더이므로 Claude Code 는 `.claude/…` · `CLAUDE.md` 를, Codex 는 `AGENTS.md` · `.codex/…` 를 **스스로** 읽는다. 앱은 아무것도 놓지 않는다.
- **다른 플랫폼의 것**(폴더에는 Claude 스킬만 있는데 받는 사람은 Codex): 파일을 만들거나 고치지 않고 **첫 프롬프트에 가리킴**(「이 폴더의 스킬은 `.claude/skills/` 에 있어요 — 필요한 것을 읽고 따르세요」). 지금 Codex 에 회사 스킬을 줄 때 폴더가 자기 `AGENTS.md` 를 지니면 포인터를 프롬프트로 보내는 것과 같은 길(`desktop/src/runner/skills.js:9-11`). 플랫폼 간 **변환 · 복제는 하지 않는다**.
- **폴더에 붙인 스킬**(§4.3)과 **회사 스킬**: 지금 로컬 단계와 같은 길 — 스킬 폴더를 읽기 토큰으로 받아 `desktop/src/runner/skills.js place` 가 놓고(같은 자리에 폴더 자신의 스킬이 있으면 그것을 씀), 커밋에는 들어가지 않는다.

### 4.3 전역 스킬을 골라 함께 (`~/.claude/skills` · `~/.claude/commands` · `~/.codex/skills` · `~/.codex/prompts`)

- 미리 보기의 「내 PC 전체에 깔아 둔 스킬도 함께할까요?」(시스템 창으로 한 번 동의한 뒤에만 그 자리를 읽음) → 이름 · 설명 목록에서 고름. `~/.claude/CLAUDE.md` 같은 전역 지침은 기본으로 고르지 않음(개인 메모가 섞임).
- 고른 스킬은 사람 폴더에 **복사하지 않고**, 각각 **스킬 폴더**(지금의 `kind='skill'` — `ensureSkillFolder`)로 올라가 그 사람의 **비공개 스킬**이 되며(`saveDraftPrivate` 와 같은 상태), 챔피언 폴더에 **붙는다**(`pro_folder_kit_skills`). 올리는 길은 폴더 동기화와 같은 엔진(원본 = 그 스킬 폴더, 올리기만).
- **규칙 하나를 넓힌다**: 지금 「비공개 스킬은 작성자의 실행에만 보낸다」 → 「…그리고 작성자가 폴더에 붙였으면 **그 폴더에서 도는 그 폴더 구성원의 실행**에도」. 붙이는 것은 작성자만. 폴더를 회사에 공개할 때 붙은 비공개 스킬이 있으면 「이 스킬 N개도 폴더를 여는 사람의 실행에 함께 가요」를 확인받는다.

### 4.4 회사 스킬 공유와의 관계

| | 폴더 안의 스킬 | 폴더에 붙인 스킬 | 회사 스킬 |
|---|---|---|---|
| 사는 곳 | 챔피언 폴더의 main | 스킬 폴더(비공개 또는 공유) | 스킬 폴더 + `tenant_skills` |
| 누가 쓰나 | 그 폴더에서 일하는 CLI | 그 폴더에서 도는 실행 | 서버 에이전트 · 로컬 단계 · 누구나 |
| 고치기 | 폴더의 변형 → 일괄 반영 | 스킬의 「반영 요청」(지금 그대로) | 같음 |
| 올리는 길 | — | — | 폴더 안의 스킬에서 **「회사 스킬로 올리기」** → `ensureSkillFolder({fromDir})` → 비공개 초안 → 작성자가 「전사에 공유」(`share`) |

「스킬만 공개」 = 이 표의 마지막 줄. 올린 뒤에도 폴더 안의 사본은 그대로이고(폴더에서 일할 때는 폴더 것을 씀), 자산 탭에 「회사 스킬로 올라감」 표시.

---

## 5. 워크트리

| 항목 | 결정 |
|---|---|
| 단위 | **사람 × 일 = 변형 하나**(서버의 가지) = 그 사람 PC 의 작업 트리 하나. 챔피언 자신의 고른 폴더는 main 줄 |
| 서버 가지 이름 | 지금 `createVariation` 이 짓는 그대로: `var/u/<사람id 8자>/<제목>`(종류 `person` · `handover`). 새 규칙 없음 |
| PC 의 자리 | `<앱 데이터>/local-agents/folders/<서버10>/<폴더8>/repo`(폴더마다 clone 하나) + `…/wt/<변형8>-<제목>`(`git worktree add`). 사람이 고른 폴더와는 다른 곳 |
| CLI 세션 | 작업 트리마다 남는다(다음 실행이 같은 PC 에서 `--resume`) |
| 올리기 | 지금처럼 일 가지 `pgpt-agent/local-<일8>-<시각>` 로 push → 서버 `bringIn` 이 변형으로(채팅의 프로젝트 변형 길). 들어간 일 가지는 서버가 지운다 |
| 버리지 않기 | 변형 작업 트리에서는 실행 전 `reset` · `clean` 을 하지 않는다 — 손으로 고친 것이 있으면 그대로 커밋에 담는다(`git.js` 에 `keep` 길을 더함, 지금의 `branch()` 는 일회용 폴더에만) |
| 손으로 일하기 | 「폴더에서 열기」 「터미널에서 열기」 — 자기 터미널에서 직접 `claude` · `codex` 를 돌려도 되고, 「올리기」로 변형에 올린다(P4) |
| 치우기 | 변형이 반영 · 버려지면 서버가 그 PC 들에 알림 → 저장 안 한 것 · 안 올린 것이 **없을 때만** 작업 트리를 지운다. 있으면 「남은 변경이 있어요 — 올리기 / 버리기」. 30일 넘게 안 쓴 것은 목록에서 권함(저절로 지우지 않음) |
| 되합치기 | 지금의 **일괄 반영**(`folders/merge.js` — 정책 stop, 파일마다 고르기, 에이전트로 풀기). 반영은 편집자 이상(챔피언). 반영되면 원본 PC 에 「받을 변경」 |
| 내 일도 나눠서 | 챔피언도 「내 변형 만들기」로 자기 작업 트리를 따로 둘 수 있다(같은 길) |

---

## 6. 데이터 모델 · API · 화면

### 6.1 SQL (059 부터 — 056 · 057 · 058 은 다른 가지 몫, 모두 더하기만 · 여러 번 돌려도 됨 · RLS 켜고 정책 없음)

**`059_champion_folders.sql`** (P0 · P1)

```sql
create table if not exists pro_folder_sources (       -- 원본 PC: 폴더 × 기기
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  folder_id uuid not null references pro_folders(id) on delete cascade,
  user_id uuid not null,
  device_id uuid not null,                            -- pro_local_devices.id
  label text not null,                                -- 그 PC 에서의 폴더 이름(경로 아님)
  direction text not null default 'up' check (direction in ('up','both','down')),
  branch text not null,                               -- pgpt-agent/sync-<기기8>/main
  state text not null default 'active' check (state in ('active','paused','blocked','removed')),
  why text,                                           -- 멈춘 까닭
  last_head text, last_pushed_at timestamptz,         -- 마지막으로 받은 머리
  seen_main text,                                     -- 그 PC 가 받은 main
  report jsonb not null default '{}',                 -- 마지막 올리기: {files, bytes, excluded:{갈래: 수}, flagged}
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (folder_id, device_id)
);
create table if not exists pro_folder_kit (           -- 폴더에서 찾은 에이전트 자산(main)
  folder_id uuid not null references pro_folders(id) on delete cascade,
  path text not null,
  platform text not null,                             -- claude · codex · cursor · gemini · copilot · spec
  type text not null,                                 -- skill · command · agent · instructions · rules · prompt · settings · mcp · spec · change
  name text, description text,
  sha text,                                           -- 그 파일의 blob
  runs boolean not null default false,                -- 실행되는 설정(훅 · MCP · 허용 목록)이 들었나
  updated_at timestamptz not null default now(),
  primary key (folder_id, path)
);
```
`pro_folders.settings.champion = {by, at}` 로 「챔피언 폴더」를 표시(열 없음).

**`060_folder_visibility.sql`** (P2)

```sql
alter table pro_folders add column if not exists visibility text not null default 'members' check (visibility in ('members','tenant'));
alter table pro_folders add column if not exists tenant_role text not null default 'viewer' check (tenant_role in ('viewer','runner'));
alter table pro_folders add column if not exists published_by uuid;
alter table pro_folders add column if not exists published_at timestamptz;
create table if not exists pro_folder_kit_skills (    -- 폴더에 붙인 스킬
  folder_id uuid not null references pro_folders(id) on delete cascade,
  skill_name text not null, added_by uuid not null, created_at timestamptz not null default now(),
  primary key (folder_id, skill_name)
);
create table if not exists pro_folder_trust (         -- 이 PC 에서 이 폴더의 실행 설정을 확인했나(§7.4)
  folder_id uuid not null references pro_folders(id) on delete cascade,
  device_id uuid not null, kit_sha text not null, trusted_at timestamptz not null default now(),
  primary key (folder_id, device_id)
);
```

**`061_forwards.sql`** (P3)

```sql
create table if not exists pro_forwards (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  folder_id uuid not null references pro_folders(id) on delete cascade,
  variation_id uuid,                                  -- 받는 사람이 일할 변형
  from_user_id uuid not null, to_user_id uuid not null,
  mode text not null check (mode in ('continue','fork','new')),   -- new: main 에서 바로
  status text not null default 'REQUESTED' check (status in ('REQUESTED','ACCEPTED','REJECTED','CANCELLED','COMPLETED')),
  done text, next text not null,
  spec jsonb,                                         -- {kind, path, id}
  context jsonb not null default '{}',                -- {from_job, thread_id, base_commit, recap, granted}
  to_room_id text, to_task_id uuid, case_id text,     -- handover.js 가 만든 것
  job_id uuid,                                        -- 수락 뒤의 pro_local_jobs
  run_on text,                                        -- desktop · server-agent · manual
  reason text,                                        -- 거절 · 거둔 까닭
  created_at timestamptz not null default now(), responded_at timestamptz, expires_at timestamptz
);
create index if not exists pro_forwards_inbox on pro_forwards (tenant_id, to_user_id, status, created_at desc);
alter table pro_local_jobs add column if not exists forward_id uuid;   -- kind = 'handover'
```
공용 테이블은 그대로 두고 지금의 약속대로만 쓴다: `todolist`(ad-hoc 행) · `handover_events` · `delegation_history`(REQUESTED → ACCEPTED/REJECTED/COMPLETED, `responded_at`) · `notifications`.

### 6.2 서버

| 단계 | 라우트 · 메시지 | 권한 · 비고 |
|---|---|---|
| P0 | `POST /api/folders/:slug/sources {deviceId, label, direction}` · `GET …/sources` · `PATCH …/sources/:id {state, direction}` · `DELETE …/sources/:id` | 기기가 부른 사람의 것, 올리기는 편집자 이상 |
| P0 | `GET /api/folders/:slug/kit` | viewer |
| P0 | 링크(`/api/local-agents/link`) 메시지: ⇧`sync:token {folderId}` ⇩`sync:token {token, path, branch, main}` · ⇧`sync:pushed {folderId, head, report}` ⇩`sync:taken {main}` / `sync:refused {why, paths}` / `sync:behind {main}` | 토큰은 그때의 역할을 보고 만든다 |
| P0 | `/api/local-git` 이 `scope: 'sync'` 토큰도 받음 — `devices.syncAccess(claims, {push})`: 기기 연결됨 · 그 폴더의 원본 행이 `active` · 그 사람의 역할(fetch ≥ viewer, push ≥ editor) · 관리형 폴더 | 공개 경로는 여전히 하나, 같은 속도 제한 |
| P1 | ⇩`sync:changed {folderId, main}`(main 이 움직임) · ⇩`sync:revoked {folderId}` | |
| P2 | `PATCH /api/folders/:slug {visibility, tenantRole}`(지금 라우트에 값 추가) · `GET /api/folders?scope=company` · `POST …/try`(내 변형) · `POST …/kit/promote {path}` · `POST/DELETE …/kit/skills {name}` · `POST …/trust {deviceId}` | 공개 · 붙이기는 owner |
| P3 | `POST /api/folders/:slug/forward {to, variation? , mode, done, next, spec?, fromJob?, grant}` · `GET /api/forwards?box=in\|out` · `POST /api/forwards/:id/accept {run, agent, start}` · `POST …/reject {reason}` · `POST …/cancel` | 넘기기는 runner 이상(지금 인계와 같음), 답은 받는 사람만 |
| P3 | 로컬 일 `kind: 'handover'` 의 job 꾸러미에 `worktree: {variation, branch, keep: true}` · `recap` · `spec` | `runner.valid()` 가 새 종류를 앎 |

코드 자리: `folders/service.js`(`roleOf` 에 `visibility` 한 갈래, `listFolders` 에 회사 칸), `folders/kit.js`(새), `folders/sources.js`(새), `folders/line.js`(`bringIn` 의 main 쪽을 꺼내 옴), `folders/gitHttp.js`(범위 하나), `folders/handover.js`(`request` · `base: 'main'`), `folders/forwards.js`(새 — 상태 전이), `localAgents/forward.js`(새 — 종류 훅: prepare · done · fail · note · cancelled), `localAgents/devices.js`(`syncAccess`), `routes/folders.js` · `routes/localAgents.js`.

`roleOf` 변경(관리형 폴더): 구성원 역할이 있으면 그것, 없고 `visibility='tenant'` 이면 `tenant_role`. 메일로 시작한 작업 폴더 · 사람의 「내 PC 에이전트 작업」 폴더는 공개할 수 없다(서버가 거절).

### 6.3 데스크톱

**IPC** — `preload.js` 의 `pglDesktop.folders`(모든 처리기는 지금처럼 `fromServerPage` 확인, 페이지는 경로를 주지도 받지도 않음)

| 호출 | 하는 일 |
|---|---|
| `pick()` | **시스템 폴더 고르기 창** → `{pickId, label, preview}`(올릴 것 · 뺀 것 · 확인 필요 · 찾은 자산) |
| `preview(pickId, {exclude, include})` | 고른 것을 반영해 다시 |
| `globalSkills(pickId)` | 시스템 창 동의 뒤 전역 스킬의 이름 · 설명 |
| `bind({pickId, folderId, direction, skills})` | **시스템 창으로 마지막 확인**(파일 수 · 크기 · 서버 · 폴더 이름) → 그림자 저장소 · 첫 올리기 |
| `list()` · `onState(cb)` | 연결된 폴더들의 상태(이름표 · 올림/받을 것/멈춤 — 경로 없음) |
| `syncNow(folderId)` · `pause(folderId, on)` · `unbind(folderId)` | |
| `incoming(folderId)` · `receive(folderId, {choices})` | 받을 변경 목록 · 받기(첫 번째와 자동 켜기는 시스템 창) |
| `reveal(id)` · `openTerminal(id)` | 고른 폴더 · 작업 트리를 파일 관리자 · 터미널에서 |
| `worktrees()` · `removeWorktree(id)` | 작업 트리 목록 · 치우기 |

**main 쪽**: `desktop/src/runner/sync.js`(새 — 그림자 저장소 · 훑기 · 비밀 검사 · 올리기 · 받기 · 지켜보기), `runner/worktrees.js`(새 — 폴더 clone · 작업 트리), `runner/git.js`(`keep` 길), `runner/runner.js`(`valid()` · `dirFor()` 에 `handover`), `settings.js`(`folders: {[서버]: [{folderId, path, label, userId, exclude, autoReceive}]}` — 경로는 여기에만), `main.js`(IPC · 시스템 창), `tray.js`(폴더 상태 · 받은 일 숫자). 등록부는 서버 · 사람별이다.

### 6.4 화면 (데스크톱 앱 = 웹 앱이므로 화면은 하나, 데스크톱에서만 보이는 단추가 있음)

| 화면 | 내용 | 390px |
|---|---|---|
| 폴더 목록(`FolderList.vue`) | 「내 PC 폴더 올리기」(데스크톱에서만, 웹에서는 「데스크톱 앱에서 올릴 수 있어요」), 「회사에 공개된 폴더」 칸, 카드에 자산 수 · 「내 PC 와 연결됨」 표시 | 칸은 가로로 넘기는 알약, 카드는 한 줄 |
| 올리기 미리 보기 시트(새 `SourceSheet.vue`) | 올릴 것 나무(체크) · 뺀 것(갈래별 접기) · 확인 필요(파일마다 빼기/올리기) · 찾은 자산 · 전역 스킬 고르기 · 이름 · 공개 범위 | 데스크톱 전용 |
| 폴더 상세(`FolderDetail.vue`) | **「에이전트 자산」 탭**(새 `KitTab.vue`), 머리의 동기화 상태(「방금 올림」 「받을 변경 7개 — 받기」 「멈춤: …」), 「넘기기」 | 탭은 가로 스크롤, 자산은 플랫폼별 접는 목록 |
| 받기 시트(새 `IncomingSheet.vue`) | 바뀐 파일 · 누가 · 겹친 파일 고르기 | 데스크톱 전용 |
| 공유 시트(`ShareSheet.vue`) | 「회사에 공개」 스위치 + 「써 보기 허용」, 붙은 비공개 스킬 확인 | 아래에서 올라오는 시트 |
| 넘기기 시트(`HandoverSheet.vue` 넓힘) | 받는 사람 · 한 일 · 할 일 · **따를 스펙** · 붙일 맥락 · (받는 사람의 PC 앱 상태 표시) | 한 열, 단추는 아래 고정 |
| Home 카드 | 「○○ 님이 일을 넘겼어요」 — 폴더 · 할 일 · 스펙, 「수락하고 시작 / 수락만 / 거절」(상황에 따라 §3.3) | 카드 그대로, 단추 두 줄 |
| 받은 일(새 `ForwardsView.vue`, 프로필 메뉴 · Home 카드에서) | 받은 것 · 보낸 것, 상태(요청 · 수락 · 진행 중 · 끝 · 거절), 실행 카드(`LocalRunCard`)로 이어짐 | 목록 한 열 |
| 변형 화면(`VariationView.vue`) | 넘겨받은 변형에 요청 상태 · 「내 PC 에서 열기」 · 실행 카드 | 지금 그대로 |
| 설정 › 계정 › 내 컴퓨터의 에이전트 | 「이 컴퓨터와 연결된 폴더」 목록(멈춤 · 끊기), 작업 트리 목록 | 한 열 |

---

## 7. 보안

### 7.1 올리기 전 비밀 검사 (데스크톱, 그리고 서버가 한 번 더)
- **이름 · 형식**(§2.4 표)으로 먼저 빼고, 남은 글 파일(1 MB 이하)은 **알려진 열쇠의 생김새**를 본다: PEM 머리(`-----BEGIN … PRIVATE KEY-----`), 제공자마다 정해진 접두사와 길이를 가진 토큰, 서명된 서비스 키 꼴, `이름=값` 줄의 값이 길고 고르게 섞인 글자. 생김새 목록은 데이터 파일(`secret-shapes.json`)로 두고 데스크톱 · 서버가 함께 쓴다.
- 확실한 것은 그 파일을 **막고**(「빼기」가 기본, 「그래도 올리기」는 파일마다 한 번씩 · 까닭 기록), 애매한 것은 「확인 필요」. 걸린 값은 화면 · 로그 · 서버로 보내지 않는다(파일 이름과 줄 번호만).
- 서버는 받은 push 의 **새로 들어온 파일**을 같은 목록으로 다시 본다. 걸리면 main 으로 넣지 않고 동기화 가지를 직전 머리로 되돌린 뒤 `sync:refused` — 닿지 않게 된 것은 밤의 정리(`folders/gc.js`, 7일)가 지운다.
- 이것은 파일 형식 · 토큰 형식의 구조 검사다(사람 말의 뜻을 규칙으로 읽는 일이 아님).

### 7.2 폴더별 권한 · 테넌트 격리
- 동기화 토큰: `{tenant, folder, push: 'pgpt-agent/sync-<기기8>/', scope: 'sync', device}` — **요청마다** 기기가 끊기지 않았는지, 원본 행이 살아 있는지, 그 사람의 지금 역할을 본다(토큰이 살아 있어도 권한이 내려가면 그 자리에서 막힘). main · 다른 가지 · 태그 · 지우기는 지금처럼 거절.
- 원본 행 · 요청 · 자산 테이블 모두 `tenant_id` 를 지니거나 폴더를 통해 묶이고, 링크 메시지는 그 링크의 테넌트 · 사람 안에서만 폴더를 찾는다. 데스크톱 등록부는 서버 주소 · 사람별.
- 공개(`tenant`)는 그 테넌트 안이다. 챔피언 폴더의 문서는 공개하기 전에는 회사 전체 색인(memento 사본)에 들어가지 않는다.
- 메일 작업 폴더 · 개인 「내 PC 에이전트 작업」 폴더는 공개 · 원본 연결의 대상이 아니다.

### 7.3 토큰 수명

| 토큰 | 수명 | 어디에 |
|---|---|---|
| 기기 토큰 | 끊을 때까지(지금 그대로) | OS 열쇠고리, 서버에는 해시만 |
| 동기화 토큰 | **1시간**, 바퀴마다 링크로 새로 | 메모리, git 에는 `GIT_CONFIG_*` 머리글로만(설정 파일 · 명령줄 · 로그에 없음) |
| 일 토큰(넘겨받은 일) | 24시간(지금 그대로), 그 일이 그 기기에서 도는 동안만 push | 같음 |
| 넘기기 요청 | 7일 뒤 닫힘 | — |

### 7.4 폴더가 싣고 오는 실행 설정
다른 사람이 만든 폴더의 `.claude/settings.json`(훅 · 허용 목록) · `.mcp.json` · `.codex/config` 는 **받는 사람 PC 에서 실행되는 것**이다.
- 자산 탭과 수락 카드에 「이 폴더에는 실행되는 설정이 있어요: 훅 2 · MCP 서버 1」과 내용 보기.
- 남이 만든 폴더의 작업 트리에는 앱이 **폴더 신뢰를 대신 써 주지 않는다**(지금은 앱이 만든 폴더에만 씀). 그 PC 의 사람이 처음 한 번 확인하고(`pro_folder_trust`), 그 파일들이 바뀌면(자산의 sha) 다시 묻는다. 확인 전에는 실행을 시작하지 않는다.
- 자기가 만든(자기가 올린) 폴더는 묻지 않는다.

### 7.5 서버가 PC 에서 결코 하지 못하는 것
1. 폴더의 **경로를 정하거나 알기**(고르기는 그 PC 의 시스템 창에서만, 서버에는 이름표만).
2. 사람이 고르지 않은 폴더를 읽기, 고른 폴더 **밖**에 쓰기(앱 데이터 폴더는 예외).
3. 사람이 받겠다고 하지 않은 변경을 고른 폴더에 쓰기, 고른 폴더의 파일을 지우기 · 되돌리기 · 치우기.
4. 사람의 git 저장소 · 설정 · 원격에 손대기.
5. 제외 목록을 줄이기, 비밀 검사를 끄기(둘 다 그 PC 의 사람만).
6. 전역 스킬 자리(`~/.claude` 등)를 동의 없이 읽기.
7. 보낸 글을 명령으로 실행하기, 정해진 CLI · 인자 밖의 것을 돌리기, 고른 폴더에서 일을 돌리기(지금 스펙 그대로).
8. 수락하지 않은 일을 시작하기, 끊은 기기에 무엇이든 하기.

페이지(서버가 준 화면)의 요청만으로는 위가 열리지 않도록, **동의는 시스템 창**에 건다(고르기 · 첫 올리기 · 첫 받기 · 자동 받기 켜기 · 전역 스킬 읽기 · 실행 설정 확인).

---

## 8. 단계 (각각 따로 내보낼 수 있음)

| | 범위 | 시험 | 스펙 · 문서 | 시연 |
|---|---|---|---|---|
| **P0 내 PC 폴더 올리기** | 폴더 고르기 → 미리 보기(제외 · 비밀 검사 · 찾은 자산) → 동의 → 관리형 폴더 + 원본 행 → 그림자 저장소 첫 올리기 → main. 「지금 올리기」(손으로). 「에이전트 자산」 탭. 고른 동료 공유는 지금 시트로. SQL 059, 동기화 토큰 범위, `kit.js`. 데스크톱 새 판 | 단위: `sync` 훑기 · 제외 · 비밀 생김새 · 「사람 폴더에 `.git` · 파일을 만들지 않음」 · `syncAccess` · `kit` 찾기. HTTP e2e: 가짜 데스크톱이 토큰 → push → main, 보기 권한이면 push 거절, 끊은 기기 거절, 다른 테넌트 거절. Playwright **F-CH-01** 미리 보기에 뺀 것 · 확인 필요가 보인다 · **F-CH-02** 올린 뒤 폴더에 파일과 자산 탭 · **F-CH-03** `.env` · `settings.local.json` 은 서버에 없다 · **F-CH-04** 웹(데스크톱 아님)에서는 안내만 · **F-CH-05** 390px 자산 탭 | `champion-folders`(요구 1 · 2 · 3 · 6) 새로, `folder-git-remote` 수정, 결정 기록(공개 git 경로에 범위 하나 더 — 노출 수준 결정) | 「스킬이 든 내 폴더를 골라 → 무엇이 올라가는지 보고 → 올리니 회사 폴더에 스킬 표가 뜬다」 |
| **P1 동기화** | 자동 올리기(지켜보기 · 쉬었다가), 받기(「받을 변경 N개」 · 겹친 파일 고르기 · 휴지통 · 되돌리기), 오프라인 쌓기, 멈춤 · 끊기, 트레이 상태, 둘째 PC, 있는 폴더에 합류(`imported` 변형) | 단위: 병합 계산이 사람 폴더를 건드리지 않음 · 겹침 세 갈래 · 지워질 파일은 휴지통 · 쓰기 직전 다시 스냅숏. e2e: 웹에서 고침 → PC 에 받을 변경, PC 두 대. **F-CH-10** 파일을 고치면 저절로 올라간다 · **F-CH-11** 반영 뒤 「받기」 · **F-CH-12** 겹친 파일 「둘 다 두기」 · **F-CH-13** 권한이 내려가면 멈춤 표시 · **F-CH-14** 연결 끊기 뒤에도 양쪽 그대로 | `champion-folders`(요구 4 · 5), `local-agents` :282 수정 | 「터미널에서 하던 대로 고치니 회사 폴더가 따라오고, 동료가 반영한 것을 눌러서 받는다」 |
| **P2 공개 · 받아 쓰기** | 회사에 공개(`visibility` · `tenant_role`) · 「회사에 공개된 폴더」 칸 · 「써 보기」(내 변형 + 내 PC 작업 트리 — 작업 트리 엔진의 첫 쓰임) · 「회사 스킬로 올리기」 · 전역 스킬 붙이기 · 실행 설정 확인. SQL 060 | 단위: `roleOf` 갈래(구성원 > 공개), 공개 못 하는 폴더, 붙인 비공개 스킬이 가는 범위. e2e: 구성원 아닌 사람이 읽기 · 변형 만들기 · main 은 못 고침. **F-CH-20** 공개하면 동료 목록에 보인다 · **F-CH-21** 「써 보기」 → 내 변형 · **F-CH-22** 스킬만 회사 스킬로 · **F-CH-23** 실행 설정 확인 전에는 시작하지 않음 · **F-CH-24** 390px 공개 시트 | `champion-folders`(요구 7 · 10), 스킬 공유 스펙의 비공개 규칙 수정 | 「챔피언이 공개 → 동료가 열어 보고 → 자기 PC 에서 같은 스킬로 일해 본다」 |
| **P3 넘기기 · 수락** | 넘기기 시트(스펙 · 맥락) → 요청 → Home 카드 · 받은 일 · 알림 → 수락/거절/거두기/기한 → 로컬 일 `handover` 가 변형 작업 트리에서(새 세션 + 요약) → 결과가 변형에 → 일괄 반영. 데스크톱 없음 · 꺼짐 갈래. SQL 061 | 단위: 상태 전이(이어받기는 수락 때 보유자 바뀜, 거절이면 되돌림), 훅 6개, 프롬프트 조립. e2e(두 사람 · 두 데스크톱 — `local-agents-collab.spec.js` 틀): 넘김 → 수락 → 실행 → 변형 → 반영. **F-CH-30** 넘기면 받는 사람 Home 에 카드 · **F-CH-31** 「수락하고 시작」 → 실행 카드 · **F-CH-32** 거절하면 보낸 사람에게 까닭과 함께 · **F-CH-33** PC 앱이 꺼져 있으면 「켜지면 시작」 · **F-CH-34** 데스크톱이 없으면 서버 에이전트 · **F-CH-35** 끝나면 보낸 사람이 반영 · **F-CH-36** 390px 수락 | `champion-folders`(요구 8 · 9), `local-agents`(새 종류 · 작업 트리 시나리오), 결정 기록 | 「챔피언이 하던 일을 넘기고 → 동료가 수락하니 동료의 Claude Code 가 같은 폴더 · 같은 스펙으로 이어 간다 → 챔피언이 반영한다」 |
| **P4 손으로 일하기 · 다듬기** | 「폴더에서 열기 · 터미널에서 열기」 · 손으로 한 일 「올리기」 · 작업 트리 치우기 · 자기 터미널에서 하던 CLI 세션을 넘길 때 붙이기(그 PC 의 기록을 골라 올림 → 요약) · 다른 플랫폼 스킬 가리키기 · 폴더의 스펙 · 진행 중 변경 보기 | 단위: 세션 찾기(폴더별) · 치우기 조건. **F-CH-40** 손으로 고친 작업 트리 올리기 · **F-CH-41** 남은 변경이 있으면 지우지 않음 · **F-CH-42** 세션을 붙여 넘기면 요약이 실림 | `champion-folders` 시나리오 추가 | 「자기 터미널에서 하던 대화까지 실어 넘긴다」 |
| P5 (뒤) | AI-DLC 를 같은 종류 틀로(`docs/local-agents/design.md` §11) · 팀/역할 단위 공유 · 내 git 이력 쓰기 · 채팅의 내 PC 에이전트를 고른 폴더에서 | — | — | — |

P0 · P1 은 데스크톱 새 판이 필요하고(서버가 먼저 나가도 옛 앱은 단추가 안 보일 뿐), P2 의 공개 부분은 서버 · 웹만으로 먼저 낼 수 있다. 크기 어림: P0 4–5일 · P1 4일 · P2 3일 · P3 4일 · P4 3일(영상 · 튜토리얼 · 제품 페이지는 따로).

---

## 9. 결정이 필요한 것 (기본값으로 진행 가능)

| # | 물음 | 추천 기본값 | 까닭 |
|---|---|---|---|
| Q1 | 서버 쪽 변경을 내 폴더에 **자동으로 받을까**? | **아니오 — 「받기」를 눌러서**, 폴더마다 자동 스위치(기본 끔) | 남이 바꾼 스킬 · 훅이 말없이 내 폴더에 들어오지 않게 |
| Q2 | 회사에 공개했을 때 모두의 기본 권한은? | **보기(viewer)**, 챔피언이 「써 보기 허용」을 켜면 runner | 지금 스킬의 공개(runner)보다 한 칸 낮게 — 폴더는 문서 · 고객 자료가 섞임 |
| Q3 | 이미 git 인 폴더의 **지난 이력**도 올릴까? | **아니오 — 지금 상태의 스냅숏부터**(P5 에서 선택으로) | 지난 커밋 속 비밀, 사람의 `.git` 에 손대지 않기 |
| Q4 | 동기화용으로 공개 git 경로(`/lite/api/local-git/`)에 **범위 하나를 더 여는 것**을 운영에 낼까? | **예** — 기기 + 폴더 + 요청마다 역할 확인, 1시간 토큰, 같은 속도 제한 | 새 경로를 열지 않고 지금 문지기를 그대로 씀(노출 수준 결정이라 기록 필요) |
| Q5 | 수락하면 CLI 가 **바로 시작**할까? | **고르게 한다 — 기본 단추는 「수락하고 시작」**, 옆에 「수락만」 | 「accept해서 이어서 일을 할 수도」 — 자기 터미널에서 하려는 사람도 있음 |

---

## 10. 확인한 것 (저장소에서 다시 본 것)

| 기대는 것 | 어디 |
|---|---|
| 역할 순서 · `roleOf` 의 스킬 공개 갈래 | `server/lib/folders/service.js:27, 39-54` |
| 폴더 만들기(첫 커밋에 `.gitattributes`) — 첫 올리기는 서버 main 위에 스냅숏을 쌓고, 사람 폴더에 없는 `.gitattributes` 가 지워진 것으로 올라가지 않게 챔피언 폴더는 저장소의 `info/attributes` 로 옮겨 둠(구현 때 확인) | `service.js:92-106` |
| 토큰 꼴 `pgf1`, `scope` · `device` · `job`, push 접두사 규칙(접두사 뒤 한 글자 이상) | `server/lib/folders/gitHttp.js:38-51, 104-118` |
| 공개 git 경로는 기기 토큰만 | `server/index.js:126-128`, `localAgents/devices.js:50-62` |
| 로컬 일: 종류 훅 · 큐 · 배정, `todo_id` 가 유일 키(채팅은 `chat:<id>`) | `localAgents/jobs.js:35, 71-124`, `server/sql/055_chat_agents.sql` |
| 내 PC 폴더 main 으로 들이기(앞감기 → 병합 → 겹치면 그대로) | `localAgents/chat.js:321-345` |
| 요약으로 새 세션 | `localAgents/chat.js:174-190` |
| 인계의 기록 · 알림 · 에이전트 받는 쪽 실행, 변형의 `locked` · 종류 `handover` · `imported` | `folders/handover.js:49-160`, `server/sql/007_folders.sql` |
| 변형 가지 이름 | `service.js:382-403` |
| 데스크톱: 폴더 고르기 없음, IPC 는 `fromServerPage`, 일 폴더는 앱 데이터 아래, 실행 전 `reset --hard` · `clean` | `desktop/src/preload.js`, `main.js:474-506`, `runner/runner.js:157-180`, `runner/git.js:98-101` |
| 일 폴더의 스킬 제외 목록 · 폴더 자신의 것은 건드리지 않음 | `desktop/src/runner/skills.js:1-18` |
| 고칠 스펙 문장 | `openspec/specs/local-agents/spec.md:282` |
| 본판의 위임 상태 말 | `process-gpt/docker-infra/volumes/db/init.sql:442-457` |
| SQL 은 055 까지 | `git ls-tree origin/main server/sql/` |
