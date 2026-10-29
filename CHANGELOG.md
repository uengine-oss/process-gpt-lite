# 변경 기록 (Changelog)

이 저장소의 모든 눈에 띄는 변경을 적습니다. 형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/),
버전은 [유의적 버전](https://semver.org/lang/ko/)을 따릅니다. 1.0 전까지는 부 버전(0.x)이 바뀔 때 호환되지 않는 변경이 있을 수 있습니다.

## [Unreleased]

### 추가

- **다국어 협업 — 회의 실시간 AI 통역 · 메신저 자동 번역** (설계 process-gpt `openspec/changes/pgpt-pro-meeting-interpretation`):
  - **주 언어**: 사람마다 말하고 읽는 언어(`pro_profile.main_lang`, `server/sql/020_interpretation.sql`)를 화면 언어(ko|en)와 따로 둡니다. ko·en·ja·zh·es·fr·de·pt·it·ru·hi·vi·id·th·ar·tr·nl·pl 중에서 고르고, 그 밖의 언어는 영어 화면이 됩니다. 설정 › 계정 › 주 언어, 회의 로비, `PUT /api/me/main-lang`.
  - **회의 통역**: 받아쓰기는 말한 사람의 주 언어로 합니다(각자 자기 마이크만 — 화자 귀속 그대로). 듣는 사람은 다른 화자의 말을 자기 주 언어의 통역 음성으로 듣고, 그동안 그 화자의 원래 소리는 0.2로 낮춥니다(끊지 않음). 자막은 원문과 번역을 함께 보여 줍니다. 자기 말의 통역은 듣지 않고, 같은 언어끼리는 손대지 않습니다.
    - 기본 엔진은 서버가 여는 `gpt-realtime-translate` 세션입니다. 말 조각이 서버에 닿고 첫 소리까지 p50 ≈0.7초(가짜 마이크 시험, 말 끝에서는 ≈1.5초), 오디오 1분에 $0.034입니다.
    - 그 모델이 말하지 못하는 언어(th·ar·tr·nl·pl)와 실패할 때는 번역문 → `gpt-4o-mini-tts` 로 대신합니다(≈2.6초, ≈$0.016/분). 측정은 `server/scripts/interp-bench.mjs` 입니다.
    - 통역 음성은 서버의 음성 통로(`/api/meetings/voice` 웹소켓, 한 번 쓰는 표, 같은 출처)로만 옵니다. 키·임시 키는 브라우저로 가지 않습니다.
    - 조작: 「통역」 스위치(언어가 섞이면 저절로 켬), 「통역 듣기 / 원래 소리 듣기」, 「AI 통역」 배지, 키 없음·한도 초과·회의 한도 안내.
  - **기록과 회의록**: 방의 회의록 블록 줄마다 언어와 번역이 있고, 회의록(요약·결정·할 일)은 방 사람들의 주 언어마다 번역해 둡니다. 각자 자기 언어로 읽고 원문을 볼 수 있습니다.
  - **메신저 자동 번역**: 팀 대화방·1:1 대화에서 내 주 언어와 다른 메시지·에이전트 행·제안 카드를 번역해 보여 줍니다(「원문 보기 / Show original」). (원문, 대상 언어)마다 한 번 `gpt-4.1-mini` 로 번역해 `pro_translations` 에 캐시합니다(`POST /team/translate`).
  - **비용과 끄기**: 언어가 다를 때만 하고, 회의마다 분당·전체 통역 한도와 읽는 사람별 번역 예산이 있습니다. `PRO_INTERP=0`, `PRO_INTERP_VOICE=0`, `PRO_INTERP_ENGINE=chain`, `PRO_TRANSLATE=0`, `PRO_MSG_TRANSLATE=0` 으로 끕니다(설치 번들 `INTERP`·`INTERP_VOICE`·`TRANSLATE`·`MSG_TRANSLATE`).
  - 시험: `server/test/interp.test.js`(짝짓기·덕킹·번역 캐시), `e2e/tests/feature/interpretation.spec.js`(F-IT-01~03), `e2e/tests/agent/interpretation.spec.js`(A-15 한·영·일 가짜 마이크). 시험 계정은 `pro-intl-*` 입니다.
- **영어 모드(English mode) 화면**: 「언어 / Language」 전환(로그인 화면·설정 › 계정), `?lang=en|ko` > 저장한 설정(`pgl-lang`, `PUT /api/me/lang`) > 브라우저 언어 순으로 고르고, 모든 `/api` 호출에 `X-PGL-Lang` 을 보냅니다. 컴포넌트는 그대로 두고 런타임 번역기(`src/i18n/translate.js`)가 사전(`src/i18n/ko-en.json`, 약 1,700개 · 패턴 · 날짜/상대 시간/만·억·원/단위 규칙)으로 화면 글자를 영어로 바꿉니다(한국어 모드에서는 번역기를 싣지 않음). 추출기·검사기·사전 추가·서버 `L(ko, en)` 쌍 반영(`scripts/i18n-{extract.py,check.mjs,add.py,handoff.py,server-pairs.mjs}`), 용어집 `i18n/GLOSSARY.md`, 서버 쪽 인계 `i18n/HANDOFF.md`, 영어 스모크 시험 `e2e/tests/smoke/english.spec.js`(e2e 는 `PGL_LANG=ko|en` 으로 언어 고정).
- **영어 모드 — 서버·에이전트·예제 데이터**: 요청마다 `X-PGL-Lang`(이벤트 스트림은 `?lang=`) > 저장한 언어 > ko, `PUT /api/me/lang`·`GET /api/me` 의 `lang`(`server/sql/019_lang.sql`, `server/lib/lang.js`). 배경 작업(메일 폴러·미션·마이닝·회의·프로세스 단계·알림)은 그 일의 주인·받는 사람이 저장한 언어로. 영어일 때 모든 모델 호출(메일 분석·검수·회의록·마이닝 이름·패널 앱·브라우저 계획·개선 설명·제목)과 에이전트(deepagents·cli-agent·작업실 Claude Code·skill-creator·프로세스 생성)가 영어로 답하고 파일 이름·문서 내용도 영어로 — 영어 설계 제안서는 평면도 그림을 넣은 워드 문서. 서버가 쓰는 고정 문장·알림·오류, 데모 메일함·연습 메일(`server/fixtures/*-en.json`), 시드 `--lang en`(개선·마이닝·출장비 정산·카탈로그 단가 조사·SNS), 회의 받아쓰기(영어 회의는 `language=en`), 로그인 코드 메일(한·영 병기)에 영어판. 한국어 모드는 그대로. 시험: `server/test/lang*.test.js`, `e2e/tests/agent/english.spec.js`.
- **영문 데모 테넌트(`en-demo`) — 호스트 이름별 테넌트** (`i18n/EN-DEMO.md`): 같은 서버·Vite 에서 `PRO_TENANT_HOSTS=en.localhost=en-demo` 로 http://en.localhost:5180 이 별도 테넌트가 됩니다(`server/lib/tenant.js`; 설정이 없으면 예전처럼 테넌트 하나, ProcessGPT 게이트웨이 모드 `PRO_TENANT_FROM_HEADER` 와 한 모듈). 계정은 처음 로그인한 테넌트(auth `app_metadata.tenant_id`)에 속하고 다른 주소에서는 403 으로 막혀, 영문 화면에 한국어 팀원·프로세스·스킬이 섞이지 않습니다. 요청은 그 사람의 테넌트로, 사람별 배경 작업(`asUser`)도 그 사람의 테넌트로, 주기 작업(마이닝 스캔·mcp-hub 등록·제약 점검·단계 재시도·폴더 단계·알림·대화방 피드·회의 정리)은 테넌트마다 돕니다. completion(X-Forwarded-Host)·deepagents·process-miner·mcp-hub·`tenants.mcp`(이 서버의 `pgpt-*` 만)·폴더 저장소·작업 폴더가 테넌트를 따릅니다. 영문 출연진(Jinyoung Jang·Minji Kim·Seoyeon Park, `pro-en-*@uengine.org`)·팀·역할과 시드를 `server/scripts/en-demo.mjs`(`--seed`·`--reset`·`--clean`·`--status`)로 만들고, 시드의 `--lang en` 은 이제 한국어 데모를 덮어쓰지 않고 영문 테넌트에 씁니다(`server/lib/seedTenant.js`, 마이닝 사례 id 에 테넌트). 영어로 시작한 영어 프로세스의 인스턴스 이름은 영어로 유지합니다(completion 의 이름 짓기는 한국어 전용). 시험: `server/test/tenant.test.js`, 영문 테넌트에서 `e2e/tests/smoke/english.spec.js`.
- **프로세스 개선 — 병목 · 가치 흐름 · 제약 이론 · 크리티컬 패스 · 개선 실행** (설계 process-gpt `openspec/changes/pgpt-pro-process-improvement`, 튜토리얼 20~22장):
  - process-gpt analytic 서비스의 리드타임 분해(`leadtime.py`: 큐 대기·검토 대기·사람 판단·에이전트 수행·재작업, 상태 전이 이력·이벤트 시각만 신뢰)를
    그대로 옮기고(원본 시험 17개 포함), 원본이 선언만 하던 검토 대기·재작업을 실제로 계산합니다. 엔진이 미리 만드는 TODO 와 도달 즉시 IN_PROGRESS 를
    보정하려고 앞 단계가 끝난 때를 배정으로, 담당자가 작업 항목을 처음 연 때(`events.human_checked`)를 착수로 씁니다.
  - 개선 화면 `/improve/:defId`: 병목(process-gpt BottleneckAnalysis 의 열지도 지표·공식, 단계별 분해, 인스턴스 프로파일) · 가치 흐름 지도(작업 vs 대기,
    첫 통과율, 흐름 효율 = Σ작업/리드타임, 차례 기다림 vs 담당자 기다림) · 제약(자원별 도착·기록에서 읽은 처리 능력·가동률·대기 건수 추세, 5단계를
    숫자와 효과로) · 크리티컬 패스(BPMN 위 CPM: 병렬=가장 늦은 가지, 배타=관측 비율 시나리오와 크리티컬 확률, 수정 요청 루프=기대 반복, 중앙값·p80,
    ES/EF/LS/LF/여유, BPMN 강조·간트, 진행 중 건의 남은 경로) · 개선 실행(자동화·사전 초안·기준 미만 건너뛰기·동시에·인원 추가·보완 줄이기의 전후를
    바로 계산, 「개선안 적용」 = 확인 후 Lite 저장 경로로 새 버전 + `proc_def_version` + PI Flag, 버전별 비교).
  - 채팅 "○○ 프로세스 어디가 병목이야? 어떻게 줄여?" — 계산 결과를 빠른 모델이 설명(25초 안에 못 하면 정해진 문장) + 개선 카드. MCP `/mcp/improve`
    도구 6개. 새 제약(가동률 75%↑ 또는 리드타임 중 대기 40%↑)이 나타나면 프로세스 소유자에게 한 번 알림.
  - 저장소: `server/sql/016_improve.sql`(멱등), 설치 번들 `install/db/seed.sql` 에 `pgpt-improve` MCP. 예제 데이터 `server/scripts/seed-improve-demo.mjs`
    (「달빛커피 제안」, `--run` 실제 엔진 실행, `--remove`).
  - 개발: `PRO_BACKGROUND=0` 이면 같은 DB 를 쓰는 두 번째 서버가 폴러·작업자·레지스트리·시작 정리를 돌리지 않습니다.
- e2e: feature F-IM-01…07(분석 권한·지표 불변식·what-if·알림·MCP·개선 적용·화면·사람 착수 신호), F-UT-06(서버 단위 시험 34개).

- **대화방 원격 회의 · 회의 도우미 · 자동 회의록** ([영상](https://youtu.be/4oOsqX72vII), 설계 process-gpt `openspec/changes/pgpt-pro-meetings`):
  - 그룹·1:1 대화방 머리줄의 "회의 시작" — 카메라·마이크·화면 공유가 되는 브라우저 회의(WebRTC 메시, 6명까지, STUN).
    신호는 기존 실시간 통로(SSE·롱폴링 `meeting` 이벤트)로, 방 구성원만 서버가 확인해 들입니다.
  - "프로세스 GPT 라이트 도우미" 타일: 각자 브라우저가 자기 마이크 소리만 말 단위 WAV 로 보내고, 서버가 OpenAI 받아쓰기로
    화자별 자막을 만듭니다. 들어가기 전 받아쓰기·기록 동의(동의하지 않으면 소리를 보내지도 받지도 않음).
  - 말의 의도 → 자료: 규칙 → 판단 모델(:8896) → 디바운스, 감지에 큰 모델 0회. 방에 공유된 파일(견적서·CAD 평면도),
    프로세스 진행 상황(단계 산출물 칩), 패널 앱 데이터, 공유 폴더 변형을 볼 권한이 있는 사람에게만 자료 패널에 띄웁니다.
    "모두에게 띄우기" 는 모든 참여자의 무대에 같은 자료를 각자의 사본으로 엽니다(파일 주인이면 공유 허가).
  - 회의 속 부탁("…다시 만들어 주세요")은 시작/아니요 제안 — 누른 사람의 에이전트가 하고, 결과는 자료 패널과 대화방에.
  - 회의 내용이 대화방에 저절로 남습니다(process-gpt `chats` 행 그대로): 회의 카드(제자리 갱신), 말 차례를 묶은 회의록 블록
    (2분·24줄마다 한 행, 문장마다 행을 만들지 않음), 띄운 자료, 맡긴 작업과 결과, 끝나면 최종 회의록(요약·결정·할 일 제안
    카드·참여자·시간·띄운 자료·동의하지 않은 사람). 띄운 자료의 전달은 프로세스 마이닝 인계(`handover_events`)로.
  - 스위치: `PRO_MEETINGS=0`(회의 끔), `PRO_MEETING_AGENT=0`(영상 회의만), 방별 도우미 끄기. `PRO_MEETING_ICE` 로 STUN/TURN.
  - 저장소: `server/sql/015_meetings.sql`(멱등, RLS — 방 구성원만 읽기), `install/db` 가 그대로 적용합니다.
  - 판단 모델이 없는 설치(번들 기본)는 자막·회의록만 남고 자료 자동 제시·부탁 제안은 꺼집니다. 받아쓰기는 OpenAI 키가 있어야 합니다
    (설치 번들: `install/.env` 의 `TRANSCRIBE_API_KEY`·`MEETING_ICE`·`MEETING_AGENT`).
- e2e: feature F-MT-01…06(구성원 확인·신호·동의·의도 감지·회의록 블록·스위치), agent A-14(가짜 카메라·마이크 두 브라우저 여정).


### 고침

- **예약 미션을 Claude Code·Codex(cli-agent)로 돌릴 때 테넌트 스킬을 찾지 못하던 문제**: cli-agent 는 기동할 때 정한 한 테넌트의 스킬 폴더(`SKILLS_DIRS`)만 설치하고, 개인 스킬 사본은 deepagents 작업 폴더에 있어서 영문 데모 테넌트(`en-demo`) 등 다른 테넌트의 스킬이 실행에 들어가지 않았습니다. 이제 미션 실행이 그 스킬의 스킬 폴더 저장소를 cli-agent 의 `git_skills` 로 넘겨, 공유·개인 스킬 모두 실행 프로젝트(`.claude/skills/<이름>`)에 설치됩니다(`server/lib/missions.js`). deepagents 미션은 그대로입니다.
- **영문 데모 테넌트의 기본 스킬 3개(bpmn-process-generation-skill·bsc-strategy-interview·process-execution)가 설정 › 스킬에서 한국어 SKILL.md 로 보이던 문제**: `server/scripts/en-demo.mjs` 설정 단계가 테넌트 자신의 스킬 컬렉션(`skills/en-demo/<이름>`)에 영어 SKILL.md(`server/fixtures/skills-en`) 사본을 둡니다. 목록·스킬 화면은 그 사본을 읽고, 에이전트는 여전히 기본 원본을 씁니다(deepagents 는 뒤 소스 `process-gpt-system` 이 이김). `references/` 는 한국어 그대로.
- 영어 모드 사전: 답 위 라우팅 줄의 "판단 모델 1.00" · "판단 모델→logprob 0.99" · "대화에서 직접 1.00" 이 영어로(`routing model 1.00` …).
- **백엔드 서브모듈 갱신**: `backends/office-host` → ecea940(편집기 화면 언어를 페이지마다 `lang=en|ko`, 워드 문서 그림 꺼내기·바꿔 넣기, 멘션 칩 언어), `backends/process-gpt` → a066e93(completion: 진행 중인 인스턴스는 시작한 정의 버전을 끝까지 유지 — 새 버전은 새로 시작하는 건부터).
- **영어 모드 사전·번역기**: 역할·단계 이름을 하나로(Sales · Finance · Design · Legal · Proposals, "Receive request mail" · "Draft quote" · "Prepare quote", 출장비 정산 = "Travel expense settlement"), 제약 표의 여유 = "Spare"(크리티컬 패스는 "Slack"), 폴더 권한 실행 = "Run", "Card saved", 일회용 값 버튼 "Enter code", 설정 메뉴·스킬 목록 "Skills", 기본 스킬 세 개의 설명. 번역기는 수가 1이면 뒤 명사를 단수로 바꾸고("1 output", "1 variation") ` — ` 로 이은 말도 나눠 옮깁니다. 용어집에 예제 이름(Solgil Bakery, Pangyo Store #3, "Store design proposal draft", "Quote tracker", 개선 데모 매장, 파일 이름)과 역할·단계 표.
- **영어 모드 다듬기 — 영문 튜토리얼·영상 캡처용** (시험 `server/test/en-fix.test.js` · `e2e/tests/feature/english-fixes.spec.js` F-EN-01…04):
  - 워드 문서 안 그림도 포토크래프트 왕복(튜토리얼 9장 영어판): 그림을 「가리키기」로 누르면 `Image 1`, 고쳐 달라고 하면 그림이 포토크래프트로 문서 위에 열리고 「Put in Word document」로 같은 자리(드로잉·크기·배치 유지)에 들어가며 ⌘S 로 편집본 .docx 에 저장됩니다. 워드 그림을 내주는 office-host(`process-gpt-office-host` `feat/per-page-ui-lang`)가 필요하고, 예전 호스트에서는 요청이 문서에 그대로 갑니다.
  - 파일 이름에 `#` 이 있으면(“Moonlight Coffee Store #2 proposal.docx”) 카드가 편집기 대신 새 창으로 열리던 것을 고침.
  - 앱 이름만 말해도 그 도구가 켜집니다: CADCraft·PhotoCraft·SoundCraft·FilmCraft(한국어 이름 포함) — 전에는 VectorCraft 만.
  - 대화방 도우미가 영어 이름으로 지목한 팀원을 찾습니다: 이름(“Minji”), 성, 대소문자 무관 전체 이름(“minji kim”). 한국어 이름은 그대로.
  - 패널 앱 설계가 “Unexpected end of JSON input” 으로 실패하던 것(시트 앱·기록형 모두): 추론 모델이 생각에 `max_tokens` 를 다 써 답이 비었음 → 설계 호출에 `reasoning_effort: low`·생각할 여유를 둔 상한(종류 판정 60→2000), 잘린 답은 그렇다고 알림. “견적 금액(숫자)*” 처럼 필드 목록의 표시까지 붙은 키, 요청 문장 속 금액(“견적 금액 2,450만 원”), 영어 금액(“₩24.5M”, “24,500,000”, “KRW …”, “24.5 million”)도 숫자로.
  - 브라우저 에이전트: 부탁하지 않은 구매·재주문·결제 버튼은 서버가 누르지 않고(요약에 따로 적음), 구매를 부탁한 작업도 결제 버튼은 승인 카드를 거친 뒤에만 누릅니다. 요약은 늘 결과 문장으로 시작(결과 없이 끝내면 한 번 더 묻고, 동작 한도에 닿으면 “확인 필요”).
  - 테스트 상점 영어판(`?lang=en`, `startShop({lang:'en'})`, `SHOP_LANG=en`): 로그인·인증 코드·주문·결제 화면.
  - 설치 스크립트의 질문·안내·요약이 `--lang en|ko`·`LITE_LANG`·로캘을 따릅니다(한국어 로캘이 아니면 영어). 첫 관리자 이름도 그 언어로.
  - 시험: S-34 는 설정된 호스트로 접속(Vite 가 127.0.0.1 만 들을 때 `::1` 로 가던 것), S-EN-02 는 화면을 판단하기 전에 테넌트 데이터를 다시 읽음(실행 중에 들어온 한국어 이름의 시험 계정) — 영어 데모 테넌트에서는 `PGPT_URL=http://en.localhost:5180`, S-53(설치 스크립트 언어), F-MT-02 는 자기 회의의 신호를 봄(같은 서버에서 두 번째 실행부터 이전 실행의 신호를 집던 것).
- **진행 중인 인스턴스가 새 정의 버전으로 넘어감**(결함 #41): process-gpt completion 이 인스턴스를 저장할 때마다 최신 버전을 다시 찍어, 개선 적용 등으로
  v2 를 저장하면 v1 로 시작한 건도 다음 단계부터 v2 를 따랐습니다. 버전은 시작 때 한 번만 찍고, 고정된 버전은 `proc_def_version` 에서 찾아 더 새 버전이
  있을 때 그 버전 정의로 진행합니다(process-gpt-completion `feat/pin-instance-version`; 백엔드 반영 필요).
- **대화로 만든 프로세스를 저장하면 폼·에이전트·스킬이 0개**(#40): deepagents 가 작업 폴더를 `/.bpmn/…` 로 알려 와 저장 때 폴더를 못 찾았습니다. 작업 폴더에서
  계약을 다시 조립하고, 에이전트는 process-gpt 화면처럼 에이전트 사용자로 만들어 정의와 잇고, 폴더의 스킬을 설치합니다. 저장된 카드의 「흐름 보기」는 펼치면 화면 안으로.
- **에이전트 단계가 실패하면 인스턴스가 멈춤**(#42): DB 복구 모드·연결 끊김·시간 초과처럼 잠깐의 오류면 1·2·4분 간격으로 최대 3번 다시 줄 세우고, 그 밖은
  시작한 사람에게 Home 알림과 인스턴스 화면의 「다시 시도」(`server/sql/018_step_retry.sql`).
- **마이닝**: 병렬 게이트웨이가 BPMN 에 배타(X)로 그려짐(#33), 팀 공유가 받는 사람과 상관없이 '재무 검토'로 기록됨(#22 — 역할·공유 메모로 단계 이름),
  고객 회신 뒤의 공유가 정의에 갈래로 들어가고 같은 사례로 추천이 두 번 생김(#43·#21 — 회신 뒤는 사례에 넣지 않고, 사례가 겹치면 같은 추천). 묶는 규칙은 마이닝 화면에 안내.
- **예약·미션**(#15·#17): 실패한 예약 실행이 채팅·Home 어디에도 안 보이던 것 — 모든 예약이 실행 기록을 남기고 실패는 채팅과 Home 카드로, DB 가 실행을 기록조차
  못 하면 몇 분 뒤 다시. 결과 줄(`MISSION_RESULT`) 없이 정상으로 끝난 스킬 미션은 '실패'가 아니라 성공(변동 여부 모름)으로, 미션용 스킬에는 결과 줄 단계를 넣음.
- **패널 앱**: "3,800만 원" 같은 한국어 금액을 숫자로 읽음(#12), 요약 타일의 큰 금액이 옆 타일로 넘치지 않음(#13), 기록형 앱 설계가 시간 초과면 작은 단계로 다시(#11).
- 대화 폴더 밖 `/workspace/<이름>` 파일 카드가 「작업실에서 열기」인데 아무 일도 없던 것 — 저장소 사본으로 엶(#14). 스킬 변형 「검증 실행」이 서버 재시작 뒤
  영영 running 이던 것 — 20분 기한, 넘긴 검증은 실패로 닫힘(#19). CADCraft 도면의 "12㎡" 가 "12□" 로 보이던 것 — 도면 글자는 m²·m³ 로(#10).
- e2e: feature F-FX2-01…09, 서버 단위 F-UT-07(`server/test/fixes2.test.js`).
- **다른 사람의 파일이 내 대화에 붙던 문제** (튜토리얼 7·9·14장): 에이전트가 참고하려고 연 테넌트 공용 `/workspace` 의 남의 문서와,
  deepagents 가 턴 끝에 다시 올리는 hwpx 사본을 파일 카드로 만들지 않습니다. 이번 턴에 쓴 파일·이 대화 폴더(`/workspace/.bpmn/<대화>`)·
  턴 중에 바뀐 파일만 카드가 되고, 다시 올린 사본은 원본 이름을 씁니다(`server/lib/provenance.js`). 에이전트에게는 새 파일을 대화 폴더에
  두고 참고 자료는 내 첨부·받은 공유(`uploads/<나>`)·공유 폴더에서만 쓰라고 알립니다(문서·ArtCraft 저장 안내도 대화 폴더로). 「이어서 작업」도
  같은 규칙. 샌드박스 셸은 여전히 테넌트 단위입니다(deepagents 는 다른 대화 폴더 읽기만 막음).
- **팀·역할 관리 권한**: 팀원 추가·빼기와 모든 프로세스에 걸리는 역할 지정(`POST/DELETE /api/team`, `PUT /api/roles`)은 관리자
  (`users.is_admin`·`tenants.owner`)만 합니다. 프로세스별 역할은 그 프로세스 담당자(`proc_def.owner`)도 정할 수 있고, 담당자가 없는 프로세스는
  process-gpt 처럼 누구나 정할 수 있습니다. 뺀 사람은 다시 들어와도 자동으로 팀에 들어가지 않습니다(`server/sql/017_team_admin.sql`).
  관리자가 하나도 없으면 처음 로그인한 사람이 관리자가 되고, 비관리자의 「설정 › 팀·역할」은 읽기 전용입니다.
- **데모 메일함 로고**: 데모 메일함의 홈 카드는 로고 서비스(favicon)를 부르지 않고 글자 타일로 보입니다(가상 거래처 도메인이 실제 회사 것일 수
  있음). 실제 메일함도 보낸 사람 도메인과 다른 로고 추측은 쓰지 않습니다.
- **답을 기다리는 중에 보낸 메시지**: 같은 대화로 가는 메시지는 앞 턴이 끝날 때까지 "대기"로 보였다가 이어서 답합니다 — 앞 턴이
  "(오류: turn cancelled)"로 끝나거나 새 답이 사라지지 않습니다(`server/lib/turns.js`). 다른 대화는 나란히 진행하고, 진행 중인 요청은
  대화 맥락 라우터에 "진행 중" 대화로 보여 후속 질문이 그 대화로 갑니다. 처리하다 실패해도 채팅에 남고, 서버 재시작으로 답하지 못한
  대기 메시지는 그렇게 표시됩니다.
- **채팅 멈추기**: 답을 쓰는 동안 입력창 위 「멈추기」 — deepagents `/chat/stop` 으로 서버 쪽 턴까지 멈추고 "답을 멈췄어요"로 남깁니다
  (`POST /api/threads/:id/stop`). 멈춘 턴의 스크립트는 산출물 카드가 되지 않습니다.
- **빠른 답 버튼**: 답이 질문과 짧은 선택지로 끝날 때만 버튼이 됩니다. 보고문의 글머리 목록은 그대로(`src/replies.js`).
- **브라우저 작업**: 작업 중에 새 작업을 시키면 줄을 섭니다(카드 "대기", 채팅에 알림, 대기 작업만 따로 취소). 앞 작업의 카드·작업 취소는
  그대로 닿고, 앞 작업이 끝나면 다음이 시작됩니다. 브라우저 동작 없이 끝내려는 작업은 한 번 되돌려 보내고, 그래도 아무것도 하지 않으면
  "완료" 대신 "확인 필요"로 남깁니다. 요약 뒤에는 실제로 한 동작 목록이 붙습니다.
- **내 스킬 + 파일 첨부**: 공유하지 않은 내 스킬을 파일과 함께 불러도 스킬 위치를 알려 줍니다. 빈 답은 안내 문장으로 남깁니다.
- **스킬 삭제가 늘 400**: deepagents `DELETE /skills/:name` 이 요구하는 JSON 본문(`{mode:'local'}`, 테넌트 사본만 지움)을 보냅니다(`server/lib/skills.js`).
- **표시 이름·메일 연결·연습 메일**: 「설정 › 계정」에서 이름을 바꿀 수 있고, 온보딩에서 이름이 메일 주소 앞부분이면 한 번 묻습니다.
  같은 화면의 「연결」에서 메일 연결(Gmail·IMAP·데모 메일함)을 바꿉니다. 데모 메일함이면 「연습 메일 받기」로 고정 메일(달빛커피 2호점
  제안·견적 요청 등, `server/fixtures/demo-practice-mail.json`)을 받습니다(`GET /api/mail/demo-templates`, `POST /api/mail/demo-arrive {template}`).
- e2e: feature F-FX-A01…A08, F-UT-08(서버 단위·통합 시험 — deepagents·모델을 흉내 낸 대기열·멈추기·파일 출처·브라우저 대기열).

### 운영 후속

- TURN 서버(대칭 NAT·사내망 뒤 참여자), 7명 이상이면 SFU(LiveKit 등).

## [0.1.1] — 2026-10-26

v0.1.0 설치 번들을 공개 저장소에서 익명으로 새로 받아 Docker Compose(lite + mining)로 다시 시험해 찾은 결함을 고쳤습니다.

### 고침

- **팀 메신저·공유·@멘션이 모두 500**: `migrate.sh` 가 process-gpt 스키마를 init → migration → init 순서로 만들면서 마지막
  init.sql 이 `public.tenant_id()` 를 예전 정의(JWT 없는 연결에서 오류)로 덮어써, 대화방 메시지를 넣을 때 process-gpt 트리거가
  실패했습니다. `install/db/compat/04_tenant_id.sql` 이 migration.sql 의 정의로 되돌립니다(새 설치·업그레이드 모두).
- **이음오피스 편집기 구버전**: `backends/office-host` 를 `e17a9bc` 로 — 편집기 AI 버튼을 대화로(`assistant=parent`),
  가리켜서 말하기, 한글 실시간 편집, 한글 그림 왕복이 번들에 빠져 있었습니다.
- **데모 메일함·설계 제안서 양식 없음**: 서버 이미지에서 `server/fixtures` 를 빼고 있어 `/api/mail/demo-arrive` 가 실패했습니다.
- **`--upgrade` 의 migrate 가 멈춤**: process-miner 가 읽은 뒤 트랜잭션을 열어 둔 채(idle in transaction) 잠금을 쥐고 있어 인계 기록 표의
  트리거 재생성이 끝없이 기다렸습니다. 마이너 쪽(process-gpt `feat/pgpt-lite-mining` `8ecf952`)과 번들 쪽(compat 03 은 이미 있으면
  건너뜀, migrate `lock_timeout=120s`)을 모두 고쳤습니다.
- 판단 모델이 없는 설치(번들 기본)에서 대화 속 에이전트 제안이 메시지마다 실패하는 judge 호출을 하지 않음. `/team/assist/stats`·
  `/api/config` 가 judge·대화 맥락 라우터 유무를 알림.

### 시험

- 공개 저장소·서브모듈(process-gpt, process-gpt-deepagents, office-host, ieumoffice)과 process-miner 소스를 자격 증명 없이 받아 설치.
- Docker Compose(lite + mining, 고친 main 새 설치): smoke 43 통과·14 건너뜀, feature 40 통과·46 건너뜀(+ 스킬 공유 6개는
  설치 데이터 폴더를 지정해 6 통과), agent 6 통과(3개는 재시도로)·7 건너뜀, 실패 0. 건너뜀은 lite 에 없는 것(ArtCraft·
  프로세스 엔진·예제 정의·대화 맥락 라우터·judge)과 서버 소스가 필요한 단위 시험.

## [0.1.0] — 2026-10-26

첫 공개(2026-10-24, `9118671`) 뒤 처음 내는 릴리스입니다.

### 추가

- **Docker Compose 한 줄 설치**(`install/`): `lite` 프로필(웹·BFF·Supabase 최소 구성·메일함·deepagents·office-mcp·이음오피스),
  `full`(실험: 프로세스 엔진·mcp-hub), 새 **`mining`** 프로필(`./install.sh --with-mining`, process-miner).
  비밀 값은 `.env`(0600)에만, 다시 실행해도 안전, `--upgrade`·`--uninstall [--purge]`.
- **라이브 공동 편집 + 최대화 다이얼**: 이음오피스(엑셀·워드·한글)와 ArtCraft 5종(CAD·Vector·Photo·Sound·Film)을 열어 둔 채
  대화로 바로 고치고, 최대화하면 대화창이 다이얼로 접힘.
- **누르면 멘션**: "@ 가리키기"(또는 ⌥클릭)로 문서의 표·그림·문단·셀 범위를 입력창 칩으로 — 다음 요청이 그 대상만 고침.
- **한글 실시간 편집**(`office_live_hwp_table`·`office_live_hwp_text`)과 **한글 그림 ↔ 포토크래프트 왕복**("한글 문서에 넣기").
- **편집 뒤 검수**(`server/lib/review.js`): 요청대로 됐는지·빠진 게 없는지(그림 선 비율, CAD 객체 수, 문서 표·행·수식) 확인,
  실패면 한 번 고쳐 다시, 그래도면 되돌리고 알림. 도면 색 바꾸기는 바탕색 기준으로 칠해 선이 사라지지 않음.
- **메일 한 통에서 초안**: 고객 메일이 문서를 요청하면 묻지 않고 평면도(CADCraft)·한글 제안서(office-mcp)·엑셀 견적서 초안,
  홈에 "초안 검토" 카드. 데모 메일함 도착(`/api/mail/demo-arrive`).
- **팀 공유·메신저**: 산출물을 팀원에게 바로 공유(받는 사람마다 허가, 원본 주소 비공개), 받은 편지함, 채팅의 @팀원 제안
  (자주 주고받은 순 + 선택적 판단 모델 `JUDGE_URL`), 1:1·그룹 메신저, "이어서 작업".
- **프로세스 마이닝**: 반복된 메일 업무의 인계 기록(handover_events)에서 process-miner 가 흐름을 찾아 관리자에게 추천 →
  정식 등록(process-gpt 정의) → 다음 비슷한 메일은 그 프로세스로 자동 시작. 재무 검토 같은 검토 카드에 **앞 단계 산출물 칩**.
- **팀 메신저를 process-gpt 대화방 위로**: 1:1·그룹 대화가 process-gpt 의 `chat_rooms`/`chats` 그 자체(양쪽 화면이 같은 방,
  process-gpt 쪽 메시지도 실시간·안 읽음으로). `014_team_rooms.sql` 이 기존 `pro_dm_*` 대화를 옮김.
  **대화 속 에이전트 제안**: 팀 대화의 업무 요청을 저렴한 판단 모델이 알아보고 요청받은 사람에게만 제안 카드.
- **대화별 산출물 스택**: 그 대화가 만든 파일이 Dock 스택처럼 쌓였다가 부채꼴·격자로 펼쳐짐.
- **이음오피스 편집기 머리줄**: 왼쪽 파일 형식 타일(채팅 카드와 같은 색), 오른쪽 이음오피스 로고.
- **회귀 테스트 스위트**(`e2e/`): smoke 57 · feature 83 · agent 13, 요구사항↔시험 카탈로그(README).

### 바뀜

- 프로세스 스피너는 에이전트가 실제로 작업 항목을 잡고 있을 때만 돈다. 사람 단계는 "담당자 확인 대기".
- 역할 목록은 많이 쓰는 역할부터 300개까지(정의가 많은 테넌트에서도 바로 응답).
- ArtCraft 가 없는 설치(Docker lite)는 그 형식의 파일을 링크로 열고, 메일 초안은 평면도 없이 만들며, 한글 그림 왕복을 끔
  (`/api/config` 의 `craft` 플래그).
- process-miner 주소(`PRO_MINER_URL`)를 비우면 마이닝 스캔을 하지 않음. 판단 모델(`PRO_JUDGE_URL`)을 비우면 "@" 제안은 빈도 순만.
- 문서 작성 요청("안내문을 워드로 만들어줘")은 패널 앱 도구로 새지 않고 에이전트로. 패널 앱이 없으면 행 추가 도구를 라우터에서 뺌.
- 설치: 처음 설치할 때 LLM 주소·모델·관리자 이메일을 묻고, 키 없는 비대화 설치와 WSL 포트 검사에서 멈추지 않음.
- "일정 추가"처럼 커넥터를 떠올리는 말도, 패널 앱을 쓰는 사람에게는 실제로 연결된 커넥터가 있을 때만 커넥터로 바로 보냄
  (아니면 라우터가 패널 앱 행 추가를 고름).

### 고침

- DB 가 재시작돼 유휴 연결이 끊겨도 서버가 죽지 않음.
- 에이전트 응답 스트림이 끊기거나 오래 말이 없으면(`PRO_STREAM_IDLE_MS`) "생각하는 중"에 멈추지 않음.
- B1: 참여하지 않은 사용자가 남의 프로세스 인스턴스·산출물을 볼 수 있던 문제(403).
- B2: db 단계 패널 앱에서 자기 행 삭제가 409 로 실패하던 문제.
- B3: 아무도 맡지 않은 역할의 단계가 시작한 사람이 아니라 정의의 기본 담당자에게 가던 문제.
- 설치 번들: 프로세스 마이닝이 쓰는 인계 기록 표(handover_events·역량 모델)를 마이그레이션이 만들도록 보정(`install/db/compat/03_handover_events.sql`).
- 설치 번들: server 가 office-host·office-mcp 주소를 몰라(`PRO_OFFICE_HOST_URL`·`PRO_OFFICE_MCP_URL` 없음) 열린 문서의
  라이브 편집 도구가 보이지 않고 메일 한글 초안이 실패하던 문제.
- 설치 번들: 작업실 터미널이 이미지에 없는 zsh 를 띄우려다 실패하던 문제(있는 셸로).
- DB 가 재시작·복구 모드일 때 다시 연결하던 배경 작업의 거절 하나로 BFF 가 죽던 문제(처리되지 않은 거절은 기록만).
- "일정 추가"처럼 커넥터를 떠올리는 말이 패널 앱 대신 연결도 안 된 캘린더로 가던 문제(A-03).

### 알려진 문제

- B4: 대화 맥락 라우터가 전혀 다른 주제를 같은 대화에 이어 붙이는 경우가 있음(A-01).
- B5: 채팅으로 스킬을 만들면 초안 카드가 다른 스킬을 보여 주는 경우가 있음(A-08).
- Docker 번들에서는 마이닝 추천의 **정식 등록**과 채팅의 프로세스 초안 저장이 아직 안 됨(process-gpt 의 Python 저장 코드가 server 이미지에 없음).
- Docker Compose 회귀: lite+mining 첫 설치에서 smoke 41 통과·14 건너뜀, feature 30 통과·39 건너뜀까지 확인했고, 그 실행에서 찾은 번들 결함(문서 라이브 편집 주소·작업실 셸·BFF 크래시)은 고쳤지만 고친 번들의 기능 재시험과 agent 단계는 이 릴리스에서 돌리지 못함(시험 PC 메모리 부족). 개발 스택에서는 smoke 57/57, feature 86/86, agent 13 중 11(B4·B5 제외) 통과.

[0.1.1]: https://github.com/uengine-oss/process-gpt-lite/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/uengine-oss/process-gpt-lite/compare/9118671...v0.1.0
