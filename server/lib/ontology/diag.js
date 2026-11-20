// Where the time of the process map goes, measured from inside the server pod (an administrator's diag route):
//   db       — this server's own Postgres pool, `select 1` (the pod → Supabase round trip every Lite query pays)
//   bolt     — `RETURN 1` over Bolt to the Ontological gateway (one whole Cypher call, its Postgres round trips included)
//   gateway  — the gateway's Postgres connection, `select 1` (CALL og_outside.ping: the gateway pod → Supabase)
//   stats    — what the gateway has done since it started (CALL og_outside.stats: round trips and time per call)
//   map      — the company's map read as the 지도 screen reads it (readGraph: its Cypher statements, end to end)
//   write    — on request only: a throwaway graph, 200 nodes MERGEd in one UNWIND, read back, dropped
// The outside-engine procedures exist only on ontological-outside; on the in-database engine they are reported missing.
import { q } from '../supa.js'
import { boltDriver, readGraph, graphName, ontologyEnabled, ontologyConfig, cypherTimer, ensureGraphOverBolt } from './store.js'

const summary = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  const r = (v) => Math.round(v * 100) / 100
  return { n: s.length, min: r(s[0]), p50: r(at(0.5)), p95: r(at(0.95)), max: r(s[s.length - 1]) }
}
const timed = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t }
const plain = (rec) => Object.fromEntries(rec.keys.map((k) => [k, rec.get(k)]))

async function boltRun(database, query, params = {}) {
  const s = boltDriver().session({ database })
  try { return (await s.run(query, params)).records.map(plain) } finally { await s.close().catch(() => {}) }
}

export async function diag({ n = 20, mapRuns = 3, write = false } = {}) {
  n = Math.min(200, Math.max(1, Number(n) || 20))
  mapRuns = Math.min(10, Math.max(0, Number(mapRuns) || 0))
  const out = { at: new Date().toISOString(), n, config: { bolt: !!ontologyConfig().bolt, install: ontologyConfig().install || (ontologyConfig().admin ? 'sql' : 'none') } }
  const step = async (name, fn) => { try { out[name] = await fn() } catch (e) { out[name] = { error: String(e.message || e).slice(0, 300) } } }

  await step('db', async () => { const xs = []; for (let i = 0; i < n; i++) xs.push(await timed(() => q('select 1'))); return summary(xs) })
  if (!ontologyEnabled()) return out
  const g = graphName()
  await step('bolt', async () => {
    const first = await timed(() => boltRun(g, 'RETURN 1 AS one')) // a new session may open a connection
    const xs = []; for (let i = 0; i < n; i++) xs.push(await timed(() => boltRun(g, 'RETURN 1 AS one')))
    return { first_ms: Math.round(first * 100) / 100, ...summary(xs) }
  })
  await step('gateway', async () => (await boltRun(g, 'CALL og_outside.ping($n)', { n }))[0])
  await step('stats', async () => (await boltRun(g, 'CALL og_outside.stats()'))[0])
  await step('map', async () => {
    const runs = []
    for (let i = 0; i < mapRuns; i++) {
      const t = { n: 0, ms: 0 }
      const ms = await cypherTimer.run(t, () => timed(() => readGraph({})))
      runs.push({ ms: Math.round(ms), statements: t.n })
    }
    return { runs, ...(runs.length ? summary(runs.map((r) => r.ms)) : {}) }
  })
  if (write) await step('write', () => writeProbe(g))
  return out
}

// a graph of its own so the company's graph and its audit are untouched; dropped at the end
async function writeProbe(company) {
  const g = `${company}__diag`
  const r = {}
  r.ensure_ms = Math.round(await timed(() => ensureGraphOverBolt(g, [['Probe', 'entity', [['key', 'text', true], ['n', 'float8'], ['label', 'text']], false]])))
  const rows = Array.from({ length: 200 }, (_, i) => ({ key: `p${i}`, n: i, label: `probe ${i}` }))
  r.merge200_ms = Math.round(await timed(() => boltRun(g, 'UNWIND $rows AS x MERGE (p:Probe {key: x.key}) SET p.n = x.n, p.label = x.label', { rows })))
  r.again200_ms = Math.round(await timed(() => boltRun(g, 'UNWIND $rows AS x MERGE (p:Probe {key: x.key}) SET p.n = x.n + 1', { rows })))
  r.read_ms = Math.round(await timed(() => boltRun(g, 'MATCH (p:Probe) RETURN count(p) AS c')))
  r.one_create_ms = Math.round(await timed(() => boltRun(g, "CREATE (p:Probe {key: 'one', n: 1})")))
  r.drop_ms = Math.round(await timed(() => boltRun(g, 'CALL og_outside.admin($fn, $args)', { fn: 'og_drop_graph', args: [g] })))
  return r
}
