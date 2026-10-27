-- Process GPT Lite seed (idempotent). psql -v tenant=<id>

-- storage buckets the services write to
insert into storage.buckets (id, name, public) values
  ('files', 'files', true),
  ('deepagent_files', 'deepagent_files', true),
  ('deep_research_files', 'deep_research_files', true),
  ('artifacts', 'artifacts', false)
on conflict (id) do nothing;

-- panel apps' db tier lives in its own schema; PostgREST must expose it
alter role authenticator set pgrst.db_schemas = 'public,storage,graphql_public,panel_data';

-- the tenant and the MCP servers its agents use (container addresses; {{user_jwt}} is filled
-- per request by deepagents)
insert into public.tenants (id) values (:'tenant') on conflict (id) do nothing;

update public.tenants
   set mcp = jsonb_set(coalesce(mcp, '{}'::jsonb), '{mcpServers}',
         coalesce(mcp->'mcpServers', '{}'::jsonb) || jsonb_build_object(
           'office-mcp', jsonb_build_object('url', 'http://office-mcp:1192/mcp/', 'type', 'streamable-http', 'enabled', true),
           'process-gpt-office', jsonb_build_object('url', 'http://office-host:5390/office/mcp', 'type', 'streamable-http', 'enabled', true,
               'headers', jsonb_build_object('Authorization', 'Bearer {{user_jwt}}')),
           'pgpt-folders', jsonb_build_object('url', 'http://server:8787/mcp/folders', 'type', 'streamable-http', 'enabled', true,
               'headers', jsonb_build_object('Authorization', 'Bearer {{user_jwt}}')),
           'pgpt-panelapps', jsonb_build_object('url', 'http://server:8787/mcp/panelapps', 'type', 'streamable-http', 'enabled', true,
               'headers', jsonb_build_object('Authorization', 'Bearer {{user_jwt}}')),
           'pgpt-improve', jsonb_build_object('url', 'http://server:8787/mcp/improve', 'type', 'streamable-http', 'enabled', true,
               'headers', jsonb_build_object('Authorization', 'Bearer {{user_jwt}}'))
         ), true)
 where id = :'tenant';
