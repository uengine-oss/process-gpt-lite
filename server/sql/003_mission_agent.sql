-- Which process-gpt agent type runs a mission: deepagents (LLM graph over an API key) or
-- cliagents (a CLI coding agent — Claude Code / Codex — on its own login).
alter table pro_schedules add column if not exists agent jsonb default '{"orch":"deepagents"}';
