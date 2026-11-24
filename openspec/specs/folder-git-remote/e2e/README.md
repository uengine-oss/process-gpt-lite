# 시험과 증거

모델은 부르지 않는다(변형의 변경 카드를 만들 때도 답하지 않는 주소를 준다). 서버 시험은 로컬 DB를 쓴다. 폴더는 임시 디렉터리에 만들고, 시험 회사 `gitremote-test`에 두었다가 끝나면 지운다. git은 실제 git으로 내려받고 올린다. 교차 시험은 실제 Lite BFF를 띄우고, cli-agent의 `core/worktree.py`(`prepare()`, `commit()`)를 cli-agent 가상환경의 Python으로 돌린다. cli-agent 서비스 자체는 띄우지 않는다.

```bash
# Lite (process-gpt-lite, feat/folder-git-remote)
cd server && node --test --test-concurrency=1 test/folderGitRemote.test.js test/folderGc.test.js
# 교차: BFF(PRO_BACKGROUND=0, 8790–8799 중 빈 포트, PRO_GIT_URL=자기 주소)를 스스로 띄우고 끝나면 내린다
CLI_AGENT_DIR=../../cli-agent-gitremote CLI_AGENT_PYTHON=<cli-agent .venv>/bin/python node test/folder-git-remote.e2e.mjs
# cli-agent (process-gpt-cli-agent, feat/remote-project-repo)
pytest tests/test_worktree.py
```

| 스펙 시나리오 | 시험 |
|---|---|
| 단계가 폴더를 주소와 토큰으로 받는다 | `folderGitRemote.test.js` 「PRO_GIT_URL 이 있으면 단계에 주소와 토큰을…」 · 교차 3 |
| 에이전트의 가지가 폴더에 올라오고, main은 그대로다 | 교차 4·5 · `folderGitRemote.test.js` 「토큰으로 내려받고 pgpt-agent/ 가지를 올린다」 · 「끝난 단계: 올라온 가지는 그 단계의 변형이 되고…」 · cli-agent `test_a_url_is_cloned_…` · `test_a_work_item_on_a_url_runs_in_the_clone_…` |
| 바꾼 것이 없으면 | cli-agent `test_nothing_changed_means_nothing_pushed` · `folderGitRemote.test.js` 「끝난 단계 …, 올라온 것이 없으면 변형을 만들지 않는다」 |
| 기한이 지난 토큰 | 교차 7 · `folderGitRemote.test.js` 「토큰이 없거나 맞지 않으면 401 · 403 · 404」 · 「토큰: … 기한이 지나면 읽히지 않는다」 · cli-agent `test_a_refused_token_is_said_…` |
| 다른 폴더의 토큰, 연결형 폴더 | `folderGitRemote.test.js` 「토큰이 없거나 맞지 않으면 401 · 403 · 404」 |
| 토큰을 비밀번호로 | `folderGitRemote.test.js` 「토큰으로 내려받고…」(`http://x:<토큰>@…` clone) · 「토큰은 Bearer 로도, Basic 의 비밀번호로도 받는다」 |
| 멈췄다가 이어지는 실행 | cli-agent `test_a_paused_run_resumes_into_its_own_clone_without_cloning_again` · `test_a_branch_an_earlier_attempt_pushed_is_continued` |
| main에 올리려 한다 | 교차 6 · `folderGitRemote.test.js` 「main · 태그 · 다른 가지 · 지우기는 「remote rejected」」 · 「거절은 receive-pack 의 상태 보고로」 |
| 태그, 다른 가지, 지우기 | `folderGitRemote.test.js` 「main · 태그 · 다른 가지 · 지우기는…」 · 「pgpt-agent/ 아래 가지를 만들거나 옮기는 것만 된다」 |
| 섞인 요청 | `folderGitRemote.test.js` 「main · 태그 …」(`pgpt-agent/mixed` + `main`) |
| 저장 중에 들어온 push | `folderGitRemote.test.js` 「밀어 넣기는 폴더의 직렬 잠금 안에서…」 |
| 너무 큰 push | `folderGitRemote.test.js` 「한도를 넘는 밀어 넣기는 413, gzip 으로 보낸 요청도 읽는다」(시험은 한도를 64KB로 줄여 띄운다) |
| 로컬 개발 | `folderGitRemote.test.js` 「PRO_GIT_URL 이 있으면…, 없으면 저장소 경로를 준다」 · cli-agent `test_a_local_path_still_gets_a_worktree_and_nothing_is_pushed` |
| 저장할 때 git이 스스로 정리하지 않는다 | `folderGc.test.js` 「폴더 git 은 자동 gc 를 하지 않는다(gc.auto=0)」 |
| 여러 번 고쳐 저장한 큰 문서 | `folderGc.test.js` 「여러 번 접어 저장한 큰 문서: 밤 기본값은 한 주를 남기고, 기한이 지나면 디스크가 준다」 |
| 저장 중에 정리할 차례가 온다 | `folderGc.test.js` 「gc 는 폴더의 직렬 잠금 안에서…」 |
| 할 일이 적은 폴더 | `folderGc.test.js` 「할 일이 적은 폴더는 건너뛴다」 · 「할 일이 적으면 건너뛰고, 연결형 폴더는 건드리지 않는다, 회사의 폴더마다 한 줄」 |
| 개발용 두 번째 서버 | `folderGc.test.js` 「index.js: 밤 정리는 PRO_BACKGROUND=0 이면 시작하지 않는다」(소스 순서 확인) |
| (경로가 세션·회사 미들웨어보다 앞) | `folderGitRemote.test.js` 「index.js: git 경로는 본문 파서·세션·회사 미들웨어보다 앞에 붙는다」 |
| (공개 주소에서 막힘) | `install/docker/nginx.conf` `location /api/git/ { return 404; }` — 시험 없음(웹 이미지 설정) |

**밤 정리 시험의 숫자**(2026-11-24, 맥 git 2.50.1): 1MB 무작위 문서를 한 편집에서 8번 접어 저장하면 정리 전 8,300KiB였다. 밤 기본값(7일)으로 정리한 뒤에도 8,198KiB로, 이전 버전이 남는다. 기한을 `now`로 준 정리에서는 1,026KiB로 줄었다. `.git` 디스크 크기도 8,227KiB에서 1,054KiB로 줄었다. 마지막 버전은 그대로이고, `fsck`에서도 빠진 객체가 없다.

`results/`:
- `server.txt`: Lite 서버 시험 출력. 새 시험 두 파일과 폴더 관련 회귀 시험(`folderEditSave`, `folderFindOpen`, `lang-panels-folders-team`, `threadFolders`, `threadFolders.e2e`, `capture-fixes`)을 한 프로세스에서 하나씩 돌렸다. `threadFolders.e2e`의 5건은 떠 있는 서버(:8793)와 deepagents 에이전트 턴이 필요해 건너뛰었다.
- `cli-agent.txt`: cli-agent `tests/test_worktree.py`(20건)와 전체 묶음.
- `cross.txt`: 교차 시험 출력. BFF를 띄우고, 폴더를 만들고, 토큰을 받고, cli-agent 코드로 clone·커밋·push한다. 이어서 Lite에 가지가 생겼는지, main으로 보낸 push가 거절되는지, 기한이 지난 토큰이 401을 받는지 확인한다.
