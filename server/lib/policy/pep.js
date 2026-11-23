// The policy enforcement point: the one way an agent's action with consequences runs. guard() asks the PDP,
// then — allow: runs it; allow_audit: runs it, records it, and leaves an undo window (Human-on-the-Loop);
// require_approval: keeps the action and asks the approver (Human-in-the-Loop), who approves it later and it
// runs then, as the person who asked; deny: does not run it and says which policy and why. Every step lands in
// the decision ledger, and a chat card (kind 'policy') follows the action for the person who asked.
//
// An action runs through a registered executor: registerExecutor('mail.send', { run, undo, undoMinutes }).
// run(payload, ctx) gets ctx = {userId, tenant, decisionId}; undo(payload, result, ctx) takes it back.
import { q } from '../supa.js'
import { config } from '../../config.js'
import { decide } from './pdp.js'
import { addMessage, updateMessage, mainThread } from '../store.js'
import { notifyUser } from '../notify.js'
import { roleMap, roleKey, isAdmin } from '../team.js'
import { L } from '../lang.js'

const T = () => config.tenantId
const executors = new Map()
export function registerExecutor(name, ex) { executors.set(name, ex) }
export const executorOf = (name) => executors.get(name)

// who decides for a role: its company-wide holder (Settings › 팀·역할), else the company's administrators
export async function approversOf(role, tenant = T()) {
  const holder = role ? (await roleMap('*'))[roleKey(role)] : null
  if (holder) return [holder]
  const rows = await q(`select u.id from users u where u.tenant_id=$1 and u.is_admin union select t.owner from tenants t where t.id=$1 and t.owner is not null`, [tenant])
  return rows.map((r) => r.id)
}
export async function canApprove(me, role) {
  return (await approversOf(role)).map(String).includes(String(me.id)) || await isAdmin(me)
}

const cardOf = (d, extra = {}) => ({ decisionId: d.id, decision: d.decision, subject: d.subject, matched: d.matched, approver: d.approver, status: d.status, ...extra })

async function run(ex, payload, ctx) {
  try {
    const result = await ex.run(payload, ctx)
    return { ok: true, result }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// one action through the policies. card: {userId, threadId} posts (and later updates) the 'policy' card in that
// chat; without it the caller shows the outcome itself.
export async function guard({ me, kind, subject, facts, executor, payload, ref = null, card = null }) {
  const ex = executors.get(executor)
  if (!ex) throw new Error(`no executor ${executor}`)
  const d = await decide({ userId: me?.id || null, action: { kind, subject, facts }, ref })
  const out = { decisionId: d.id, decision: d.decision, matched: d.matched, approver: d.approver, subject }
  if (d.decision === 'allow' || d.decision === 'allow_audit') {
    const r = await run(ex, payload, { userId: me?.id, tenant: T(), decisionId: d.id })
    const undoUntil = r.ok && d.decision === 'allow_audit' && ex.undo && ex.undoMinutes ? new Date(Date.now() + ex.undoMinutes * 6e4) : null
    await q('update pro_policy_decisions set status=$2, result=$3 where id=$1', [d.id, r.ok ? 'executed' : 'failed', r.ok ? r.result ?? {} : { error: r.error }])
    await q(`insert into pro_policy_actions(decision_id, executor, payload, undo_until) values ($1,$2,$3,$4) on conflict do nothing`, [d.id, executor, payload, undoUntil])
    Object.assign(out, { status: r.ok ? 'executed' : 'failed', result: r.result, error: r.error, undoUntil })
  } else if (d.decision === 'require_approval') {
    await q('insert into pro_policy_actions(decision_id, executor, payload) values ($1,$2,$3)', [d.id, executor, payload])
    for (const uid of await approversOf(d.approver)) {
      await notifyUser(uid, {
        type: 'policy', url: `/settings/policies?d=${d.id}`,
        title: L(`승인 요청 — ${subject}`, `Approval needed — ${subject}`),
        text: L(`${me?.name || '팀원'}님의 요청이 정책 「${d.matched.find((m) => m.decision === 'require_approval')?.title?.[0] || ''}」에 걸려 ${d.approver || '관리자'} 승인을 기다려요.`,
          `${me?.name || 'A teammate'}'s request waits for the ${d.approver || 'administrator'} under "${d.matched.find((m) => m.decision === 'require_approval')?.title?.[1] || ''}".`),
      }).catch(() => {})
    }
    Object.assign(out, { status: 'pending' })
  } else {
    Object.assign(out, { status: 'blocked' })
  }
  if (card?.userId) {
    const threadId = card.threadId || (await mainThread(card.userId)).id
    const m = await addMessage(card.userId, threadId, 'agent', 'policy', cardOf({ ...d, subject, status: out.status }, { undoUntil: out.undoUntil || null, error: out.error || null }))
    await q('update pro_policy_decisions set ref=coalesce(ref, $2) where id=$1', [d.id, `message:${m.id}`])
    out.messageId = m.id
  }
  return out
}

async function loadPending(id) {
  const [d] = await q(`select d.*, a.executor, a.payload, a.undo_until from pro_policy_decisions d join pro_policy_actions a on a.decision_id=d.id
    where d.id=$1 and d.tenant_id=$2`, [id, T()])
  if (!d) throw Object.assign(new Error('no such decision'), { status: 404 })
  return d
}
const messageOf = (d) => (String(d.ref || '').startsWith('message:') ? d.ref.slice(8) : null)

// the approver's answer: approved → the kept action runs now, as the person who asked
export async function answer(me, id, approve, note = '') {
  const d = await loadPending(id)
  if (d.status !== 'pending') throw Object.assign(new Error(L('이미 처리된 요청이에요.', 'Already decided.')), { status: 409 })
  if (!(await canApprove(me, d.approver_role))) throw Object.assign(new Error(L(`${d.approver_role || '관리자'}만 승인할 수 있어요.`, `Only the ${d.approver_role || 'administrator'} can approve.`)), { status: 403 })
  // separation of duties: the person who asked never approves it, even holding the role or being an administrator
  // (another administrator can); they may still reject — withdraw — their own request
  if (approve && String(d.user_id) === String(me.id)) throw Object.assign(new Error(L('본인 요청은 다른 승인자가 승인해야 해요.', 'Someone else has to approve your own request.')), { status: 403 })
  let status = approve ? 'approved' : 'rejected'
  let result = { note }
  if (approve) {
    const ex = executors.get(d.executor)
    const r = ex ? await run(ex, d.payload, { userId: d.user_id, tenant: d.tenant_id, decisionId: d.id }) : { ok: false, error: `no executor ${d.executor}` }
    status = r.ok ? 'executed' : 'failed'
    result = r.ok ? { ...(r.result || {}), note } : { error: r.error, note }
  }
  await q('update pro_policy_decisions set status=$2, approved_by=$3, approved_at=now(), result=$4 where id=$1', [id, status, me.id, result])
  const msg = messageOf(d)
  if (msg && d.user_id) await updateMessage(d.user_id, msg, { status, approvedBy: me.name || me.email, note })
  if (d.user_id) {
    await notifyUser(d.user_id, {
      type: 'policy', url: '/chat',
      title: approve ? L(`승인됨 — ${d.subject}`, `Approved — ${d.subject}`) : L(`반려됨 — ${d.subject}`, `Rejected — ${d.subject}`),
      text: note || (approve ? L('요청하신 일을 실행했어요.', 'Your request ran.') : L('요청이 반려됐어요.', 'Your request was rejected.')),
    }).catch(() => {})
  }
  return { id, status, result }
}

// take back an action that ran under "record and allow" while its window is open
export async function undo(me, id) {
  const d = await loadPending(id)
  if (d.status !== 'executed' || !d.undo_until || new Date(d.undo_until) < new Date()) throw Object.assign(new Error(L('되돌릴 수 있는 시간이 지났어요.', 'The undo window has passed.')), { status: 409 })
  if (String(d.user_id) !== String(me.id) && !(await isAdmin(me))) throw Object.assign(new Error(L('요청한 사람이나 관리자만 되돌릴 수 있어요.', 'Only the requester or an administrator can undo.')), { status: 403 })
  const ex = executors.get(d.executor)
  await ex.undo(d.payload, d.result, { userId: d.user_id, tenant: d.tenant_id, decisionId: d.id })
  await q(`update pro_policy_decisions set status='undone' where id=$1`, [id])
  const msg = messageOf(d)
  if (msg) await updateMessage(d.user_id, msg, { status: 'undone' })
  return { id, status: 'undone' }
}
