// HTTP routes of the local CLI agents (lib/localAgents — design docs/local-agents/design.md). The desktop's own link is the
// WebSocket /api/local-agents/link (hub.js); these are for the signed-in page:
//   POST   /local-agents/devices          — a device token for the desktop app this page runs in (handed to its main process)
//   GET    /local-agents/devices          — my desktops (on or off, what they can run)
//   DELETE /local-agents/devices/:id      — revoke one (its link closes now)
//   GET    /local-agents/catalog          — the agents an activity can name, and how many desktops can run each now
//   GET    /local-agents/instances/:id    — an instance's local runs (its page)
//   GET    /local-agents/active           — the runs on now of instances I see (Home)
//   GET    /local-agents/jobs/:id         — one run's card (who sees its instance)
//   POST   /local-agents/jobs/:id/steer   — put words into the running CLI: only its worker (own words, or a suggestion: suggestionId)
//   POST   /local-agents/jobs/:id/delegate — hand a run waiting for its desktop to the server agent now (the worker, who may edit the work)
//   POST   /local-agents/jobs/:id/suggestions — suggest a prompt (anyone who sees the instance); it waits at the run's input
//   POST   /local-agents/jobs/:id/suggestions/:sid/dismiss — the worker drops a suggestion
//   POST   /local-agents/jobs/:id/knowhow/:kid — apply or dismiss what the run learned (knowhow.js mayDecide)
//   POST   /local-agents/jobs/:id/term     — a ticket for the run's terminal · conversation (WebSocket /api/local-agents/term)
//   GET    /local-agents/jobs/:id/transcript — the run's conversation (the CLI's own records), live or kept with the finished run
//   POST   /local-agents/jobs/:id/finish   — 「끝내기」: the worker ends a run that waits after its CLI's turn
//   POST   /local-agents/jobs/:id/answer   — the worker answers what the CLI asks ({ask, answer} — the desktop presses the keys)
//   GET    /local-agents/chat?key=         — the composer's agent picker: 기본 and the CLIs my desktops report (on · off, why), my choice for
//                                             that chat (chat.js — the message itself goes to POST /api/threads/:id/messages with {agent})
//   PUT    /local-agents/chat/choice       — remember my choice for a chat ({key, agent}: 'default' · 'claude-code' · 'codex')
//   POST   /local-agents/jobs/:id/fallback — 「기본으로 다시 보내기」: a chat run's sender stops it; the words that got no answer come back
import express from 'express'
import { config } from '../config.js'
import * as A from '../lib/localAgents/agents.js'
import * as D from '../lib/localAgents/devices.js'
import * as H from '../lib/localAgents/hub.js'
import * as J from '../lib/localAgents/jobs.js'
import * as ST from '../lib/localAgents/steps.js'
import * as R from '../lib/localAgents/relay.js'
import * as CH from '../lib/localAgents/chat.js'
import { canSeeInstance } from '../lib/processes.js'
import { L } from '../lib/lang.js'

export function localAgentRoutes(auth) {
  const r = express.Router()
  const h = (fn) => async (req, res) => {
    try { res.json(await fn(req, res)) } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
  }
  const T = () => config.tenantId

  r.post('/local-agents/devices', auth, h(async (req) => D.issue(req.user, { name: req.body?.name, platform: req.body?.platform, appVersion: req.body?.appVersion })))
  r.get('/local-agents/devices', auth, h(async (req) => (await D.list(req.user)).map((d) => ({ ...d, online: !!H.linkOf(T(), d.id) }))))
  r.delete('/local-agents/devices/:id', auth, h(async (req) => {
    const d = await D.revoke(req.user, req.params.id)
    if (!d) throw Object.assign(new Error(L('그 기기를 찾지 못했어요.', 'That device was not found.')), { status: 404 })
    H.closeDevice(T(), d.id)
    // (its working copies of variations: their seats go — 보관 중 from what it last pushed; lib/folders/seatLink.js)
    await import('../lib/folders/seatLink.js').then((m) => m.deviceGone(d.id, req.user.id)).catch((e) => console.warn('[seats] device gone', e.message))
    return d
  }))
  r.get('/local-agents/catalog', auth, h(async () => {
    const now = H.catalog(T())
    const lab = L(A.LABEL, A.LABEL_EN)
    return {
      local: A.LOCAL.map((id) => ({ id: `local:${id}`, cli: id, label: lab[id], devices: now[id]?.devices || 0, people: now[id]?.people || 0 })),
      server: A.SERVER.map((id) => ({ id, label: lab[id] })),
    }
  }))
  r.get('/local-agents/instances/:id', auth, h(async (req) => {
    if (!(await canSeeInstance(req.params.id, req.user))) throw Object.assign(new Error(L('이 프로세스를 볼 권한이 없어요.', "You don't have access to this process.")), { status: 403 })
    return ST.instanceView(req.params.id, req.user)
  }))
  // a job, for someone who may see its instance (404: no such job · 403: its instance is not theirs to see) — a chat's run: its sender, or
  // a member of its project's folder (chat.js canSee)
  const jobFor = async (req) => {
    const job = await J.byId(req.params.id)
    if (!job) throw Object.assign(new Error(L('그 실행을 찾지 못했어요.', 'That run was not found.')), { status: 404 })
    if (job.kind === CH.KIND) {
      if (!(await CH.canSee(req.user, job))) throw Object.assign(new Error(L('이 대화의 실행을 볼 권한이 없어요.', "You don't have access to this chat's run.")), { status: 403 })
      return job
    }
    if (!(await ST.canSee(req.user, job.proc_inst_id))) throw Object.assign(new Error(L('이 프로세스를 볼 권한이 없어요.', "You don't have access to this process.")), { status: 403 })
    return job
  }
  // the relayed session's kind of a job ('step', or 'chat')
  const kindOf = (job) => job.kind || 'step'
  r.get('/local-agents/jobs/:id', auth, h(async (req) => ST.cardFor(req.user, await jobFor(req))))
  // the CLI's input: only the person whose computer runs it — their own words, or a suggestion they loaded (suggestionId; edited or not)
  r.post('/local-agents/jobs/:id/steer', auth, h(async (req) => {
    const job = await jobFor(req)
    const out = await ST.steerAs(req.user, job, req.body?.text, req.body?.suggestionId ? String(req.body.suggestionId) : null)
    return { delivered: out.delivered, steer: out.steer, job: await ST.cardFor(req.user, out.job) }
  }))
  // 「서버에 맡기기」: a run waiting for its desktop goes to the activity's server agent now
  r.post('/local-agents/jobs/:id/delegate', auth, h(async (req) => {
    const job = await jobFor(req)
    if (!(await ST.mayDelegate(req.user, job))) throw Object.assign(new Error(L('담당자나 이 일을 고칠 수 있는 사람만 할 수 있어요.', 'Only the assignee or someone who may edit this work can do this.')), { status: 403 })
    return ST.cardFor(req.user, await ST.delegateNow(req.user, job))
  }))
  // a suggested prompt for the run — anyone who sees the instance; it stacks at the run's input for its worker
  r.post('/local-agents/jobs/:id/suggestions', auth, h(async (req) => {
    const job = await jobFor(req)
    const out = await ST.suggestOn(req.user, job, req.body?.text, { kind: req.body?.kind, option: req.body?.option })
    return { suggestion: out.suggestion, job: await ST.cardFor(req.user, out.job) }
  }))
  r.post('/local-agents/jobs/:id/suggestions/:sid/dismiss', auth, h(async (req) => {
    const job = await jobFor(req)
    return ST.cardFor(req.user, await ST.dismissSuggestion(req.user, job, req.params.sid))
  }))
  // what the run learned: apply (into the activity's definition, or as a proposal to the skill) or dismiss
  r.post('/local-agents/jobs/:id/knowhow/:kid', auth, h(async (req) => {
    const job = await jobFor(req)
    return ST.cardFor(req.user, await ST.decideKnowhow(req.user, job, req.params.kid, String(req.body?.action || '')))
  }))
  // Home: the runs on now, of instances I see
  // the run's terminal (relay.js): a one-time ticket for /api/local-agents/term — whoever sees the instance watches it, only the worker
  // types (owner); and what is on its screen now
  // (a run sent to a desktop that runs steps in a terminal gets a ticket before its terminal is open: the viewer waits for it there)
  r.post('/local-agents/jobs/:id/term', auth, h(async (req) => {
    const job = await jobFor(req)
    const S = R.find(config.tenantId, kindOf(job), job.id)
    const card = ST.cardOf(job)
    if (!S && !job.screen && !(Array.isArray(job.transcript) && job.transcript.length) && !card.terminalSoon) throw Object.assign(new Error(L('이 실행에는 터미널이 없어요.', 'This run has no terminal.')), { status: 404 })
    return { ticket: R.issueTicket(req.user, { kind: kindOf(job), ref: job.id, tenant: config.tenantId }), owner: ST.isWorker(req.user, job), live: !!S && !S.exited, waiting: !S && card.terminalSoon }
  }))
  // the conversation of the run, as the 「대화」 view shows it (the same people as its terminal)
  r.get('/local-agents/jobs/:id/transcript', auth, h(async (req) => {
    const job = await jobFor(req)
    const S = R.find(config.tenantId, kindOf(job), job.id)
    return { live: !!S && !S.exited, items: S ? R.txOf(S) : (job.transcript || []), asks: S ? R.asksOf(S) : [] }
  }))
  r.post('/local-agents/jobs/:id/finish', auth, h(async (req) => ST.cardFor(req.user, await ST.finishNow(req.user, await jobFor(req)))))
  r.post('/local-agents/jobs/:id/answer', auth, h(async (req) => {
    const job = await jobFor(req)
    const a = req.body?.answer
    const answer = Array.isArray(a) ? a.slice(0, 8).map((n) => Number(n)) : typeof a === 'number' ? a : String(a || '').slice(0, 20)
    return ST.answerAsk(req.user, job, String(req.body?.ask || ''), answer)
  }))
  r.get('/local-agents/jobs/:id/screen', auth, h(async (req) => {
    const job = await jobFor(req)
    const S = R.find(config.tenantId, kindOf(job), job.id)
    if (!S) throw Object.assign(new Error(L('지금 열린 터미널이 없어요.', 'No terminal is open now.')), { status: 404 })
    await R.flushed(S)
    return { screen: R.screenOf(S), stats: R.stats(S) }
  }))
  r.get('/local-agents/active', auth, h(async (req) => ST.activeFor(req.user)))
  // ---------- the chat's agent picker (chat.js) ----------
  r.get('/local-agents/chat', auth, h(async (req) => {
    const key = String(req.query.key || '').slice(0, 200)
    return { ...(await CH.availability(req.user)), ...(key ? { key, choice: await CH.choiceOf(req.user, key) } : {}) }
  }))
  r.put('/local-agents/chat/choice', auth, h(async (req) => ({ key: String(req.body?.key || ''), choice: await CH.choose(req.user, req.body?.key, String(req.body?.agent || 'default')) })))
  r.post('/local-agents/jobs/:id/fallback', auth, h(async (req) => {
    const job = await jobFor(req)
    if (job.kind !== CH.KIND) throw Object.assign(new Error(L('채팅의 실행만 기본으로 다시 보낼 수 있어요.', 'Only a chat run can be sent to Default instead.')), { status: 400 })
    return CH.fallback(req.user, job)
  }))
  return r
}
