-- A scheduled task can start a process-gpt process: each run starts an instance whose first step
-- is completed with params (the start form's values); agents and people carry it from there.
alter table pro_schedules add column if not exists process_id text;
