-- 이 일이 쓰는 양식 · 양식마다 형식 규칙(lib/ontology/formats.js).
--   일이 쓰는 양식: 관리자가 고른 것(pro_form_choices) → 일 정의의 내놓는 것에 적힌 양식(outputs[].template) → 메일에 가장 많이
--   오간, 파일이 있는 양식(자동). 고른 것은 결정 원장(pro_policy_decisions)에도 남는다.
--   형식 규칙: 그 양식의 문서가 건마다 내용이 달라도 늘 지키는 것(로고 · 머리글 · 바닥글 · 고정 문구 · 제목 · 파일 이름) —
--   양식 파일들에서 규칙으로 찾은 후보를 모델이 이름 붙이고 꼭 지킬지 정한다(후보에 없는 것은 더하지 않는다). SKILL.md 모양으로 둔다.
-- 새 표만 — 기존 공용 표는 고치지 않는다.

-- 양식 이름: 파일 이름이 문서 종류를 말하지 않는 양식(고객 이름이 앞에 오는 첨부)은 모델이 이름을 붙인다(prompts/name-form.md). 한 번 붙인
-- 이름은 여기 남겨 서버가 다시 떠도, 서버가 여럿이어도 같은 이름으로 읽는다 — 고른 양식과 형식 규칙이 이 이름으로 남기 때문.
create table if not exists pro_form_names (
  tenant_id text not null,
  names_key text not null,                -- 그 양식의 첨부 파일 이름(최대 6개)을 정렬해 | 로 이은 것
  names     jsonb not null default '[]',
  name      text not null,
  at        timestamptz not null default now(),
  primary key (tenant_id, names_key)
);
alter table pro_form_names enable row level security;

create table if not exists pro_form_choices (
  tenant_id text not null,
  task      text not null,
  form      text not null,                -- 양식 이름(taskdef.js templatesOf 의 name)
  of_task   text,                         -- 다른 일의 양식을 골랐으면 그 일(없으면 이 일의 양식)
  by_user   uuid,
  by_email  text,
  at        timestamptz not null default now(),
  primary key (tenant_id, task)
);
alter table pro_form_choices enable row level security;

create table if not exists pro_form_formats (
  tenant_id text not null,
  task      text not null,
  form      text not null,
  skill_md  text not null default '',     -- 형식 규칙 스킬(SKILL.md 모양, kind: format)
  items     jsonb not null default '[]',  -- [{id, kind, where, text, name, mandatory, why, files, of}]
  source    jsonb not null default '{}',  -- {files:[{name, from}], n, kept, fetched, lowConfidence, model}
  by        text not null default 'ai' check (by in ('ai', 'person')),
  decided   boolean not null default false,
  by_user   uuid,
  at        timestamptz not null default now(),
  primary key (tenant_id, task, form)
);
alter table pro_form_formats enable row level security;
