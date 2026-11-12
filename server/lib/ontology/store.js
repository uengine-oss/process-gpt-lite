// 프로세스 온톨로지 저장소: Ontological DB (spec pgpt-pro_process-ontology, design-v0.2 §3).
// Runtime reads and writes go over Bolt only (the Neo4j driver, Bolt 4.4), each company in its own graph — the
// Bolt "database" is the graph. Who and why ride along as tx_metadata (actor · source · reason) and land in
// Ontological's audit; an effective date is validFrom, a point in time to read at is validAt / systemAt.
// Installing a company's graph (create graph, declare types and properties, switch time on) is the one install-time
// step done with Ontological's SQL functions, as Ontological Studio's installer does — nothing else touches its
// internals. Properties are declared up front because a property's type is fixed by its first value (a count
// written as 1 and later as a float stops the graph: "cannot alter type of a column used by a view"), and `id` is
// Ontological's own node id — a task's identity is `key`.
import neo4j from 'neo4j-driver'
import pg from 'pg'
import { config } from '../../config.js'

const env = (k, d = '') => process.env[k] ?? d
export const ontologyConfig = () => ({
  bolt: env('PRO_ONTOLOGY_BOLT_URL'),
  user: env('PRO_ONTOLOGY_USER', 'ogadmin'),
  password: env('PRO_ONTOLOGY_PASSWORD'),
  admin: env('PRO_ONTOLOGY_ADMIN_URL'), // install-time only (postgres://…/pgpt_onto)
})
export const ontologyEnabled = () => !!ontologyConfig().bolt
export const graphName = (tenant = config.tenantId) => `pgpt_${String(tenant).toLowerCase().replace(/[^a-z0-9_]/g, '_')}`

let driver = null
function bolt() {
  if (driver) return driver
  const c = ontologyConfig()
  if (!c.bolt) throw Object.assign(new Error('Ontological DB 가 설정되지 않았어요(PRO_ONTOLOGY_BOLT_URL).'), { status: 503 })
  driver = neo4j.driver(c.bolt, neo4j.auth.basic(c.user, c.password), { disableLosslessIntegers: true, maxConnectionPoolSize: 8 })
  return driver
}
export async function closeOntology() { if (driver) { await driver.close(); driver = null } }

const toPlain = (v) => {
  if (v && typeof v === 'object' && 'properties' in v && ('labels' in v || 'type' in v)) return { ...v.properties }
  if (Array.isArray(v)) return v.map(toPlain)
  return v
}

// One Cypher statement in the tenant's graph. meta: {actor, reason, source, validFrom, validAt, systemAt}
// A graph dropped outside this process (a demo reset) leaves `made` saying it exists, and Bolt then answers with the
// dropped graph's views (relation "og_data.v_…" does not exist): forget it, make the graph again, and run once more.
const goneGraph = (e) => /relation "og_data\.v_\d+" does not exist|graph .* does not exist/i.test(e?.message || '')
export async function cypher(query, params = {}, meta = {}, tenant = config.tenantId, again = true) {
  await ensureGraph(tenant)
  const s = bolt().session({ database: graphName(tenant) })
  const metadata = Object.fromEntries(Object.entries({ source: 'pgpt-lite', ...meta }).filter(([, v]) => v !== undefined && v !== null && v !== ''))
  try {
    const r = await s.run(query, params, { metadata })
    return r.records.map((rec) => Object.fromEntries(rec.keys.map((k) => [k, toPlain(rec.get(k))])))
  } catch (e) {
    if (again && goneGraph(e)) { made.delete(graphName(tenant)); await s.close(); return cypher(query, params, meta, tenant, false) }
    e.message = `${e.message} — in: ${query.replace(/\s+/g, ' ').slice(0, 90)}${metadata.validFrom ? ` (validFrom ${metadata.validFrom})` : ''}`
    throw e
  } finally { await s.close().catch(() => {}) }
}

// ---------- install-time: the company's graph ----------
// [type, kind, [[prop, datatype, isKey?]], temporal?]
const N = 'float8', S = 'text', B = 'bool', A = 'text[]'
export const SCHEMA = [
  ['Task', 'entity', [['key', S, true], ['name', S], ['aliases', A], ['description', S], ['role', S], ['bundle', S], ['definition_md', S],
    ['skills', A], ['checkpoints', S], ['outputs', S], ['autonomy', S], ['split_type', S], ['join_type', S], ['pinned', B], ['pinned_by', S], ['pin_reason', S],
    ['status', S], ['n', N], ['n_cases', N], ['entry_share', N], ['exit_share', N], ['first_seen', S], ['last_seen', S], ['sources', S], ['people', N],
    ['candidate', B], ['stale', B]], true],
  ['NEXT', 'relation', [['n', N], ['p', N], ['share', N], ['dependency', N], ['w', N], ['wait_h', N], ['ci_low', N], ['ci_high', N], ['thin', B],
    ['first_seen', S], ['last_seen', S], ['cond', S], ['cond_cases', S], ['pinned', B], ['status', S], ['stale', B], ['expected', N], ['p_value', N],
    ['gap_days', N], ['by_source', S], ['people', N], ['parallel', B], ['retired_by', S], ['retire_reason', S]], true],
  ['End', 'entity', [['key', S, true]], false],
  ['Bundle', 'entity', [['key', S, true], ['name', S], ['summary', S], ['band', S], ['status', S], ['theta', N], ['theta_start', B], ['half_life', N],
    ['half_life_start', B], ['a1', N], ['a3', N], ['held', N], ['held_transitions', N], ['curve', S], ['hl_scores', S], ['autonomy', S], ['tasks', A],
    ['entries', A], ['cases', N], ['owner', S], ['summary_theta', N]], true],
  ['HAS_TASK', 'relation', [['entry', B]], false],
  ['Role', 'entity', [['key', S, true], ['name', S], ['outside', B]], false],
  ['PERFORMED_BY', 'relation', [['share', N]], false],
  ['Snapshot', 'entity', [['key', S, true], ['bundle', S], ['entry', S], ['theta', N], ['made_at', S], ['onto_at', S], ['proc_def_id', S], ['tasks', A]], false],
  ['HAS_SNAPSHOT', 'relation', [], false],
  ['Meta', 'entity', [['key', S, true], ['built_at', S], ['events', N], ['cases', N], ['data_start', S], ['data_end', S], ['sources', S], ['values', S], ['backfilled', B]], false],
]

const made = new Set()
export async function ensureGraph(tenant = config.tenantId) {
  const g = graphName(tenant)
  if (made.has(g)) return g
  const c = ontologyConfig()
  if (!c.admin) { made.add(g); return g } // an install whose graphs were made by its installer
  const db = new pg.Client({ connectionString: c.admin })
  await db.connect()
  try {
    const have = await db.query(`select 1 from og_catalog.graph where name=$1`, [g]).catch(() => ({ rows: [] }))
    if (!have.rows.length) {
      await db.query('select og_create_graph($1)', [g])
      for (const [type, kind, props, temporal] of SCHEMA) {
        await db.query('select og_create_type($1,$2,$3)', [g, type, kind])
        for (const [p, t, key] of props) await db.query('select og_add_property($1,$2,$3,$4,$5,$6)', [g, type, p, t, false, !!key])
        if (temporal) await db.query('select og_enable_temporal($1,$2)', [g, type])
      }
    }
  } finally { await db.end() }
  made.add(g)
  return g
}

export async function dropGraph(tenant = config.tenantId) {
  const g = graphName(tenant)
  const c = ontologyConfig()
  made.delete(g)
  if (!c.admin) return false
  const db = new pg.Client({ connectionString: c.admin })
  await db.connect()
  try {
    const have = await db.query(`select 1 from og_catalog.graph where name=$1`, [g]).catch(() => ({ rows: [] }))
    if (have.rows.length) await db.query('select og_drop_graph($1)', [g])
    return have.rows.length > 0
  } finally { await db.end() }
}

// ---------- reads ----------
const J = (s, d) => { try { return s ? JSON.parse(s) : d } catch { return d } }
export const parseTask = (t) => t && ({ ...t, checkpoints: J(t.checkpoints, []), outputs: J(t.outputs, []), sources: J(t.sources, {}), aliases: t.aliases || [], skills: t.skills || [] })
export const parseEdge = (e) => e && ({ ...e, cond_cases: J(e.cond_cases, null), by_source: J(e.by_source, {}) })
export const parseBundle = (b) => b && ({ ...b, curve: J(b.curve, []), hl_scores: J(b.hl_scores, []), tasks: b.tasks || [], entries: b.entries || [] })

// at: {validAt?, systemAt?} — read the graph as it was then
export async function readGraph(at = {}) {
  const meta = { validAt: at.validAt, systemAt: at.systemAt }
  const tasks = (await cypher('MATCH (t:Task) RETURN t', {}, meta)).map((r) => parseTask(r.t))
  const edges = (await cypher('MATCH (a:Task)-[e:NEXT]->(b:Task) RETURN a.key AS from, b.key AS to, e', {}, meta)).map((r) => ({ from: r.from, to: r.to, ...parseEdge(r.e) }))
  const ends = (await cypher('MATCH (a:Task)-[e:NEXT]->(b:End) RETURN a.key AS from, e', {}, meta)).map((r) => ({ from: r.from, to: '__end__', ...parseEdge(r.e) }))
  const bundles = (await cypher('MATCH (b:Bundle) RETURN b', {}, meta)).map((r) => parseBundle(r.b)).filter((b) => b.status !== 'gone')
  const [m] = await cypher(`MATCH (m:Meta {key:'meta'}) RETURN m`, {}, {})
  return { tasks, edges: [...edges, ...ends], bundles, meta: m?.m ? { ...m.m, values: J(m.m.values, {}), sources: J(m.m.sources, {}) } : null }
}
