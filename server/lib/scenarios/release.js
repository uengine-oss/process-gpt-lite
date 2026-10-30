// Scenario 1 「금요일 출시」 (pgpt-pro/docs/agentic-bpm/plan.md §6, P3). A cloud storage service plans a Friday
// release of three features; the QA agent found an open privacy issue in one of them (공유 링크, which handles
// personal data). The request goes through the policies (release.deploy — facts below); the public release is
// denied (release-open-pii), and instead of stopping there the path optimizer (lib/optimize) looks for a way round.
//
// Nothing is deployed anywhere: the executor 'release.deploy' writes a demo deployment log (pro_release_deployments,
// sql/027_scenario_release.sql) and its undo marks the row rolled back.
//
// Facts of release.deploy (lib/policy/catalog.js): audience ('public'|'internal'|'beta'), rollout (%),
// features[{name, pii}], open_findings{privacy, security} (open findings on the features shipped), security_scan,
// weekday (0 = Sunday … 5 = Friday), hour — at the time the phase ships (a demo passes weekday/hour in).
import { q } from '../supa.js'
import { config } from '../../config.js'
import { registerExecutor, guard } from '../policy/pep.js'
import { registerScenario, optimize } from '../optimize/index.js'
import { openAt } from '../optimize/simulate.js'
import { chatJson } from '../llm.js'
import { L } from '../lang.js'

export const ACTION = 'release.deploy'
export const ACCOUNTABLE = '릴리스 책임자'
const T = () => config.tenantId
const TZ = 'Asia/Seoul'
const DAY = 864e5

// ── the demo data (the seed writes it; scripts/seed-release-demo.mjs)
export const DEMO_PLAN = {
  id: 'rel-2026-10-30',
  title: '클라우드 드라이브 4.12 정기 출시',
  planned_for: '2026-10-30T16:00:00+09:00',
  audience: 'public',
  security_scan: 'passed',
  features: [
    { name: '공유 링크', pii: true, summary: '파일·폴더를 링크로 공유 — 받는 사람의 이메일과 소유자 정보를 다룸' },
    { name: '대용량 업로드', pii: false, summary: '최대 50GB 파일을 끊긴 곳부터 이어 올리기' },
    { name: '폴더 동기화 개선', pii: false, summary: '동기화 충돌 해결과 속도 개선' },
  ],
}
// the change the QA agent reviews (made up for the demo)
export const DEMO_DIFF = `--- a/server/share/links.ts
+++ b/server/share/links.ts
@@ export async function createShareLink(fileId: string, owner: User) {
-  return db.links.insert({ fileId, token: randomToken(32), expiresAt: daysFromNow(7), access: 'invited' })
+  return db.links.insert({ fileId, token: randomToken(8), expiresAt: null, access: 'anyone' })
 }
@@ export function linkPreview(link: ShareLink) {
-  return { name: link.file.name, size: link.file.size }
+  return { name: link.file.name, size: link.file.size,
+    owner: { name: link.owner.name, email: link.owner.email, phone: link.owner.phone },
+    recentViewers: link.views.slice(0, 5).map((v) => ({ email: v.email, at: v.at })) }
 }`
export const DEMO_FINDING = {
  id: 'qa-share-link-pii', feature: '공유 링크', category: 'privacy', severity: 'high', fix_days: 3, found_by: 'QA 에이전트',
  title: '공유 링크 미리보기에 소유자 연락처와 열람자 이메일이 노출됨',
  detail: '로그인 없이 열리는 링크 미리보기(linkPreview)가 소유자의 이메일·전화번호와 최근 열람자 이메일을 돌려줍니다. 링크 토큰도 8자로 짧아지고 만료가 없어져(expiresAt: null) 추측·유출된 링크로 개인정보가 계속 노출될 수 있습니다. 미리보기에서 개인정보를 빼고 토큰 길이·만료를 되돌려야 합니다.',
}

// the QA agent: reads a diff and writes its findings. The category and severity it gives are facts the policies
// use, so they are kept to the known values; the fix estimate is the team's (DEMO_FINDING.fix_days), not the
// model's, so the demo's numbers stay the same from one take to the next.
const QA = `너는 클라우드 스토리지 서비스의 QA 에이전트다. 출시 전 변경(diff)을 보고 개인정보·보안 문제를 찾는다.
JSON 으로만 답한다: {"findings":[{"category":"privacy|security|quality","severity":"high|medium|low","title":"한 줄(한국어, 40자 이내)",
"detail":"무엇이 왜 문제이고 어떻게 고치는지 2~3문장(한국어)"}]}`
export async function qaReview({ feature = DEMO_FINDING.feature, diff = DEMO_DIFF } = {}) {
  try {
    const r = await chatJson(QA, `기능: ${feature}\n\n${diff}`, { temperature: 0.2, timeoutMs: 40000, maxTokens: 900 })
    const f = (r?.findings || []).find((x) => x?.category === 'privacy') || r?.findings?.[0]
    if (!f?.title) throw new Error('no finding')
    return {
      ...DEMO_FINDING,
      category: ['privacy', 'security', 'quality'].includes(f.category) ? f.category : 'privacy',
      severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'high',
      title: String(f.title).slice(0, 120), detail: String(f.detail || '').slice(0, 600),
      by_model: true,
    }
  } catch (e) {
    console.warn('[release] QA agent:', e.message)
    return { ...DEMO_FINDING, by_model: false }
  }
}

// ── data
export async function planOf(id = DEMO_PLAN.id) {
  const [p] = await q('select * from pro_release_plans where tenant_id=$1 and id=$2', [T(), id])
  if (!p) throw Object.assign(new Error(L('출시 계획이 없어요. 시드를 먼저 돌려 주세요 (scripts/seed-release-demo.mjs).', 'No release plan: run scripts/seed-release-demo.mjs first.')), { status: 404 })
  return p
}
export const findingsOf = (planId) => q('select id, feature, category, severity, title, detail, fix_days, status, found_by, created_at from pro_release_findings where tenant_id=$1 and plan_id=$2 order by created_at', [T(), planId])

const WD = [['일', 'Sun'], ['월', 'Mon'], ['화', 'Tue'], ['수', 'Wed'], ['목', 'Thu'], ['금', 'Fri'], ['토', 'Sat']]
function clockOf(t) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]))
  return { weekday: WD.findIndex((w) => w[1] === parts.weekday), hour: Number(parts.hour) }
}
// a phase's clock: the request's on day 0, 10:00 on a later day
const timeAt = (ctx, day) => (day === 0 ? { weekday: ctx.weekday, hour: ctx.hour } : { weekday: (ctx.weekday + day) % 7, hour: 10 })
const whenOf = (weekday, hour) => L(`${WD[weekday][0]} ${hour}:00`, `${WD[weekday][1]} ${hour}:00`)
const AUD = { public: ['일반 공개', 'public'], beta: ['베타 그룹', 'beta group'], internal: ['사내 사용자', 'internal users'] }

function factsOf(phase, ctx, fixes = []) {
  const open = (cat) => ctx.findings.filter((f) => f.category === cat && phase.items.includes(f.feature) && openAt(f, phase.day, fixes)).length
  const t = timeAt(ctx, phase.day)
  return {
    audience: phase.audience, rollout: phase.rollout ?? 100,
    features: phase.items.map((n) => ({ name: n, pii: !!ctx.pii[n] })),
    open_findings: { privacy: open('privacy'), security: open('security') },
    security_scan: ctx.security_scan, weekday: t.weekday, hour: t.hour,
  }
}
function subjectOf(phase, ctx) {
  const t = timeAt(ctx, phase.day)
  const rollout = (phase.rollout ?? 100) < 100 ? ` ${phase.rollout}%` : ''
  // the plan's title first: the ledger, the approval cards and the notifications name the release
  return L(`${ctx.title} · ${AUD[phase.audience][0]}${rollout} 출시 — ${phase.items.join(', ')} (${whenOf(t.weekday, t.hour)}${phase.day ? `, +${phase.day}일` : ''})`,
    `${ctx.title} · release to ${AUD[phase.audience][1]}${rollout} — ${phase.items.join(', ')} (${whenOf(t.weekday, t.hour)}${phase.day ? `, +${phase.day} days` : ''})`)
}

// the optimizer's view of a request (lib/optimize/index.js): re-read each time, so a finding fixed since counts
async function context(trigger) {
  const r = trigger.request
  const plan = await planOf(r.planId)
  return {
    planId: plan.id, plannedFor: plan.planned_for, title: r.title || plan.title, audience: r.audience, when: whenOf(r.weekday, r.hour),
    planned: r.features.map((f) => f.name), pii: Object.fromEntries(r.features.map((f) => [f.name, !!f.pii])),
    findings: await findingsOf(plan.id), weekday: r.weekday, hour: r.hour, security_scan: r.security_scan,
  }
}

async function recordLater(phase, ctx, opt, alt, userId) {
  const status = phase === alt.phases[0] ? 'scheduled' : 'planned'
  const at = new Date(new Date(ctx.plannedFor).getTime() + phase.day * DAY)
  const [row] = await q(`insert into pro_release_deployments(tenant_id, plan_id, optimization_id, alternative, audience, rollout, features, status, scheduled_for, note, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
  [T(), ctx.planId, opt.id, alt.id, phase.audience, phase.rollout ?? 100, JSON.stringify(phase.items), status, at,
    L('조치 후 그때 다시 정책을 확인하고 출시', 'Released then, after the fix, once the policies are checked again'), userId])
  return { status, id: row.id }
}

registerScenario(ACTION, {
  executor: 'release.deploy', accountableRole: ACCOUNTABLE,
  context, factsOf, subjectOf, sourceOf: (name) => `feature:${name}`, recordLater,
  payloadOf: (phase, ctx, opt, alt) => ({ planId: ctx.planId, optimizationId: opt?.id || null, alternative: alt?.id || null, label: alt?.label || null, audience: phase.audience, rollout: phase.rollout ?? 100, features: phase.items }),
})

// ── the executor: a demo deployment log entry, taken back by undo
registerExecutor('release.deploy', {
  undoMinutes: 30,
  async run(p, ctx) {
    const [row] = await q(`insert into pro_release_deployments(tenant_id, plan_id, optimization_id, alternative, decision_id, audience, rollout, features, status, note, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'deployed',$9,$10) returning id, created_at`,
    [ctx.tenant || T(), p.planId, p.optimizationId, p.alternative, ctx.decisionId, p.audience, p.rollout ?? 100, JSON.stringify(p.features || []),
      L('시연용 배포 기록 — 실제로 배포하지 않음', 'Demo deployment log — nothing was deployed'), ctx.userId || null])
    return { deploymentId: row.id, audience: p.audience, rollout: p.rollout ?? 100, features: p.features, demo: true }
  },
  async undo(p, result) {
    await q(`update pro_release_deployments set status='rolled_back' where id=$1`, [result?.deploymentId])
  },
})

// ── a release request: the policies first; a denied one goes to the optimizer
// body: {planId, audience, weekday, hour, security_scan, threadId, useModel, ask, unheldRoles, optimize}
export async function requestRelease(me, body = {}) {
  const plan = await planOf(body.planId || DEMO_PLAN.id)
  const findings = await findingsOf(plan.id)
  const clock = clockOf(plan.planned_for || new Date())
  const weekday = Number.isInteger(body.weekday) ? body.weekday : clock.weekday
  const hour = Number.isInteger(body.hour) ? body.hour : clock.hour
  const audience = ['public', 'beta', 'internal'].includes(body.audience) ? body.audience : plan.audience
  const security_scan = body.security_scan || plan.security_scan
  const features = plan.features.map((f) => ({ name: f.name, pii: !!f.pii }))
  const names = features.map((f) => f.name)
  const ctx = { title: plan.title, findings, pii: Object.fromEntries(features.map((f) => [f.name, f.pii])), security_scan, weekday, hour }
  const phase = { day: 0, audience, rollout: 100, items: names }
  const facts = factsOf(phase, ctx)
  const subject = subjectOf(phase, ctx)
  const g = await guard({ me, kind: ACTION, subject, facts, executor: 'release.deploy',
    payload: { planId: plan.id, audience, rollout: 100, features: names, label: L('계획대로 출시', 'As planned') },
    card: { userId: me.id, threadId: body.threadId || null } })
  const [req] = await q(`insert into pro_release_requests(tenant_id, plan_id, user_id, facts, decision_id, decision) values ($1,$2,$3,$4,$5,$6) returning *`,
    [T(), plan.id, me.id, facts, g.decisionId, g.decision])
  let optimization = null
  if (g.status === 'blocked' || (g.status === 'pending' && body.optimize)) {
    const open = findings.filter((f) => f.status !== 'fixed' && names.includes(f.feature))
    optimization = await optimize({
      me,
      trigger: {
        kind: 'policy_block', decision_id: g.decisionId, request_id: req.id,
        action: { kind: ACTION, subject, facts }, matched: g.matched,
        request: { planId: plan.id, title: plan.title, audience, weekday, hour, when: whenOf(weekday, hour), security_scan, features },
        finding: open[0] ? { feature: open[0].feature, category: open[0].category, severity: open[0].severity, title: open[0].title, detail: open[0].detail, by: open[0].found_by, fix_days: open[0].fix_days } : null,
        findings: open.length,
      },
      options: { useModel: body.useModel !== false, ask: !!body.ask, unheldRoles: Array.isArray(body.unheldRoles) ? body.unheldRoles : [] },
    })
    await q('update pro_release_requests set optimization_id=$2 where id=$1', [req.id, optimization.id])
  }
  return { request: req, decision: g, optimization }
}

export async function deployments(limit = 30) {
  return q(`select d.*, u.username as by_name from pro_release_deployments d left join users u on u.id=d.created_by and u.tenant_id=d.tenant_id
    where d.tenant_id=$1 order by d.created_at desc limit $2`, [T(), limit])
}
