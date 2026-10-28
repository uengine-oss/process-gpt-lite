// The tenant of the work in progress, one value per request or job (lib/tenant.js decides it).
// Its own module, without imports, so that config.js can read it (config.tenantId).
import { AsyncLocalStorage } from 'node:async_hooks'

export const tenantStore = new AsyncLocalStorage()
