// The disk lease a piece of work on a variation's checkout runs under (folders/seats.js onDisk — a lease row of that variation, renewed
// while the work goes on). What removes, checks out or commits asks it first (stillHeld): a lease that was lost — its renewals did not
// reach the database in time and another server took the variation — stops the work right there, before anything on disk changes.
// Outside such work (a folder's main, a test that calls the service itself) there is no lease to ask and nothing is stopped.
import { AsyncLocalStorage } from 'node:async_hooks'

export const leaseStore = new AsyncLocalStorage()
// step: what is about to happen (retire · checkout · commit) — it is in the error when the lease is gone
export async function stillHeld(step) {
  const l = leaseStore.getStore()
  if (l) await l.check(step)
}
// a scratch checkout of this server's own (not any variation's place): no lease is asked for it
export const withoutLease = (fn) => leaseStore.exit(fn)
