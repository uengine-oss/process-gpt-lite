-- Row level security on the two Lite tables that were made without it (2026-11-18). The server reads and
-- writes them over its own database connection, like every other pro_* table; through PostgREST a
-- browser key (anon, authenticated) reads nothing — RLS on, no policies.
-- (Production: pro_mining_talk was the only pro_* table with RLS off; pro_thread_folders was created with
-- it on from the SQL Editor. This makes a Compose install and a fresh database the same.)
alter table pro_mining_talk enable row level security;
alter table pro_thread_folders enable row level security;
