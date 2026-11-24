# 실제 `claude` · `codex` 로 한 번씩 (2026-11-24)

## 주 길 — 사람의 대화형 Claude Code 를 터미널에서 (`smoke-tty-2026-11-24.json`)

```bash
cd server && LA_SMOKE_GATEWAY=1 LA_SMOKE_ANTHROPIC_BASE_URL=… LA_SMOKE_ANTHROPIC_AUTH_TOKEN=… LA_SMOKE_ANTHROPIC_MODEL=… node test/localAgents.smoke.mjs tty
```

- 왜 게이트웨이로: 이 맥의 Claude Code 는 대화형 첫 설정(테마 고르기)을 끝내지 않은 상태라(`hasCompletedOnboarding: false` — 늘 SDK · 데스크톱 앱으로 써 옴) 사람의 구독 로그인으로 띄우면 그 창이 먼저 뜬다(프로브로 확인, 프롬프트는 보내지 않음). 사람의 설정을 바꾸지 않으려고 임시 Claude Code 설정 폴더(첫 설정만 끝낸 것)와 회사 모델 게이트웨이(Anthropic Messages API)로 돌렸다. 게이트웨이 주소 · 키는 기록에 넣지 않았다.
- 그 전에 확인한 것(프로브, 프롬프트 없이): 새 폴더에서 신뢰 창이 뜨는 동안에는 `SessionStart` 훅이 오지 않는다 → 그 훅을 「입력을 받을 수 있음」으로 쓴다. Codex 0.162.1 은 새 폴더에서 「Trust this folder?」, 신뢰를 명령줄(`-c projects."<폴더>".trust_level="trusted"`)로 주면 그다음 「Update available」 창 → `-c check_for_update_on_startup=false`. Codex 의 rollout 파일은 첫 메시지 때 생긴다.

명령(runner 가 띄운 그대로): `claude --session-id <uuid> --settings <세션 설정: 훅만> --permission-mode acceptEdits` (PTY 80×28, 사람의 설정 소스 그대로)

| 때 | 일어난 것 |
|---|---|
| 0s | 작업 폴더 받음 · 가지 · 회사 스킬 「인사말-규칙」을 `.claude/skills/` 에 · 폴더 신뢰(임시 설정 폴더의 `.claude.json`) |
| 1.8s | `SessionStart` 훅 → 프롬프트를 붙여 넣기 + Enter |
| 2.3s | `UserPromptSubmit` 훅(턴 시작) |
| 5.8s | 첫 도구 줄이 보인 뒤 인스턴스 대화로 입력 → 서버 → 링크 → 터미널에 붙여 넣기 + Enter |
| 6.3s | `UserPromptSubmit` — 일하는 중에 넣은 입력을 Claude Code 가 받음 |
| 12.6s | `Stop` 훅(턴 하나 — 입력은 같은 턴에서 반영) |
| 16.2s | 3초 동안 새 일이 없어 끝 → CLI 닫음 → 커밋 · push → 인스턴스 라인 · 단계 끝 |

결과: `인사.md` = 「안녕하세요, 달빛상사입니다.」 + 끝 줄 「— 달빛상사 인사 규칙 v1」(회사 스킬의 규칙 그대로), `조종.md` = 「조종 받음 — 사람이 실행 중에 바꾼 방향」, `결과.md`(실행 중에 바꾼 방향 · 요약). 입력 상태: 보냄 → 반영 `live`. 일에 남은 마지막 화면(보는 사람 모두가 본 그 터미널)의 끝에는 Claude Code 의 화면 그대로 — 「⏵⏵ accept edits on」, 「Sautéed for 10s」, 닫을 때의 「Resume this session with: claude --resume <id>」.

알게 된 것: 대화형 Claude Code 는 일하는 중에 붙여 넣은 입력을 그 턴 안에서 받는다(`UserPromptSubmit` 가 한 번 더, `Stop` 은 한 번). 사람의 설정이 그대로 돌아 그 사람의 자동 업데이트(「Auto-updating…」)도 화면에 보였다.

## 예비 길 — 헤드리스

이 맥에 깔린 CLI(사람 자신의 구독)로, 실제 Lite BFF(`PRO_BACKGROUND=0`, 시험 회사 `localagent-smoke`, 임시 폴더) + 데스크톱 앱의 runner 코드(`desktop/src/runner`)로 아주 작은 단계 하나씩과 조종 한 번씩을 돌렸다. 기록 원본은 같은 폴더의 `smoke-claude-2026-11-24.json` · `smoke-codex-2026-11-24.json`(토큰 · 계정 이름 · 홈 경로는 지움).

```bash
cd server && node test/localAgents.smoke.mjs claude    # 또는 codex · both
```

단계의 일 정의: 「「인사.md」 파일을 만들고 한 줄로 "안녕하세요 — 로컬 …" 라고 쓰세요. 그다음 「체크.md」 파일을 만들고 "1차 완료" 라고 쓰세요. 다른 일은 하지 마세요.」
조종(인스턴스 대화에 보낸 글, CLI 가 첫 도구 · 첫 글을 낸 뒤): 「방향을 바꿔 주세요: 「조종.md」 파일을 하나 더 만들고 "조종 받음 — 사람이 실행 중에 바꾼 방향" 이라고 쓰세요. 이미 만든 파일은 그대로 두세요.」

## Claude Code 2.1.330 — 멈추지 않고 반영(`live`)

명령(runner 가 띄운 그대로, 프롬프트는 stdin):
```
claude -p --input-format stream-json --output-format stream-json --verbose --replay-user-messages --session-id <uuid>
  --permission-mode acceptEdits --allowed-tools Read,Write,Edit,MultiEdit,Glob,Grep,TodoWrite,Bash(ls:*),Bash(cat:*),Bash(head:*),Bash(wc:*),Bash(mkdir:*)
  --disallowed-tools Bash(git:*),Bash(curl:*),Bash(wget:*),Bash(rm -rf:*),WebFetch --setting-sources project --strict-mcp-config
```

| 때 | 일어난 것 |
|---|---|
| 0s | 작업 폴더를 서버에서 받음(인스턴스 라인 없음 → main) · `pgpt-agent/local-…` 가지 |
| | `system init` → 프롬프트 replay(받음) |
| | Bash `mkdir … && printf … > 인사.md` → **permission_denied**(허용 목록 밖의 셸 쓰기는 막힘) → Write 로 `인사.md`, `체크.md` |
| 4.3s | 조종 보냄(인스턴스 대화 → 서버 → 링크 → stdin 의 user 메시지) |
| | 두 Write 의 결과 뒤에 조종 replay(같은 턴에 받음) → Write `조종.md` |
| 13.2s | `result success`(턴 하나) → stdin 닫음 → 커밋 · push → 서버가 인스턴스 라인에 넣고 단계 끝(SUBMITTED) |

결과(인스턴스 라인): `산출물/01_인사말 쓰기 (Claude Code)/인사.md`(「안녕하세요 — 로컬 Claude Code」) · `체크.md`(「1차 완료」) · `조종.md`(「조종 받음 — 사람이 실행 중에 바꾼 방향」) · `결과.md`(「실행 중에 바꾼 방향」에 조종 글).
요약(CLI 의 마지막 답): 「세 파일을 모두 만들었어요 … 중간에 바뀐 방향에 따라 `조종.md`를 더 만들고 … 먼저 만든 두 파일은 고치지 않았고, git 명령은 쓰지 않았어요.」
조종 상태: 보냄 → 반영 `live`. 세션은 하나(다시 띄우지 않음).

## Codex 0.162.1 — 멈추고 같은 세션을 이어서(`resume`)

명령:
```
codex exec --json --skip-git-repo-check -s workspace-write -c approval_policy="never" -C <작업 폴더> -
codex exec resume --json --skip-git-repo-check -c sandbox_mode="workspace-write" -c approval_policy="never" <thread id> -
```

| 때 | 일어난 것 |
|---|---|
| 0s | 작업 폴더 받음 · 가지 |
| | `thread.started`(thread id = 세션) · `turn.started` · `agent_message`「지정된 산출물 폴더에 두 파일을 만들고 요청하신 문구를 쓸게요.」 |
| 7.0s | 조종 보냄 → runner 가 SIGINT 로 멈춤(파일을 쓰기 전) |
| | `codex exec resume <thread> -` 에 조종 글 → `thread.started`(같은 id) · 「기존 요청을 이어서 완료하고, 같은 산출물 폴더에 `조종.md`도 추가할게요.」 · 셸 하나(`python3` 로 세 파일, workspace-write 샌드박스) · `turn.completed` |
| 24.6s | 커밋 · push → 인스턴스 라인 · 단계 끝 |

결과: `인사.md`(「안녕하세요 — 로컬 Codex」) · `체크.md` · `조종.md`(「조종 받음 — …」) · `결과.md`.
조종 상태: 보냄 → 반영 `resume`. 이어 간 세션이 처음 지시(인사 · 체크)를 기억하고 끝까지 했다.

## 알게 된 것
- Claude Code 는 `--input-format stream-json` 에서 실행 중에 들어온 user 메시지를 지금 도구 호출이 끝난 뒤 **같은 턴**에 받는다(`--replay-user-messages` 로 받았다는 것을 안다). 그래서 멈추지 않고 조종된다. 실행이 끝난 뒤의 조종은 `--resume` 으로 같은 세션을 잇는다.
- Codex `exec` 는 실행 중 입력을 받지 않는다. 멈추고 `exec resume <thread>` 로 이으면 앞 지시를 기억한 채 계속한다.
- `--setting-sources project` 로 사람의 훅(이 맥의 rtk 등)이 끼지 않았다. `acceptEdits` 는 허용 목록 밖의 셸 쓰기를 막는다(위 permission_denied) — 모델은 Write 로 바꿔 했다.

## Claude Code 2.1.330 — 서버의 회사 스킬을 쓴다

```bash
cd server && node test/localAgents.smoke.mjs skill
```

서버에 스킬 폴더 「인사말-규칙」(kind skill)을 두고, 활동 「인사말 쓰기 (회사 스킬)」의 `skills` 에 그 이름을 적었다. SKILL.md:
```
---
name: 인사말-규칙
description: 회사 인사말 · 안내 문구를 쓸 때 지키는 규칙. 인사말 파일을 만들 때 쓴다.
---
# 인사말 규칙
- 인사말은 「안녕하세요, 달빛상사입니다.」로 시작한다.
- 파일의 맨 끝 줄에 「— 달빛상사 인사 규칙 v1」을 붙인다.
```
일 정의: 「「인사.md」 파일을 만들고 한 줄 인사말을 쓰세요. 이 일에 쓰는 회사 스킬이 있으면 그 규칙을 따르세요. 다른 일은 하지 마세요.」

| 때 | 일어난 것 |
|---|---|
| 0s | 작업 폴더 받음 · 스킬 폴더를 읽기 전용 토큰으로 받아 `.claude/skills/인사말-규칙/` 에 둠(카드: 「스킬 1개를 받았어요: 인사말-규칙」) |
| | `system init` → **`tool_use Skill {"skill":"인사말-규칙"}`** → 스킬 본문이 들어옴(「Base directory for this skill: …/.claude/skills/인사말-규칙」) |
| | Write `인사.md` |
| 11.4s | `result success` → 커밋 · push(`.claude` 는 커밋에 없음) → 인스턴스 라인 · 단계 끝 |

결과 `인사.md`: 「안녕하세요, 달빛상사입니다. 오늘도 좋은 하루 보내세요!」 / 「— 달빛상사 인사 규칙 v1」. 요약: 「회사 스킬 「인사말-규칙」을 읽고 그 규칙대로 인사말 파일을 만들었어요 …」.
→ `--setting-sources project` 에서도 작업 폴더의 `.claude/skills` 는 프로젝트 스킬로 읽히고, 허용 도구에 넣은 `Skill` 로 부른다.

## CLI 가 묻는 것과 답하는 키 — 실제 Claude Code 2.1.331 프로브 (2026-11-24, 「대화」 보기의 물음 카드)

이 맥의 `claude` 2.1.331 을 PTY(100×32)에서 띄웠다: 임시 `CLAUDE_CONFIG_DIR`(첫 설정을 끝낸 `.claude.json`, 그 폴더만 신뢰), 회사 모델 게이트웨이(Anthropic Messages API, 추론 low), `--session-id <uuid> --settings <훅만> --permission-mode acceptEdits`, 훅은 runner 의 `hook.js`(exec 형식)로 `SessionStart` · `UserPromptSubmit` · `Stop` · `StopFailure` · `Notification` · `PermissionRequest` · `PreToolUse` · `PostToolUse`. 화면은 @xterm/headless 로 읽었다. 사람의 `~/.claude.json` · 로그인은 건드리지 않았고 게이트웨이 주소 · 키는 기록에 넣지 않았다. 스크립트는 저장소에 넣지 않았다(시험이 아니라 한 번 재는 프로브).

| 한 것 | CLI 가 보인 것 | 누른 키 | 일어난 것 |
|---|---|---|---|
| `python3 -c "print(41+1)"` 를 Bash 로 | 「Bash command … This command requires approval · Do you want to proceed? ❯ 1. Yes · 2. Yes, and don’t ask again for: python3 * · 3. Yes, and switch to auto mode · auto mode handles these prompts for you · 4. No · Esc to cancel · Tab to amend」, 훅 `PreToolUse` → **`PermissionRequest`** `{tool_name: "Bash", tool_input: {command, description}, permission_suggestions: [{type: "addRules", rules: [{toolName: "Bash", ruleContent: …}], behavior: "allow", destination: "localSettings"}]}` | `1` | 명령이 돌고(`⎿ 42`) 턴이 끝남(`Stop`) |
| 다음 명령 | 같은 창 | `Esc` | 「⎿ Interrupted · What should Claude do instead?」, **`Stop` 훅 없음**, 기록에 `tool_result {is_error: true, "The user doesn't want to proceed with this tool use…"}`(`toolUseResult: "User rejected tool use"`) 다음 `user {rowSource: "harness", text: "[Request interrupted by user for tool use]"}` |
| 다음 명령 | 같은 창 | `2` | 명령이 돌고 규칙이 더해짐, `Stop` |
| `AskUserQuestion` 한 물음(「Markdown」 · 「Plain text」) | 「☐ File format · Which file format should the quote use? ❯ 1. Markdown · 2. Plain text · 3. Type something. · 4. Chat about this · Enter to select · ↑/↓ to navigate · Esc to cancel」, 훅 `PermissionRequest {tool_name: "AskUserQuestion", tool_input: {questions: [...]}}` | `2` | 바로 답이 됨: 「Answered Claude's questions: · … → Plain text」, 기록 `toolUseResult.answers` 에 그 답, 이어서 `choice.txt` 에 「Plain text」 |
| `AskUserQuestion` 두 물음(「Which currency?」 KRW · USD, 「Include VAT?」 Yes · No — 다른 세션) | 「← ☐ Currency ☐ VAT ✔ Submit →」 탭과 첫 물음의 항목들 | `2` | 「☒ Currency」, 둘째 물음으로 넘어감 |
| | 「← ☒ Currency ☐ VAT ✔ Submit →」 · 「Include VAT? ❯ 1. Yes · 2. No …」 | `1` | 「Review your answers ● Which currency? → USD ● Include VAT? → Yes ❯ 1. Submit answers · 2. Cancel」 — 여기서 멈춤(8초 동안 `Stop` 없음) |
| | 그 확인 화면 | Enter | 「Answered Claude's questions: · Which currency? → USD · Include VAT? → Yes」, 이어서 `answers.txt` 에 「Currency: USD」 · 「VAT: Yes」 |
| 회사 스킬 · Edit (같은 세션 다음 턴) | `tool_use Skill {"skill": "quote-rule"}`(세션 뒤에 만든 스킬이라 「Unknown skill」), `Edit {file_path, old_string, new_string, replace_all}` → `toolUseResult {filePath, oldString, newString, originalFile, structuredPatch: [{oldStart, oldLines, newStart, newLines, lines: [" …", "-…", "+…"]}]}` | — | 「대화」의 차이는 이 `structuredPatch` 그대로 |

알게 된 것:
- 물음의 키는 그 창이 떠 있을 때만 키다. 창이 없을 때 누른 `2` · `1` 은 입력란에 「21」로 들어가 줄 선 메시지가 됐다 — runner 는 물음이 아직 열려 있을 때만 키를 누른다.
- 기록에는 대화 말고도 기록 관리 항목이 많다(`mode` · `permission-mode` · `atis-latch` · `file-history-snapshot` · `api-request` · `api-request-blob`(보낸 것의 사본 — 같은 말이 또 있음) · `attachment`(environment · skill_listing · prompt_snapshot …) · `system`(stop_hook_summary · turn_duration) · `last-prompt` · `ai-title` · `tools-used`). 「대화」는 `user` · `assistant` · `queued_command` 만 읽는다. assistant 한 메시지는 블록마다(`thinking` · `text` · `tool_use`) 한 줄씩 기록된다.
- 여러 물음은 물음마다 번호를 누르면 다음 물음으로 넘어가고, 끝의 확인 화면에서 Enter 를 눌러야 낸다 → runner 의 키는 「번호들 + Enter」(가짜 CLI 의 `CHOOSE` 도 같게 했다).
- 첫 프로브에서는 화면에 메뉴가 뜨기 전에(프롬프트의 글자에 「KRW」가 있어 뜬 줄 알았다) 번호를 눌러 입력란에 「21」이 들어갔다 — 물음은 화면이 아니라 훅(`PermissionRequest`)으로 알아야 하는 까닭이다.
