// Loads process-gpt's own .env so secrets are not copied into this project,
// then lets a local server/.env override anything.
import dotenv from 'dotenv'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGPT_ROOT, ARTCRAFT_ROOT } from './lib/paths.js'
import { tenantStore } from './lib/tenantStore.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const local = dotenv.config({ path: path.join(here, '.env') }).parsed || {}
const pgpt = fs.existsSync(path.join(PGPT_ROOT, '.env'))
  ? dotenv.parse(fs.readFileSync(path.join(PGPT_ROOT, '.env')))
  : {}
const get = (k, d) => process.env[k] ?? local[k] ?? pgpt[k] ?? d

export const config = {
  port: Number(get('PRO_PORT', 8787)),
  publicUrl: get('PRO_PUBLIC_URL', 'http://localhost:5180'),
  // the request's or job's tenant (lib/tenant.js), else this install's one
  get tenantId() { return tenantStore.getStore()?.tenant || this.defaultTenantId },
  defaultTenantId: get('PRO_TENANT_ID', 'localhost'),
  // behind the ProcessGPT gateway: the tenant is the address's subdomain, which the gateway always
  // sets as X-Tenant-Id (ForwardHostHeaderFilter); sign-in is ProcessGPT's own
  tenantFromHeader: get('PRO_TENANT_FROM_HEADER', '0') === '1',
  // more tenants on the same server, each on its own host name: "en.localhost=en-demo,…" (lib/tenant.js)
  tenantHosts: get('PRO_TENANT_HOSTS', ''),
  // the English demo tenant the seeds write to with --lang en (lib/seedTenant.js, i18n/EN-DEMO.md)
  enDemoTenant: get('PRO_EN_DEMO_TENANT', 'en-demo'),

  supabaseUrl: get('PRO_SUPABASE_URL', 'http://127.0.0.1:54321'),
  anonKey: get('ANON_KEY'),
  serviceKey: get('SERVICE_ROLE_KEY'),
  db: {
    host: get('PRO_DB_HOST', '127.0.0.1'),
    port: Number(get('PRO_DB_PORT', 54322)),
    user: get('PRO_DB_USER', 'postgres'),
    password: get('POSTGRES_PASSWORD'),
    database: get('PRO_DB_NAME', 'postgres'),
  },

  deepagentsUrl: get('PRO_DEEPAGENTS_URL', 'http://127.0.0.1:8888'),
  cliAgentUrl: get('PRO_CLI_AGENT_URL', 'http://127.0.0.1:8890'),
  // where saveGenerated runs process-gpt's Python (Docker bundle); empty = the local deepagents venv
  bridgeUrl: get('PRO_BRIDGE_URL', ''),
  // context-router in front of the agents: picks the conversation a chat message belongs to
  contextRouterUrl: get('PRO_CONTEXT_ROUTER_URL', ''),
  // template office-mcp generate_hwpx fills when someone asks for a 한글 document
  hwpxTemplateUrl: get('PRO_HWPX_TEMPLATE_URL', ''),
  // the template office-mcp fills for a proposal (제안서) a customer mail asks for (lib/mail.js drafts)
  proposalTemplateUrl: get('PRO_PROPOSAL_TEMPLATE_URL', ''),
  // process-gpt office-mcp (template filling: generate_hwpx), called directly for those drafts
  officeMcpUrl: get('PRO_OFFICE_MCP_URL', 'http://127.0.0.1:1192'),
  // a design proposal's 한글 template: its picture (3:2) takes the floor plan CADCraft drew (lib/mail.js)
  designTemplatePath: get('PRO_DESIGN_TEMPLATE_PATH', path.join(here, 'fixtures', 'interior-proposal-template.hwpx')),
  // agent workroom: where cli-agent keeps per-run workspaces, the key a terminal needs on top of
  // sign-in (no key → no terminals), and the Claude Code binary resumed in a run's folder
  cliWorkspaceRoot: get('PRO_CLI_WORKSPACE_ROOT', '/tmp/cli-agent-ws'),
  terminalKey: get('PRO_TERMINAL_KEY', ''),
  // shared folders: where folder repositories live (<root>/<tenant>/<slug>); unset = ~/pgpt-folders
  foldersRoot: get('PRO_FOLDERS_ROOT', ''),
  claudeBin: get('PRO_CLAUDE_BIN', 'claude'),
  // fast page-state / goal-done checks in the browser loop through the router's /decide
  browserGates: get('PRO_BROWSER_GATES', 'on') !== 'off',
  // ArtCraft apps: the self-hosted web builds served at /craft/<app>/ and each app's MCP CLI
  // (default: <app>-cli on PATH; see artcraft/README.md)
  craftWebRoot: get('PRO_CRAFT_WEB_ROOT', path.join(ARTCRAFT_ROOT, 'web')),
  craftCli: {
    cadcraft: get('PRO_CADCRAFT_CLI', 'cadcraft-cli'),
    vectorcraft: get('PRO_VECTORCRAFT_CLI', 'vectorcraft-cli'),
    photocraft: get('PRO_PHOTOCRAFT_CLI', 'photocraft-cli'),
    soundcraft: get('PRO_SOUNDCRAFT_CLI', 'soundcraft-cli'),
    filmcraft: get('PRO_FILMCRAFT_CLI', 'filmcraft-cli'),
  },
  // IeumOffice editor host (process-gpt office-host): its MCP (/office/mcp) edits the documents open in the page
  officeHostUrl: get('PRO_OFFICE_HOST_URL', 'http://127.0.0.1:5390'),
  completionUrl: get('PRO_COMPLETION_URL', 'http://127.0.0.1:8099'),
  mementoUrl: get('PRO_MEMENTO_URL', 'http://127.0.0.1:8005'),
  llm: {
    baseUrl: get('PRO_LLM_BASE_URL', get('LLM_PROXY_URL', 'https://api.openai.com/v1')),
    apiKey: get('PRO_LLM_API_KEY', get('OPENAI_API_KEY')),
    model: get('PRO_LLM_MODEL', 'gpt-6-luna'),
    fastModel: get('PRO_LLM_FAST_MODEL', 'gpt-4.1-mini'),
  },
  llmTrace: get('PRO_LLM_TRACE', ''), // file to append model request text to (see lib/llm.js)

  google: {
    clientId: get('GOOGLE_CLIENT_ID'),
    clientSecret: get('GOOGLE_CLIENT_SECRET'),
  },
  // Vault KEKs (32 bytes, base64), never stored in the database. Either PRO_VAULT_KEK (current) plus
  // PRO_VAULT_KEK_RETIRED (comma-separated older keys), or a 0600 keyring file created on first run
  // (importing the single-key server/.vault-kek of earlier versions).
  vaultKek: get('PRO_VAULT_KEK'),
  vaultKekRetired: (get('PRO_VAULT_KEK_RETIRED') || '').split(',').map((s) => s.trim()).filter(Boolean),
  vaultKeyringFile: get('PRO_VAULT_KEYRING', path.join(here, '.vault-keyring.json')),
  vaultKekFile: path.join(here, '.vault-kek'),
  mailPollSeconds: Number(get('PRO_MAIL_POLL_SECONDS', 300)),
  // pg_cron fires schedules by calling back into this server through pg_net.
  cronCallbackBase: get('PRO_CRON_CALLBACK', 'http://host.docker.internal:8787'),
  // 'server': this server checks the schedules every minute instead (lib/scheduler.js)
  cronMode: get('PRO_CRON_MODE', 'pg_cron') === 'server' ? 'server' : 'pg_cron',
  cronSecret: get('PRO_CRON_SECRET', 'pgpt-pro-cron'),
}
