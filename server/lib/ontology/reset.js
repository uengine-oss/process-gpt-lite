// A demo tenant's reset (scripts/ax-demo.mjs --reset): its graph goes, and the Lite rows the ontology made.
import { q } from '../supa.js'
import { dropGraph, ontologyEnabled } from './store.js'

export async function resetTenant(tenant) {
  for (const t of ['pro_mail_history', 'pro_mail_archive', 'pro_onto_jobs', 'pro_onto_labels', 'pro_po_cases', 'pro_onto_answers']) {
    await q(`delete from ${t} where tenant_id=$1`, [tenant]).catch(() => {})
  }
  const dropped = ontologyEnabled() ? await dropGraph(tenant).catch((e) => { console.warn('[ontology] drop', e.message); return false }) : false
  return { dropped }
}
