# English glossary — Process GPT Lite (pgpt-pro)

One source for the English edition: the app's English mode (`src/i18n/ko-en.json`), server-generated
cards and notices, agent prompts and sample data (server side), the English product page, the
29-chapter English tutorial and the English demo videos all use these words. Add a term here before
using a new one in more than one place. The app's English is the reference: the tutorial names a
screen element exactly as the English mode shows it.

Style
- Product name: **Process GPT Lite** (Korean 「프로세스 GPT 라이트」). Codename pgpt-pro stays internal.
- Buttons and tabs are short (1–3 words, Title Case for screen names, sentence case for buttons:
  "Save", "Open in editor", "Request merge"). Sentences stay sentences, in a plain, friendly voice
  ("I couldn't save it." for "저장하지 못했어요.").
- The assistant speaks in the first person ("I'll…", "I found…"); the user is "you".
- Korean counters (건·개·명·회) usually disappear: "3건" → "3", "팀원 4명" → "4 teammates".
- Dates and numbers: en-US ("Oct 28, 2026", "3:20 PM", "12,400"). Relative time: "just now",
  "5 min ago", "3 days ago". 만/억 amounts: "30K", "1.2M" in charts; money as "₩30,000"
  (keep the won; do not convert currency).
- `/skill-name`, process ids, file names, field keys and code stay as they are.

## Screens and navigation

| Korean | English |
|---|---|
| 홈 / Home (dock, top bar) | Home |
| Home 접기 / Home 펼치기 | Collapse Home / Expand Home |
| 채팅 | Chat |
| 프로젝트 / 프로젝트 목록 | Projects / Project list |
| 폴더 / 공유 폴더 | Folders / Shared folders |
| 검색 / 페이지와 메일 검색 | Search / Search pages and mail |
| 설정 | Settings |
| 설정 탭: 예약된 작업 · 팀·역할 · 스킬 · 계정 · 지갑 · 시스템 설정 · 보안 · 프로필 | Scheduled tasks · Team & roles · Skills · Accounts · Wallet · System · Security · Profile |
| 스킬 (설정 메뉴·목록 화면·폴더 탭) / 스킬 (배지·한 스킬의 화면) | Skills / Skill |
| 계정 › 내 정보 · 연결 · 언어 | Accounts › About me · Connections · Language |
| 로그아웃 | Log out |
| 작업실 | Workroom |
| 보관함 | Vault |
| 프로세스 마이닝 | Process mining |
| 개선 / 프로세스 개선 (`/improve`) | Improve / Process improvement |
| 팀 메시지 / 메신저 / 받은 편지함 | Team messages / Messenger / Inbox |
| 대화방 (팀) | room (team room) |
| 회의 / 원격 회의 | meeting / online meeting |
| 이음오피스 (문서 편집기) | IeumOffice (document editor) |
| 편집기에서 열기 / 편집기로 크게 | Open in editor / Expand in editor |
| 새 패널 만들기 | New panel |

## Core concepts

| Korean | English |
|---|---|
| 비서 (my assistant) | assistant |
| 도우미 (rooms and meetings: 프로세스 GPT 라이트 도우미) | helper (Process GPT Lite helper) |
| 에이전트 / 내 에이전트 / 브라우저 에이전트 | agent / my agent / browser agent |
| 판단 모델 | routing model (the model that decides; "judge" in code) |
| 대화 / 새 대화 / 전체 대화 / 다른 대화 | conversation / New conversation / All conversations / Other conversations |
| 대화 맥락 / 대화 맥락 라우터 | conversation context / context router |
| 산출물 / 산출물 스택 | outputs / output stack |
| 편집본 | edited copy |
| 카드 (chat/Home card) | card |
| 패널 / 패널 앱 | panel / panel app |
| 스킬 / 스킬 초안 / 전사 공유 | skill / skill draft / share company-wide |
| 미션 / 예약 미션 / 예약된 작업 | mission / scheduled mission / scheduled task |
| 연결 / 커넥터 | connection / connector |
| 할 일 · Submit · Review (Home buttons) | to-do · Submit · Review |
| 프로세스 / 프로세스 정의 / 인스턴스 | process / process definition / instance (run) |
| 단계 / 활동 / 시작 폼 / 양식 | step / activity / start form / form |
| 진행 중 / 대기 / 완료 / 실패 / 취소됨 | in progress / waiting / done / failed / canceled |
| 내 차례 / 내 입력이 필요해요 | my turn / Needs your input |
| 결재 / 승인 / 반려 / 검토 | approval / approve / reject / review |
| 담당 / 담당자 / 역할 | owner / assignee / role |
| 인계 / 인계 기록 | handover / handover record |
| 흐름 보기 / BPMN 다이어그램 | View flow / BPMN diagram |
| 정식 등록 (mining) | Register as a process |
| 근거 | evidence |
| 이어서 하기 | Continue |
| 공유 / 공유하기 / 모두 공유 | share / Share / Share all |
| 팀원 / 구성원 | teammate / member |
| 멘션 (@팀원) | mention (@teammate) |
| 알림 | notification |
| 첨부 | attachment / attach |

## Folders (git-backed shared folders)

| Korean | English |
|---|---|
| 변형 / 새 변형 | variation / New variation |
| 반영 / 반영 요청 / 일괄 반영 | merge / Request merge / Merge all |
| 충돌 | conflict |
| 색인 / 본문 색인 | index / Full-text index |
| 기여 기록 / 이력 | contributions / history |
| 작성자 | author |
| 공개 범위 / 나만 쓰기 | visibility / Only me |
| 저장소 / 작업 사본 / 브랜치 | repository / working copy / branch |
| 문서 카드 | document cards |
| 원본 | original |

Folder roles (공유 폴더 권한): 소유 · 편집 · 실행 · 보기 → **Owner · Edit · Run · View** (and in the share sheet
"Run — Create variations and run agents").

## Panel apps

| Korean | English |
|---|---|
| 패널 앱 | panel app |
| 시트 열기 | Open sheet |
| 행 권한 / 행 단위 보안 | row access / row-level security |
| 보안·개인정보 기본값 | Security & privacy defaults |
| 민감도 / 가림 | sensitivity / masked |
| 스냅샷 저장(폴더에 xlsx) | Save snapshot (xlsx to folder) |
| Home에서 숨기기 / 앱 지우기 | Hide from Home / Delete app |
| 보기 전용 | View only |

## Vault and security

| Korean | English |
|---|---|
| 보관함 | Vault |
| 로그인 / 카드 / API 키 / 일회용 값 | login / card / API key / one-time value |
| 지갑 | Wallet |
| 데이터 키(DEK) / 마스터 키(KEK) | data key (DEK) / master key (KEK) |
| 감사 기록 | audit log |
| 조치 필요 / 직접 제어 | Action needed / Take control |

## Process mining and improvement

| Korean | English |
|---|---|
| 프로세스 마이닝 / 찾은 흐름 / 반복 흐름 / 사례 | process mining / discovered flows / recurring flow / case |
| 개선 / 개선안 / 개선 실행 / 개선안 적용 | Improve / improvement proposal / Run improvement / Apply proposal |
| 병목 | bottleneck |
| 가치 흐름 / 가치 흐름 지도 | value stream / value stream map |
| 제약 / 제약 이론 | constraint / theory of constraints |
| 크리티컬 패스 / 남은 크리티컬 패스 | critical path / remaining critical path |
| 리드타임 / 기대 리드타임 / 단계별 리드타임 분해 | lead time / expected lead time / lead time by step |
| 대기 / 대기 시간 / 대기 건수 | waiting / wait time / items waiting |
| 처리 시간 / 단계 시간 | processing time / step time |
| 흐름 효율 | flow efficiency |
| 가동률 | utilization |
| 여유 (CPM: 크리티컬 패스 표·간트) | slack |
| 여유 (제약 표의 처리 능력 열: 쌓인 날이 없음) | Spare |
| 가장 이른 시작 ES / 가장 이른 끝 EF / 가장 늦은 시작 LS / 가장 늦은 끝 LF | earliest start ES / earliest finish EF / latest start LS / latest finish LF |
| 중앙값 / 평균 / 늦을 때(p80) | median / average / slow case (p80) |
| 표본 적음 | small sample |
| 간트 | Gantt |
| 버전 | version |

## Meetings and team rooms

| Korean | English |
|---|---|
| 회의 시작 / 회의 끝내기 / 나가기 | Start meeting / End meeting / Leave |
| 받아쓰기 / 자막 / 회의록 | transcription / captions / meeting minutes |
| 자료 / 새 자료 / 모두에게 띄우기 / 내리기 | materials / New material / Show to everyone / Take down |
| 도우미 꺼짐 | Helper off |
| 대화 발췌 | conversation excerpt |

## Example cast and data (English mode, tutorial and videos)

The English demo tenant (`en-demo`, http://en.localhost:5180 — i18n/EN-DEMO.md) holds exactly this cast and data.

| Korean | English |
|---|---|
| 장진영 (제안팀 팀장, 관리자) | Jinyoung Jang (proposal team lead, administrator) — `pro-en-jinyoung@uengine.org` |
| 김민지 (디자이너) | Minji Kim (designer) — `pro-en-minji@uengine.org` |
| 박서연 (재무) | Seoyeon Park (finance) — `pro-en-seoyeon@uengine.org` |
| 최유나 (회의 데모: 방 밖의 팀원) | Yuna Choi (meeting demo: a teammate outside the room) — `pro-en-yuna@uengine.org` |
| 달빛커피 (고객사) | Moonlight Coffee (customer) |
| 2호점 | Store #2 |
| 성수동 | Seongsu-dong, Seoul |
| 출장비 정산 (데모 프로세스) | Travel expense settlement |
| 공급사 카탈로그 단가 조사 | Supplier catalog price survey |
| 견적서 / 제안서 / 계약서 | quote / proposal / contract |
| 거래처 | client |
| 솔길베이커리 (프로젝트 장의 고객사) | Solgil Bakery |
| 판교 / 판교 3호점 | Pangyo / Pangyo Store #3 |
| 3호점 · 4호점 | Store #3 · Store #4 |
| 스킬 「매장 설계 제안서 초안」 | the "Store design proposal draft" skill |
| 패널 앱·폴더 「견적 현황판」 (패널 앱 장) | the "Quote tracker" panel app and its "Quote tracker" folder (`apps/Quote tracker.xlsx`) |
| 패널 「제안 파이프라인」 (프로젝트 장·치트시트) | the "Proposal pipeline" panel |
| 휴가 일정 (패널 앱, 회의 데모) | Leave schedule |
| 달빛커피 제안팀 (팀 대화방) | Moonlight Coffee proposal team |
| 개선 데모 매장: 서울숲 52호점 · 광화문 53호점 · 송리단길 54호점 · 익선동 55호점 · 연남 56호점 | Seoul Forest Store #52 · Gwanghwamun Store #53 · Songnidan-gil Store #54 · Ikseon-dong Store #55 · Yeonnam Store #56 |
| 마이닝 데모 고객사: 한빛치과 · 온새미로 베이커리 · 그린핏 필라테스 | Hanbit Dental · Onsaemiro Bakery · GreenFit Pilates |
| 달빛커피 2호점 평면도.dxf · 견적서.xlsx · 준비 체크리스트.docx · 일정표.xlsx | `Moonlight Coffee Store 2 floor plan.dxf` · `Moonlight Coffee Store 2 quote.xlsx` · `Moonlight Coffee Store 2 prep checklist.docx` · `Moonlight Coffee Store 2 schedule.xlsx` (file names write "Store 2", screens and text "Store #2") |
| 공급사 카탈로그 단가 조사 · SNS 데일리 트렌드 대응 | Supplier catalog price survey · Daily SNS trend response |

### Roles and steps (one name everywhere: seeds, mining, dictionary, tutorial)

| Korean | English |
|---|---|
| 제안팀장 (every process) | Proposal team lead |
| 영업 담당 | Sales |
| 디자이너 / 디자인 담당 | Designer / Design |
| 재무 담당 | Finance |
| 법무 담당 · 제안 담당 · 검토 담당 | Legal · Proposals · Review owner |
| 제품 책임자 · 마케팅 | Product owner · Marketing |
| 신청자 · 결재자 (출장비 정산) · 구매 담당 (카탈로그 조사) | Requester · Approver · Buyer |
| 요청 메일 도착 → 요청 메일 접수 → 평면도 작성 ∥ 견적 초안 → 제안서 작성 → 재무 검토 → 고객 회신 → 회신 완료 (달빛커피 제안) | Request mail arrives → Receive request mail → Draw floor plan ∥ Draft quote → Write proposal → Finance review → Reply to customer → Reply sent (Moonlight Coffee proposal) |
| 견적서 작성 (마이닝 흐름) | Prepare quote |
| 견적 에이전트 · 제안서 에이전트 · 도면 에이전트 | Quote agent · Proposal agent · Drawing agent |
| 출장비 신청 → 규정 검토 (정산 검토 에이전트) → 결재 | Submit travel expenses → Policy review (expense review agent) → Approval |

Keep process ids, numbers, amounts and dates identical to the Korean set so screens and tutorial tables
line up; only names and texts change. The English data lives in its own tenant (`en-demo`), so the same ids
never touch the Korean demo; mining case ids there name the tenant (`mail:en-demo:<mail id>`).
