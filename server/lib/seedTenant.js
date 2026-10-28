// The tenant a seed script writes to, entered for the rest of the script (lib/tenant.js):
//   --lang en      the English demo tenant (PRO_EN_DEMO_TENANT, default en-demo) — never the default one,
//                  so an English seed cannot overwrite the Korean demo data that shares its ids
//   --tenant <id>  a tenant by name
//   otherwise      the default tenant (PRO_TENANT_ID), as before
// The tenant must be one this server serves (PRO_TENANT_HOSTS in server/.env); otherwise the script stops.
import { config } from '../config.js'
import { tenantStore } from './tenantStore.js'
import { servesTenant, DEFAULT_TENANT, urlOf } from './tenant.js'

const argOf = (argv, k) => {
  const eq = argv.find((a) => a.startsWith(`${k}=`))
  if (eq) return eq.slice(k.length + 1)
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : undefined
}
export const seedLang = (argv = process.argv.slice(2)) => (/^en/i.test(String(argOf(argv, '--lang') || process.env.DEMO_LANG || '')) ? 'en' : 'ko')

export function enterSeedTenant(argv = process.argv.slice(2)) {
  const t = argOf(argv, '--tenant') || (seedLang(argv) === 'en' ? config.enDemoTenant : DEFAULT_TENANT)
  if (!servesTenant(t)) {
    console.error(`tenant '${t}' is not served here: add it to PRO_TENANT_HOSTS in server/.env (e.g. PRO_TENANT_HOSTS=en.localhost=${t}) — i18n/EN-DEMO.md`)
    process.exit(2)
  }
  tenantStore.enterWith({ tenant: t })
  return t
}

// the BFF address for this tenant: the same server on the tenant's host (sign-in picks the tenant by host)
export function apiFor(t, api) {
  if (t === DEFAULT_TENANT) return api
  try {
    const u = new URL(api)
    u.hostname = new URL(urlOf(t)).hostname
    return u.toString().replace(/\/$/, '')
  } catch { return api }
}
