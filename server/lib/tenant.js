// The tenant a piece of work is for. One install serves one tenant (PRO_TENANT_ID); behind the
// ProcessGPT gateway (<tenant>.process-gpt.io/lite, PRO_TENANT_FROM_HEADER=1) every request names its
// own and background jobs go round the tenants that use Lite. config.tenantId reads it from here, so
// code below a request or a job just keeps using config.tenantId.
import { AsyncLocalStorage } from 'node:async_hooks'

const scope = new AsyncLocalStorage()
export const currentTenant = () => scope.getStore()
export const withTenant = (tenantId, fn) => scope.run(tenantId, fn)
