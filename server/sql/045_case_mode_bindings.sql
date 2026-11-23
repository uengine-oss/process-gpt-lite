-- 건이 시작할 때 정해 두는 두 가지(lib/ontology/run.js startCase · mapengine.js startMapCase). 여러 번 돌려도 된다.
-- 이 기능이 만든 우리 표만 고친다 — 공용 표(todolist · bpm_proc_inst · proc_def)는 그대로다.

-- 실행 방식: 프로세스의 단계(관찰 · 제안 · 자동)가 정한다 — 제안이면 단계마다 사람이 정함(hitl), 자동이면 사람이 지켜봄(hotl).
-- 건은 시작할 때의 방식을 지닌다(단계를 나중에 바꾸면 새 건부터). 비어 있으면(이 열 전에 시작한 건) 프로세스의 지금 단계로 읽는다.
-- 따로 고르던 실행 방식(pro_run_modes · pro_run_settings.default_mode)은 더 읽지 않는다 — 표와 행은 지우지 않고 둔다.
alter table pro_po_cases add column if not exists run_mode text;
alter table pro_po_cases drop constraint if exists pro_po_cases_run_mode_check;
alter table pro_po_cases add constraint pro_po_cases_run_mode_check check (run_mode is null or run_mode in ('hotl', 'hitl'));

-- 역할마다 맡을 사람: 건을 시작할 때 이 건의 흐름에서 사람이 하는 단계가 있는 역할마다 누가 맡는지 풀어 두고(설정의 팀 · 역할 담당자 →
-- 시작한 사람), 시작 전에(제안) 또는 시작한 뒤(자동) 바꿀 수 있다. 뒤에 생기는 단계는 다시 찾지 않고 여기서 사람을 가져간다.
-- [{role, userId, name, from: settings | starter | picked | none | several, candidates?: [{id, name}], changedBy?, changedAt?}]
-- 회사 설정(pro_role_assignments)은 그대로다.
alter table pro_po_cases add column if not exists bindings jsonb;
