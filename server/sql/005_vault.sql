-- Vault v2: key versions, several accounts per site, usage, and an audit trail.
-- Idempotent; existing rows keep working (fingerprints are back-filled by `node scripts/vault-admin.mjs verify`).

-- DEK version: bumped when the user's DEK is replaced and every item re-encrypted.
alter table pro_vault_keys add column if not exists dek_version int not null default 1;
alter table pro_vault_keys add column if not exists rotated_at timestamptz;

-- fingerprint = HMAC(DEK-derived key, account identity) so two accounts on one site, or two cards,
-- are told apart without storing the username / card number in the clear.
alter table pro_vault_items add column if not exists fingerprint text;
alter table pro_vault_items add column if not exists meta jsonb not null default '{}';  -- non-secret display info (card brand, last4)
alter table pro_vault_items add column if not exists dek_version int not null default 1;
alter table pro_vault_items add column if not exists last_used_at timestamptz;
alter table pro_vault_items add column if not exists use_count int not null default 0;
create unique index if not exists pro_vault_items_identity on pro_vault_items(user_id, kind, site, fingerprint);

-- Who touched which secret, when, and for which task. Never holds a secret value.
create table if not exists pro_vault_audit (
  id bigserial primary key,
  user_id uuid not null,
  item_id uuid,
  kind text, site text,
  action text not null,         -- create | update | delete | fill | capture | confirm | discard | reject | one_time | rotate_dek | rotate_kek
  actor text not null,          -- user | browser-agent | mail | connector | admin
  task_id uuid,
  detail jsonb not null default '{}',
  created_at timestamptz default now()
);
create index if not exists pro_vault_audit_user on pro_vault_audit(user_id, created_at desc);
