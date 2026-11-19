-- The tenant a schedule was made in. Behind the ProcessGPT gateway a request names its tenant, but the
-- minute ticker that fires schedules has no request: without this a run fell back to the server's default
-- tenant (localhost), so the agent refused it (X-Tenant-Id localhost for an ohsy person) and the
-- notification went to the wrong tenant. A person can belong to more than one tenant (users is keyed by
-- id and tenant_id), so the tenant is kept with the schedule rather than looked up from the person.
alter table pro_schedules add column if not exists tenant_id text;

-- schedules made before this: the person's tenant when they belong to exactly one
update pro_schedules s set tenant_id = u.tenant_id
from (select id::text as id, min(tenant_id) as tenant_id from users group by id having count(distinct tenant_id) = 1) u
where s.tenant_id is null and u.id = s.user_id::text;
