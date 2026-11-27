# 시험과 증거 — 챔피언 폴더 0단계

자산 경로 탐색, 프런트 매터 파싱, 제외 대상 이름 판별, 비밀 키 패턴 탐지, 동기화 토큰 검증, 원본 연결의 전체 수명 주기는 단위 테스트로 검증한다. 단위 테스트는 실제 Git과 데이터베이스를 사용하며, 모델은 사용하지 않는다. 실제 기기 연결과 `git push`는 HTTP E2E 테스트로, 화면은 Playwright로 검증한다. 데스크톱 앱의 폴더 스캔 및 업로드 기능(F-CH-01~03)은 데스크톱 테스트에서 검증한다.

데이터베이스 마이그레이션 파일은 `059_champion_folders.sql`이다. 기존 구조에 항목을 추가하는 방식이며 반복 실행할 수 있다. 개발 공용 데이터베이스에는 이미 적용했다.

## 단위 테스트

```bash
cd server && node --test test/championFolders.test.js
```

- **CH-U-01 경로 패턴:** `**`는 0개 이상의 경로 세그먼트와 일치하고, `*`는 단일 세그먼트 안에서 일치한다. 패턴 앞에 `**/`가 없으면 폴더 루트를 기준으로 매칭한다. 정규식 특수 문자는 일반 문자로 처리한다.
- **CH-U-02 자산 경로:** 플랫폼별로 지정된 경로의 파일만 자산으로 인식한다. `openspec/changes/archive/…`, `docs/skills/SKILL.md`, `.claude/settings.local.json`은 제외한다. 자산 이름은 경로에서 추출한다. 스킬은 폴더 이름, 명령은 `opsx:apply`와 같은 이름, 나머지는 파일 이름을 사용한다.
- **CH-U-03 이름 및 설명 추출:** 프런트 매터에서 이름과 설명을 추출한다. 한 줄 값, 따옴표로 감싼 값, 여러 줄 값(`>`), CRLF 줄바꿈을 지원한다. 프런트 매터가 없는 지침 파일은 첫 번째 제목을 사용한다.
- **CH-U-04 실행 설정 판별:** 훅, 허용 목록 또는 MCP 서버가 있는 설정만 실행 설정으로 인식한다. 허용 목록이 비어 있거나 모델 설정만 있으면 제외한다.
- **CH-U-05 제외 대상 이름:** 대소문자를 구분하지 않고 판별한다. `.env.example`, `*.pub`, 발표 파일의 `.key` 확장자는 비밀 정보로 간주하지 않는다.
- **CH-U-06·07 비밀 정보 차단:** 서버는 명확한 비밀 키 패턴(`level block`)과 비밀 정보로 분류된 파일 이름만 차단하며, 줄 번호와 사유만 반환한다. 키 패턴을 가진 테스트 값은 테스트 실행 중 생성하고 파일에 저장하지 않는다.
- **CH-U-08 데이터 파일 일치:** 두 데이터 파일은 편집 가능한 JSON 형식이며, 데스크톱 사본(`desktop/src/runner/`)과 일치한다.
- **CH-U-09 초기 커밋 및 삭제:** 챔피언 폴더의 초기 커밋에는 파일이 없다. Git 속성은 저장소의 `info/attributes`에 저장한다. 폴더가 비어 있을 때만 소유자가 삭제할 수 있다.
- **CH-U-10 자산 목록 갱신:** `main`이 변경되면 자산 목록도 갱신한다. 변경된 파일만 다시 읽고, 삭제된 파일은 목록에서 제거한다. 폴더 목록 카드의 종류별 자산 수도 검증한다.
- **CH-U-11 동기화 토큰 검증:** 요청마다 기기, 원본, 역할을 확인한다. 연결 전, 보기 권한(받기만 허용), 비구성원, 일시 중지, 원본 제거, 다른 기기, 연결 해제된 기기, 다른 회사에 해당하는 경우를 검증한다.
- **CH-U-12 원본 연결의 전체 수명 주기:** 다음 흐름을 검증한다.
  1. 일반 폴더, 존재하지 않는 폴더, 비구성원, 보기 권한 사용자, 연결 전 토큰의 요청을 거절한다.
  2. 원본을 연결하고 경로 대신 이름만 저장한 뒤, 유효 기간 1시간의 토큰을 발급한다.
  3. 스냅숏을 반영하고 `main`의 빨리 감기 병합, 작업 파일, 자산 5개를 확인한다.
  4. 비밀 키 패턴이 포함된 파일은 push 직후 브랜치를 이전 상태로 되돌린다. `sync:pushed`도 거절하며 `main`은 유지한다.
  5. `.env` 파일과 한 번의 push에 포함된 커밋 이력에서 키를 추가했다가 삭제한 경우도 검증한다. 비밀 정보가 없는 스냅숏은 정상 반영한다.
  6. 웹 편집과 병합을 검증한다. 같은 줄에서 충돌하면 `main`을 유지하고 `sync:behind`를 반환한다.
  7. 일시 중지 → 재개 → 원본 제거 → 재연결 → 연결 해제 → 기기 연결 해제를 검증한다.

- **CH-U-13 구조:** 심볼릭 링크 · gitlink · `.gitmodules` · `.lfsconfig`가 포함된 push는 `structure`로 거절한다. 브랜치는 직전 HEAD로 복구하고 main은 그대로 유지한다.
- **CH-U-14 한도:** 새 커밋 21개(커밋에 비밀키가 포함되어 있어도 커밋 수 검사에서 먼저 차단), 파일당 크기, 스냅숏 전체 파일 수 또는 전체 크기가 한도를 초과하면 `too_big`과 초과한 한도를 반환한다. 한도 이내이면 허용한다.
- **CH-U-15 검사 미완료 시 거절:** 누락된 객체나 블롭이 아닌 객체는 `cat-file --batch` 읽기에 실패한다. 알 수 없는 HEAD와 객체가 사라진 파일은 `unchecked`로 거절한다. 모든 블롭은 한 번의 읽기로 순서대로 누락 없이 수신한다.
- **CH-U-16 속성:** 폴더에 `.gitattributes`(`* text eol=crlf` · `*.md merge=union` · `filter=lfs`)가 있어도 서버의 main 작업 트리 파일은 블롭과 바이트 단위로 일치하며 CR이 없다. 같은 줄을 웹과 PC에서 서로 다르게 수정하면 union으로 병합하지 않고 「서버 쪽에도 바뀐 것이 있어요」를 반환한다.
- **CH-U-17 연결 · 반복 · 빈도:** 파일이 있는 폴더에 동료의 PC나 두 번째 PC를 연결하면 `not_empty`를 반환하고, 최초 업로드 PC는 다시 연결할 수 있다. 이미 수신한 HEAD를 다시 알리면 즉시 `sync:taken`을 반환한다. 다른 회사 링크에 대한 연결 해제 요청은 영향을 주지 않으며, 요청 빈도가 한도를 초과하면 `rate_limited`를 반환한다.
- **CH-U-18 브랜치 숨김:** 클러스터 토큰과 다른 기기의 동기화 토큰에는 동기화 브랜치가 보이지 않고, 해당 기기의 토큰에는 보인다. 데스크톱 토큰으로 `/api/git`에 접근하면 403을 반환하고, 클러스터 토큰으로 동기화 브랜치에 push하면 거절한다.

**결과(2026-11-26): 18개 통과.** 공통 코드를 사용하는 채팅의 내 PC 에이전트(`chatAgents.test.js`, 8개), 로컬 에이전트(`localAgents.test.js`, 31개), 공유 폴더 Git(`folderGitRemote.test.js`, 13개) 테스트도 모두 통과했다. 정리, 편집 저장, 검색, 언어, 사전 관련 테스트도 모두 통과했다.

## HTTP E2E 테스트 — 실제 연결 및 Git 사용

```bash
cd server && node test/champion-sync.e2e.mjs
```

BFF 포트는 8963(`CH_PORT`), 회사는 `champion-e2e`를 사용한다. 테스트 폴더는 임시 폴더이며, 모델은 사용하지 않는다.

- **CH-E-01 BFF 실행:** BFF를 시작한다.
- **CH-E-02 연결 및 동기화:** 챔피언 폴더를 생성하고, 데스크톱 대역이 실제 연결 API(`/api/local-agents/link`)로 연결한다. 해당 기기와 브랜치에 한정된 유효 기간 1시간의 동기화 토큰으로 공개 경로(`/api/local-git`)에서 `git clone`과 `git push`를 수행한다. `sync:pushed` 이후 `main`의 빨리 감기 병합, 파일 8개, 자산 6개(Claude Code·Codex·Cursor·스펙)를 확인한다. 원본 PC 정보에는 이름, 사용자, 기기가 포함되며 경로는 포함되지 않는다.
- **CH-E-03 접근 제한:** 같은 토큰으로 `main`이나 다른 사용자의 브랜치에 push하거나 브랜치를 삭제하면 `remote rejected`로 거절된다. 토큰이 없으면 401, 다른 폴더에 접근하면 403을 반환한다. 다른 회사의 폴더와 일반 폴더는 연결할 수 없다.
- **CH-E-04 비밀 정보 차단 및 복구:** 개인 키가 포함된 파일을 push하면 push 자체는 수락되지만, 응답이 완료되기 전에 브랜치가 직전 커밋으로 복원된다. `sync:refused secret`에는 경로, 2번째 줄, `private_key`가 포함되며 `main`은 유지된다. 키 값은 응답과 서버 로그 모두에 포함되지 않는다. 해당 파일을 제거한 뒤 다시 push하면 정상 반영된다.
- **CH-E-05 구조 · 한도 · 속성:** 실제 git으로 심볼릭 링크 · gitlink · `.gitmodules` · 새 커밋 21개 · 50 MB 초과 파일을 push한다. push 자체는 수락하지만 응답이 완료될 때 브랜치는 이미 이전 상태로 복구되어 있다. `sync:pushed`는 `structure` · `too_big`으로 거절하고 main은 그대로 유지한다. `.gitattributes`(`eol=crlf` · `union`)는 수락하지만 서버의 main 작업 트리 파일에는 CR이 생기지 않는다.
- **CH-E-06 브랜치 숨김:** 클러스터 토큰으로 실행한 `ls-remote`에는 main만 표시되고 동기화 브랜치는 표시되지 않는다. 클러스터 토큰으로 동기화 브랜치에 push하면 거절하고, 데스크톱 토큰으로 `/api/git`에 접근하면 403을 반환한다.
- **CH-E-07 연결 제한 · 권한 변경 · 기기 연결 해제:** 파일이 있는 폴더는 김동료의 PC가 연결하지 못한다(`not_empty`). 빈 폴더에서는 김동료의 토큰에 박챔피언의 동기화 브랜치가 보이지 않는다. 편집자였던 김동료의 권한을 보기로 변경하면 push는 403으로 거절되지만 fetch는 허용된다. 기기 연결을 해제하면 링크가 코드 4401로 종료되고, 토큰을 사용한 요청은 403으로 거절된다.
- **CH-E-08 원본 연결 제어:** 웹에서 일시 중지, 재개, 원본 연결 제거를 수행한다. 해당 컴퓨터가 상태에 따라 `sync:refused paused` 또는 `sync:refused source_removed`를 즉시 수신하는지 확인한다. 토큰을 사용한 요청의 403 응답과 `sync:token` 거절, 재연결 및 연결 해제도 검증한다.
- **CH-E-09 폴더 삭제 및 자산 수:** 업로드되지 않은 빈 챔피언 폴더는 삭제할 수 있다. 파일이 있으면 409, 일반 폴더이면 400, 소유자가 아니면 403을 반환한다. 폴더 목록의 자산 수도 확인한다.

**결과(2026-11-26): 9단계 통과.** 기존 `localAgents.e2e.mjs`(9단계)와 `chatAgents.e2e.mjs`(8단계)도 통과했다. 이 두 테스트에는 공개 Git 경로의 작업 토큰 검증이 포함된다.

## 화면 테스트 — Playwright

```bash
cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/champion-folders.spec.js
```

테스트 전용 스택(회사 `champion-web`, BFF 8963, Vite 5363 — `RT_CH_API_PORT` · `RT_CH_WEB_PORT`로 바꿈)을 실행하고 테스트 후 정리한다. F-CH-07 · F-CH-10은 데스크톱 연결 인터페이스(`window.pglDesktop.folders` · `localRunner`)를 흉내 낸 페이지로 확인한다.

**결과(2026-11-26): 5개 통과.** 녹화 결함 수정 뒤(같은 날, BFF 8970 · Vite 5370): **7개 통과**(F-CH-08 · F-CH-10 추가).

| 테스트 | 스크린샷 (`results/`) |
|---|---|
| F-CH-04 브라우저에서 안내만 표시 — 화면 너비 1280px·390px | `f-ch-04-web-hint.png` · `f-ch-04-web-hint-390.png` |
| F-CH-05 390px 화면의 「에이전트 자산」 — 라이트·다크 테마 | `f-ch-05-kit-390-light.png` · `f-ch-05-kit-390-light-2.png` · `f-ch-05-kit-390-dark.png` · `f-ch-05-kit-390-dark-2.png` |
| F-CH-06 넓은 화면의 자산 탭 및 파일 열기 | `f-ch-06-kit-desktop.png` · `f-ch-06-kit-open.png` |
| F-CH-07 업로드 시트 및 업로드 후 폴더 화면 | `f-ch-07-sheet.png` · `f-ch-07-bound.png` |
| F-CH-08 SKILL.md 의 머리말을 작은 표로 — 화면 너비 1280px·390px | `f-ch-08-front-matter.png` · `f-ch-08-front-matter-390.png` |
| F-CH-10 연결된 뒤에만 「내 PC 폴더 올리기」 — 폴더 화면에서 연결, 연결을 해제한 PC 의 안내(1280px·390px) | `f-ch-10-paired-from-folders.png` · `f-ch-10-unpaired.png` · `f-ch-10-unpaired-390.png` |

녹화 결함 수정의 단위 시험: `cd server && node --test test/frontMatter.test.js`(FM-01~03, 머리말 나누기 · YAML 일부 · 머리말이 아닌 것) · `cd desktop && node --test test/sync.test.js`(F-CH-09, 확인 창의 설명).

## 데스크톱 앱 (Playwright `_electron`)

```bash
cd e2e && npx playwright test --project=desktop tests/desktop/champion.spec.js
```

데스크톱 앱(Electron)을 이 작업 트리의 서버(BFF 8964 · Vite 5364, 회사 `champion-ui`)에 붙여 실제로 폴더를 고르고 올린다. 결과(2026-11-26, 데스크톱 담당 보고): 5개 통과.

| 검증 내용 | 테스트 |
|---|---|
| 실제 Electron 앱: 미리 보기에는 제외 항목의 유형과 사유(비밀 정보 · 개인 설정 · 재생성 가능한 항목 · `.gitignore` 규칙), 확인이 필요한 `config/app.txt`와 「GitHub 토큰」, 발견한 에이전트 자산(Claude Code · Codex)을 표시함. 페이지 HTML에는 토큰 값과 선택한 폴더 경로가 포함되지 않음 | F-CH-01 |
| 업로드 시 시스템 대화상자에서 한 번 더 확인하며, 대화상자 문구도 검증함. 새 폴더의 파일, 「이 PC의 … 폴더와 연결됨 · 올려 둠」 상태, 「에이전트 자산」 탭의 스킬 · `CLAUDE.md` · `AGENTS.md`를 확인함. 앱 목록과 서버의 원본 레코드에는 경로 없이 이름표와 숫자만 표시됨 | F-CH-02 |
| `main` 브랜치와 파일 목록에 `.env` · `.claude/settings.local.json` · `config/app.txt` · `node_modules/` · `dist/`는 없고, `.env.example` · `.claude/settings.json`은 있음. `main`의 커밋은 「박챔피언 · 동기화 · 박챔피언의 맥」 하나뿐임. 선택한 폴더는 파일 바이트와 타임스탬프까지 그대로 유지되며, `.git`이 생성되지 않음 | F-CH-03 |
| 「지금 올리기」 실행 시 수정한 README가 `main`에 커밋 하나로 반영되며, 선택한 폴더는 그대로 유지됨 | (데스크톱 시험 4) |
| 시스템 대화상자에서 「취소」를 선택하면 「올리지 않았어요」가 표시됨. 원본 레코드와 폴더가 남지 않으며, 앱 목록도 변경되지 않음 | (데스크톱 시험 5) |

스크린샷: `f-ch-01-desktop-preview.png` · `f-ch-02-desktop-folder.png` · `f-ch-02-desktop-kit.png`

## 폴더를 끌어다 놓아 올리기 · 「파일 올리기」 · 「폴더 올리기」 · 작업실의 까닭 (사용자 녹화 11-27)

`e2e/README.md` 68절. 화면은 자기 스택(여러 회사 · 터미널 열쇠 없음 — 운영과 같은 설정)으로 본다.

```bash
cd server && node --test test/folderDrop.test.js
cd e2e && npx playwright test --project=feature tests/feature/folder-drop.spec.js
cd e2e && npx playwright test --project=desktop tests/desktop/folder-drop.spec.js
```

- 단위(13): 서버와 같은 갈래 읽기(`groupOf` 견주기) · 들어가지 않는 폴더(`.git` · `node_modules` · `.ssh` · `.claude/projects`) · 따라 내려가기(`readEntries` 여러 번) · 빠지는 것과 까닭 · 열쇠 모양(줄 · 종류, 값 없음) · 새 폴더는 그 안의 것을 맨 위부터 · 한도와 가장 큰 것 · 여럿 놓기 · `webkitdirectory` 목록 · 원격 주소(이름 · 토큰 지움) · 요청 나누기 · 서버의 파일별 거절(`refusalOf`) · 자기 안으로 이어지는 폴더(깊이에서 멈춤).
- 화면 F-FD-01~09 · 데스크톱 F-FD-10 · 11 — 증거 사진(`results/`): `f-fd-01-drop-sheet` · `f-fd-01-uploaded` · `f-fd-02-list-dropzone` · `f-fd-02-new-sheet` · `f-fd-03-over` · `f-fd-04-menu` · `f-fd-05-sheet-390` · `f-fd-06-dark` · `f-fd-07-desktop-old` · `f-fd-07-desktop-ways` · `f-fd-09-workroom` · `f-fd-10-desktop-dir-sheet` · `f-fd-11-desktop-workroom`.
