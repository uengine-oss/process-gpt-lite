-- 지도에서 바로 실행(lib/ontology/mapengine.js): 건을 프로세스 정의(proc_def) 없이, 지도에서 곧바로 돌리는 두 번째 방식.
--   프로세스 정의로(bpm, 기존): 건이 들어오면 지도를 펼쳐 스냅샷 proc_def 를 만들고 completion 엔진이 인스턴스를 돌린다.
--   지도에서 바로(map): Lite 가 단계마다 todolist 행을 직접 넣고, 단계가 끝날 때마다 그때의 지도(또는 건을 시작한 날의 지도)를
--   읽어 다음 단계를 정한다. 건 하나 = 인스턴스 하나(옮기기 · 되감기도 같은 인스턴스 안에서), 요청 접수 단계 없이 요청은 건의 행에.
-- 회사마다 고른 방식은 pro_run_settings.engine(없으면 bpm, PRO_ONTO_ENGINE 이 이긴다). 건은 시작할 때의 방식을 기억한다.
-- 이 기능이 만든 우리 표만 고친다 — 공용 표(todolist · bpm_proc_inst · proc_def)는 그대로다. 여러 번 돌려도 된다.

-- 건: 어느 방식으로 도는지 · 지도를 고정했는지(map_pin: 이 시각의 지도로만 다음 단계를 정한다) · 들어온 요청(제목 · 내용 · 보낸 사람 · 고객)
alter table pro_po_cases add column if not exists engine text not null default 'bpm';
alter table pro_po_cases drop constraint if exists pro_po_cases_engine_check;
alter table pro_po_cases add constraint pro_po_cases_engine_check check (engine in ('bpm', 'map'));
alter table pro_po_cases add column if not exists map_pin timestamptz;
alter table pro_po_cases add column if not exists request jsonb;

-- 건의 단계마다(지도에서 바로): 어느 지도로 정했는지(map_at — 지도는 시점이 있어 그 시각으로 다시 읽으면 된다), 어떻게 정했는지
-- (via: {how: entry | single | amount | text | common | parallel | join | moved | rewound, from, why, p, outs}), 그 단계의 일 정의에서
-- 뽑은 것(act: 스킬 · 점검 항목 · 지시 · 맡는 이 — 스냅샷이 activities 에 담던 것), 나란히 하는 일(par: {group, siblings})
alter table pro_case_steps add column if not exists map_at timestamptz;
alter table pro_case_steps add column if not exists via jsonb;
alter table pro_case_steps add column if not exists act jsonb;
alter table pro_case_steps add column if not exists par jsonb;
-- planned: 할 일을 넣었고 관문이 아직 보지 않은 단계(지도에서 바로)
alter table pro_case_steps drop constraint if exists pro_case_steps_state_check;
alter table pro_case_steps add constraint pro_case_steps_state_check check (state in ('planned', 'auto', 'waiting', 'go', 'released', 'moved', 'skipped'));

-- 회사의 실행 엔진(bpm | map, 비우면 제품 기본값). 엔진만 정한 행은 실행 방식(default_mode)을 비워 둔다 — 비어 있으면 제품 기본값.
alter table pro_run_settings add column if not exists engine text;
alter table pro_run_settings drop constraint if exists pro_run_settings_engine_check;
alter table pro_run_settings add constraint pro_run_settings_engine_check check (engine is null or engine in ('bpm', 'map'));
alter table pro_run_settings alter column default_mode drop not null;
