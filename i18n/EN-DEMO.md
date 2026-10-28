# English demo tenant — where the English tutorial and videos are captured

The dev tenant (`localhost`, http://localhost:5180) is full of Korean data from many test accounts:
Korean teammates in member pickers, Korean mined processes, Korean skills. The English screenshots and
videos are captured in a tenant of their own, **`en-demo`**, on the same dev stack (Vite :5180, server
:8787). It holds only English data: the English cast (GLOSSARY.md › Example cast and data), their team
and roles, and the English seeds. Korean mode and the Korean demo data are not touched by any of this.

## How to reach it

**http://en.localhost:5180** — nothing to set up on the machine: `*.localhost` resolves to this computer
(Chrome, Playwright, Node, curl).

How it works (`server/lib/tenant.js`):

- `PRO_TENANT_HOSTS=en.localhost=en-demo` in `server/.env` maps a host name to a tenant. Vite passes the
  browser's `Host` to the server (`changeOrigin: false`), and the server picks the tenant from it — the
  way Process GPT takes the tenant from the subdomain, but only for the hosts listed. Without
  `PRO_TENANT_HOSTS` the server has one tenant (`PRO_TENANT_ID`, default `localhost`) and works as before.
- An account belongs to the tenant it was first used on: `app_metadata.tenant_id` of the auth user
  (written by the service key only). Every request of a signed-in person runs in that person's tenant;
  background work (mail poller, missions, process steps, mining, meetings, notifications) runs in the
  tenant of the person it is for, and the per-tenant sweeps (mining scan, mcp-hub registry, constraint
  sweep, step retry, folder steps) run once per tenant.
- **An account of one tenant cannot sign in on the other's address** (403 "This account belongs to another
  workspace (en-demo). Please sign in at http://en.localhost:5180."). So an English capture can never
  pull a Korean teammate in, and the English cast never shows up in the Korean team.
- Everything that names the tenant follows: database rows (`tenant_id`), deepagents (`tenant_id`, its
  `skills/en-demo` and `workspace/en-demo`), completion (`X-Forwarded-Host: en-demo.…`, completion's own
  tenant rule), process-miner (`tenant_id`), mcp-hub (`X-Tenant-Id`: the pgpt-* servers are registered for
  en-demo and bound to the cast), the `tenants` row's MCP list (only this server's `pgpt-*` gateways, not
  the default tenant's MES/WMS demo servers), shared-folder repositories (`~/pgpt-folders/en-demo/…`).
- No Korean tenant skill, mined process, process, teammate, room or folder is visible there. The only
  skills listed are process-gpt's three built-in ones (bpmn-process-generation-skill,
  bsc-strategy-interview, process-execution), with English descriptions from the dictionary.

## Accounts

Sign in with the e-mail and the demo code **000000** (email sign-in; not "Sign in with Google", whose
callback goes to the default address). The accounts are English users (`pro_profile.lang = en`) and onboarded.

| Person | Account | Role |
|---|---|---|
| Jinyoung Jang | `pro-en-jinyoung@uengine.org` | proposal team lead, **administrator** (and tenant owner) |
| Minji Kim | `pro-en-minji@uengine.org` | designer |
| Seoyeon Park | `pro-en-seoyeon@uengine.org` | finance |
| Yuna Choi | `pro-en-yuna@uengine.org` | meeting demo only: a teammate outside the room |

Role owners (Settings › Team & roles): every process — **Proposal team lead** Jinyoung Jang, **Designer**
Minji Kim, **Finance** Seoyeon Park, **Product owner** Minji Kim; Moonlight Coffee proposal — Sales Jinyoung
Jang, Designer Minji Kim, Finance Seoyeon Park; Travel expense settlement — Approver Jinyoung Jang; Supplier
catalog price survey — Buyer Seoyeon Park. One naming everywhere (GLOSSARY.md › Roles and steps).

## What is seeded

| Seed | In the tenant |
|---|---|
| `sql/seed-demo-process.mjs --lang en` | **Travel expense settlement** (`pro_expense_claim`) + Expense review agent |
| `sql/seed-browser-process.mjs --lang en` | **Supplier catalog price survey** (`pro_supplier_survey`) + Browser agent |
| `sql/seed-sns-process.mjs --lang en` | **Daily SNS trend response** (`pro_sns_trend_response`) + its agents |
| `scripts/seed-improve-demo.mjs --lang en` | **Moonlight Coffee proposal** (`tutd_moonlight_proposal`, v1.0) with ~3 months of history (48 instances, Aug 3 – today, stores such as Gwanghwamun Store #53, Ikseon-dong Store #55, Yeonnam Store #56), Quote agent, Proposal agent; the constraint notice "Moonlight Coffee proposal: a new constraint appeared — Finance review" for Jinyoung Jang |
| `scripts/seed-mining-demo.mjs --lang en` | three earlier English mail cases (Hanbit Dental, Onsaemiro Bakery, GreenFit Pilates — `mail:en-demo:demo-*`): Receive request mail → Draw floor plan → Write proposal → Prepare quote → Finance review → Reply to customer. **No suggestion yet**: it appears with the live fourth case (Settings › practice mail "Moonlight Coffee Store #2 proposal & quote request" through the real mail → drafts → share → reply flow; `PRO_MINING_MIN_CASES`, default 4) |
| `docs/demo/meetings/record/seed.mjs --lang en` | team room **Moonlight Coffee proposal team** (Jinyoung, Minji, Seoyeon) with `Moonlight_Coffee_quote.xlsx` and `Moonlight_Coffee_floor_plan.dxf` shared in it, a Travel expense settlement instance by Minji (agent review done, **Approval** waiting for Jinyoung), the **Leave schedule** panel app in its folder; writes `seed-en.json` |

Not seeded on purpose (each is a capture moment): the demo mailbox connection (Settings › Accounts ›
Connections › demo mailbox — English mails from `server/fixtures/*-en.json`), chats, skills such as
"Store design proposal draft", the "Quote tracker" panel, the "Solgil Bakery Pangyo Store #3" folder.

## (Re)seed and reset

From `server/` (the dev server must already serve `en.localhost`: `PRO_TENANT_HOSTS` in `server/.env`):

```bash
node scripts/en-demo.mjs                  # tenant row + MCP list, cast, team, roles, admin, mcp-hub (idempotent)
node scripts/en-demo.mjs --seed           # … and every seed above (the meeting seed signs in through the server:
                                          #     --api http://localhost:8787 → http://en.localhost:8787)
node scripts/en-demo.mjs --reset          # empty the tenant (data, folders + repositories, skills, workspace,
                                          #     chats, mail, schedules, vault, panels), keep the cast, set up again
node scripts/en-demo.mjs --reset --seed   # a fresh English demo in one go (about 4 minutes)
node scripts/en-demo.mjs --reset --accounts   # … and remove every account of the tenant too
node scripts/en-demo.mjs --clean          # remove test accounts that signed in there (pro-rt-*, pro-en-ui-*, pro-en-fix-*)
node scripts/en-demo.mjs --status         # team, roles, processes, mining, folders, rooms, agents, and any Hangul left
```

Each seed also runs on its own with `--lang en`: it writes to `en-demo` (`server/lib/seedTenant.js`; it
stops if the server does not serve that tenant) and never to the Korean tenant, so the same ids live in
both. `seed-improve-demo.mjs --lang en --run N --api http://localhost:8787` drives real instances as the
cast (it signs in on `en.localhost`).

## For the tutorial and video capture agents

- Open **http://en.localhost:5180** only, sign in as the cast above (code 000000). Never sign the cast in
  on http://localhost:5180 (refused) and never sign Korean accounts in here (refused).
- Browser locale `en-US`; the accounts are already English (`?lang=en` is harmless, not needed).
- Start from a known state: `node scripts/en-demo.mjs --reset --seed`, then `--status` (expect `"korean": []`).
- After any check or test run against the tenant (checker, smoke) run `node scripts/en-demo.mjs --clean`:
  test accounts join the team on sight and the smoke names itself "Jinyoung Jang".
- Use the names of GLOSSARY.md as they are; the screens and the seeds use the same words (Sales,
  Designer, Finance, Proposal team lead; Receive request mail, Draft quote, Prepare quote …). Tutorial
  chapters that still say "Finance owner" (messenger, process-create, email-to-quote, mining, folders) now
  read **Finance** on screen.
- Instances started in English get English names (`<process> · <first start-form value>`); completion's
  own namer writes Korean, so the server keeps the English one.
- Still Korean in this tenant (know before you frame a shot): the body (SKILL.md) of process-gpt's three
  built-in skills when one is opened in Settings › Skills; the IeumOffice ribbon until the office host's
  `feat/per-page-ui-lang` is built and the host restarted (HANDOFF.md › Embedded editors).
- Model calls run on the shared dev model; a mail poll can time out when it is slow — retry.
- Limits: a scheduled task run by Claude Code or Codex (cli-agent) finds named skills only in the folder its
  `SKILLS_DIRS` names (the localhost tenant's), so a skill made in en-demo does not reach it — deepagents is
  fine; "Sign in with Google" returns to the default address. The shared dev database sometimes restarts
  (recovery mode): a page then stays blank or a sign-in fails with "Database error checking email" — wait
  a minute and reload.

## Checks

```bash
# every screen in English on a fresh account of the tenant (0 left expected), report in i18n/check/
WEB=http://en.localhost:5180 API=http://en.localhost:8787 PGPT_TENANT=en-demo node scripts/i18n-check.mjs
# English smoke (S-EN-01…03) against the tenant
cd e2e && PGPT_URL=http://en.localhost:5180 PGPT_TENANT=en-demo npx playwright test --project=smoke tests/smoke/english.spec.js
cd ../server && node scripts/en-demo.mjs --clean
```

## Where it is in the code

`server/lib/tenant.js` (host → tenant, a person's tenant, per-tenant loops, sign-in refusal, the `tenants`
row), `server/lib/tenantStore.js` + `config.tenantId` (a getter: the tenant of the request or job),
`server/lib/supa.js ensureUser` (tenant of a new account, refusal), `server/lib/lang.js asUser` (a person's
language and tenant), `server/lib/seedTenant.js` (seeds), `server/scripts/en-demo.mjs`, `server/lib/engine.js`
(completion's tenant header, English instance names), `server/lib/mining/recorder.js caseOf` (tenant in case
ids), `server/lib/folders/service.js foldersRoot()/workspaceDir()`, `vite.config.js` (`*.localhost` is local).
